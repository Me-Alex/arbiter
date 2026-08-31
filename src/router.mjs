import { extname, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { csrfToken, assertLocalApiRequest, assertCsrf } from './shared/security.mjs';
import { sanitizeLogLine } from './shared/sanitize.mjs';
import { RateLimiter, rateLimitMiddleware } from './shared/rate-limit.mjs';
import { resolveScanRequest } from './scrape-orchestrator.mjs';

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
    tracker,
    broadcaster,
    scanService,
    aiService = null,
    logger = () => {},
    rateLimiter = new RateLimiter({ capacity: 30, refillPerSec: 10 }),
  } = ctx;

  const limitCheck = rateLimitMiddleware(rateLimiter);

  const handlers = {
    'GET /api/health': () => sendJson(null, 200, {
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
    'GET /api/csrf': () => sendJson(null, 200, { token: csrfToken() }),
    'GET /api/scrape/state': () => sendJson(null, 200, { state: orchestrator.scrapeState || emptyState() }),
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
    'GET /api/scan': async () => sendJson(null, 200, await scanService.readLatestScan(dataDir)), 
    'POST /api/scan': async (req) => {
      const body = await parseBody(req);
      const options = resolveScanRequest(body);
      const scan = await scanService.runScan({
        dataDir,
        sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : null,
        bankroll: options.bankroll,
        minRoiPercent: options.minRoiPercent,
        maxMiddleRiskPercent: options.maxMiddleRiskPercent,
        minMiddleRoiPercent: options.minMiddleRoiPercent,
        includeLive: options.includeLive,
        includePast: options.includePast,
        publish: false,
      });
      return sendJson(null, 200, scan);
    },
    'GET /api/catalog': async () => sendJson(null, 200, await scanService.readLatestCatalog(dataDir) || {}),
    'GET /api/scrapers': async () => {
      const { promises: fsp } = await import('node:fs');
      const raw = await fsp.readFile(configPath, 'utf8').catch(() => '{"jobs":[]}');
      const cfg = JSON.parse(raw);
      return sendJson(null, 200, { jobs: Array.isArray(cfg.jobs) ? cfg.jobs : [] });
    },
    'GET /api/profiles': async () => {
      const { promises: fsp } = await import('node:fs');
      const raw = await fsp.readFile(profilesPath, 'utf8').catch(() => '{"profiles":[]}');
      const cfg = JSON.parse(raw);
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
    'GET /api/alerts': async () => sendJson(null, 200, await tracker.loadAlerts()),
    'POST /api/alerts': async (req) => {
      const body = await parseBody(req);
      return sendJson(null, 200, await tracker.saveAlerts(body.preferences || body));
    },
    'GET /api/ai/insights': async () => sendJson(null, 200, { insights: aiService ? await aiService.generate() : [] }),
    'GET /api/events': (_req, res) => {
      if (!broadcaster) {
        return sendJson(res, 503, { error: { name: 'Unavailable', message: 'sse disabled', code: 'ENOSSE' } });
      }
      broadcaster.add(res);
      return null;
    },
  };

  return async function route(req, res, parsedUrl) {
    try {
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
      const status = err.statusCode || 500;
      logger('error', `route ${req.method} ${parsedUrl.pathname}: ${err.message}`);
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

async function serveStatic(_req, res, parsedUrl, { publicDir }) {
  let p = parsedUrl.pathname;
  if (p === '/' || p === '') p = '/index.html';
  const safe = resolve(publicDir, '.' + p);
  if (!safe.startsWith(resolve(publicDir))) {
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
