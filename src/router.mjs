import { extname, resolve, sep, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { rotateCsrf, assertLocalApiRequest, assertCsrf } from './shared/security.mjs';
import { sanitizeLogLine } from './shared/sanitize.mjs';
import { RateLimiter, rateLimitMiddleware } from './shared/rate-limit.mjs';
import { tryReadJson, readJson, writeJsonAtomic } from './shared/atomic-write.mjs';
import { resolveScanRequest } from './scrape-orchestrator.mjs';
import { sportOptions, getSport } from './sports/registry.mjs';
import { ALERT_SCHEMA, evaluateAlerts, normalizeAlertPreferences } from './alert-engine.mjs';

/**
 * router.mjs — pure HTTP dispatch. All routes are co-located here so the
 * file is grep-friendly; if it grows past ~700 lines we split.
 *
 * Conventions:
 *   - GET  /api/*          read-only, no CSRF
 *   - POST/PUT/DELETE      CSRF required (x-arbiter-token)
 *   - Mutations rate-limited per peer (token bucket)
 *   - Body parsing caps at 1 MB
 *   - All errors come back as { error: { name, message, code } }
 */

const MAX_BODY = 1024 * 1024;

export function buildRouter(ctx) {
  const {
    dataDir,
    publicDir,
    configPath,
    profilesPath,
    orchestrator,
    scheduler,
    live,
    tracker,
    broadcaster,
    scanService,
    logger = () => {},
    rateLimiter = new RateLimiter({ capacity: 30, refillPerSec: 10 }),
  } = ctx;

  const limitCheck = rateLimitMiddleware(rateLimiter);

  // `prune()` drops buckets that have been idle past their refill horizon. It
  // was written and unit-tested but never scheduled, so the Map only ever grew
  // to `maxBuckets` via the overflow evictor and the idle entries stayed
  // resident for the life of the process. The interval is unref'd so it never
  // holds the event loop open on its own.
  const pruneTimer = setInterval(() => {
    const removed = rateLimiter.prune();
    if (removed > 0) logger('info', `rate limiter: pruned ${removed} idle bucket(s)`);
  }, 60_000);
  pruneTimer.unref?.();

  const handlers = {
    'GET /api/health': () => sendJson(null, 200, {
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
    'GET /api/csrf': () => sendJson(null, 200, { token: rotateCsrf() }),
    'GET /api/scrape/state': () => sendJson(null, 200, { state: orchestrator.scrapeState || emptyState() }),
    'GET /api/scrape-run': async () => {
      const run = await scanService.readLatestScrapeRun(dataDir);
      return sendJson(null, 200, run || { jobs: [], opportunitiesCount: 0 });
    },
    'POST /api/scrape': async (req) => {
      const body = await parseBody(req);
      const bookIds = Array.isArray(body.bookIds) ? body.bookIds : [];
      const scanOptions = resolveScanRequest(body.scanOptions || {});
      try {
        const state = await orchestrator.launch({ bookIds, scanOptions });
        return sendJson(null, 202, { state });
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'ELOCKED') {
          return sendJson(null, 409, { error: { name: err.name, message: err.message, code: err.code } });
        }
        throw err;
      }
    },
    'POST /api/scrape/cancel': async () => {
      const result = await orchestrator.cancel();
      return sendJson(null, result.cancelled ? 202 : 409, result);
    },
    'GET /api/scan': async () => {
      // `published` rides on the served document rather than wrapping it in an
      // envelope like readAlertPayload does. There the page asks for the
      // payload and knows the scan is inside it; here four pages read
      // `scan.opportunities` and `scan.dataHealth` directly, and an envelope
      // would hand every one of them `undefined` — which renders as 0, the
      // exact lie the flag exists to stop. Flat, a consumer that never learns
      // the flag exists still receives it.
      const { scan, published } = await scanService.readPublishedScan(dataDir);
      return sendJson(null, 200, { ...scan, published });
    },
    'POST /api/scan': async (req) => {
      const body = await parseBody(req);
      const options = resolveScanRequest(body);
      // Validate sport against registry if provided
      if (options.sport) {
        if (!getSport(options.sport)) {
          const err = new Error(`unknown sport "${options.sport}"`);
          err.code = 'EBADINPUT';
          throw err;
        }
      }
      const scan = await scanService.runScan({
        dataDir,
        sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : null,
        bankroll: options.bankroll,
        minRoiPercent: options.minRoiPercent,
        minEvPercent: options.minEvPercent,
        maxMiddleRiskPercent: options.maxMiddleRiskPercent,
        minMiddleRoiPercent: options.minMiddleRoiPercent,
        includeLive: options.includeLive,
        includePast: options.includePast,
        sport: options.sport,
        publish: false,
      });
      return sendJson(null, 200, scan);
    },
    'GET /api/scan/export.csv': async (req, res) => {
      const { buildScanCsv } = await import('./scan-service.mjs');
      const params = new URL(req.url, 'http://localhost').searchParams;
      const types = params.getAll('type').flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
      const scan = await scanService.readLatestScan(dataDir);
      const csv = buildScanCsv(scan, types);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="scan-findings.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      res.end(csv);
      return null;
    },
    'GET /api/catalog': async () => sendJson(null, 200, await scanService.readLatestCatalog(dataDir) || {}),
    'POST /api/verify': async (req) => {
      const { runVerificationPass, expireAutomaticConfirmations } = await import('./verification.mjs');
      const body = await parseBody(req);
      const baseScan = await readJson(join(dataDir, 'latest-scan.json'), null);
      if (!baseScan) {
        return sendJson(null, 400, { error: { name: 'BadRequest', code: 'ENOSCAN', message: 'no latest-scan.json' } });
      }
      const targets = Array.isArray(body.targets) ? body.targets : [...(baseScan.opportunities || [])];
      const result = await runVerificationPass(targets, baseScan, {
        dataDir,
        // Without this the batch re-reads config/scrapers.json from process.cwd(),
        // which is not the project root when the server is started elsewhere —
        // the read then threw a bare ENOENT and the route answered 500.
        configPath,
        parallel: 12,
        minEvPercent: baseScan.options?.minEvPercent,
        logger,
      });
      // Retire confirmations whose event has settled, then persist the
      // verification verdicts back into the published scan.
      expireAutomaticConfirmations(baseScan);
      await writeJsonAtomic(join(dataDir, 'latest-scan.json'), baseScan);
      // The four counters, and only those. `runVerificationPass` also returns
      // `verifications` (one entry per target, each carrying the whole target)
      // and `newScan` (the whole re-scan of every book the pass touched), and
      // the route used to forward both verbatim.
      //
      // Nothing read them. The page formats these four numbers and then
      // re-reads /api/scan (scanner.js:345), which is where the verdicts already
      // are — the loop above writes `verification` onto every opportunity and
      // `verificationSummary` onto the scan itself. Measured over the real
      // route: 4 bytes of counters answered with 2207, 550x more than the page
      // uses, and `newScan` grows with the whole scan while the payload the UI
      // renders stays four integers.
      //
      // That is not a neutral trim either. The page's own comment above the call
      // says "the response is the verdict counters, not the scan" — which was
      // not true of the route it was describing, and the reason nothing caught
      // it is that no test asserted the response shape either.
      return sendJson(null, 200, {
        confirmed: result.confirmed,
        rejected: result.rejected,
        expired: result.expired,
        unconfirmed: result.unconfirmed,
      });
    },
    'GET /api/scrapers': async () => {
      const cfg = await tryReadJson(configPath, { jobs: [] });
      const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
      const enabledJobs = jobs.filter((job) => job.enabled !== false);
      const validatedJobs = jobs.filter((job) => job.validationStatus === 'validated');
      const experimentalJobs = jobs.filter((job) => job.validationStatus !== 'validated');
      return sendJson(null, 200, { jobs, enabledJobs, validatedJobs, experimentalJobs });
    },
    'GET /api/sports': () => {
      return sendJson(null, 200, { sports: sportOptions() });
    },
    'GET /api/profiles': async () => {
      const cfg = await tryReadJson(profilesPath, { profiles: [] });
      return sendJson(null, 200, { profiles: Array.isArray(cfg.profiles) ? cfg.profiles : [] });
    },
    'GET /api/scheduler': async () => sendJson(null, 200, await scheduler.status()),
    'POST /api/scheduler': async (req) => {
      const body = await parseBody(req);
      if (body.enabled === false) return sendJson(null, 200, await scheduler.disable());
      return sendJson(null, 200, await scheduler.enable({
        bookIds: Array.isArray(body.bookIds) ? body.bookIds : [],
        scanOptions: resolveScanRequest(body.scanOptions || {}),
        intervalMinutes: body.intervalMinutes,
      }));
    },
    'GET /api/live': async () => sendJson(null, 200, await live.status()),
    'POST /api/live': async (req) => {
      const body = await parseBody(req);
      if (body.enabled === false) return sendJson(null, 200, await live.disable());
      return sendJson(null, 200, await live.enable({
        bookIds: Array.isArray(body.bookIds) ? body.bookIds : [],
        scanOptions: resolveScanRequest(body.scanOptions || {}),
        intervalSeconds: body.intervalSeconds,
      }));
    },
    'GET /api/tracker': async () => sendJson(null, 200, await tracker.loadTracker()),
    'POST /api/tracker': async (req) => {
      const body = await parseBody(req);
      return sendJson(null, 201, await tracker.addBet(body));
    },
    'GET /api/tracker/export.csv': async (_req, res) => {
      const csv = await tracker.exportCsv();
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="bet-tracker.csv"');
      res.statusCode = 200;
      res.end(csv);
      return null;
    },
    'POST /api/tracker/import': async (req) => {
      const body = await parseBody(req);
      return sendJson(null, 200, await tracker.importCsv(body.csv || ''));
    },
    'GET /api/alerts': async () => sendJson(null, 200, await readAlertPayload()),
    'POST /api/alerts': async (req) => {
      const body = await parseBody(req);
      await tracker.saveAlerts(body.preferences || body);
      // Answer with the freshly evaluated set rather than the settings that
      // were just written. The page has to render the effect of the change it
      // just made, and making it re-read to learn its own thresholds is a
      // second round trip that can straddle a scan update and show numbers
      // that were computed under the old settings.
      return sendJson(null, 200, await readAlertPayload());
    },
    'GET /api/events': (_req, res) => {
      if (!broadcaster) {
        return sendJson(res, 503, { error: { name: 'Unavailable', message: 'sse disabled', code: 'ENOSSE' } });
      }
      broadcaster.add(res);
      return null;
    },
  };

  /**
   * Settings + the signals those settings select out of the published scan.
   *
   * One payload for both alert routes, and one scan read per call: the two
   * halves have to describe the same instant, or the page renders a list
   * computed under thresholds it is no longer showing.
   *
   * `scan` is a reference, not the scan — the page needs to say which run a
   * list came from, and shipping several hundred opportunities again to
   * annotate a count would double the payload of the most-polled endpoint in
   * the app for no gain.
   *
   * The preferences are normalized here rather than echoed as the service
   * returned them. TrackerService already normalizes, but a route whose
   * contract holds only because of something a collaborator happens to do is a
   * contract nothing tests: the page builds its inputs out of this object, and
   * an undefined threshold there renders an empty box that saves an empty box.
   */
  async function readAlertPayload() {
    const { scan, published } = await scanService.readPublishedScan(dataDir);
    const stored = await tracker.loadAlerts();
    const preferences = normalizeAlertPreferences(stored?.preferences);
    return {
      schemaVersion: ALERT_SCHEMA,
      // False means the list below is empty because nothing has been scraped
      // yet, not because the market was quiet. The page must not conflate them.
      published,
      scan: { id: scan.id, scrapedAt: scan.scrapedAt, eventCount: scan.eventCount },
      preferences,
      ...evaluateAlerts(scan, preferences),
    };
  }

  return async function route(req, res, parsedUrl) {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (parsedUrl.pathname.startsWith('/api/')) {
        assertLocalApiRequest(req);
      }
      // rate limit mutations
      const limit = limitCheck(req);
      if (!limit.ok) {
        res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
        res.setHeader('X-RateLimit-Remaining', '0');
        return sendJson(res, 429, {
          error: {
            name: 'TooManyRequests',
            message: `rate limit exceeded; retry after ${limit.retryAfterMs}ms`,
            code: 'ERATELIMIT',
          },
        });
      }
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
      if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/snapshot/')) {
        return await readSnapshotRoute(res, parsedUrl, dataDir);
      }
      if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/odds/')) {
        return await readOddsRoute(res, parsedUrl, dataDir);
      }
      if (req.method === 'GET' && parsedUrl.pathname === '/api/event-detail') {
        return await readEventDetailRoute(res, parsedUrl, dataDir);
      }
      const key = `${req.method} ${parsedUrl.pathname}`;
      const handler = handlers[key];
      if (handler) {
        const needsCsrf = req.method !== 'GET' && req.method !== 'HEAD' && parsedUrl.pathname !== '/api/events';
        if (needsCsrf) assertCsrf(req);
        const out = await handler(req, res);
        if (out) sendJson(res, out.status, out.body);
        return;
      }
      if (req.method === 'PUT' && parsedUrl.pathname.startsWith('/api/tracker/')) {
        assertCsrf(req);
        const id = decodeURIComponent(parsedUrl.pathname.slice('/api/tracker/'.length));
        const body = await parseBody(req);
        const updated = await tracker.updateBet(id, body);
        if (!updated) {
          sendJson(res, 404, { error: { name: 'NotFound', message: `bet ${id} not found`, code: 'ENOTFOUND' } });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }
      if (req.method === 'DELETE' && parsedUrl.pathname.startsWith('/api/tracker/')) {
        assertCsrf(req);
        sendJson(res, 200, await tracker.removeBet(idFromPath(parsedUrl.pathname)));
        return;
      }
      return await serveStatic(req, res, parsedUrl, { publicDir });
    } catch (err) {
      const status = statusForError(err);
      logger('error', `route ${req.method} ${parsedUrl.pathname}: ${err.message}`);
      if (res.headersSent) {
        // Response already streaming (SSE, CSV export) — the error body can no
        // longer be delivered; just terminate the connection cleanly.
        res.end();
        return null;
      }
      return sendJson(res, status, {
        error: {
          name: err.name || 'Error',
          message: sanitizeLogLine(err.message || 'internal error'),
          code: err.code || 'EINTERNAL',
        },
      });
    }
  };
}

