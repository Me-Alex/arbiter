/**
 * router.test.mjs — integration tests for the HTTP dispatcher.
 *
 * Boots the real router against stub services so we exercise the actual
 * security + rate-limit wiring (CSRF, host guard, token bucket, body parsing,
 * static serving, 404 fallback) rather than mocking the routing layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildRouter } from '../src/router.mjs';
import { emptyScan } from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { csrfToken, rotateCsrf } from '../src/shared/security.mjs';
import { fileURLToPath } from 'node:url';
import { LIVE_EVIDENCE } from '../src/scrapers/live-status.mjs';

// The real registry, not a fixture. A hand-written config here would be a
// config the join was never measured against, which is the mistake this whole
// surface is about: the evidence table has 24 rows and the registry has 26 jobs,
// and only the real file shows which two fall outside it.
const REAL_CONFIG = fileURLToPath(new URL('../config/scrapers.json', import.meta.url));

const TMP = `.tmp-router-test-${process.pid}`;

// minimal in-memory broadcaster
function fakeBroadcaster() {
  const conns = new Set();
  return {
    add(res) { conns.add(res); },
    stop() { conns.clear(); },
    count() { return conns.size; },
  };
}

function stubServices() {
  return {
    dataDir: TMP,
    publicDir: TMP, // unused; we override via path
    configPath: 'unused',
    profilesPath: 'unused',
    orchestrator: {
      scrapeState: { status: 'idle', jobs: [], books: [], options: {}, summary: null, currentStep: null, currentActivity: null },
      async launch() { return this.scrapeState; },
      async cancel() { return { cancelled: true, state: this.scrapeState }; },
    },
    scheduler: {
      async status() { return { enabled: false, intervalMinutes: 15 }; },
      async enable() { return { enabled: true }; },
      async disable() { return { enabled: false }; },
    },
    tracker: {
      async loadTracker() { return { items: [] }; },
      async addBet(b) { return { id: 'b1', ...b }; },
      async updateBet() { return null; },
      async removeBet() { return { ok: true }; },
      async exportCsv() { return 'id,selection\nb1,FCSB\n'; },
      async importCsv() { return { imported: 1 }; },
      async loadAlerts() { return { preferences: {} }; },
      async saveAlerts(p) { return { preferences: p }; },
    },
    broadcaster: fakeBroadcaster(),
    scanService: {
      // Delegates to the real factory rather than hand-writing `{opportunities,
      // middles}`: the last time a stub spelled out the scan's keys by hand it
      // was missing five of the fourteen, and a route that reads `scan.id` or
      // `scan.eventCount` then "worked" in every test and in no real run.
      async readPublishedScan() { const s = emptyScan(); return { scan: s, published: true }; },
      async readLatestScan() { return (await this.readPublishedScan()).scan; },
      async readLatestCatalog() { return { markets: [] }; },
      async runScan() { return emptyScan(); },
    },
    logger: () => {},
  };
}

function makeServer(extra = {}) {
  const services = { ...stubServices(), ...extra };
  // Allow injecting a custom rate limiter for tests
  if (!extra.rateLimiter) services.rateLimiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
  const route = buildRouter(services);
  return { route, services };
}

function startServer(route) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      Promise.resolve(route(req, res, url)).catch(() => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  // closeAllConnections is required, not optional. `server.close(cb)` waits for
  // every open socket to go idle, and keep-alive connections from earlier
  // requests in this file stay open, so the callback can hang. That produced an
  // intermittent file-level failure with all subtests green — a teardown hang,
  // not a logic failure — on roughly one run in five, on a suite CI runs on
  // every push.
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function fetchOnce(server, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = server.address();
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- /api/health ----------------------------------------------------------

test('GET /api/health returns ok with uptime', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(typeof body.uptimeSeconds === 'number');
    assert.ok(typeof body.timestamp === 'string');
  } finally { await closeServer(server); }
});

// ---- /api/csrf ------------------------------------------------------------

test('GET /api/csrf returns a token', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/csrf');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.token, csrfToken());
  } finally { await closeServer(server); }
});

// ---- host guard -----------------------------------------------------------

test('rejects non-loopback host header', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/health', { headers: { Host: 'evil.example.com' } });
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'ENOTLOCAL');
  } finally { await closeServer(server); }
});

test('accepts loopback host header', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/health', { headers: { Host: '127.0.0.1' } });
    assert.equal(res.status, 200);
  } finally { await closeServer(server); }
});

// ---- CSRF guard -----------------------------------------------------------

test('rejects POST without CSRF token', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/scrape/cancel', {
      method: 'POST',
      headers: { Host: '127.0.0.1' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.match(body.error.message, /csrf/i);
  } finally { await closeServer(server); }
});

test('accepts POST with valid CSRF token', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/scrape/cancel', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': csrfToken() },
      body: '{}',
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers['x-ratelimit-remaining'] !== undefined, true);
  } finally { await closeServer(server); }
});

test('rejects POST after CSRF rotation', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const oldToken = csrfToken();
    rotateCsrf();
    const res = await fetchOnce(server, '/api/scrape/cancel', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': oldToken },
      body: '{}',
    });
    assert.equal(res.status, 403);
  } finally { await closeServer(server); }
});

// ---- rate limit -----------------------------------------------------------

test('returns 429 once mutation bucket is empty', async () => {
  const { route, services } = makeServer();
  // capacity 2, refill 0/s → exhaustible in one test
  services.rateLimiter = new RateLimiter({ capacity: 2, refillPerSec: 0.001 });
  const route2 = buildRouter(services);
  const server = await startServer(route2);
  const token = csrfToken();
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetchOnce(server, '/api/scrape/cancel', {
        method: 'POST',
        headers: { Host: '127.0.0.1', 'x-arbiter-token': token },
        body: '{}',
      });
      assert.equal(r.status, 202, `request ${i} should pass`);
    }
    const blocked = await fetchOnce(server, '/api/scrape/cancel', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': token },
      body: '{}',
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['x-ratelimit-remaining'], '0');
    assert.ok(blocked.headers['retry-after']);
    const body = JSON.parse(blocked.body);
    assert.equal(body.error.code, 'ERATELIMIT');
  } finally { await closeServer(server); }
});

test('GETs do not consume the bucket', async () => {
  const { route, services } = makeServer();
  services.rateLimiter = new RateLimiter({ capacity: 1, refillPerSec: 0.001 });
  const route2 = buildRouter(services);
  const server = await startServer(route2);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetchOnce(server, '/api/health');
      assert.equal(r.status, 200);
    }
  } finally { await closeServer(server); }
});

// ---- body parsing ---------------------------------------------------------

test('rejects oversized body with 413', async () => {
  const { route: _route } = makeServer();
  const server = await startServer(_route);
  const token = csrfToken();
  try {
    const big = 'x'.repeat(1024 * 1024 + 16);
    const payload = JSON.stringify({ bookIds: [], extra: big });
    assert.ok(payload.length > 1024 * 1024, 'payload must exceed limit');
    // Server destroys the connection once it sees the body is too large,
    // which surfaces as a hang-up / ECONNRESET depending on buffering.
    const expected = new Set(['413', 'hang up', 'ECONNRESET']);
    let status = 'ok';
    let body = '';
    try {
      const res = await fetchOnce(server, '/api/scrape', {
        method: 'POST',
        headers: { Host: '127.0.0.1', 'x-arbiter-token': token, 'Content-Type': 'application/json' },
        body: payload,
      });
      status = String(res.status);
      body = res.body;
    } catch (err) {
      body = err.message || '';
      status = body.includes('hang up') || body.includes('ECONNRESET') ? 'hang up' : 'error';
    }
    assert.ok(expected.has(status) || expected.has(body) || body.toLowerCase().includes('hang up') || status === '413', `expected 413 or connection close, got status=${status} body=${body.slice(0, 80)}`);
  } finally { await closeServer(server); }
});

test('rejects invalid JSON with 400', async () => {
  const { route: _route2 } = makeServer();
  const server = await startServer(_route2);
  const token = csrfToken();
  try {
    const res = await fetchOnce(server, '/api/scrape', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': token, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'EBADJSON');
  } finally { await closeServer(server); }
});

// ---- the removed insights route stays removed ------------------------------

test('GET /api/ai/insights is gone, not merely unused', async () => {
  // It read a service that no call site ever constructed: there is no
  // src/ai-service.mjs in the tree, so the handler could only ever have
  // answered `{ insights: [] }`. The AI page says in its own subtitle that its
  // summaries are scan-derived and deterministic, so the route was a leftover
  // of a design that was replaced rather than a feature awaiting a caller.
  //
  // Removed rather than left dormant: a route that can only return an empty
  // array looks like surface somebody is relying on.
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/ai/insights');
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.code, 'ENOTFOUND');
  } finally { await closeServer(server); }
});

// ---- unknown route falls through to static serving -----------------------

test('unknown path returns 404 JSON', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/does-not-exist');
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'ENOTFOUND');
  } finally { await closeServer(server); }
});

// ---- /api/event-detail keeps the in-play scope -----------------------------

/**
 * The dashboard marks an in-play row and this route is where that row is opened,
 * so a projection that dropped `live` would hand the detail page a price list
 * unmarked — a different, calmer thing than the signal the trader just clicked.
 *
 * Per market, not per event: the adapters mark each market from the provider's
 * own field, so two books of one event can legitimately disagree and the page
 * has to be able to show that.
 */
