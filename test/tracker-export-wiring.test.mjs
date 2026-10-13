/**
 * tracker-export-wiring.test.mjs
 *
 * The chain from the Export CSV button on the bet tracker to the file that
 * downloads, and back: `#export-csv` -> GET /api/tracker/export.csv ->
 * importCsv. The other half of the page's CSV loop, POST /api/tracker/import,
 * is driven end to end in test/analytics-page.test.mjs; what had no test was
 * the export side reaching the importer's own reader.
 *
 * Measured before this file existed, over the tree as it stands:
 *
 *   - `GET /api/tracker/export.csv` is served (src/router.mjs:268) and the
 *     page navigates to it on one click (public/js/pages/analytics.js:468),
 *     and the only assertion that both exist is a string reference in
 *     test/api-surface.test.mjs:556 -- it greps for the path in any frontend
 *     file and stops there. It would pass on a page whose handler navigated to
 *     a different route as long as some other file still mentioned the string.
 *   - test/router.test.mjs:58 stubs exportCsv with a two-column string, so the
 *     route's content negotiation was never read either: no test in the tree
 *     names `text/csv` or `bet-tracker.csv` (measured by grep).
 *   - test/tracker-service.test.mjs round-trips the service in process. Nothing
 *     carried the served bytes over HTTP into importCsv, which is the one path
 *     a user's file takes: they download, then paste the same bytes back.
 *
 * So this file pins the two halves of the tie, over the router that really
 * serves the route and the real TrackerService, and then drives them together:
 * a bet added through POST /api/tracker is exported through the button's own
 * href and imported back as an identical row rather than a corrupted one.
 *
 * What this file does NOT claim: what the operator does with the file after it
 * lands on disk. The route sends `Content-Disposition: attachment`, which is
 * the whole of what a server can say about it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import { TrackerService } from '../src/tracker-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { rotateCsrf } from '../src/shared/security.mjs';
import { codeOnly } from './helpers/code-only.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const EXPORT_HREF = '/api/tracker/export.csv';
const CSV_HEADER = 'id,createdAt,eventKey,marketKey,selection,sourceId,odds,stake,status,notes';

// The real TrackerService, in a temp dir, per test: the export reads whatever
// bet-tracker.json holds, so two tests sharing one service would read each
// other's rows and the counts below would stop being about the one bet.
async function service() {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-export-'));
  return { tracker: new TrackerService({ dataDir }), dataDir };
}

// The router with only the services the tracker routes touch. `scanService`
// and `scheduler` are absent on purpose: nothing on this chain reads them, and
// a stub that answered would be a stub the route under test never calls. The
// rate limiter is wide open because this is not a rate-limit test.
async function server(tracker) {
  const route = buildRouter({
    dataDir: tracker.dataDir,
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    tracker,
    rateLimiter: new RateLimiter({ capacity: 100, refillPerSec: 100 }),
    logger: () => {},
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    Promise.resolve(route(req, res, url)).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    async get(path) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const headers = Object.fromEntries(res.headers);
      return { status: res.status, headers, text: await res.text() };
    },
    async post(path, body) {
      // POST routes are CSRF-guarded (src/router.mjs:337, assertCsrf below it),
      // so a test that posts without the token gets a 403 and no bet — and the
      // failure reads as a route that refuses writes rather than as a test that
      // forgot a header. rotateCsrf() is the token the guard compares against.
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Host: '127.0.0.1', 'x-arbiter-token': rotateCsrf() },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, json: await res.json() };
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---- the page, as the browser drives it -----------------------------------
//
// Loaded the same way test/csv-export-wiring.test.mjs loads arbitrage.js: real
// source, a stubbed `arbiterApi`, and a real `$`-shaped node whose listeners are
// recorded rather than run. The export handler is one line at the end of the
// IIFE (analytics.js:468), after `init()` is defined and after the whole import
// form, so running the file to the end reaches it; the page's own init() is
// never called, which is why the stubs below only have to satisfy the listeners
// the page registers, not the load path it runs on a real page.

function node(key) {
  return {
    key,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    className: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    fire(type) { for (const fn of this._listeners[type] || []) fn({ target: this, preventDefault() {} }); },
    querySelectorAll: () => [],
    showModal() {}, close() {},
  };
}

/** Load the page and drive `#export-csv` through its own listener. */
function exportHrefFromPage() {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node(id));
    return byId.get(id);
  };
  const context = {
    document: {
      getElementById: get,
      querySelector: (s) => get(s),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    escapeHtml: (v) => String(v ?? ''),
    URLSearchParams,
    setTimeout, clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    arbiterApp: { mount() {} },
    arbiterSse: { connect() {} },
    // A page that fetched at load time would hit this and would be the reason
    // this test fails, rather than passing on a page that only looks wired.
    arbiterApi: {
      async get(path) { throw new Error(`analytics.js called ${path} at load, outside the handler under test`); },
      async post(path) { throw new Error(`analytics.js posted ${path} at load, outside the handler under test`); },
    },
    arbiterI18n: { t: (key) => key },
    location: { href: '' },
  };
  context.window = context;
  vm.runInNewContext(read('public/js/pages/analytics.js'), context);
  get('export-csv').fire('click');
  return context.location.href;
}

