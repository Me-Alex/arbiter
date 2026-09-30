/**
 * diagnostic-routes.test.mjs — contract for /api/snapshot/:sourceId and
 * /api/odds/:sourceId.
 *
 * These are the only two routes in the dispatcher that are reached by a
 * `startsWith` branch rather than by a handler-table key, and neither had a
 * single test. A `startsWith` line that was deleted or retyped would leave the
 * handler exported, intact and unreachable, and every other test in the repo
 * would stay green — so these go through the real server rather than calling
 * the handlers directly, which is the only way the dispatch is measured at all.
 *
 * They are also the only two routes with no consumer in the frontend and no
 * entry in the README. That is a deliberate shape, not an accident: the event
 * page renders the same fields through /api/event-detail, which resolves an
 * event through a heuristic matcher, and a route that bypasses the matcher is
 * the only way to audit the matcher itself. docs/no-arbitrage-root-cause.md
 * records exactly that use. What was missing was any statement of it anywhere
 * the next reader would look, and any proof the projection still holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import { emptyScan } from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

/** One book, one event, two markets, carrying the fields both routes project. */
function snapshotFor({ eventLive, marketLive, capturedAt = '2026-10-01T10:00:00.000Z' } = {}) {
  return {
    schemaVersion: 2,
    sourceId: 'favbet',
    runId: 'run-diag',
    capturedAt,
    // Not projected by either route. Present so a test that asserted "the
    // whole file" could not pass by accident on a projection.
    transport: 'test-feed',
    events: [{
      id: 'ev-1',
      eventKey: 'fotbal::liga-1::fcsb|dinamo',
      sport: 'Football',
      league: 'Liga 1',
      kickoff: '2026-10-01T12:00:00.000Z',
      homeTeam: 'FCSB',
      awayTeam: 'Dinamo',
      sourceUrl: 'https://favbet.example/e/1',
      live: eventLive,
      markets: [
        { key: 'MATCH_ODDS', name: '1X2', live: marketLive, selections: [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.4 }] },
        { key: 'OVER_UNDER_25', name: 'O/U 2.5', selections: [{ name: 'Over', odds: 1.9 }] },
      ],
    }],
  };
}

function stubServices(dataDir) {
  return {
    dataDir,
    publicDir: dataDir,
    configPath: join(dataDir, 'scrapers.json'),
    profilesPath: join(dataDir, 'profiles.json'),
    orchestrator: {
      scrapeState: { status: 'idle', jobs: [], books: [], options: {}, summary: null, currentStep: null, currentActivity: null },
      async launch() { return this.scrapeState; },
      async cancel() { return { cancelled: true }; },
    },
    scheduler: {
      async status() { return { enabled: false, intervalMinutes: 15 }; },
      async enable() { return { enabled: true }; },
      async disable() { return { enabled: false }; },
    },
    tracker: {
      async loadTracker() { return { items: [] }; },
      async loadAlerts() { return { preferences: {} }; },
      async saveAlerts(p) { return { preferences: p }; },
    },
    broadcaster: { add() {}, stop() {}, count() { return 0; } },
    scanService: {
      async readPublishedScan() { return { scan: emptyScan(), published: true }; },
      async readLatestScan() { return emptyScan(); },
      async readLatestCatalog() { return { markets: [] }; },
      async runScan() { return emptyScan(); },
    },
    logger: () => {},
    // The default limiter in the router is capacity 30 / refill 10 per second.
    // The clamp cases below fire a dozen requests in one test, which is enough
    // to trip it and turn every assertion into a 429 — a rate-limit failure
    // masquerading as a projection failure.
    rateLimiter: new RateLimiter({ capacity: 500, refillPerSec: 500 }),
  };
}