test('event detail keeps live on the event and on each market', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readEventDetailRoute } = await import('../src/router.mjs');

  const QUERY = { sport: 'Football', home: 'Home', away: 'Away', kickoff: '2030-01-01T12:00:00.000Z' };
  const snapshot = (eventLive, marketLive) => ({
    events: [{
      sport: 'Football', league: 'Liga 1', kickoff: QUERY.kickoff,
      homeTeam: 'Home', awayTeam: 'Away', sourceUrl: 'https://book.ro/e/1',
      live: eventLive,
      markets: [{ key: 'MATCH_ODDS', name: '1X2', live: marketLive,
        selections: [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.4 }] }],
    }],
  });

  // A fresh dataDir per case: the route caches snapshots per directory, so
  // reusing one would read the previous case's files and pass regardless.
  const detailFrom = async (label, favbet, unibet) => {
    const dir = await mkdtemp(join(tmpdir(), `arb-detail-${label}-`));
    await mkdir(join(dir, 'workspace'), { recursive: true });
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshot(...favbet)));
    await writeFile(join(dir, 'workspace', 'unibet_events.json'), JSON.stringify(snapshot(...unibet)));
    const { body } = await readEventDetailRoute(null, { searchParams: new URLSearchParams(QUERY) }, dir);
    await rm(dir, { recursive: true, force: true });
    return {
      favbet: body.events.find((e) => e.sourceId === 'favbet'),
      unibet: body.events.find((e) => e.sourceId === 'unibet'),
    };
  };

  // Two books of one event in different scopes: both must survive separately.
  const mixed = await detailFrom('mixed', [true, true], [false, false]);
  assert.equal(mixed.favbet.live, true, 'an in-play event is still in-play downstream');
  assert.equal(mixed.favbet.markets[0].live, true, 'and so is its market');
  assert.equal(mixed.unibet.live, false, 'a pre-match event is not marked');
  assert.equal(mixed.unibet.markets[0].live, false, 'and neither is its market');

  // The control that makes the two lines above mean something: the event flag
  // and the market flag are measured from different provider fields, so they can
  // disagree. A route that copied one onto the other would pass the first case
  // and be wrong here — a pre-match event header over a live price, or worse, a
  // live market silently downgraded because the event header was stale.
  const disagree = await detailFrom('disagree', [false, true], [true, false]);
  assert.equal(disagree.favbet.live, false, 'the event keeps its own scope');
  assert.equal(disagree.favbet.markets[0].live, true, 'and the market keeps its own, even when the event header disagrees');
  assert.equal(disagree.unibet.live, true);
  assert.equal(disagree.unibet.markets[0].live, false);

  // A snapshot with no `live` at all — what the 21 books that cannot measure it
  // emit — must not read as in-play.
  const unmeasured = await detailFrom('unmeasured', [undefined, undefined], [undefined, undefined]);
  assert.equal(unmeasured.favbet.live, false, 'an unmeasured event is not marked in-play');
  assert.equal(unmeasured.favbet.markets[0].live, false, 'and neither is its market');
});

