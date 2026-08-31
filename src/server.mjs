/**
 * server.mjs — legacy monolith + standalone entrypoint.
 *
 * Same code runs as `npm start` (plain Node) and via Electron's BrowserView.
 * The modular wiring lives in server-modular.mjs; this file inlines the
 * shared helpers so the legacy path is self-contained.
 *
 * Why have both?
 *   - The modular split was done mid-project. server.mjs is the single file
 *     that "just works" if you can't load the modular entrypoint.
 *   - server-modular.mjs re-uses the same services but splits them into
 *     router.mjs / scrape-orchestrator.mjs / etc.
 *
 * Cross-cutting helpers that every module needs (sanitize*, csrf, security)
 * live here. The six new modules import them via `shared/security.mjs` and
 * `shared/sanitize.mjs` instead of from this file directly.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { csrfToken, assertLocalApiRequest, assertCsrf, buildCsp } from './shared/security.mjs';
import { sanitizeLogLine, sanitizeResult, sanitizeReport } from './shared/sanitize.mjs';
import { writeJsonAtomic, readJson } from './shared/atomic-write.mjs';
import { RateLimiter, rateLimitMiddleware } from './shared/rate-limit.mjs';
import { installShutdown } from './shared/graceful-shutdown.mjs';

import { StateBroadcaster } from './state-broadcaster.mjs';
import { ScrapeOrchestrator, resolveScanRequest, loadScraperJobs } from './scrape-orchestrator.mjs';
import { runScraperBatch, persistRunReport } from './scraper-service.mjs';
import { scanWorkspace, loadWorkspace } from './scanner/scanner.mjs';
import { buildMarketCatalog } from './scanner/market-catalog.mjs';
import { runVerificationPass, expireAutomaticConfirmations } from './verification.mjs';
import { TrackerService } from './tracker-service.mjs';
import { SchedulerService } from './scheduler-service.mjs';
import { CronService } from './cron-service.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.ARBITER_DATA_DIR || join(ROOT, 'data');
const PUBLIC_DIR = join(ROOT, 'public');
const CONFIG_PATH = join(ROOT, 'config', 'scrapers.json');
const PROFILES_PATH = join(ROOT, 'config', 'scan-profiles.json');
const PORT = Number(process.env.PORT || 3022);
const HOST = process.env.HOST || '127.0.0.1';

const logger = (level, msg) => {
  const ts = new Date().toISOString();
  const safe = sanitizeLogLine(msg);
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [${level}] ${safe}`);
};

// ---- bootstrap -------------------------------------------------------------

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(join(DATA_DIR, 'workspace'), { recursive: true });
await fs.mkdir(join(DATA_DIR, 'staging'), { recursive: true });
await fs.mkdir(join(DATA_DIR, 'backups'), { recursive: true });

const broadcaster = new StateBroadcaster();
broadcaster.start();

const orchestrator = new ScrapeOrchestrator({
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  broadcaster,
  logger,
});
await orchestrator.restoreState();

const tracker = new TrackerService({ dataDir: DATA_DIR, logger });
const scheduler = new SchedulerService({
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  orchestrator,
  logger,
});
await scheduler.loadState();

const cronService = new CronService({ logger });
cronService.start();

// ---- legacy scan + verify flow (used by /api/scan POST) --------------------

async function runScan(args) {
  return await scanWorkspace({ dataDir: DATA_DIR, ...args });
}

async function runFullVerification(args) {
  return await runVerificationPass(args.targets || [], args.baseScan, {
    dataDir: DATA_DIR,
    parallel: 12,
    logger,
  });
}

// ---- HTTP server -----------------------------------------------------------

const MAX_BODY = 1024 * 1024;
const rateLimiter = new RateLimiter({ capacity: 30, refillPerSec: 10 });
const limitCheck = rateLimitMiddleware(rateLimiter);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      assertLocalApiRequest(req);
    }
    const limit = limitCheck(req);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      res.setHeader('X-RateLimit-Remaining', '0');
      sendJson(res, 429, {
        error: {
          name: 'TooManyRequests',
          message: `rate limit exceeded; retry after ${limit.retryAfterMs}ms`,
          code: 'ERATELIMIT',
        },
      });
      return;
    }
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD' && url.pathname !== '/api/events';
    if (isWrite) assertCsrf(req);
    await dispatch(req, res, url);
  } catch (err) {
    const status = err.statusCode || 500;
    sendJson(res, status, {
      error: {
        name: err.name || 'Error',
        message: sanitizeLogLine(err.message || 'internal error'),
        code: err.code || 'EINTERNAL',
      },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Arbitrage dashboard: http://${HOST}:${PORT}/admin/scrape`);
  console.log(`Health probe:       http://${HOST}:${PORT}/api/health`);
});

server.on('error', (err) => {
  console.error('server error', err);
  process.exit(1);
});

// graceful shutdown — drains in-flight requests and stops background services
installShutdown({
  server,
  logger,
  tasks: [
    async () => { await scheduler.disable(); },
    () => broadcaster.stop(),
    () => cronService.stop(),
  ],
});

// ---- dispatcher ------------------------------------------------------------

async function dispatch(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  // read endpoints
  if (m === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true, uptimeSeconds: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
  if (m === 'GET' && p === '/api/csrf') return sendJson(res, 200, { token: csrfToken() });
  if (m === 'GET' && p === '/api/scrape/state') return sendJson(res, 200, { state: orchestrator.scrapeState || emptyState() });
  if (m === 'GET' && p === '/api/scan') {
    return sendJson(res, 200, await readJson(join(DATA_DIR, 'latest-scan.json'), {
      schemaVersion: 2,
      dataHealth: { status: 'empty', actionableSourceCount: 0, sources: {} },
      opportunities: [], middles: [], positiveEv: [], lowHold: [], sources: [], eventCount: 0,
    }));
  }
  if (m === 'GET' && p === '/api/catalog') return sendJson(res, 200, await readJson(join(DATA_DIR, 'latest-market-catalog.json'), {}));
  if (m === 'GET' && p === '/api/scrape-run') return sendJson(res, 200, await readJson(join(DATA_DIR, 'latest-scrape-run.json'), {}));
  if (m === 'GET' && p === '/api/scrapers') {
    const cfg = await readJson(CONFIG_PATH, { jobs: [] });
    return sendJson(res, 200, cfg);
  }
  if (m === 'GET' && p === '/api/profiles') {
    const cfg = await readJson(PROFILES_PATH, { profiles: [] });
    return sendJson(res, 200, cfg);
  }
  if (m === 'GET' && p === '/api/scheduler') return sendJson(res, 200, await scheduler.status());

  // SSE
  if (m === 'GET' && p === '/api/events') {
    broadcaster.add(res);
    return;
  }

  // write endpoints
  if (m === 'POST' && p === '/api/scrape') return await launchScrape(req, res);
  if (m === 'POST' && p === '/api/scrape/cancel') {
    const result = await orchestrator.cancel();
    return sendJson(res, result.cancelled ? 202 : 409, result);
  }
  if (m === 'POST' && p === '/api/scan') return await runScanPost(req, res);
  if (m === 'POST' && p === '/api/verify') return await runVerifyPost(req, res);
  if (m === 'POST' && p === '/api/scheduler') return await toggleScheduler(req, res);

  if (m === 'GET' && p === '/api/tracker') return sendJson(res, 200, await tracker.loadTracker());
  if (m === 'POST' && p === '/api/tracker') {
    const body = await parseBody(req);
    return sendJson(res, 201, await tracker.addBet(body));
  }
  if (m === 'GET' && p === '/api/tracker/export.csv') {
    const csv = await tracker.exportCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bet-tracker.csv"');
    return res.end(csv);
  }
  if (m === 'POST' && p === '/api/tracker/import') {
    const body = await parseBody(req);
    return sendJson(res, 200, await tracker.importCsv(body.csv || ''));
  }
  if (m === 'PUT' && p.startsWith('/api/tracker/')) {
    const id = decodeURIComponent(p.slice('/api/tracker/'.length));
    const body = await parseBody(req);
    const updated = await tracker.updateBet(id, body);
    if (!updated) return sendJson(res, 404, { error: { name: 'NotFound', code: 'ENOTFOUND', message: `bet ${id} not found` } });
    return sendJson(res, 200, updated);
  }
  if (m === 'DELETE' && p.startsWith('/api/tracker/')) {
    const id = decodeURIComponent(p.slice('/api/tracker/'.length));
    return sendJson(res, 200, await tracker.removeBet(id));
  }
  if (m === 'GET' && p === '/api/alerts') return sendJson(res, 200, await tracker.loadAlerts());
  if (m === 'POST' && p === '/api/alerts') {
    const body = await parseBody(req);
    return sendJson(res, 200, await tracker.saveAlerts(body.preferences || body));
  }
  if (m === 'GET' && p === '/api/ai/insights') {
    return sendJson(res, 200, { insights: await aiInsights() });
  }

  // static
  return await serveStatic(req, res, url);
}

// ---- handlers --------------------------------------------------------------

async function launchScrape(req, res) {
  const body = await parseBody(req);
  const bookIds = Array.isArray(body.bookIds) ? body.bookIds : [];
  const scanOptions = resolveScanRequest(body.scanOptions || {});
  try {
    const state = await orchestrator.launch({ bookIds, scanOptions });
    sendJson(res, 202, { state });
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'ELOCKED') {
      return sendJson(res, 409, { error: { name: err.name, message: err.message, code: err.code } });
    }
    throw err;
  }
}

async function runScanPost(req, res) {
  const body = await parseBody(req);
  const options = resolveScanRequest(body);
  const scan = await runScan({
    sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : null,
    bankroll: options.bankroll,
    minRoiPercent: options.minRoiPercent,
    maxMiddleRiskPercent: options.maxMiddleRiskPercent,
    minMiddleRoiPercent: options.minMiddleRoiPercent,
    includeLive: options.includeLive,
    includePast: options.includePast,
    publish: false,
  });
  sendJson(res, 200, scan);
}

async function runVerifyPost(req, res) {
  const body = await parseBody(req);
  const baseScan = await readJson(join(DATA_DIR, 'latest-scan.json'), null);
  if (!baseScan) return sendJson(res, 400, { error: { name: 'BadRequest', code: 'ENOSCAN', message: 'no latest-scan.json' } });
  const targets = Array.isArray(body.targets) ? body.targets : [...(baseScan.opportunities || [])];
  const result = await runFullVerification({ targets, baseScan });
  expireAutomaticConfirmations(baseScan);
  await writeJsonAtomic(join(DATA_DIR, 'latest-scan.json'), baseScan);
  sendJson(res, 200, result);
}

async function toggleScheduler(req, res) {
  const body = await parseBody(req);
  if (body.enabled === false) return sendJson(res, 200, await scheduler.disable());
  return sendJson(res, 200, await scheduler.enable({
    bookIds: Array.isArray(body.bookIds) ? body.bookIds : [],
    scanOptions: resolveScanRequest(body.scanOptions || {}),
    intervalMinutes: body.intervalMinutes,
  }));
}

async function aiInsights() {
  const scan = await readJson(join(DATA_DIR, 'latest-scan.json'), null);
  if (!scan) return [];
  const out = [];
  for (const o of scan.opportunities || []) {
    out.push({
      type: 'arb',
      eventKey: o.eventKey,
      marketKey: o.marketKey,
      message: `${o.homeTeam} vs ${o.awayTeam} — ${o.marketKey} arb at ${o.roiPercent}%`,
      books: (o.legs || []).map((l) => l.sourceId),
    });
  }
  return out;
}

// ---- helpers ---------------------------------------------------------------

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

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', buildCsp());
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
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
        resolve(JSON.parse(raw));
      } catch (_err) {
        const e = new Error('invalid JSON body');
        e.statusCode = 400;
        e.code = 'EBADJSON';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(_req, res, url) {
  let p = url.pathname;
  if (p === '/' || p === '') p = '/index.html';
  const safe = resolve(PUBLIC_DIR, '.' + p);
  if (!safe.startsWith(resolve(PUBLIC_DIR))) {
    return sendJson(res, 403, { error: { name: 'Forbidden', code: 'EFORBIDDEN', message: 'path traversal' } });
  }
  try {
    const data = await fs.readFile(safe);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(safe));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', buildCsp());
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('not found');
    }
    res.statusCode = 500;
    res.end('error');
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

export {
  server,
  broadcaster,
  orchestrator,
  scheduler,
  tracker,
  runScan,
  runFullVerification,
};

// allow `node --test` import to skip listen():
if (process.env.ARBITER_NO_LISTEN === '1') {
  server.close();
}

// silence unused-import warning for legacy exports
void sanitizeResult;
void sanitizeReport;
void runScraperBatch;
void persistRunReport;
void buildMarketCatalog;
void loadWorkspace;
void loadScraperJobs;
