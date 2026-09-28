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
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { csrfToken, rotateCsrf } from '../src/shared/security.mjs';

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
      async readLatestScan() { return { opportunities: [], middles: [] }; },
      async readLatestCatalog() { return { markets: [] }; },
      async runScan() { return { opportunities: [], middles: [] }; },
    },
    aiService: null,
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