// ---- /api/scrape/state ----------------------------------------------------

test('returns empty scrape state', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/scrape/state');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.state.status, 'idle');
  } finally { await closeServer(server); }
});

// ---- /api/alerts -----------------------------------------------------------

/** A scan service that publishes `findings`, or nothing at all. */
function withScan(findings, { published = true } = {}) {
  const services = stubServices();
  return {
    ...services,
    scanService: {
      ...services.scanService,
      async readPublishedScan() {
        return { scan: { ...emptyScan(), ...findings }, published };
      },
    },
  };
}

function alertOpportunity(overrides = {}) {
  return {
    sport: 'fotbal',
    league: 'Superliga',
    kickoff: '2026-05-01T18:00:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'Dinamo',
    marketKey: '1x2',
    eventKey: 'fotbal:superliga:fcsb-dinamo',
    live: false,
    roiPercent: 4,
    totalStake: 100,
    guaranteedProfit: 4,
    riskPercent: 0,
    verification: { status: 'confirmed' },
    legs: [{ sourceId: 'betano' }, { sourceId: 'fortuna' }],
    ...overrides,
  };
}

async function getAlerts(services) {
  const route = buildRouter({ ...services, rateLimiter: new RateLimiter({ capacity: 20, refillPerSec: 10 }) });
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/alerts');
    return { status: res.status, body: JSON.parse(res.body) };
  } finally { await closeServer(server); }
}