function startServer(services) {
  const route = buildRouter(services);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      Promise.resolve(route(req, res, url)).catch(() => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function request(server, path, method = 'GET') {
  const { port } = server.address();
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const get = (server, path) => request(server, path, 'GET');

/**
 * A fresh dataDir per call, with `favbet` seeded.
 *
 * A fresh directory is not tidiness: readEventDetailRoute caches parsed
 * snapshots per directory, so a shared one would serve the previous case's
 * fixture and let a projection assertion pass on the wrong bytes.
 */
async function withSeeded(label, fn) {
  const dir = await mkdtemp(join(tmpdir(), `arb-diag-${label}-`));
  await mkdir(join(dir, 'workspace'), { recursive: true });
  const server = await startServer(stubServices(dir));
  try {
    return await fn({ dir, server, get: (p) => get(server, p) });
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- /api/snapshot/:sourceId ------------------------------------------------

test('the snapshot route returns the file unprojected, and reaches the handler', async () => {
  const snap = snapshotFor({ eventLive: true, marketLive: true });
  await withSeeded('verbatim', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snap));

    const res = await get('/api/snapshot/favbet');

    // The control for every rejection below: the same dispatch, the same
    // directory, a file that is there. If this fails, the 400s and 404s in the
    // other cases prove nothing.
    assert.equal(res.status, 200, 'a present snapshot must be served');
    assert.deepEqual(
      JSON.parse(JSON.stringify(res.body)),
      JSON.parse(JSON.stringify(snap)),
      'the snapshot route is the ground truth: every key survives, including the ones no projection wants',
    );
    assert.equal(res.body.transport, 'test-feed', 'unprojected means unprojected, not "the fields we happened to copy"');
  });
});

test('the snapshot route refuses anything that is not a bare slug', async () => {
  await withSeeded('badid', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    // The target a traversal attempt is aiming at. Written so that a regex
    // which failed to reject "../latest-scan" would actually serve something
    // rather than 404-ing for an unrelated reason and passing the test.
    await writeFile(join(dir, 'latest-scan.json'), JSON.stringify({ id: 'scan-secret' }));

    // %2F so the client does not normalize the path away before it is routed.
    for (const bad of ['..%2Flatest-scan', '_leading', 'has%20space', 'UPPER.ok', 'dot.', '']) {
      const res = await get(`/api/snapshot/${bad}`);
      assert.equal(res.status, 400, `"${bad}" must not be accepted as a source id`);
      assert.equal(res.body?.error?.code, 'EBADID', `"${bad}" must be refused by the id check, not by a missing file`);
    }

    // Control: the sibling that IS a bare slug still answers, in the same
    // directory, after all six rejections.
    const ok = await get('/api/snapshot/favbet');
    assert.equal(ok.status, 200, 'the refusals above are the id check, not a broken route');
  });
});

test('a missing snapshot is 404 and a corrupt one is 500, and both are distinguished', async () => {
  await withSeeded('missing', async ({ dir, get }) => {
    const res = await get('/api/snapshot/never-scraped');
    assert.equal(res.status, 404, 'a book that has never run has no snapshot');
    assert.equal(res.body?.error?.code, 'ENOTFOUND');

    // The control: a valid book in the same directory still reads.
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    assert.equal((await get('/api/snapshot/favbet')).status, 200);
  });

  await withSeeded('corrupt', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), '{ not json at all');
    const res = await get('/api/snapshot/favbet');
    // A truncated write must not read as "no data" — that is the one answer a
    // debug route must never give, because it is indistinguishable from the
    // book having nothing to offer.
    assert.equal(res.status, 500, 'corrupt JSON is a server-side data fault, not a missing file');
    assert.equal(res.body?.error?.code, 'EINVALID');
  });
});

test('the snapshot route is GET-only: any other method falls through to 404', async () => {
  await withSeeded('method', async ({ dir, server, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    const res = await get('/api/snapshot/favbet');
    assert.equal(res.status, 200, 'control: GET is served');

    // The dispatch guards on `req.method === 'GET'` before the startsWith, so
    // a write verb must not reach a read handler. No CSRF token is sent: a
    // verb that reached the handler table would be turned away by the token
    // check, and this is here to prove the startsWith branch is skipped
    // entirely rather than reached and refused.
    //
    // Both routes, because the guard is written out twice — the snapshot
    // branch is covered here and the odds branch was not, which is exactly
    // the kind of half-measure a mutation run is for.
    for (const path of ['/api/snapshot/favbet', '/api/odds/favbet']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await request(server, path, method);
        assert.equal(res.status, 404, `${method} ${path} must not be served by a read-only route`);
        assert.equal(res.body?.error?.code, 'ENOTFOUND', `${method} ${path} falls through to the static handler, not to the route`);
      }
    }
  });
});