/**
 * Map an error to an HTTP status.
 *
 * Services signal rejected input with `code = 'EBADINPUT'` (the tracker needs a
 * selection, the scheduler needs a book, a scrape needs jobs). Those are the
 * caller's fault, so they answer 400 rather than 500 — a validation failure
 * reported as a server error hides the real problem behind an alert.
 */
function statusForError(err) {
  if (Number.isInteger(err.statusCode)) return err.statusCode;
  if (err.code === 'EBADINPUT' || err.code === 'EBADJSON' || err.code === 'EBADQUERY' || err.code === 'EDEPTH') return 400;
  if (err.code === 'ENOSCAN') return 400;
  if (err.code === 'ENOTFOUND') return 404;
  if (err.code === 'ESCRAPERCONFIG') return 422;
  if (err.code === 'EBUSY' || err.code === 'ELOCKED') return 409;
  return 500;
}

async function readSnapshotRoute(res, parsedUrl, dataDir) {
  const sourceId = decodeURIComponent(parsedUrl.pathname.slice('/api/snapshot/'.length));
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(sourceId)) {
    return sendJson(res, 400, { error: { name: 'BadRequest', message: 'invalid source id', code: 'EBADID' } });
  }
  let snapshot;
  try {
    snapshot = await readJson(join(dataDir, 'workspace', `${sourceId}_events.json`), null);
  } catch {
    return sendJson(res, 500, { error: { name: 'InvalidData', message: 'snapshot is invalid JSON', code: 'EINVALID' } });
  }
  if (!snapshot) return sendJson(res, 404, { error: { name: 'NotFound', message: 'snapshot not found', code: 'ENOTFOUND' } });
  return sendJson(res, 200, snapshot);
}