test('GET /api/alerts returns the settings and the signals they select', async () => {
  const { status, body } = await getAlerts(withScan({ opportunities: [alertOpportunity()] }));
  assert.equal(status, 200);
  // The settings are what the page renders its controls from, and the signals
  // are what it renders the list from. A route that returned only the settings
  // was what this route used to do: a control screen with nothing behind it.
  assert.ok(body.preferences, 'the preferences the page draws its controls from');
  assert.equal(typeof body.preferences.minRoiPercent, 'number');
  assert.ok(Array.isArray(body.alerts.arbitrages), '...and the alerts those settings select');
  assert.ok(Array.isArray(body.alerts.middles));
  assert.equal(body.counts.arbitrages, 1, 'the 4% signal clears the default 1% threshold');
  assert.equal(body.alerts.arbitrages[0].key, 'fotbal:superliga:fcsb-dinamo::1x2::arb');
  assert.equal(body.alerts.arbitrages[0].verified, 'confirmed');
  // Which run the list came from, so the page can date it.
  assert.equal(body.scan.eventCount, 0);
  assert.ok(body.scan.scrapedAt);
  assert.ok(body.evaluatedAt);
  assert.equal(body.schemaVersion, 1);
});

test('the route normalizes the settings it hands back', async () => {
  // The stub service returns `{}` — raw, un-normalized, exactly what a
  // hand-edited settings file or an older stored schema amounts to. The page
  // builds its input boxes out of this object, so an undefined threshold here
  // is an empty box that saves an empty box.
  const { body } = await getAlerts(withScan({}));
  assert.equal(typeof body.preferences.minRoiPercent, 'number');
  assert.equal(typeof body.preferences.cooldownSeconds, 'number');
  assert.deepEqual(body.preferences.channels, { desktop: true, sound: false });
  assert.equal(body.preferences.quietHours.from, '23:00');
  // ...and the thresholds the engine used are the same ones that came back.
  assert.equal(body.thresholds.minRoiPercent, body.preferences.minRoiPercent);
  assert.equal(body.thresholds.minMiddleRoiPercent, body.preferences.minMiddleRoiPercent);
  assert.equal(body.thresholds.includeLive, body.preferences.includeLive);
});

