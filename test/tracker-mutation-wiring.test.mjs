// test/tracker-mutation-wiring.test.mjs — PUT /api/tracker/:id and DELETE
// /api/tracker/:id, the two mutate-by-row routes the analytics page's bet
// table drives.
//
// Measured before this file existed, over the tree as it stands:
//
//   - The page wires both (public/js/pages/analytics.js:153,155): a row is
//     marked won or lost through `arbiterApi.put('/api/tracker/<id>',
//     { status })` and deleted through `arbiterApi.del('/api/tracker/<id>')`.
//   - test/write-request-census.test.mjs:160-161 pins those two consumers as
//     strings — the page half only.
//   - test/router.test.mjs:56-57 stubs the tracker (`updateBet() { return
//     null }`, `removeBet() { return { ok: true } }`), and does not request
//     either route: the router's PUT/DELETE dispatch branches
//     (src/router.mjs:371-387) were never reached over a socket by any test.
//     test/tracker-service.test.mjs round-trips the service in process.
//
// So the tie the two routes exist for — a click on a row changing what the
// stored document says — was asserted by nobody. This file pins it over the
// router that really serves the routes and the real TrackerService: a bet
// added through the same POST the page uses is marked through PUT and checked
// on disk, and deleted through DELETE and checked again.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import { TrackerService } from '../src/tracker-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { rotateCsrf } from '../src/shared/security.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The bet the page's rows act on: enough fields to normalize clean. */
const NEW_BET = {
  eventKey: 'liga-1::fcsb|universitatea',
  marketKey: 'MATCH_ODDS',
  selection: 'FCSB',
  sourceId: 'superbet',
  odds: 2.35,
  stake: 50,
};

/**
 * The router with the real TrackerService, over a socket. Everything else the
 * router might ask of a service is absent exactly as in
 * tracker-export-wiring.test.mjs: these two routes touch only the tracker.
 */