// ---- /api/odds/:sourceId ----------------------------------------------------

test('the odds route projects exactly the agreed fields, and no others', async () => {
  await withSeeded('project', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor({ eventLive: false, marketLive: false })));

    const res = await get('/api/odds/favbet');
    assert.equal(res.status, 200);
    assert.equal(res.body.sourceId, 'favbet', 'the caller learns which book it asked about');
    assert.equal(res.body.results.length, 2, 'one row per market, so a market filter has something to remove');

    // Named outright rather than compared against a second projection: two
    // shapes compared to each other cannot notice a field that vanished from
    // both, which is how `id` could have been added or dropped unnoticed.
    const EXPECTED_EVENT_FIELDS = ['awayTeam', 'eventKey', 'homeTeam', 'id', 'kickoff', 'league', 'live', 'market', 'sport'];
    const EXPECTED_MARKET_FIELDS = ['key', 'live', 'name', 'selections'];

    assert.deepEqual(Object.keys(res.body.results[0]).sort(), EXPECTED_EVENT_FIELDS);
    assert.deepEqual(Object.keys(res.body.results[0].market).sort(), EXPECTED_MARKET_FIELDS);
    // The name is the catalog's label, falling back to the key when the
    // adapter did not write one. Asserted as a value, not just as a present
    // key: a route that projected `name: market.key` would pass every key
    // check above and label a market "MATCH_ODDS" where the catalog calls it
    // "1X2" — the same string twice, which reads as agreement.
    assert.equal(res.body.results[0].market.name, '1X2', 'the market keeps the label the adapter gave it');
    assert.equal(
      res.body.results.find((r) => r.market.key === 'OVER_UNDER_25').market.name,
      'O/U 2.5',
      'and a second label is not overwritten by the first market’s',
    );
    // The selections are passed through, not reshaped: the engine reads these
    // objects as the scrapers wrote them, and a projection that copied them
    // would quietly fork the odds shape the rest of the app depends on.
    assert.deepEqual(res.body.results[0].market.selections, [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.4 }]);
  });
});

test('a market with no label falls back to its key, because the column needs something', async () => {
  await withSeeded('noname', async ({ dir, get }) => {
    // Not every adapter writes `name` on every market. An empty cell in a
    // price table is worse than a redundant one, so the key stands in — and
    // the fallback has to be a real branch, not a truthiness test that never
    // fires because every fixture happens to carry a name.
    const snap = snapshotFor();
    snap.events[0].markets = [{ key: 'BTTS', selections: [{ name: 'Yes', odds: 1.7 }] }];
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snap));

    const res = await get('/api/odds/favbet');
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].market.name, 'BTTS', 'the key stands in for the label the adapter omitted');
  });
});

test('the odds route answers with the book it was asked about, not the one the file claims', async () => {
  await withSeeded('whichbook', async ({ dir, get }) => {
    // The file is named for the book it holds, and the caller asked for that
    // name. If the two ever disagree the caller has still asked about the
    // name it used, and a response that named the file's own idea instead
    // would send a debug session after the wrong book — the one symptom these
    // routes exist to chase.
    const snap = snapshotFor();
    snap.sourceId = 'whatever-the-adapter-wrote';
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snap));

    const res = await get('/api/odds/favbet');
    assert.equal(res.status, 200);
    assert.equal(res.body.sourceId, 'favbet', 'the response names the book that was requested');
  });
});

test('the odds route keeps the in-play flag on the event and on each market', async () => {
  // This route projects `market.selections` out of the same snapshots that
  // readEventDetailRoute reads, and that route keeps `live` for a recorded
  // reason: an unmarked price list reads as a pre-match one, which is a
  // different and calmer thing than the signal the reader asked for. This
  // route dropped it, so the same book quoted twice — once per route — gave
  // two different answers about whether the price was moving.
  const mixed = async (label, eventLive, marketLive) => withSeeded(label, async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor({ eventLive, marketLive })));
    const { body } = await get('/api/odds/favbet');
    return body.results[0];
  });

  assert.equal((await mixed('odds-live', true, true)).live, true, 'an in-play event is still in-play here');
  assert.equal((await mixed('odds-live', true, true)).market.live, true, 'and so is its market');

  // The control that gives the two lines above their meaning: the event flag
  // and the market flag are measured from different provider fields, so a
  // route that copied one onto the other passes the first case and is wrong
  // here — a pre-match event header over a live price, or a live market
  // silently downgraded because the event header was stale.
  const disagree = await mixed('odds-disagree', false, true);
  assert.equal(disagree.live, false, 'the event keeps its own scope');
  assert.equal(disagree.market.live, true, 'and the market keeps its own, even when the event header disagrees');

  // What the 21 books that cannot measure it emit: absent, not false-only.
  const unmeasured = await mixed('odds-unmeasured', undefined, undefined);
  assert.equal(unmeasured.live, false, 'an unmeasured event must not read as in-play');
  assert.equal(unmeasured.market.live, false, 'nor an unmeasured market');
});

