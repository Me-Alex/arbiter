/**
 * csv-export-wiring.test.mjs
 *
 * The chain from a sport selection to the file that downloads, for the page
 * that was not in it.
 *
 * The chain already has two owners and neither is this file:
 * test/sport-selection.test.mjs owns the scanner page's half and
 * test/router.test.mjs owns the route's half. The arbitrage page is a second
 * page with a sport selection and its own navigation to the same route, and it
 * was in neither.
 *
 * Measured before this file existed: public/js/pages/arbitrage.js sent a bare
 * "/api/scan/export.csv". The route reads `?sport=` and an absent parameter
 * means every sport (src/router.mjs:140, `sameSport` in src/scan-service.mjs),
 * so under a selection the four tables drew one sport while the download held
 * all of them. Over the real router, on a two-sport fixture: 3 rows on screen,
 * 5 in the file, the 2 extra ones a family the selection had emptied.
 *
 * The property asserted here is the one the scanner page already holds: what
 * the page asks for and what the tables show are the same question. It is
 * asserted over the page's own click, not over a string the test wrote, so a
 * page that stops carrying the selection fails here.
 *
 * What this file does NOT claim: the search box and `confirmed only` still do
 * not travel, because the route has no parameter for either. That is a
 * backend capability that does not exist, not a wiring defect, and it is
 * written down here rather than quietly invented on the server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRouter } from '../src/router.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const arbitrageSource = read('public/js/pages/arbitrage.js');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Two sports in every family, spelled the way the records spell them. The page
// seeds its control from the records themselves (public/js/pages/arbitrage.js
// `state.sports`), so the value a reader can pick is `Football` and not the
// registry's lowercase id -- and the route lowercases both sides before
// comparing, so the two spellings have to meet in the middle.
function opportunity(sport, tag) {
  return {
    sport, league: 'Test League', kickoff: '2026-01-01T00:00:00Z',
    homeTeam: `${tag} Home`, awayTeam: `${tag} Away`, marketKey: '1x2',
    legs: [{ sourceId: 'bookA', selection: 'HOME', outcome: 'home', odds: 2.1, stake: 100 }],
    totalStake: 100, guaranteedProfit: 5, verification: { status: 'confirmed' },
  };
}
function middle(sport, tag, verified = false) {
  return {
    sport, league: 'Test League', kickoff: '2026-01-01T00:00:00Z',
    homeTeam: `${tag} Home`, awayTeam: `${tag} Away`, marketKey: 'ou',
    // One leg, so the export's one-row-per-leg is one row per record and the
    // file's count is the tables' count. See `middlesOnScreen`.
    legs: [{ sourceId: 'bookB', selection: 'OVER', odds: 1.9, stake: 50 }],
    roiPercent: 1.2, riskPercent: 0.4,
    // The export already publishes `verificationStatus` for this family
    // (src/scan-service.mjs), so a middle carrying a verdict is a shape the
    // file can express rather than one invented for this test. Middles go out
    // unverified most of the time, which is why both cases are in the fixture.
    ...(verified ? { verification: { status: 'confirmed', reason: 'both legs verified' } } : {}),
  };
}

const FIXTURE = {
  dataHealth: { status: 'fresh' },
  sources: [],
  opportunities: [opportunity('Football', 'FCSB'), opportunity('TENNIS', 'Alcaraz')],
  middles: [middle('Football', 'FCSB', true), middle('TENNIS', 'Alcaraz')],
  positiveEv: [
    { sport: 'Football', marketKey: '1x2', sourceId: 'bookC', selection: 'AWAY', odds: 3.1, evPercent: 4.5, consensusProbability: 0.3, totalStake: 20, guaranteedProfit: 1 },
    { sport: 'TENNIS', marketKey: '1x2', sourceId: 'bookD', selection: 'AWAY', odds: 3.2, evPercent: 4.1, consensusProbability: 0.31, totalStake: 20, guaranteedProfit: 1 },
  ],
  lowHold: [
    { sport: 'Football', marketKey: 'ou', sourceId: 'bookE', selectionCount: 6, holdPercent: 2.1 },
    { sport: 'TENNIS', marketKey: 'ou', sourceId: 'bookF', selectionCount: 5, holdPercent: 2.4 },
  ],
};

// ---- the page, as the browser drives it ------------------------------------
//
// The same shape as test/helpers/scanner-page.mjs, kept separate because the
// two pages share no harness: the scanner rewrites anchors the markup ships and
// this one navigates on a click. Copying that helper and widening it would have
// produced a stub whose `querySelectorAll` answered for a page that never calls
// it -- a harness that passes by modelling a document this page does not have.
//
// `window` is the context itself, so a bare identifier and `window.<name>` are
// the same binding the way they are in a browser. `arbiterFormat` is null on
// purpose: the page's own comment says it formats locally and never reads the
// shared object, and a stub that supplied one would make that claim untested.

function node() {
  return {
    textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    fire(type) { for (const fn of this._listeners[type] || []) fn({ target: this }); },
    setAttribute(name, value) { this[`attr:${name}`] = value; },
    getAttribute(name) { return `attr:${name}` in this ? this[`attr:${name}`] : null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
  };
}

function arbitragePage(scan = FIXTURE) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node());
    return byId.get(id);
  };
  const context = {
    document: {
      getElementById: get,
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    escapeHtml,
    // A browser global, not an ECMAScript one: `runInNewContext` starts from
    // ECMAScript alone and the page builds its export URL with this.
    URLSearchParams,
    setTimeout, clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    arbiterSse: { connect() {} },
    arbiterApi: {
      async get(path) { return path === '/api/scan' ? scan : {}; },
      async post() { return {}; },
    },
    arbiterApp: { mount() {} },
    arbiterI18n: { t: (key) => key },
    arbiterFormat: null,
    location: { href: '' },
  };
  context.window = context;
  vm.runInNewContext(arbitrageSource, context);
  return { context, get };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * The href the page navigates to, after driving its own controls.
 *
 * Every control goes through the page's own listener rather than by writing to
 * `state`, which is not reachable: the page is an IIFE and nothing it declares
 * leaks to the context. A test that set the state directly would pass on a page
 * whose listener had stopped calling `render`.
 */