async function serve() {
  const dataDir = await mkdtemp(join(tmpdir(), 'arb-tracker-mut-'));
  const tracker = new TrackerService({ dataDir, logger: () => {} });
  const route = buildRouter({
    dataDir,
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    tracker,
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
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    tracker,
    /** The row actions are CSRF-guarded, so the token is rotated per request. */
    authHeaders: () => ({ Host: '127.0.0.1', 'x-arbiter-token': rotateCsrf(), 'content-type': 'application/json' }),
    /** A bet added the way the page adds one: POST /api/tracker. */
    async addBet(body = NEW_BET) {
      const res = await fetch(`${base}/api/tracker`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
    async put(path, body) {
      const res = await fetch(`${base}${path}`, {
        method: 'PUT',
        headers: this.authHeaders(),
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async del(path) {
      const res = await fetch(`${base}${path}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/* ── the write path: a click on a row changes the stored document ────────── */

test('the won/lost click the page sends lands on the row and on disk', async () => {
  const srv = await serve();
  try {
    const added = await srv.addBet();
    assert.equal(added.status, 201, `the add answered ${added.status}`);
    const { id } = added.json;
    assert.ok(id, 'no id came back for the added bet');

    // The exact request analytics.js:155 makes when a row is marked: the only
    // key the page posts is `status`.
    const { status, json } = await srv.put(`/api/tracker/${encodeURIComponent(id)}`, { status: 'won' });
    assert.equal(status, 200, `the route answered ${status}`);
    assert.equal(json.status, 'won', `the route answered status ${json.status} for a posted 'won'`);
    // Identity preserved: a patch that re-keyed the row would orphan every
    // later action the page takes on it.
    assert.equal(json.id, id, 'the answered row is not the row that was patched');

    // The write really happened: the file, not only the answer. This is the
    // half a stubbed tracker (test/router.test.mjs:56) can never show.
    const stored = await srv.tracker.loadTracker();
    const row = stored.items.find((b) => b.id === id);
    assert.ok(row, 'the patched row is not in the stored document');
    assert.equal(row.status, 'won', 'the stored row did not keep the posted status');
    assert.ok(row.updatedAt, 'the patch left no updatedAt stamp on the row');
  } finally {
    await srv.close();
  }
});

test('a patch naming a row that is not there answers 404, not 200', async () => {
  const srv = await serve();
  try {
    // The router compares the patched row the service hands back
    // (src/router.mjs:376-378): null means no such bet. A route that answered
    // 200 here would have the page render a row that exists nowhere.
    const { status, json } = await srv.put('/api/tracker/bet-does-not-exist', { status: 'won' });
    assert.equal(status, 404, `the route answered ${status} for a missing bet`);
    assert.equal(json.error.code, 'ENOTFOUND', `the route answered code ${json.error?.code}`);
    assert.match(json.error.message, /bet-does-not-exist/,
      'the 404 does not name the id the page asked about');
  } finally {
    await srv.close();
  }
});

test('the delete click the page sends removes the row from the stored document', async () => {
  const srv = await serve();
  try {
    const added = await srv.addBet();
    const { id } = added.json;

    // analytics.js:153: a bare DELETE on the row's path, no body.
    const { status, json } = await srv.del(`/api/tracker/${encodeURIComponent(id)}`);
    assert.equal(status, 200, `the route answered ${status}`);
    assert.deepEqual(json.items, [], 'the answered document still holds the deleted row');

    const stored = await srv.tracker.loadTracker();
    assert.deepEqual(stored.items.map((b) => b.id), [],
      'the stored document still holds the deleted row');
    assert.ok(stored.updatedAt, 'the delete left no updatedAt stamp on the document');
  } finally {
    await srv.close();
  }
});

/* ── the contract: the keys the page posts are the keys the service writes ── */

test('every key the page posts with a won/lost click is one the service accepts', async () => {
  // Measured out of the page: the body object of the arbiterApi.put call,
  // sliced by brace depth — the first `)` in the call belongs to
  // encodeURIComponent(id), so a cut there never reaches the body.
  const page = read('public/js/pages/analytics.js');
  const at = page.indexOf("arbiterApi.put('/api/tracker/'");
  assert.notEqual(at, -1, 'the page lost its arbiterApi.put tracker call — this test pins it');
  const open = page.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < page.length; end++) {
    if (page[end] === '{') depth++;
    else if (page[end] === '}') { depth--; if (depth === 0) break; }
  }
  const body = page.slice(open + 1, end);
  const posted = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);

  // Measured out of the service: the patch allow-list (tracker-service.mjs:225).
  const service = read('src/tracker-service.mjs');
  const allowed = /'eventKey',\s*'marketKey',\s*'selection',\s*'sourceId',\s*'odds',\s*'stake',\s*'status',\s*'notes',\s*'provenance'/
    .exec(service);
  assert.ok(allowed, 'the service no longer spells out allowedBetPatch — this test pins it');
  const allowedKeys = allowed[0].split(',').map((k) => k.trim().replace(/'/g, ''));

  assert.deepEqual(posted.filter((k) => !allowedKeys.includes(k)), [],
    `the page posts ${posted.join(', ')} and the service accepts only ${allowedKeys.join(', ')}`);
  assert.ok(posted.includes('status'), 'the page no longer posts status with a won/lost click');
});

/* ── the consumer pin: who asks, measured from the page ──────────────────── */

test('both row actions the router serves are the ones the page drives', () => {
  const page = read('public/js/pages/analytics.js');
  // Each dynamic branch has exactly one live caller on the page.
  const puts = [...page.matchAll(/arbiterApi\.put\('\/api\/tracker\/'/g)];
  const dels = [...page.matchAll(/arbiterApi\.del\('\/api\/tracker\/'/g)];
  assert.equal(puts.length, 1, `the page drives the PUT branch ${puts.length} times`);
  assert.equal(dels.length, 1, `the page drives the DELETE branch ${dels.length} times`);
  // The paths are built from an encoded id — the branch slices the path after
  // '/api/tracker/', so an unencoded id would be sliced into its %XX escapes.
  assert.match(page, /arbiterApi\.put\('\/api\/tracker\/' \+ encodeURIComponent\(id\)/,
    'the PUT path is no longer built from an encoded id');
  assert.match(page, /arbiterApi\.del\('\/api\/tracker\/' \+ encodeURIComponent\(id\)/,
    'the DELETE path is no longer built from an encoded id');
});
