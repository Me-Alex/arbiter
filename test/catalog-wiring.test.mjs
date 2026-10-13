// test/catalog-wiring.test.mjs — GET /api/catalog, the route behind the
// analytics page's market catalog and event coverage cards.
//
// The route had a live consumer and no test that ever asked it for anything:
// analytics-page.test.mjs:1036 counts the page's fetches against a stub
// (`if (path === '/api/catalog') return { markets: [], events: [] }`), and the
// two payload censuses stub it the same way. Nothing ever met the route on a
// socket, so the two questions the route answers — what it hands a page that
// asked for a catalog nobody has built, and whether the stored document
// survives the trip whole — were answered by a stub answering for it.
//
// This file meets them on the wire. The scan service is real, the router is
// real, the document on disk is written by the same buildMarketCatalog the
// scraper runs, and the fields the page reads are measured out of the page —
// so a leaf the page reads and the route never carries fails here rather than
// on a reader's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { buildMarketCatalog } from '../src/scanner/market-catalog.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const pageSource = readFileSync(new URL('../public/js/pages/analytics.js', import.meta.url), 'utf8');

/**
 * The router over a socket, with the real scan service the route delegates to.
 *
 * The catalog is read off disk exactly the way the server reads it, so a route
 * that changed which file it opened would fail here rather than in a page that
 * silently renders the empty state.
 */