test('the threshold is applied to the scan, not just echoed back', async () => {
  const { body } = await getAlerts(withScan({
    opportunities: [alertOpportunity({ roiPercent: 0.5 })],
  }));
  // 0.5% is under the default 1%, so it is not an alert...
  assert.equal(body.counts.arbitrages, 0);
  assert.equal(body.thresholds.minRoiPercent, 1);
  // ...and the signal is still in the scan, it simply did not qualify. The
  // negative above only means something next to this one.
  const raised = await getAlerts(withScan({ opportunities: [alertOpportunity({ roiPercent: 1 })] }));
  assert.equal(raised.body.counts.arbitrages, 1, 'the same signal, exactly on the line');
});

test('an unpublished scan is reported as such, not as a quiet market', async () => {
  const { body } = await getAlerts(withScan({}, { published: false }));
  // An empty list with no explanation reads as "nothing worth your time right
  // now", which is a claim about the market. With no scan ever run there is no
  // such claim to make.
  assert.equal(body.published, false);
  assert.deepEqual(body.alerts.arbitrages, []);
  // The control: the same empty findings, with a scan behind them, is published.
  const scanned = await getAlerts(withScan({}));
  assert.equal(scanned.body.published, true);
  assert.deepEqual(scanned.body.alerts.arbitrages, [], '...and an honest empty list');
});

test('POST /api/alerts persists the settings and answers under them', async () => {
  const saved = [];
  const services = withScan({ opportunities: [alertOpportunity({ roiPercent: 4 })] });
  services.tracker = {
    ...services.tracker,
    async loadAlerts() { return { preferences: saved.length ? saved[saved.length - 1] : {} }; },
    async saveAlerts(p) { saved.push(p); return { preferences: p }; },
  };
  const route = buildRouter({ ...services, rateLimiter: new RateLimiter({ capacity: 20, refillPerSec: 10 }) });
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/alerts', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': csrfToken() },
      body: JSON.stringify({ preferences: { minRoiPercent: 10, cooldownSeconds: 30 } }),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(saved.length, 1, 'the settings reached storage');
    assert.equal(saved[0].minRoiPercent, 10);
    // The answer is evaluated under the settings just written, so the page does
    // not have to ask again to learn what it just set — and cannot render a
    // list computed under thresholds it is no longer showing.
    assert.equal(body.preferences.minRoiPercent, 10);
    assert.equal(body.thresholds.minRoiPercent, 10);
    assert.equal(body.counts.arbitrages, 0, 'a 4% signal no longer qualifies at 10%');
    // The bare-body form is accepted too, since that is what the client posts.
    const bare = await fetchOnce(server, '/api/alerts', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'x-arbiter-token': csrfToken() },
      body: JSON.stringify({ minMiddleRoiPercent: 40 }),
    });
    assert.equal(bare.status, 200);
    assert.equal(JSON.parse(bare.body).preferences.minMiddleRoiPercent, 40);
  } finally { await closeServer(server); }
});

test('POST /api/alerts is behind the same CSRF guard as every other mutation', async () => {
  const { route } = makeServer();
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/alerts', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, 'ECSRF');
  } finally { await closeServer(server); }
});

/**
 * GET /api/scrapers carries each book's measured live capability.
 *
 * The route already published the book list the scrape page draws, and it
 * published none of this. LIVE_EVIDENCE holds a verdict for 24 of the 26
 * registered jobs, 11 adapters already computed it and spread it into a
 * `coverage` object — and that object only ever became a log string, so the one
 * per-book fact that says whether a book can quote an in-play price at all
 * stopped there.
 *
 * Checked against the real config, because the join is the thing under test:
 * 26 jobs against a 24-row table, joined on job id, leaving exactly two jobs
 * with no evidence row. A fixture with three hand-written jobs could not have
 * produced that number, and could not have shown that both of the two are
 * disabled experiments.
 */