/** The href the shipped markup offers, read out of the page's own node. */
const controlHref = () => {
  const html = read('public/admin/analytics.html');
  const match = /\bid="export-csv"/.exec(html);
  assert.ok(match, 'analytics.html has no #export-csv control for the listener to read');
  return match;
};

// ---- the two halves --------------------------------------------------------

test('the export button navigates to the tracker export route', () => {
  assert.equal(exportHrefFromPage(), EXPORT_HREF,
    'the page navigated somewhere other than the export route');
});

test('the route the button navigates to is the route the router serves', async () => {
  // The half api-surface.test.mjs cannot see: not that the string appears in a
  // frontend file, but that the file the listener lives in asks for exactly the
  // path the router answers, with no query the route would have to read.
  const { tracker, dataDir } = await service();
  const http_ = await server(tracker);
  try {
    const res = await http_.get(EXPORT_HREF);
    assert.equal(res.status, 200, `${EXPORT_HREF} answered ${res.status}`);
    assert.ok(res.text.startsWith(CSV_HEADER),
      `the export did not begin with the header the importer reads:\n${res.text.split('\n')[0]}`);
  } finally {
    await http_.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the export is marked as a file to download, not as a page to read', async () => {
  // Content negotiation: a `text/html` answer to a URL assigned to
  // window.location.href is what the browser renders instead of saving, and the
  // one header that makes it save is the one no test in this tree named.
  const { tracker, dataDir } = await service();
  const http_ = await server(tracker);
  try {
    const res = await http_.get(EXPORT_HREF);
    assert.match(res.headers['content-type'] || '', /^text\/csv\b/,
      `the export answered ${res.headers['content-type']}`);
    assert.match(res.headers['content-disposition'] || '', /attachment/,
      `the export answered ${res.headers['content-disposition']}`);
    assert.match(res.headers['content-disposition'] || '', /bet-tracker\.csv/,
      `the export named no file to save: ${res.headers['content-disposition']}`);
  } finally {
    await http_.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('what the button asks for is what the download holds', async () => {
  // The tie between the two halves: the rows the importer accepts, with nothing
  // left over. Two bets, both placed through the same route the add-bet form
  // posts to, so the ledger the export describes is one this app wrote.
  const { tracker, dataDir } = await service();
  const http_ = await server(tracker);
  try {
    const placed = await http_.post('/api/tracker', {
      selection: 'Home win',
      odds: 2.35,
      stake: 100,
      sourceId: 'favbet',
      marketKey: 'MATCH_ODDS',
      status: 'pending',
      provenance: 'manual',
    });
    assert.equal(placed.status, 201, 'the bet did not reach storage');
    await http_.post('/api/tracker', {
      selection: 'Away win',
      odds: 3.1,
      stake: 50,
      sourceId: 'mrplay',
      marketKey: 'MATCH_ODDS',
      status: 'pending',
      provenance: 'manual',
    });

    const exported = await http_.get(EXPORT_HREF);
    const lines = exported.text.trim().split('\n');
    assert.equal(lines.length, 3, `the export held ${lines.length - 1} bets, not 2:\n${exported.text}`);
    assert.deepEqual(lines[0], CSV_HEADER, 'the importer would have read a different file');

    const back = await http_.post('/api/tracker/import', { csv: exported.text });
    assert.deepEqual(back.json, { imported: 2, skipped: 0 },
      `the file this page produced did not import back cleanly: ${JSON.stringify(back.json)}`);
  } finally {
    await http_.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a note with a comma and a quote survives the round trip', async () => {
  // The one column whose content can break a row. `notes` is quoted on export
  // (src/shared/csv.mjs) and parsed on import, so this is the property that
  // makes the file a CSV rather than two kinds of CSV the user cannot tell
  // apart. Placed through PUT, because notes cannot be typed in the add-bet
  // form and the import dialog is the only other writer.
  const { tracker, dataDir } = await service();
  const http_ = await server(tracker);
  try {
    const note = 'said "hi", then left';
    const placed = await http_.post('/api/tracker', {
      selection: 'Draw', odds: 3.4, stake: 25, sourceId: 'favbet', marketKey: 'MATCH_ODDS',
    });
    assert.equal(placed.status, 201);

    const before = await tracker.loadTracker();    assert.equal(before.items.length, 1, 'the fixture this test asserts about is one bet');
    await tracker.updateBet(before.items[0].id, { notes: note });

    const exported = await http_.get(EXPORT_HREF);
    assert.ok(exported.text.includes(`"${note.replace(/"/g, '""')}"`),
      `the note was not written as one CSV field:\n${exported.text}`);

    // A fresh ledger, so the import's counts are about the file rather than
    // about rows that were already there.
    const { tracker: fresh, dataDir: freshDir } = await service();
    try {
      const routeRes = await fresh.importCsv(exported.text);
      assert.deepEqual(routeRes, { imported: 1, skipped: 0 },
        `the exported row did not come back: ${JSON.stringify(routeRes)}`);
      const after = await fresh.loadTracker();
      assert.equal(after.items[0].notes, note, 'the note changed shape on the way back');
      // The date is carried, not stamped: an export whose re-import rewrote
      // every placed-at would turn the ledger's own history into a lie.
      assert.equal(after.items[0].createdAt, before.items[0].createdAt,
        'the placed-at date was rewritten on import');
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  } finally {
    await http_.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the export describes the tracker as it is, and the page can still read it', async () => {
  // Backend-only vs frontend: every column the export writes is a field the
  // add-bet flow or the import writes, and `provenance`/`updatedAt` are
  // deliberately absent (test/tracker-service.test.mjs:366 records why). The
  // point of this check is the direction that is easy to get wrong: a column
  // the export writes and nothing in the app can produce would be a column
  // that is always empty in every file a user downloads.
  //
  // Run rather than read. `exportCsv` fills each cell with `b[h]`, so a header
  // that names no stored field is a column of undefined-by-omission, and the
  // only way to see it is to export a bet that has every field set and look
  // for an empty cell. A regex over the service source would have to be taught
  // the shape of normalizeBet's return and would drift the day it changed.
  const { tracker, dataDir } = await service();
  try {
    await tracker.addBet({
      selection: 'Home win', odds: 2.35, stake: 100, sourceId: 'favbet',
      marketKey: 'MATCH_ODDS', status: 'pending', provenance: 'scan',
      notes: 'cashed at the branch', eventKey: 'soccer|liga-1|kiv-x-y',
    });
    const stored = (await tracker.loadTracker()).items[0];
    assert.ok(stored.selection, 'the bet this test asserts about was not stored');

    const exported = await tracker.exportCsv();
    const header = exported.split('\n')[0].split(',');
    assert.deepEqual(header, CSV_HEADER.split(','),
      'the export changed its columns — the importer reads them by name');

    // A bet that came from a scan is exported too: the export does not know
    // where the bet came from, and filtering on it would be a smaller file
    // than the ledger behind it.
    const row = exported.split('\n')[1].split(',');
    for (const [i, column] of header.entries()) {
      assert.notEqual(stored[column], undefined,
        `the export's ${column} column has no matching field on a stored bet`);
      assert.notEqual(row[i], '', `the export wrote an empty ${column} for a bet that has one`);
    }
    assert.ok(exported.includes('soccer|liga-1|kiv-x-y'), 'the scan bet is in the file');
    assert.ok(exported.includes('cashed at the branch'), 'and so is its note');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an empty tracker still exports the header, not an empty body', async () => {
  // A file with no header row is a file the importer cannot read at all
  // (headers.forEach over an empty first line imports nothing), and the
  // download button is the only way to get one.
  const { tracker, dataDir } = await service();
  const http_ = await server(tracker);
  try {
    const exported = await http_.get(EXPORT_HREF);
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.text.trim().split('\n'), [CSV_HEADER],
      `an empty tracker exported more than a header:\n${exported.text}`);
    const back = await http_.post('/api/tracker/import', { csv: exported.text });
    assert.deepEqual(back.json, { imported: 0, skipped: 0 },
      'the header-only file the empty tracker produces does not import cleanly');
  } finally {
    await http_.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