async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), 'arb-catalog-'));
  const route = buildRouter({
    dataDir,
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    scanService,
    orchestrator: { scrapeState: { status: 'idle', jobs: [] } },
    scheduler: { status: async () => ({}) },
    live: { status: async () => ({}) },
    tracker: {},
    broadcaster: { add() {}, stop() {} },
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
    dataDir,
    async get(path) {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The status as the wire would carry it: JSON drops `undefined`-valued keys. */
const asJson = (value) => JSON.parse(JSON.stringify(value));

/** Every leaf path of a value, arrays descended into: `markets[].sourceId`. */
function leafPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
    if (value.length) leafPaths(value[0], `${prefix}[]`, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) leafPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (prefix) out.add(prefix);
  return out;
}

/**
 * Does the document carry what a reader reads?
 *
 * A read of a branch (`markets`, used as a truthiness test before the helper
 * that walks its rows) is carried by any leaf under it, because that is what
 * the page does with it: it reads the branch to decide whether to render, and
 * the leaves to render. A read qualified with its row array (`markets.sourceId`)
 * is carried by the leaf the rows of that array hold (`markets[].sourceId`).
 */
function carries(leaves, read) {
  if (leaves.has(read) || leaves.has(`${read}[]`)) return true;
  const inRows = read.replace('.', '[].'); // markets.sourceId → markets[].sourceId
  return leaves.has(inRows) || leaves.has(`${inRows}[]`)
    || [...leaves].some((leaf) => leaf.startsWith(`${read}.`) || leaf.startsWith(`${inRows}.`) || leaf.startsWith(`${inRows}[].`));
}

/** The body of a function in the page, comments stripped. */
function pageWindow(name) {
  const at = pageSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(at, -1, `the page lost ${name}() — this test pins it`);
  const end = pageSource.indexOf('\n}', at);
  return pageSource
    .slice(at, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const readsIn = (win, receiver) => [...new Set([...win.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();

/**
 * The array each row reader walks, measured out of the page: the rows
 * `renderCatalog` receives are the ones `catalogRows` cut out of `cat`, so a
 * field that reader reads is a field the document's `markets` rows carry.
 */
const rowArray = (fn) => {
  const win = pageWindow(fn);
  const m = /\bcat\.(\w+)/.exec(win);
  assert.ok(m, `the page must cut ${fn}'s rows out of a cat.<array> field`);
  return m[1];
};

/**
 * What each half of the page reads off the catalog document, measured from the
 * page itself — the same measurement the two payload censuses make, redone
 * here against the socket answer instead of a stub.
 *
 * The market half: `initCatalog` walks `catalogRows` (rows of `cat.markets`,
 * each read for the table and the filter), `catalogRunText` (the run stamp:
 * `builtAt` and `scrapeRunId`). The event half: `initEventCoverage` walks
 * `eventCoverageRows` (rows of `cat.events`, sorted by `sources` length), each
 * row read for its table (`sources`, `marketKeys`, `homeTeam`, `awayTeam`,
 * `league`, `kickoff`, `sport`, `eventKey`, `selectionCount`) and for the
 * filter (`matchesEventQuery`).
 */
const CATALOG_READS = () => {
  const markets = rowArray('catalogRows');
  const events = rowArray('eventCoverageRows');
  // Top level, walked by the two init helpers and the run stamp.
  const top = [
    ...readsIn(pageWindow('initCatalog'), 'cat'),
    ...readsIn(pageWindow('initEventCoverage'), 'cat'),
    ...readsIn(pageWindow('catalogRunText'), 'cat'),
  ];
  // The market table's rows and filter, qualified with the array they are cut from.
  const marketRows = [
    ...readsIn(pageWindow('matchesCatalogQuery'), 'm'),
    ...readsIn(pageWindow('renderCatalog'), 'm'),
  ].map((field) => `${markets}.${field}`);
  // The event coverage table's rows and filter, likewise.
  const eventRows = [
    ...readsIn(pageWindow('matchesEventQuery'), 'ev'),
    ...readsIn(pageWindow('renderEventCoverage'), 'ev'),
  ].map((field) => `${events}.${field}`);
  return [...new Set([...top, ...marketRows, ...eventRows])].sort();
};

/**
 * A scan as buildMarketCatalog reads one: a workspace blob per source, with
 * two events and two markets — one event quoted by both books, so the coverage
 * rows the page sorts by `sources.length` have something to sort.
 */
function writeCatalogInputs(dataDir) {
  const workspace = join(dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'w-superbet.json'), JSON.stringify({
    events: [
      {
        id: 'sb-e1', sourceId: 'superbet', eventKey: 'k-shared',
        sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
        homeTeam: 'Home', awayTeam: 'Away',
        markets: [
          { key: 'MATCH_ODDS', name: 'Rezultat final', selections: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
          { key: 'DOUBLE_CHANCE', name: 'Sansa dubla', selections: [{ id: 's1' }, { id: 's2' }] },
        ],
      },
      {
        id: 'sb-e2', sourceId: 'superbet', eventKey: 'k-solo',
        sport: 'Tennis', league: 'ATP', kickoff: '2030-01-02T00:00:00Z',
        homeTeam: 'P1', awayTeam: 'P2',
        markets: [{ key: 'MATCH_ODDS', name: 'Rezultat final', selections: [{ id: 's1' }, { id: 's2' }] }],
      },
    ],
  }));
  writeFileSync(join(workspace, 'w-betano.json'), JSON.stringify({
    events: [
      {
        id: 'bn-e1', sourceId: 'betano', eventKey: 'k-shared',
        sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
        homeTeam: 'Home', awayTeam: 'Away',
        markets: [{ key: 'MATCH_ODDS', name: 'Rezultat final', selections: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] }],
      },
    ],
  }));
  return {
    schemaVersion: 1,
    scrapeRunId: 'run-catalog-1',
    sources: [
      { sourceId: 'superbet', file: 'w-superbet.json' },
      { sourceId: 'betano', file: 'w-betano.json' },
    ],
  };
}

/* ── the write path: what the scraper built is what the route answers ─────── */

test('the document the scraper wrote on disk is the document the route answers with', async () => {
  const srv = await serve();
  try {
    const scan = writeCatalogInputs(srv.dataDir);
    const built = await buildMarketCatalog(srv.dataDir, scan);

    const { status, json } = await srv.get('/api/catalog');
    assert.equal(status, 200, `the route answered ${status}`);
    // Whole, not a selection: every leaf the producer wrote, including the run
    // stamp the page stamps under the tables.
    assert.deepEqual(json, asJson(built),
      'the route did not answer with the catalog that was on disk');
  } finally {
    await srv.close();
  }
});

test('every field the page reads off the catalog is on the answer it gets', async () => {
  const srv = await serve();
  try {
    const scan = writeCatalogInputs(srv.dataDir);
    const built = await buildMarketCatalog(srv.dataDir, scan);

    const { json } = await srv.get('/api/catalog');
    const leaves = leafPaths(json);
    const reads = CATALOG_READS();
    const missing = reads.filter((read) => !carries(leaves, read));
    assert.deepEqual(missing, [],
      `the page reads ${missing.join(', ')} off the catalog and the route's answer carries none of them`);

    // And the document is not merely leaf-complete: both halves the page draws
    // actually hold rows the fixture produced, so the test above is not passing
    // over two empty arrays.
    assert.ok(json.markets.length > 0, 'the market half came back empty');
    assert.ok(json.events.length > 0, 'the event coverage half came back empty');
    assert.equal(json.events.find((e) => e.eventKey === 'k-shared').sources.length, 2,
      'the event quoted by both books must carry both sources, or the coverage count understates it');
  } finally {
    await srv.close();
  }
});

test('a directory with no catalog answers {} — the empty document the page already handles', async () => {
  const srv = await serve();
  try {
    // Nothing was ever scraped: no latest-market-catalog.json on disk. The
    // page's own failure path is `.catch(() => ({}))`, so the route answering
    // `{}` for a missing file keeps the two states identical.
    const { status, json } = await srv.get('/api/catalog');
    assert.equal(status, 200, `the route answered ${status} for a missing catalog`);
    assert.deepEqual(json, {}, 'the route did not answer the empty document for a missing catalog');

    // The readers agree: both halves of the page walk a missing document the
    // same way they walk `{}` — as zero rows, which is the empty state.
    assert.deepEqual((json.markets || []), [], 'a missing catalog is not zero market rows');
    assert.deepEqual((json.events || []), [], 'a missing catalog is not zero event rows');
  } finally {
    await srv.close();
  }
});

/* ── the read side: who asks, measured from the page ──────────────────────── */

test('the only reader of the route asks it once and feeds both cards', async () => {
  // One fetch, two cards — the shape analytics-page.test.mjs:1036 pins with a
  // stub, re-measured here against the route. The fetch, and the two helpers
  // it hands the document to, are the consumer this file keeps honest.
  const gets = [...pageSource.matchAll(/arbiterApi\.get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(gets.includes('/api/catalog'), 'the page no longer fetches /api/catalog — this test pins the reader');
  assert.equal(gets.filter((p) => p === '/api/catalog').length, 1,
    'the catalog is asked for more than once; the comment about one fetch, two cards is stale');

  const init = pageWindow('init');
  assert.match(init, /initCatalog\(catalog, t\)/, 'the catalog document no longer reaches the market card');
  assert.match(init, /initEventCoverage\(catalog, t\)/, 'the catalog document no longer reaches the coverage card');
});