test('the odds route filters by eventKey and by marketKey, case-insensitively', async () => {
  await withSeeded('filters', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    const key = 'fotbal::liga-1::fcsb|dinamo';

    const byEvent = await get(`/api/odds/favbet?eventKey=${encodeURIComponent(key)}`);
    assert.equal(byEvent.status, 200);
    assert.equal(byEvent.body.results.length, 2, 'the one matching event contributes both markets');

    const missed = await get(`/api/odds/favbet?eventKey=${encodeURIComponent('fotbal::liga-1::nope|x')}`);
    assert.deepEqual(missed.body.results, [], 'a key no event carries yields no rows, not an error');
    assert.equal(missed.status, 200, 'an empty match is a fact, not a failure');

    // Case-insensitive on the market key, because the catalog writes them in
    // two cases across the codebase and a diagnostic route that rejected one
    // spelling would fail exactly when someone is debugging a key mismatch.
    const upper = await get('/api/odds/favbet?marketKey=OVER_UNDER_25');
    const lower = await get('/api/odds/favbet?marketKey=over_under_25');
    assert.equal(upper.body.results.length, 1);
    assert.equal(lower.body.results.length, 1, 'the key match must not depend on how the caller spelled it');
    assert.equal(upper.body.results[0].market.key, 'OVER_UNDER_25', 'and the stored spelling comes back, not the query one');
  });
});