async function readOddsRoute(res, parsedUrl, dataDir) {
  const parts = parsedUrl.pathname.slice('/api/odds/'.length).split('/').filter(Boolean);
  const sourceId = decodeURIComponent(parts[0] || '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(sourceId)) {
    return sendJson(res, 400, { error: { name: 'BadRequest', message: 'invalid source id', code: 'EBADID' } });
  }
  let snapshot;
  try {
    snapshot = await readJson(join(dataDir, 'workspace', `${sourceId}_events.json`), null);
  } catch {
    return sendJson(res, 500, { error: { name: 'InvalidData', message: 'snapshot is invalid JSON', code: 'EINVALID' } });
  }
  if (!snapshot) return sendJson(res, 404, { error: { name: 'NotFound', message: 'snapshot not found', code: 'ENOTFOUND' } });
  const params = parsedUrl.searchParams;
  const eventKey = params.get('eventKey');
  const marketKey = params.get('marketKey')?.toUpperCase();
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') || '50', 10) || 50));
  const events = (Array.isArray(snapshot.events) ? snapshot.events : []).filter((event) => !eventKey || event.eventKey === eventKey);
  const result = [];
  for (const event of events) {
    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (marketKey && String(market.key).toUpperCase() !== marketKey) continue;
      result.push({
        eventKey: event.eventKey,
        id: event.id,
        sport: event.sport,
        league: event.league,
        kickoff: event.kickoff,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        // Kept for the same reason readEventDetailRoute keeps it, and on the
        // same files: this projects `market.selections` out of the very same
        // snapshots, so a price list that arrived here without the in-play flag
        // would be marked the same way a pre-match one is — a different,
        // calmer thing than the signal the reader just asked for. A diagnostic
        // route is read fastest precisely when something looks wrong, which is
        // the worst moment to lose the field that says the price is moving.
        //
        // Per market, not per event: the adapters mark each market from the
        // provider's own field, and two books of one event can disagree.
        live: event.live === true,
        market: {
          key: market.key,
          name: market.name || market.key,
          live: market.live === true,
          selections: Array.isArray(market.selections) ? market.selections : [],
        },
      });
      if (result.length >= limit) return sendJson(res, 200, { sourceId, capturedAt: snapshot.capturedAt || null, results: result });
    }
  }
  return sendJson(res, 200, { sourceId, capturedAt: snapshot.capturedAt || null, results: result });
}