async function exportHrefFor({ sport = '', q = '', confirmedOnly = false } = {}) {
  const { context, get } = arbitragePage();
  await settle();
  await settle();
  if (sport) {
    get('f-sport').value = sport;
    get('f-sport').fire('change');
  }
  if (q) {
    get('f-q').value = q;
    get('f-q').fire('input');
  }
  if (confirmedOnly) {
    get('f-confirmed').checked = true;
    get('f-confirmed').fire('change');
  }
  get('btn-export').fire('click');
  return context.location.href;
}

/**
 * How many middle records the page is showing, read out of its own render.
 *
 * Middles are the family this file counts against, for two measured reasons.
 * They carry the identity columns a search can actually reach, where a +EV row
 * publishes only a sport and a market key, so a +EV search matches the market
 * and nothing else. And the export writes one row per leg, so the fixture gives
 * every middle a single leg and the two counts are the same count.
 */
async function middlesOnScreen({ sport = '', q = '', confirmedOnly = false } = {}) {
  const { get } = arbitragePage();
  await settle();
  await settle();
  if (sport) {
    get('f-sport').value = sport;
    get('f-sport').fire('change');
  }
  if (q) {
    get('f-q').value = q;
    get('f-q').fire('input');
  }
  if (confirmedOnly) {
    get('f-confirmed').checked = true;
    get('f-confirmed').fire('change');
  }
  const text = get('k-middles').textContent;
  const shown = /^\s*([\d,]+)/.exec(text);
  assert.ok(shown, `the page drew no middle count to read: ${JSON.stringify(text)}`);
  return Number(shown[1].replace(/,/g, ''));
}

// ---- the route, over HTTP ---------------------------------------------------