async function getScrapers() {
  const services = { ...stubServices(), configPath: REAL_CONFIG };
  const route = buildRouter({ ...services, rateLimiter: new RateLimiter({ capacity: 20, refillPerSec: 10 }) });
  const server = await startServer(route);
  try {
    const res = await fetchOnce(server, '/api/scrapers');
    return { status: res.status, body: JSON.parse(res.body) };
  } finally { await closeServer(server); }
}

test('GET /api/scrapers publishes a measured live capability per book', async () => {
  const { status, body } = await getScrapers();
  assert.equal(status, 200);
  const jobs = body.jobs;
  assert.ok(jobs.length >= 26, `the real registry should reach the route, got ${jobs.length}`);

  for (const job of jobs) {
    const c = job.liveCapability;
    assert.ok(c, `${job.id} has no liveCapability — the join dropped a book`);
    assert.equal(typeof c.measured, 'boolean', `${job.id}.measured is not a boolean`);
    assert.equal(typeof c.live, 'boolean', `${job.id}.live is not a boolean`);
    assert.equal(c.live, c.scope !== null, `${job.id}: live and scope disagree`);
    assert.equal(typeof c.started, 'number', `${job.id}.started is not a number`);
  }

  // The join, asserted against the evidence table rather than against a count:
  // a book with a row must come back measured, and one without must not.
  const withRow = jobs.filter((j) => Object.hasOwn(LIVE_EVIDENCE, j.id));
  const withoutRow = jobs.filter((j) => !Object.hasOwn(LIVE_EVIDENCE, j.id));
  assert.ok(withRow.length > 0, 'the control is empty: no job matched the evidence table');
  for (const j of withRow) assert.equal(j.liveCapability.measured, true, `${j.id} has a row but reads unmeasured`);
  for (const j of withoutRow) assert.equal(j.liveCapability.measured, false, `${j.id} has no row but reads measured`);
  for (const j of withRow) {
    assert.equal(j.liveCapability.field, LIVE_EVIDENCE[j.id].field, `${j.id}: the published field is not the measured one`);
    assert.equal(j.liveCapability.started, LIVE_EVIDENCE[j.id].started, `${j.id}: the published count is not the measured one`);
  }

  // The positive control for the whole surface: at least one book must actually
  // publish in-play, or the assertion above could pass over a table of nulls.
  const capable = jobs.filter((j) => j.liveCapability.live);
  assert.ok(capable.length >= 5, `expected the 5 measured books, got ${capable.length}: ${capable.map((j) => j.id).join(', ')}`);
  for (const j of capable) {
    assert.equal(typeof j.liveCapability.field, 'string', `${j.id} claims to go live without naming the field`);
    assert.ok(j.liveCapability.field.length > 0);
  }
});

test('the four filtered lists stay consistent once the capability is attached', async () => {
  const { body } = await getScrapers();
  const { jobs, enabledJobs, validatedJobs, experimentalJobs } = body;
  assert.equal(validatedJobs.length + experimentalJobs.length, jobs.length, 'the two groups no longer partition the list');
  for (const list of [enabledJobs, validatedJobs, experimentalJobs]) {
    for (const j of list) assert.ok(j.liveCapability, `a filtered list lost the capability on ${j.id}`);
  }
  assert.deepEqual(
    enabledJobs.map((j) => j.id).sort(),
    jobs.filter((j) => j.enabled !== false).map((j) => j.id).sort(),
    'enabledJobs is no longer the enabled subset',
  );
  assert.deepEqual(
    validatedJobs.map((j) => j.id).sort(),
    jobs.filter((j) => j.validationStatus === 'validated').map((j) => j.id).sort(),
    'validatedJobs is no longer the validated subset',
  );
});
