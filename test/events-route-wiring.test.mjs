// test/events-route-wiring.test.mjs — GET /api/events, the SSE route nine
// pages read through public/js/sse.js.
//
// The channel itself was already measured from both ends: test/events-channel-
// census.test.mjs drives a real scrape through a real StateBroadcaster and
// censuses the frames off the bytes, and measures the subscriber set by running
// sse.js in a vm. What that census never does — because it writes into a fake
// response — is ask the route over a socket. So the one contract nothing holds
// is the route's own: that a client that connects gets a stream it can parse,
// that a frame the server broadcasts arrives whole at `JSON.parse(e.data)`,
// and that a server built without the broadcaster says so instead of hanging.
//
// This file holds exactly those. The broadcaster is the real StateBroadcaster,
// the frames it emits are the ones the orchestrator emits, and the client is a
// plain fetch reading the response body — the same bytes a browser's
// EventSource would receive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { buildRouter } from '../src/router.mjs';
import { StateBroadcaster } from '../src/state-broadcaster.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const sseSource = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');

/**
 * The router over a socket, with the real broadcaster the route hands clients
 * to. `withBroadcaster: false` builds the server the way one runs with SSE
 * disabled.
 */
async function serve(withBroadcaster = true) {
  const broadcaster = withBroadcaster ? new StateBroadcaster() : null;
  const route = buildRouter({
    dataDir: 'unused',
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    scanService: { async readLatestScan() { return {}; }, async readLatestCatalog() { return null; } },
    orchestrator: { scrapeState: { status: 'idle', jobs: [] } },
    scheduler: { status: async () => ({}) },
    live: { status: async () => ({}) },
    tracker: {},
    broadcaster,
    rateLimiter: new RateLimiter({ capacity: 500, refillPerSec: 500 }),
    logger: () => {},
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    Promise.resolve(route(req, res, url)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    broadcaster,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Read the response body until the stream yields a frame of `type`. */
async function readFrame(res, type, timeoutMs = 4000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split('\n\n')) {
        const event = new RegExp(`^event: ${type}$`, 'm').exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (event && data) return { block, payload: JSON.parse(data[1]) };
      }
      if (Date.now() > deadline) return null;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

/* ── the open side: what a connecting client is answered ─────────────────── */

test('the route answers a client with an SSE stream, not a document', async () => {
  const srv = await serve();
  try {
    const res = await fetch(`${srv.base}/api/events`);
    assert.equal(res.status, 200, `the route answered ${res.status}`);
    // The header a browser's EventSource checks before it will parse a frame:
    // without it the connection opens and no event ever fires.
    assert.match(res.headers.get('content-type') || '', /^text\/event-stream/,
      `the route answered content-type ${res.headers.get('content-type')}`);
    // And the first bytes are the retry hint add() writes before any frame —
    // proof the response really went through the broadcaster rather than being
    // buffered whole by the router. A race guard keeps a regression that stops
    // writing from hanging the suite instead of failing it.
    const reader = res.body.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    const text = first && first.value ? new TextDecoder().decode(first.value) : '';
    assert.match(text, /^retry: 5000/, 'the first bytes on the stream are not the retry hint add() writes');
    await reader.cancel().catch(() => {});
  } finally {
    await srv.close();
  }
});

test('a frame the server broadcasts reaches the client whole, as the page parses it', async () => {
  const srv = await serve();
  try {
    // The payload scrape-orchestrator.mjs:341 broadcasts on `scan-update`: the
    // four counts, nothing else. analytics.js:470 re-runs init() on it, so a
    // frame that lost its keys on the way would repaint with zero rows.
    const payload = { opportunities: 3, middles: 1, positiveEv: 2, lowHold: 0 };
    const res = await fetch(`${srv.base}/api/events`);
    assert.equal(res.status, 200, `the route answered ${res.status}`);
    // The route registered this response with the broadcaster synchronously,
    // so by the time fetch has answered the client is on the list. Emit now.
    const frame = readFrame(res, 'scan-update');
    srv.broadcaster.broadcast('scan-update', payload);
    const got = await frame;
    assert.ok(got, 'the scan-update frame never reached the client');
    // What sse.js:17 does with the bytes: JSON.parse(e.data). If the route or
    // the broadcaster mangled the line, this is where it fails rather than in
    // nine pages' handlers.
    assert.deepEqual(got.payload, payload,
      'the frame the client parsed is not the frame the server broadcast');
  } finally {
    await srv.close();
  }
});

/* ── the disabled side: a server with no broadcaster says so ─────────────── */

test('a server built without the broadcaster answers 503 ENOSSE, not a hang', async () => {
  const srv = await serve(false);
  try {
    const res = await fetch(`${srv.base}/api/events`);
    assert.equal(res.status, 503, `the route answered ${res.status} on a server with no broadcaster`);
    const json = await res.json();
    assert.equal(json.error.code, 'ENOSSE', `the route answered error code ${json.error?.code}`);
    assert.equal(json.error.name, 'Unavailable');
  } finally {
    await srv.close();
  }
});

/* ── the consumer pin: who asks, measured from the client ─────────────────── */

test('the client the pages load asks this route and subscribes to what the server emits', () => {
  // The one URL sse.js connects to.
  assert.match(sseSource, /new EventSource\('\/api\/events'\)/,
    'sse.js no longer connects to /api/events — this test pins the client');
  // The frames it dispatches, which is what the census measures against the
  // producer; pinned here so a route-side change to one of these types cannot
  // silently strand a page.
  for (const type of ['scrape-update', 'scan-update', 'verify-start', 'verify-end']) {
    assert.ok(new RegExp(`addEventListener\\('${type}'`).test(sseSource),
      `sse.js no longer listens for ${type}`);
  }
});