function stubServices(scan) {
  return {
    dataDir: '.tmp-csv-export-wiring', publicDir: '.tmp-csv-export-wiring',
    configPath: 'unused', profilesPath: 'unused',
    orchestrator: { scrapeState: {} },
    scheduler: { async status() { return { enabled: false }; } },
    tracker: {},
    broadcaster: { add() {}, stop() {}, count() { return 0; } },
    scanService: {
      async readPublishedScan() { return { scan, published: true }; },
      async readLatestScan() { return scan; },
      async readLatestCatalog() { return { markets: [] }; },
      async runScan() { return scan; },
    },
    logger: () => {},
    rateLimiter: new RateLimiter({ capacity: 100, refillPerSec: 100 }),
  };
}

/**
 * One CSV line as an object keyed by the header's own column names.
 *
 * Keyed rather than positional on purpose: the export's header has grown
 * columns before, and it is appended to at the end on purpose
 * (src/scan-service.mjs), so a test reading index 1 would silently start
 * reading a different field the day a column is inserted.
 */
function csvTable(path) {
  return fetch(path).then(async (res) => {
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    const lines = (await res.text()).trim().split(/\r?\n/);
    const header = lines[0].split(',');
    for (const column of ['type', 'sport', 'homeTeam', 'verificationStatus']) {
      assert.ok(header.includes(column), `the export lost its ${column} column: ${lines[0]}`);
    }
    return lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']));
    });
  });
}