test('a market key stored in the other case is still findable', async () => {
  // The mutation run earned this one. Every other fixture in the file spelled
  // its market keys in upper case, which made the route's uppercasing of the
  // *stored* value look redundant — uppercasing only the query was enough.
  // It is not: the Altenar family writes lower-case keys (`asian_handicap`,
  // `tgoals`, `btts` — src/scrapers/altenar-public.mjs), so a route that
  // compared the caller's upper-cased key against the raw stored string
  // answered "no results" for exactly the books it was written to serve.
  await withSeeded('lowercase-key', async ({ dir, get }) => {
    const snap = snapshotFor();
    snap.events[0].markets = [
      { key: 'asian_handicap', name: 'AH', selections: [{ name: 'Home', odds: 1.9 }] },
      { key: 'tgoals', selections: [{ name: 'Over', odds: 2.2 }] },
    ];
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snap));

    for (const [query, expectedKey] of [
      ['ASIAN_HANDICAP', 'asian_handicap'],
      ['asian_handicap', 'asian_handicap'],
      ['Asian_Handicap', 'asian_handicap'],
      ['TGOALS', 'tgoals'],
    ]) {
      const res = await get(`/api/odds/favbet?marketKey=${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.results.length, 1, `marketKey=${query} must find the ${expectedKey} market`);
      assert.equal(res.body.results[0].market.key, expectedKey, 'and hand back the spelling the book actually wrote');
    }

    const none = await get('/api/odds/favbet?marketKey=MATCH_ODDS');
    assert.deepEqual(none.body.results, [], 'a market this book does not carry still yields nothing');
  });
});

test('the odds route clamps limit at the top and floors it at zero', async () => {
  await withSeeded('limit', async ({ dir, get }) => {
    // More markets than any limit case below needs, so a clamp that is not
    // applied shows up as a short list rather than as a coincidence.
    const many = snapshotFor();
    many.events[0].markets = Array.from({ length: 120 }, (_, i) => ({
      key: `M${i}`, name: `M${i}`, selections: [{ name: 'Over', odds: 1.8 }],
    }));
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(many));

    const capped = await get('/api/odds/favbet?limit=1000');
    assert.equal(capped.body.results.length, 100, 'a caller cannot make the server build an unbounded response');

    const floored = await get('/api/odds/favbet?limit=-5');
    assert.equal(floored.body.results.length, 1, 'a negative limit yields the minimum, not all 120');

    for (const junk of ['', 'abc', 'NaN', '0x10']) {
      const res = await get(`/api/odds/favbet?limit=${junk}`);
      assert.equal(res.status, 200, `limit=${junk} must fall back to the default, not fail`);
      assert.equal(res.body.results.length, 50, `limit=${junk} must fall back to 50`);
    }

    // `1e999` is not garbage to parseInt, which reads the longest valid integer
    // prefix and stops at the `e` — so it means 1, not Infinity. Safe, because
    // the clamp still applies, but the opposite of what the string looks like,
    // and a caller who wrote it expecting a huge limit gets one row. Pinned
    // because "unparseable" and "parses to something unexpected" are different
    // inputs that happen to look alike in a query string.
    const exponential = await get('/api/odds/favbet?limit=1e999');
    assert.equal(exponential.body.results.length, 1, 'parseInt stops at the exponent sign, so 1e999 means 1');

    // `Math.max(1, …)` cannot see a zero: `parseInt('0') || 50` has already
    // replaced it, so asking for no rows returns fifty. Pinned rather than
    // fixed — it is a defensible default, but it is not what the clamp in the
    // source reads like, and a reader should be able to see which it is.
    const zero = await get('/api/odds/favbet?limit=0');
    assert.equal(zero.body.results.length, 50, 'limit=0 is not honoured; the floor in the source is unreachable for it');

    const small = await get('/api/odds/favbet?limit=3');
    assert.equal(small.body.results.length, 3, 'and a limit that is honoured is honoured exactly');
  });
});

test('the odds route reports capturedAt, and says so plainly when there is none', async () => {
  await withSeeded('captured', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    const withStamp = await get('/api/odds/favbet');
    assert.equal(withStamp.body.capturedAt, '2026-10-01T10:00:00.000Z', 'a price list without a capture time cannot be aged');

    const stamp = snapshotFor();
    delete stamp.capturedAt;
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(stamp));
    const without = await get('/api/odds/favbet');
    assert.equal(without.body.capturedAt, null, 'absent is null, so the client can tell it from a zero timestamp');
  });
});

test('the odds route refuses bad ids, missing books and corrupt files like its sibling does', async () => {
  await withSeeded('odds-badid', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify(snapshotFor()));
    assert.equal((await get('/api/odds/favbet')).status, 200, 'control: the good id is served first');

    for (const bad of ['..%2Flatest-scan', 'has%20space', '']) {
      const res = await get(`/api/odds/${bad}`);
      assert.equal(res.status, 400, `"${bad}" must be refused`);
      assert.equal(res.body?.error?.code, 'EBADID');
    }
  });

  await withSeeded('odds-missing', async ({ get }) => {
    const res = await get('/api/odds/never-scraped');
    assert.equal(res.status, 404);
    assert.equal(res.body?.error?.code, 'ENOTFOUND');
  });

  await withSeeded('odds-corrupt', async ({ dir, get }) => {
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), '{ truncated');
    const res = await get('/api/odds/favbet');
    assert.equal(res.status, 500, 'a truncated write must not read as a book with no markets');
    assert.equal(res.body?.error?.code, 'EINVALID');
  });
});

test('a snapshot with no events array is empty, not a crash', async () => {
  await withSeeded('noevents', async ({ dir, get }) => {
    // The 21 books that cannot measure live, and any book mid-write, can
    // produce a file with no usable `events`. A diagnostic route that threw
    // there would be unavailable exactly when an adapter is misbehaving.
    await writeFile(join(dir, 'workspace', 'favbet_events.json'), JSON.stringify({ sourceId: 'favbet', capturedAt: 'x' }));

    const odds = await get('/api/odds/favbet');
    assert.equal(odds.status, 200);
    assert.deepEqual(odds.body.results, [], 'no events means no rows, not a 500');

    const snap = await get('/api/snapshot/favbet');
    assert.equal(snap.status, 200, 'and the raw route still serves the file it actually found');
    assert.equal(snap.body.sourceId, 'favbet');
  });
});