// Small TTL cache for event-detail workspace reads. Snapshots change only when
// the orchestrator promotes an atomic write, so re-reading and re-parsing up to
// 30 files per request is pure waste. Keyed per dataDir so parallel server
// instances never share state.
const eventDetailCache = new Map();
const EVENT_CACHE_TTL_MS = 2000;
const EVENT_CACHE_MAX = 4;
async function loadEventDetailSnapshots(dataDir) {
  const now = Date.now();
  const cached = eventDetailCache.get(dataDir);
  if (cached && now - cached.at < EVENT_CACHE_TTL_MS) return cached.snapshots;
  let dirEntries;
  try { dirEntries = await fs.readdir(join(dataDir, 'workspace')); } catch { return []; }
  const files = dirEntries.filter((f) => f.endsWith('_events.json')).slice(0, 30);
  const snapshots = [];
  for (const file of files) {
    const snapshot = await tryReadJson(join(dataDir, 'workspace', file), null);
    if (snapshot) snapshots.push({ sourceId: file.replace('_events.json', ''), snapshot });
  }
  if (eventDetailCache.size >= EVENT_CACHE_MAX) eventDetailCache.clear();
  eventDetailCache.set(dataDir, { at: now, snapshots });
  return snapshots;
}

export async function readEventDetailRoute(res, parsedUrl, dataDir) {
  const { normalizeClubIdentity, normalizeTeamName } = await import('./shared/text.mjs');

  const params = parsedUrl.searchParams;
  const sport = params.get('sport') || '';
  const home = params.get('home') || '';
  const away = params.get('away') || '';
  const kickoff = params.get('kickoff') || '';

  if (!sport || !home || !away) {
    return sendJson(res, 400, { error: { name: 'BadRequest', message: 'sport, home, away are required', code: 'EBADQUERY' } });
  }

  const queryKickoff = Date.parse(kickoff);
  const normSport = normalizeTeamName(sport);
  const normHome = normalizeClubIdentity(home);
  const normAway = normalizeClubIdentity(away);

  const snapshots = await loadEventDetailSnapshots(dataDir);

  const events = [];
  // The engine-shaped copies of every matched book, kept aside so the arbitrage
  // planner sees the same contract/selection shape the scanner does.
  const engineInstances = [];

  for (const entry of snapshots) {
    if (!entry || !Array.isArray(entry.snapshot.events)) continue;
    const { sourceId, snapshot } = entry;

    for (const ev of snapshot.events) {
      if (normalizeTeamName(ev.sport || '') !== normSport) continue;
      if (Number.isFinite(queryKickoff)) {
        const evKickoff = Date.parse(ev.kickoff || '');
        if (Number.isFinite(evKickoff) && Math.abs(evKickoff - queryKickoff) > 5 * 60 * 1000) continue;
      }
      // Match by normalized club identity, with an eventKey-token fallback for
      // scrapers whose team names don't normalize identically to the query.
      const evHome = normalizeClubIdentity(ev.homeTeam || '');
      const evAway = normalizeClubIdentity(ev.awayTeam || '');
      const homeMatch = evHome === normHome || eventKeyTokensMatch(ev.eventKey, normHome, normAway);
      const awayMatch = evAway === normAway || eventKeyTokensMatch(ev.eventKey, normHome, normAway);
      if (!homeMatch || !awayMatch) continue;
      // Keep an engine-shaped copy: findArbitrage() buckets by eventKey and
      // reads selection/market objects exactly as the scrapers emitted them, so
      // the detail arb is planned from the same contract machinery as a scan
      // rather than a re-implementation of it.
      if (Array.isArray(ev.markets) && ev.markets.length) {
        engineInstances.push({ ...ev, sourceId });
      }
      events.push({
        sourceId,
        sourceUrl: ev.sourceUrl || null,
        eventUrl: ev.sourceUrl || null,
        sport: ev.sport,
        league: ev.league || '',
        kickoff: ev.kickoff,
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        // Kept, not dropped: the dashboard marks an in-play row and this page is
        // where that row is opened, so a price list that arrives unmarked reads
        // as a different, calmer thing than the signal the trader just clicked.
        live: ev.live === true,
        markets: Array.isArray(ev.markets) ? ev.markets.map((m) => ({
          key: m.key,
          name: m.name || m.key,
          // Per-market, not per-event: the adapters mark each market from the
          // provider's own field, and two books of one event can disagree.
          live: m.live === true,
          selections: Array.isArray(m.selections) ? m.selections : [],
        })) : [],
      });
    }
  }

  // Per-market cross-book arbitrage with a reconciled money plan. Computed once
  // for the whole fixture and attached by market key, so the detail view can
  // show where the headline ROI actually comes from instead of a per-book
  // overround that cannot reproduce it.
  let arbs = new Map();
  if (engineInstances.length >= 2) {
    try {
      const { findDetailArbitrages } = await import('./scanner/event-arbs.mjs');
      arbs = findDetailArbitrages(engineInstances);
    } catch {
      // Detection is additive: a failure here must not break the odds view.
    }
  }
  if (arbs.size) {
    for (const ev of events) {
      for (const market of ev.markets) {
        const arb = arbs.get(String(market.key));
        if (arb) market.arb = arb;
      }
    }
  }

  // Only `events`. The arbitrage map was also being published as a flat
  // `arbs: [...arbs.values()]` array, and nothing read it: the modal reads the
  // per-market `arb` this same map is attached to. Worse than unread, the flat
  // form is the one that cannot be used — `findDetailArbitrages` keys its
  // result by market key, and spreading the values drops the key, so a
  // consumer holding that array has no way to tell which market a plan belongs
  // to. Two copies of one fact, one of them lossy, and the lossy one is what
  // the payload offers.
  return sendJson(res, 200, { events });
}