async function withServer(scan, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    Promise.resolve(buildRouter(stubServices(scan))(req, res, url)).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const table = async (path) => csvTable(`http://127.0.0.1:${port}${path}`);
  const csvRows = async (path) => (await table(path)).map((r) => r.sport.toLowerCase());
  try {
    await fn({ table, csvRows });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---- the page half ----------------------------------------------------------

test('the arbitrage export carries the selection its tables are drawn under', async () => {
  assert.equal(await exportHrefFor({ sport: 'Football' }), '/api/scan/export.csv?sport=Football',
    'the page navigated to a URL that does not name the selected sport');
});

test('the selection travels as the control spelled it, not as the registry would', async () => {
  // The control is seeded from the records, so its value is the record's own
  // spelling. The route lowercases both sides before comparing
  // (`sameSport`), so either case works there -- what must not happen is the
  // page inventing a spelling the control never offered.
  const { context, get } = arbitragePage();
  await settle();
  await settle();
  const offered = [...get('f-sport').innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, ['', 'Football', 'TENNIS'],
    'the control no longer offers the sports the records carry, so the pin below is measuring nothing');
  get('f-sport').value = 'TENNIS';
  get('f-sport').fire('change');
  get('btn-export').fire('click');
  assert.equal(context.location.href, '/api/scan/export.csv?sport=TENNIS');
});

test('with no selection the arbitrage export asks for the whole document', async () => {
  // Pinned as measured, and deliberately: an empty selection means every sport
  // on the tables too (`visible()` in public/js/pages/arbitrage.js returns the
  // list untouched when `state.sport` is ''), so a bare URL is the right answer
  // here rather than a hole in the wiring. The dashboard link is bare for the
  // same measured reason and is pinned in the census below.
  assert.equal(await exportHrefFor({}), '/api/scan/export.csv');
});

// ---- the tie between the two halves ----------------------------------------

test('the href the page builds answers for exactly the rows the tables keep', async () => {
  const href = await exportHrefFor({ sport: 'Football' });
  await withServer(FIXTURE, async ({ csvRows }) => {
    const rows = await csvRows(href);
    assert.ok(rows.length > 0, `?sport=Football exported nothing: ${href}`);
    assert.deepEqual([...new Set(rows)], ['football'],
      `the download holds rows the selected sport does not cover: ${rows.join(', ')}`);

    // The control: the bare URL the page used to send. If this ever agrees with
    // the selected one, the fixture stopped having a second sport and the
    // assertion above would pass on a page that is broken again.
    const bare = await csvRows('/api/scan/export.csv');
    assert.ok(bare.some((s) => s !== 'football'),
      `the fixture has only one sport, so this file cannot tell the two apart: ${bare.join(', ')}`);
  });
});

// ---- the two controls that had no parameter at all --------------------------

test('every sidebar control travels with the export', async () => {
  assert.equal(
    await exportHrefFor({ sport: 'Football', q: 'fcsb', confirmedOnly: true }),
    '/api/scan/export.csv?sport=Football&q=fcsb&confirmed=1',
    'the search or the confirmed box did not reach the request',
  );
});

test('a control that is off writes no parameter, and an off control is not a filter', async () => {
  // Absence, not an empty value: the route reads an absent parameter as "no
  // filter", so writing `q=` would ask it a question the tables are not asking.
  assert.equal(await exportHrefFor({ sport: 'Football', q: '' }), '/api/scan/export.csv?sport=Football',
    'an empty search wrote a parameter');
  assert.equal(await exportHrefFor({ sport: 'Football', confirmedOnly: false }), '/api/scan/export.csv?sport=Football',
    'an unticked box wrote a parameter');
});

test('the route narrows the file by the search the sidebar holds', async () => {
  await withServer(FIXTURE, async ({ table }) => {
    const matched = await table('/api/scan/export.csv?type=middles&q=fcsb');
    assert.ok(matched.length > 0, '?q= exported nothing for a term the tables match');
    assert.ok(matched.every((r) => r.homeTeam.toLowerCase().includes('fcsb')),
      `?q=fcsb kept rows that do not carry the term: ${matched.map((r) => r.homeTeam).join(', ')}`);

    // The control: without the parameter the same request keeps both, so the
    // assertion above is about the search rather than about a fixture that
    // only holds one record.
    const all = await table('/api/scan/export.csv?type=middles');
    assert.ok(all.length > matched.length,
      `?q=fcsb changed nothing, so this test proves nothing: ${all.length} rows either way`);
  });
});

test('the route narrows the file by the confirmed box', async () => {
  await withServer(FIXTURE, async ({ table }) => {
    const confirmed = await table('/api/scan/export.csv?type=middles&confirmed');
    assert.ok(confirmed.length > 0, '?confirmed= dropped every row, including the verified one');
    assert.ok(confirmed.every((r) => r.verificationStatus === 'confirmed'),
      `?confirmed= kept an unverified row: ${confirmed.map((r) => r.verificationStatus).join(', ')}`);

    const all = await table('/api/scan/export.csv?type=middles');
    assert.ok(all.length > confirmed.length,
      `?confirmed= changed nothing, so this test proves nothing: ${all.length} rows either way`);
  });
});

test('confirmed is presence, not a value, and the surprising case is pinned here', async () => {
  // Spelled out in src/router.mjs next to the read. A reader who writes
  // `?confirmed=false` expecting to switch the box off gets the confirmed rows,
  // because `URLSearchParams.has` cannot tell an empty value from a false one.
  // Pinned rather than left to be discovered by a download that came back
  // holding the wrong rows.
  await withServer(FIXTURE, async ({ table }) => {
    const bare = await table('/api/scan/export.csv?type=middles&confirmed');
    const empty = await table('/api/scan/export.csv?type=middles&confirmed=');
    const word = await table('/api/scan/export.csv?type=middles&confirmed=false');
    assert.equal(empty.length, bare.length, '?confirmed= stopped meaning the same as ?confirmed');
    assert.equal(word.length, bare.length,
      '?confirmed=false no longer filters; if the parameter became value-based, delete this pin and say why');
  });
});

test('the file keeps exactly the middles the tables keep, under search and box', async () => {
  // The tie. The page is driven through its own listeners and the count is read
  // out of its own render, because `visible()` is inside the page's IIFE and
  // unreachable -- so this is the only way to compare what the tables keep
  // against what the file keeps without asking the page to expose something it
  // does not otherwise need.
  await withServer(FIXTURE, async ({ table }) => {
    const cases = [
      { sport: '', q: '', confirmedOnly: false },
      { sport: 'Football', q: '', confirmedOnly: false },
      { sport: '', q: 'fcsb', confirmedOnly: false },
      { sport: '', q: 'alcaraz', confirmedOnly: false },
      { sport: '', q: '', confirmedOnly: true },
      { sport: 'Football', q: 'fcsb', confirmedOnly: true },
    ];
    let varied = 0;
    for (const selection of cases) {
      const onScreen = await middlesOnScreen(selection);
      const params = new URLSearchParams({ type: 'middles' });
      if (selection.sport) params.set('sport', selection.sport);
      if (selection.q) params.set('q', selection.q);
      if (selection.confirmedOnly) params.set('confirmed', '1');
      const inFile = (await table(`/api/scan/export.csv?${params}`)).length;
      assert.equal(inFile, onScreen,
        `${JSON.stringify(selection)}: the tables show ${onScreen} middles and the file holds ${inFile}`);
      if (onScreen > 0 && onScreen < 2) varied += 1;
    }
    // The control on the control: if every case above answered 2, the equality
    // would hold for a builder that ignores both parameters.
    assert.ok(varied >= 2,
      `only ${varied} of the cases narrowed the fixture, so the equalities above are mostly 2 == 2`);
  });
});

// ---- the census -------------------------------------------------------------

/**
 * Every public/ file, as a repo-relative path with forward slashes.
 *
 * Built by recursion rather than by stripping a prefix off an absolute path:
 * the walk joins with `/` while `fileURLToPath` hands back backslashes on
 * Windows, so a prefix strip misses and every site reads as `public/...`.
 */
function publicFiles(dir = 'public', prefix = '', acc = []) {
  const root = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) publicFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, acc);
    else if (/\.(html|js)$/.test(entry.name)) acc.push({ file: `${prefix}${entry.name}`, source: readFileSync(`${root}/${entry.name}`, 'utf8') });
  }
  return acc;
}

/**
 * Every place public/ points at the CSV route, classified.
 *
 * Pinned as a list rather than a count, because a count only notices that the
 * number moved: the defect measured above was a site that existed and was
 * classified as correct. A sixth navigation has to be a decision.
 *
 * `query` is the parameter written in the source, and is null for the two code
 * sites because neither has one to write down -- the scanner rewrites anchors
 * the markup already carries, and the arbitrage button builds its query at
 * click time from the selection. Recording the template placeholder instead
 * would pin a string that says nothing about what is requested.
 */
const SITES = publicFiles()
  .flatMap(({ file, source }) => [...source.matchAll(/.*\/api\/scan\/export\.csv.*/g)].map((m) => {
    const line = m[0];
    const kind = line.includes('window.location.href') ? 'navigation'
      : line.includes('a[href*=') ? 'rewriter'
        : 'anchor';
    const written = line.match(/export\.csv\?([^"'`]*)/);
    return { file, kind, query: kind === 'anchor' ? (written ? written[1] : '') : null };
  }))
  .sort((a, b) => `${a.file}|${a.kind}|${a.query}`.localeCompare(`${b.file}|${b.kind}|${b.query}`));

test('every navigation to the CSV route is a classified site', () => {
  assert.deepEqual(SITES, [
    { file: 'admin/scanner.html', kind: 'anchor', query: 'type=lowHold' },
    { file: 'admin/scanner.html', kind: 'anchor', query: 'type=middles' },
    { file: 'admin/scanner.html', kind: 'anchor', query: 'type=opportunities' },
    { file: 'admin/scanner.html', kind: 'anchor', query: 'type=positiveEv' },
    { file: 'index.html', kind: 'anchor', query: '' },
    { file: 'js/pages/arbitrage.js', kind: 'navigation', query: null },
    { file: 'js/pages/scanner.js', kind: 'rewriter', query: null },
  ], 'a site was added, removed or re-pointed; classify it here before it ships');
});

test('the dashboard link is bare, and the dashboard has no sport to select', () => {
  // The contrast this file is about, measured on both sides: a page with a
  // sport control sends it (asserted above) and a page without one does not.
  // If a sport control is ever added to the dashboard, this anchor is the line
  // that has to learn to carry it, and this pin is what should fail first.
  const dashboard = read('public/index.html');
  assert.match(dashboard, /href="\/api\/scan\/export\.csv"/,
    'the dashboard anchor no longer ships bare');
  assert.doesNotMatch(read('public/js/pages/dashboard.js'), /addEventListener\('change',\s*\(e\)\s*=>\s*\{?\s*state\.sport/,
    'the dashboard grew a sport selection; its export link has to learn to carry it');
});