function eventKeyTokensMatch(eventKey, normHome, normAway) {
  if (!eventKey) return false;
  const tokens = String(eventKey).toLowerCase().split('|');
  const homeTokens = new Set(normHome.split(' '));
  const awayTokens = new Set(normAway.split(' '));
  let homeHits = 0, awayHits = 0;
  for (const tok of tokens) {
    if (homeTokens.has(tok)) homeHits++;
    if (awayTokens.has(tok)) awayHits++;
  }
  return homeHits > 0 && awayHits > 0;
}

function emptyState() {
  return {
    status: 'idle',
    jobs: [],
    books: [],
    options: {},
    summary: null,
    currentStep: null,
    currentActivity: null,
  };
}

function idFromPath(path) {
  return decodeURIComponent(path.slice('/api/tracker/'.length));
}

export function sendJson(res, status, body) {
  if (res) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
    return null;
  }
  return { status, body };
}

export async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('request body too large');
        err.statusCode = 413;
        err.code = 'EBODYLARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(parseJsonDepthLimited(raw));
      } catch (err) {
        const tooNested = err.code === 'EDEPTH';
        const e = new Error(tooNested ? 'request body too nested' : 'invalid JSON body');
        e.statusCode = 400;
        e.code = tooNested ? 'EDEPTH' : 'EBADJSON';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Defend against a deeply-nested JSON body causing a stack overflow during
// parse (a known Node DoS vector). We count the brute bracket depth on the
// raw string (ignoring string literals) and reject before JSON.parse ever
// gets a chance to recurse too far — cheap and deterministic.
function parseJsonDepthLimited(raw, maxDepth = 128) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (++depth > maxDepth) {
        const err = new Error('maximum JSON nesting depth exceeded');
        err.code = 'EDEPTH';
        throw err;
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }
  return JSON.parse(raw);
}

async function serveStatic(_req, res, parsedUrl, { publicDir }) {
  let p = parsedUrl.pathname;
  if (p === '/' || p === '') p = '/index.html';
  const root = resolve(publicDir);
  const safe = resolve(root, '.' + p);
  if (safe !== root && !safe.startsWith(root + sep)) {
    return sendJson(res, 403, { error: { name: 'Forbidden', message: 'path traversal', code: 'EFORBIDDEN' } });
  }
  try {
    const data = await fs.readFile(safe);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(safe));
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return sendJson(res, 404, { error: { name: 'NotFound', message: 'not found', code: 'ENOTFOUND' } });
    }
    return sendJson(res, 500, { error: { name: 'Error', message: err.message, code: 'EREAD' } });
  }
}

function contentType(path) {
  const e = extname(path).toLowerCase();
  switch (e) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}
