// The /api/scan field census.
//
// The other payloads in this tree are censused from the producer: the names a
// loader writes, read out of the loader. This one is censused from a run
// instead, because the scan payload is not a list of names — it is nine keys
// from an envelope, five families whose shapes are built by the engine, and an
// overlay a second pass writes onto the published document afterwards. Naming
// those by hand would be a census of a list that can drift from the code, which
// is the exact failure this tree keeps paying to fix.
//
// So the producer is driven. scanWorkspace runs over a synthetic workspace that
// is shaped to populate all five families, and the leaf set of what it returns
// is the published set. The overlay is pinned against verification.mjs, because
// it cannot be produced without a live re-scrape.
//
// The reader half is executed, not searched. A regex over page source cannot
// tell this payload apart from a fixture: `Number((scan.options || {}).liveMaxAgeMs)`
// has no receiver to anchor on, ai.js reads the seven dataHealth status counters
// through `Object.entries` and names none of them, and `s` is the receiver for
// both verificationSummary and a signal in scanner.js — so one file-level search
// credits the summary with fields only a signal carries. Instead each page is
// run in a vm against a recording Proxy and every property path it touches is
// collected. An instrument that reports zero because a page threw has to say
// so, which is why each page's hit count is asserted.
//
// The set of pages is derived from the pages, because a typed list is a claim
// about the frontend that nothing re-checks. It was typed, it listed four, and
// the fifth consumer — scrape.js, `refreshScanSummary` — was outside the census
// for as long as the omission lasted, with the route's own comment agreeing with
// the list. A field read only by the omitted page reads as a field nobody reads.
// scrape.js cannot be run whole (its init awaits /api/scrape/state first and
// rejects into its own catch, touching 0 paths), so the three functions that
// read the document are lifted out of it and driven against the same proxy.
//
// An executed instrument has a blind spot of its own, and it is the same trap
// as everywhere else in this repo: a field read only in a rare branch is
// indistinguishable from a field nobody reads. `scanStartedAt` is never touched
// on a real scan, because `scan.scrapedAt || scan.scanStartedAt` short-circuits
// on the first operand. So the reader runs four passes and the census takes
// the union: the real one, a degraded one that forces the fallback branches, one
// that puts an arbitrage on top of the ROI sort so the dashboard's `best`
// record comes from the other family, and one that leaves the sport filter
// selected — the three documents alone would all report `sport` unread on the
// two families whose rows print no sport chip, because `filterBySport` returns
// its argument untouched when nothing is selected. Without the third,
// `opportunities[].eventKey`
// reads as unread — which it is not, and which a test would then have excused
// forever on the strength of an accident in the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { scanWorkspace } from '../src/scanner/scanner.mjs';
import { codeOnly, fieldsOn, functionSource } from './helpers/code-only.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// The producer, driven.
// ---------------------------------------------------------------------------

const EVENT = (id, sourceId, eventKey, markets) => ({
  id, sourceId, eventKey, providerEventId: `p-${id}`,
  sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
  homeTeam: 'Home', awayTeam: 'Away', markets,
});
const sel = (name, odds, extra = {}) => ({ name, odds, id: `s-${extra.k || name}`, ...extra });
const mkt = (key, selections) => ({ key, selections, id: `m-${key}` });

/**
 * A workspace that populates all five families.
 *
 * Every event carries the market and selection ids a real scrape supplies,
 * because two of the published leaves (`opportunities[].legs[].marketId` and
 * `selectionId`) are written from `m.id` / `s.id` and a workspace without them
 * reports a payload narrower than any the server can serve. Measured: with the
 * ids the run publishes 132 leaves, without them 130, and the two missing ones
 * are exactly those.
 */
const WORKSPACE = [
  // Arbitrage: two independent books, inverse sum under 1.
  EVENT('a1', 'alpha', 'k-arb', [mkt('MATCH_ODDS', [sel('H', 2.10), sel('D', 4.20), sel('A', 4.60)])]),
  EVENT('b1', 'bravo', 'k-arb', [mkt('MATCH_ODDS', [sel('H', 2.05), sel('D', 4.50), sel('A', 5.00)])]),
  // Middles: an over/under pair straddling a line.
  EVENT('a2', 'alpha', 'k-middle', [mkt('OVER_UNDER_25', [sel('Over', 2.00, { handicap: 2.5 }), sel('Under', 2.00, { handicap: 2.5 })])]),
  EVENT('b2', 'bravo', 'k-middle', [mkt('OVER_UNDER_25', [sel('Over', 1.95, { handicap: 2.25 }), sel('Under', 1.95, { handicap: 2.75 })])]),
  // Positive EV: one selection far above the other two books' consensus.
  EVENT('a3', 'alpha', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 5.20), sel('D', 3.60), sel('A', 3.40)])]),
  EVENT('b3', 'bravo', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 2.10), sel('D', 3.60), sel('A', 3.50)])]),
  EVENT('c3', 'charlie', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 2.15), sel('D', 3.55), sel('A', 3.45)])]),
  // Low hold: a two-way market whose inverse sum sits just above 1.
  EVENT('a4', 'alpha', 'k-hold', [mkt('BOTH_TEAMS_TO_SCORE', [sel('Yes', 2.00), sel('No', 1.98)])]),
];

let driven = null;
let capturedAtUsed = null;

/** @returns {Promise<object>} a scan produced by the real scanWorkspace. */
async function driveScan() {
  if (driven) return driven;
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-scan-census-'));
  capturedAtUsed = new Date().toISOString();
  await mkdir(join(dir, 'workspace'), { recursive: true });
  for (const sourceId of ['alpha', 'bravo', 'charlie']) {
    await writeFile(join(dir, 'workspace', `${sourceId}_events.json`), JSON.stringify({
      runId: 'run-census', sourceUrl: `https://${sourceId}.example/offer`, transport: 'test-public-feed',
      schemaVersion: 2, sourceId, capturedAt: capturedAtUsed, dataStatus: 'fresh',
      events: WORKSPACE.filter((e) => e.sourceId === sourceId),
    }), 'utf8');
  }
  const scan = await scanWorkspace({ dataDir: dir, bankroll: 1000, publish: false });
  await rm(dir, { recursive: true });
  // The route's own flag, and nothing else added to the document. An earlier
  // draft stashed the fixture's capture time on the scan object to reach the
  // overlay, and the leaf collector — correctly — published it as a field: 167
  // leaves instead of 166, one of which no server has ever served.
  scan.published = true;
  driven = scan;
  return scan;
}

// ---------------------------------------------------------------------------
// The overlay a verification pass writes onto the published document.
// ---------------------------------------------------------------------------

const verificationCode = codeOnly(read('src/verification.mjs'));

/**
 * The names the merge writes, read out of the merge rather than typed here.
 *
 * @returns {{overlay: string[], summary: string[]}}
 */
function overlayNames() {
  const at = verificationCode.indexOf('verification: { status:');
  assert.notEqual(at, -1, 'the verification overlay is gone from the merge in verification.mjs');
  const open = verificationCode.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < verificationCode.length; i += 1) {
    if (verificationCode[i] === '{') depth += 1;
    else if (verificationCode[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, 'the verification overlay literal is not closed');
  const overlay = [...verificationCode.slice(open, end).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);

  const summaryAt = verificationCode.indexOf('baseScan.verificationSummary = {');
  assert.notEqual(summaryAt, -1, 'the verification summary is no longer written by the pass');
  const summaryEnd = verificationCode.indexOf('}', summaryAt);
  const summary = [...verificationCode.slice(summaryAt, summaryEnd).matchAll(/(\w+)\s*[:,]/g)].map((m) => m[1]);
  return { overlay, summary };
}

const OVERLAY_NAMES = overlayNames();

/**
 * The published document: the driven scan plus the overlay, as
 * verification.mjs leaves it.
 */
async function publishedScan() {
  const scan = await driveScan();
  const doc = JSON.parse(JSON.stringify(scan));
  for (const o of doc.opportunities) {
    o.verification = {
      status: 'confirmed', reason: 'all legs re-priced within tolerance',
      legs: (o.legs || []).map((l) => ({ ...l, currentOdds: l.odds })),
    };
  }
  for (const m of doc.middles) {
    m.verification = {
      status: 'confirmed', reason: 'all legs re-priced within tolerance',
      legs: (m.legs || []).map((l) => ({ ...l, currentOdds: l.odds })),
    };
  }
  doc.verificationSummary = { confirmed: 1, rejected: 0, expired: 0, unconfirmed: 0, at: capturedAtUsed };
  doc.published = true;
  return doc;
}

// ---------------------------------------------------------------------------
// Leaf collection.
// ---------------------------------------------------------------------------

/**
 * Every leaf path of a published value.
 *
 * `undefined` is not a leaf. The route serves the scan through JSON.stringify,
 * which drops undefined properties, so counting them would publish keys the
 * wire never carries. The first version of this probe counted them and
 * reported `opportunities[].legs[].marketId` on a workspace whose markets had no
 * id at all.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @param {Set<string>} out
 */
function leaves(value, prefix, out) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    const at = `${prefix}[]`;
    for (const item of value) leaves(item, at, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.add(prefix);
}

// ---------------------------------------------------------------------------
// The reader, executed.
// ---------------------------------------------------------------------------

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const node = (overrides = {}) => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
  dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector() { return node(); }, querySelectorAll() { return []; }, nextElementSibling: null,
  remove() {}, appendChild() {}, insertAdjacentHTML() {},
  ...overrides,
});

/**
 * The controls a pass puts the page into, keyed by element id, read by
 * `pageContext`. The comment on `node` says why a pass has to set one at all.
 */

/**
 * A value that records every property path read off it.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {Set<string>} hits
 */
function record(value, path, hits) {
  if (value === null || typeof value !== 'object') return value;
  hits.add(path);
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      const child = path ? `${path}.${prop}` : String(prop);
      hits.add(child);
      const raw = target[prop];
      // Methods run on the proxy, so what a callback receives is itself a proxy
      // and the fields read inside the callback are recorded too.
      if (typeof raw === 'function') {
        return (...args) => raw.apply(record(target, path, hits), args);
      }
      return record(raw, child, hits);
    },
  });
}

// Array and promise machinery the proxy walks through on the way to a field.
// The bare `then` is here because `await` reaches it at the ROOT, not under a
// key: the filter below only ever matched the dotted spellings, so a lifted
// reader that awaits the document records one `then` that is machinery wearing a
// payload key's name — and the constant's own comment claimed it filtered
// promise machinery.
const NOT_PAYLOAD = /(^$)|(^then$)|(\.(constructor|length|map|filter|sort|slice|then|forEach|reduce|concat|join|indexOf|includes|push|find|some|every|values|entries|keys|toFixed|replace|split|toLocaleString|toLocaleDateString|toISOString|prototype)$)/;

const i18nSource = read('public/js/i18n.js');

/**
 * A pass that never sets a control drives the page in exactly one state, and a
 * control gated on a value the harness left empty takes an early return no
 * reader would ever see. That is how `sport` came to be reported unread on two
 * of the four families: the arb and middle rows print a sport chip, so `.sport`
 * is read off them whichever way the filter sits, while the positive-EV and
 * low-hold rows print none — there `sport` was read only by `filterBySport`, and
 * `filterBySport` returns `items` untouched when nothing is selected.
 *
 * @param {object} api the arbiterApi stand-in for this pass
 * @param {Record<string, unknown>} [values] control values by element id
 */
function pageContext(api, values = {}) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) {
      const own = Object.prototype.hasOwnProperty.call(values, id);
      byId.set(id, node(own ? { value: values[id] } : {}));
    }
    return byId.get(id);
  };
  const context = {
    document: {
      getElementById: get, querySelector: () => node(), querySelectorAll: () => [],
      addEventListener() {}, createElement: () => node(), documentElement: {}, body: node(),
    },
    escapeHtml, console: { log() {}, warn() {}, error() {} }, createDropdown() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }), location: { href: '' },
    // A browser global, not a stand-in: rows build their own event link through
    // it (`renderOppGroup`, dashboard.js:484), so a context without it throws
    // before the census has read a single field, and every page that renders an
    // opportunity would have been counted as reading nothing.
    URLSearchParams,
  };
  context.window = {
    arbiterConnectionStatus: null, arbiterApp: { mount() {} }, arbiterFormat: null, addEventListener() {},
    // connection-status.js arms its poll through `window.setInterval`.
    setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {},
  };
  context.arbiterApp = context.window.arbiterApp;
  context.arbiterSse = { connect() {} };
  context.arbiterApi = api;
  context.arbiterFormat = null;
  context.globalThis = context;
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? 'en' : null), setItem() {} },
  }));
  context.arbiterI18n = context.window.arbiterI18n;
  return context;
}

/**
 * The readers that cannot be run whole, and the functions that read the
 * document in them.
 *
 * scrape.js fetches this route too — `refreshScanSummary`, line 1226 — and the
 * census left it out for a year because the list of pages was typed by hand
 * rather than measured, and the route's own comment agreed with the list
 * ("four pages"). Running the page whole does not find it either: its init
 * awaits `/api/scrape/state` first, and the harness answers that route with a
 * stub that has no `state`, so init rejects into its own catch and the fetch
 * below it never happens. Measured: the page ran, threw nothing, and touched
 * **0** paths — which is exactly the silence the per-reader floor exists to
 * refuse, and which no floor could have caught while the page was not in the
 * list at all.
 *
 * So those three functions are lifted out of the page and driven directly.
 * Production code, read from the file, not a second implementation of it — the
 * same trade `liftFromOrchestrator` makes on the other side of this tree. The
 * page's own `$` comes along for the ride rather than being retyped here.
 */
const LIFTED_READERS = {
  'scrape.js': ['scanSummaryText', 'renderScanSummary', 'refreshScanSummary'],
};

/**
 * The source a lifted reader runs: the page's own `$`, then its own functions.
 *
 * The `$` is read out of the page rather than typed here, because a harness
 * that draws through a helper the page does not have is measuring a page that
 * does not exist. Both halves come from the file, and both fail loudly rather
 * than degrading: a page that stops declaring `$`, or a function that is renamed
 * away, is a loud stop, not an empty reader set.
 *
 * @param {string} page file under public/js/pages
 * @param {string[]} names functions to lift, in dependency order
 * @returns {{dollar: string, code: string}}
 */
function liftedSource(page, names) {
  const source = read(`public/js/pages/${page}`);
  const dollar = source.match(/^const \$ = .*$/m);
  if (!dollar) throw new Error(`${page} no longer declares \`$\` the way the lift assumes`);
  return {
    dollar: dollar[0],
    code: [dollar[0], ...names.map((n) => functionSource(source, n).text)].join('\n'),
  };
}

/**
 * Every page that fetches this route, derived from the pages themselves.
 *
 * A typed list is a claim about the frontend that nothing re-checks, and the
 * failure it hides is the one this census exists to prevent: a field read by
 * the page that was left out reads as a field nobody reads, and gets excused
 * forever on the strength of an omission. Deriving it costs one pass over the
 * directory, so the omission cannot survive the next run.
 *
 * Comments are blanked first, because scrape.js names this route in three
 * places in prose and two of them are sentences about it, not calls.
 */
const SCAN_FETCH = /arbiterApi\.get\(\s*'\/api\/scan'\s*\)/;
const PAGE_NAMES = readdirSync(join(ROOT, 'public', 'js', 'pages')).filter((f) => f.endsWith('.js'));

/**
 * Whether a page source is a consumer of this route.
 *
 * One function, used by the derivation and by its own control below: if the two
 * spelled out the rule separately they could drift, and the drift would look
 * like the control passing.
 *
 * @param {string} src a page's whole source
 * @returns {boolean}
 */
const isConsumer = (src) => SCAN_FETCH.test(codeOnly(src));

const SCAN_CONSUMERS = PAGE_NAMES
  .filter((f) => isConsumer(read(`public/js/pages/${f}`)))
  .sort();

/**
 * How little a reader may touch and still be a reader.
 *
 * A number, not a derivation, because the floor's job is to catch a reader that
 * throws — and the number that does that is whatever each reader touches today,
 * measured. scrape.js's is 11 raw paths for 5 of the document, one floor below
 * that; the four it shares with the other pages are already past theirs.
 *
 * The three ArbEdge console pages are floors of a different kind, and the
 * difference is the fixture rather than the page. live.js is the honest 7: the
 * driven scan is a pre-match run, so no opportunity carries `live: true`,
 * `liveOpps()` is empty and the page correctly reads almost nothing. Its floor
 * says "it ran", not "it rendered a signal" — a run with live opportunities in it
 * is what would move that number, and this census does not drive one. bookies.js
 * reads the envelope through the join onto /api/scrapers, so its 25 is the depth
 * of that join rather than of the tables it draws.
 */
const FLOOR = {
  'scanner.js': 50,
  'dashboard.js': 20,
  'analytics.js': 5,
  'ai.js': 15,
  'connection-status.js': 3,
  'scrape.js': 10,
  'arbitrage.js': 231,
  // Recalibrated when the sidebar footer stats card was dropped: bookies.js
  // stopped reading `opportunities`/`middles`/`positiveEv`/`lowHold` (array
  // lengths only, for that card), taking it from 25 paths to 22. No field lost
  // its last reader — arbitrage.js reads all four properly — so this is the
  // reader shrinking on purpose, not a reader that threw. The floor stays just
  // under the real count so the tripwire is still armed.
  'bookies.js': 21,
  'live.js': 7,
};

/** Whole-page readers: every consumer whose reads happen at load time. */
const PAGE_FILES = SCAN_CONSUMERS.filter((f) => !LIFTED_READERS[f]);

/**
 * Run one payload past every reader and collect the paths touched.
 *
 * Each reader gets its own copy of the document, and that is a measurement
 * decision rather than tidiness. The pages sort the arrays they are handed in
 * place — `scanner.js:660` sorts `scan.middles` straight through the proxy the
 * probe wrapped around it — so a single shared payload let one reader rewrite
 * the document the next one was about to be shown. Measured: on one shared
 * payload scanner.js read 75 paths and reported `middles[].legs[].handicap`
 * unread, while `middles[].legs[].handicap` is read at scanner.js:665 and the
 * same run reads the whole middles family the moment each page is handed its
 * own copy (259 paths). A census that lets the previous reader decide the
 * next one's reads is measuring the order of the list, not the pages.
 *
 * @param {object} payload
 * @param {Record<string, unknown>} [values] controls the pages are put into
 * @returns {Promise<{hits: Set<string>, perPage: Record<string, number>, perPagePaths: Record<string, string[]>}>}
 */
async function measureReads(payload, values = {}) {
  const hits = new Set();
  const perPage = {};
  const perPagePaths = {};
  const collect = (page, pageHits) => {
    perPage[page] = pageHits.size;
    perPagePaths[page] = [...pageHits].sort();
    for (const p of pageHits) {
      const n = p.replace(/\.\d+/g, '[]');
      if (!NOT_PAYLOAD.test(n)) hits.add(n);
    }
  };

  for (const page of PAGE_FILES) {
    const own = JSON.parse(JSON.stringify(payload));
    const pageHits = new Set();
    const api = {
      async get(path) {
        if (path === '/api/scan') return record(own, '', pageHits);
        // `jobs` is here because GET /api/scrapers returns it: bookies.js reads
        // the scan only after it has a book list to join the sources onto, and a
        // stand-in without `jobs` made that page look like a reader that touched
        // almost nothing when it had simply found the envelope unfamiliar.
        return { jobs: [], profiles: [], sports: [], markets: [], events: [] };
      },
      async post() { return {}; },
    };
    const context = pageContext(api, values);
    vm.runInNewContext(read(`public/js/pages/${page}`), context);
    // scanner.js draws through render() only once its own init has resolved a
    // profile list; the preview path is the same function.
    if (page === 'scanner.js') context.render(record(own, '', pageHits));
    await new Promise((r) => setTimeout(r, 25));
    collect(page, pageHits);
  }

  // scrape.js reads this document through three lifted functions rather than
  // through its own init, which never reaches them here. Lifting a function
  // that no longer exists fails loudly in `functionSource`, and a page whose `$`
  // is not the one the page declares fails in `liftedSource` — a retyped `$`
  // would quietly change what the page draws.
  for (const [page, names] of Object.entries(LIFTED_READERS)) {
    const own = JSON.parse(JSON.stringify(payload));
    const pageHits = new Set();
    const api = {
      async get(path) {
        if (path === '/api/scan') return record(own, '', pageHits);
        return {};
      },
      async post() { return {}; },
    };
    const context = pageContext(api, values);
    vm.runInNewContext(liftedSource(page, names).code, context);
    await context[names[names.length - 1]]();
    collect(page, pageHits);
  }

  // connection-status.js is not a page but it is a reader: it decides the
  // freshness banner from the same dataHealth, and `prematchMaxAgeMs` is read
  // nowhere else. Leaving it out would have reported that field unread.
  {
    const pageHits = new Set();
    const context = pageContext({ async get() { return {}; }, async post() { return {}; } });
    vm.runInNewContext(read('public/js/connection-status.js'), context);
    const proxied = record(payload, '', pageHits);
    context.decideHealthBanner(proxied.dataHealth);
    context.decideHealthChip(proxied.dataHealth);
    collect('connection-status.js', pageHits);
  }

  return { hits, perPage, perPagePaths };
}

/** The scan with every fallback branch forced. */
function degraded(base) {
  const d = JSON.parse(JSON.stringify(base));
  d.scrapedAt = undefined;
  d.published = false;
  d.options = {};
  d.verificationSummary = { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0 };
  for (const o of d.opportunities) delete o.verification;
  for (const m of d.middles) delete m.verification;
  d.opportunities = [];
  d.middles = [];
  d.positiveEv = [];
  d.sources = [];
  d.dataHealth = { ...d.dataHealth, status: 'empty', actionableSourceCount: 0, sources: {} };
  return d;
}

/** The scan with an arbitrage on top of the margin sort, so `best` is not a middle. */
function arbOnTop(base) {
  const d = JSON.parse(JSON.stringify(base));
  const bestOpp = Math.max(...d.opportunities.map((o) => Number(o.marginPercent || 0)));
  for (const m of d.middles) m.roiPercent = bestOpp - 1;
  return d;
}

/**
 * The controls each pass puts the pages into.
 *
 * Three of the four vary the document, because the document is what a real run
 * changes. The fourth varies the page instead: `sport-filter` left empty makes
 * `filterBySport` return its argument untouched, and that early return hid the
 * only reader of `sport` on two of the four families — the rows that print no
 * sport chip of their own. `football` is the value the scanner page can
 * actually be put into today, being the one sport the registry offers
 * (`src/sports/registry.mjs`), and it matches the driven events' `Football`
 * case-insensitively, so the pass renders every row and reads every filter.
 */
const PASSES = (base) => [
  { payload: base },
  { payload: degraded(base) },
  { payload: arbOnTop(base) },
  { payload: base, values: { 'sport-filter': 'football' } },
];

let readRun = null;

/** @returns {Promise<{hits: Set<string>, perPage: Record<string, number>, perPagePaths: Record<string, string[]>}>} */
async function readPaths() {
  if (readRun) return readRun;
  const base = await publishedScan();
  const perPage = {};
  const perPagePaths = {};
  const hits = new Set();
  for (const { payload, values } of PASSES(base)) {
    const run = await measureReads(payload, values);
    // Union, not last writer wins: the four passes force different branches, so
    // a path read only by the degraded one is exactly the kind this census
    // cannot see if it keeps only the final pass. The count a reader touched
    // takes the largest, because the floor below is a claim about the busiest
    // pass rather than about the last one.
    for (const [page, n] of Object.entries(run.perPage)) {
      perPage[page] = Math.max(perPage[page] || 0, n);
    }
    for (const [page, paths] of Object.entries(run.perPagePaths)) {
      perPagePaths[page] = [...new Set([...(perPagePaths[page] || []), ...paths])].sort();
    }
    for (const p of run.hits) hits.add(p);
  }
  readRun = { hits, perPage, perPagePaths };
  return readRun;
}

/** sources[] has its own census, in source-health-list.test.mjs. */
const isSourceBranch = (p) => p === 'sources' || p.startsWith('sources[].');

// ---------------------------------------------------------------------------
// Facts the excuses rest on, measured rather than asserted in prose.
// ---------------------------------------------------------------------------

/**
 * Leg fields whose value equals the parent's, on every record of the driven
 * scan.
 */
function restatements() {
  const out = {};
  for (const family of ['opportunities', 'middles']) {
    const equal = new Set();
    let counted = 0;
    for (const record of driven[family]) {
      for (const leg of record.legs || []) {
        counted += 1;
        for (const [k, v] of Object.entries(leg)) {
          if (v !== undefined && JSON.stringify(v) === JSON.stringify(record[k])) equal.add(k);
        }
      }
    }
    out[family] = { legs: counted, equal: [...equal].sort() };
  }
  const evEqual = new Set();
  let evLegs = 0;
  for (const record of driven.positiveEv) {
    const leg = (record.legs || [])[0];
    if (!leg) continue;
    evLegs += 1;
    for (const [k, v] of Object.entries(leg)) {
      if (v !== undefined && JSON.stringify(v) === JSON.stringify(record[k])) evEqual.add(k);
    }
  }
  out.positiveEv = { legs: evLegs, equal: [...evEqual].sort() };
  return out;
}

/** What verifySignal reads off a leg and off its target. */
function serverReads() {
  const at = verificationCode.indexOf('export function verifySignal');
  assert.notEqual(at, -1, 'verifySignal is gone from verification.mjs');
  const body = verificationCode.slice(at);
  return { leg: fieldsOn(body, 'leg'), target: fieldsOn(body, 'target') };
}

const distinct = (values) => [...new Set(values)].sort();

// ---------------------------------------------------------------------------
// Published by the scan, read by nobody, with the reason it is allowed.
// ---------------------------------------------------------------------------

/**
 * Grouped rather than flat, because the reason is the same for all of them and
 * repeating one sentence per leaf would be padding dressed as rigour. Each
 * group names every leaf it covers, the census below fails on a name that is in
 * no group, and fails on a name in a group that has since become read — so a
 * group cannot quietly grow into a place where fields go to be quiet.
 *
 * Every reason contains a measurement, and the measurement is asserted by a
 * named test in this file rather than trusted.
 */
const UNREAD_BY_DESIGN = [
  {
    id: 'requote-scope',
    covers: [
      'opportunities[].legs[].eventKey', 'opportunities[].legs[].kickoff', 'opportunities[].legs[].live',
      'opportunities[].legs[].marketId', 'opportunities[].legs[].marketKey',
      'opportunities[].legs[].providerEventId', 'opportunities[].legs[].selectionId',
      'middles[].legs[].eventKey', 'middles[].legs[].live', 'middles[].legs[].marketKey',
    ],
    reason: [
      'Re-quote scope, read by the server and not by a page. verifySignal reads 11 names off a leg',
      '(eventKey, handicap, kickoff, live, marketId, marketKey, odds, providerEventId, selection,',
      'selectionId, sourceId) and these 10 are the ones among them no page reaches. They exist so the',
      'pass can re-quote the same price at the same scope; the page shows the verdict and its reason.',
    ].join(' '),
    measuredBy: 'the verification pass reads the leg names it is excused for',
  },
  {
    id: 'requote-record',
    covers: [
      ...['currentOdds', 'eventKey', 'eventUrl', 'handicap', 'kickoff', 'live', 'marketId', 'marketKey', 'odds', 'outcome', 'payout', 'profit', 'providerEventId', 'selection', 'selectionId', 'sourceId', 'stake'].map((f) => `opportunities[].verification.legs[].${f}`),
      ...['currentOdds', 'eventKey', 'eventUrl', 'handicap', 'live', 'marketKey', 'odds', 'payout', 'selection', 'side', 'sourceId', 'stake'].map((f) => `middles[].verification.legs[].${f}`),
    ],
    reason: [
      'The pass writes verification.legs and then reads it again nowhere: it is the input legs plus',
      'currentOdds, the prices the books actually quoted at confirmation time. 29 leaves, 0 readers,',
      'and the page deliberately shows the verdict instead — scanner.js puts the reason on the status',
      'chip and ai.js renders only confirmed cards.',
    ].join(' '),
    measuredBy: 'the overlay is the pass output, and no page reads below its status',
  },
  {
    id: 'ev-leg-restatement',
    covers: ['consensusProbability', 'evPercent', 'eventKey', 'live', 'marketKey', 'selection', 'sport', 'type']
      .map((f) => `positiveEv[].legs[].${f}`),
    reason: [
      'A restatement of the parent, measured rather than argued: 8 of the 13 fields on',
      'positiveEv[].legs[0] are byte-identical to the signal above them, which the page does read.',
      'The spread is withBankroll copying the whole signal into its single leg so the shape matches',
      'the other families. Two left this group when the ArbEdge console landed, and both are the',
      'fields a row needs to be actionable: sourceId is the book the filter box searches, and odds',
      'is the price the EV was computed from.',
    ].join(' '),
    measuredBy: 'the positive-EV leg restates its parent on every driven record',
  },
  {
    id: 'envelope-marker',
    covers: ['schemaVersion', 'id'],
    reason: [
      'Envelope markers, not page state. Both are required keys in',
      'test/scan-contract.test.mjs:39-43, which asserts an empty scan has exactly the keys a real scan',
      'has, so their presence is pinned; id is minted per run as scan-<Date.now()>.',
    ].join(' '),
    measuredBy: 'the scan contract already requires both envelope keys',
  },
  {
    id: 'duplicate-window',
    covers: ['dataHealth.liveMaxAgeMs'],
    reason: [
      'The same number twice. dataHealth.liveMaxAgeMs and options.liveMaxAgeMs are both 90000 on this',
      'run, and the page reads the copy under options — the line that prints the in-play window. The',
      'banner reads the prematch sibling because a stale verdict is judged against the prematch window.',
    ].join(' '),
    measuredBy: 'the two windows carry the same value',
  },
  {
    id: 'unreached-settings',
    covers: ['options.includePast', 'options.minEvPercent', 'options.prematchMaxAgeMs', 'options.sourceIds'],
    reason: [
      'Four settings of 11. includePast and sourceIds are null on a full run and the preview always',
      'sends includePast false; minEvPercent has no field in the scan form, so there is nowhere to put',
      'it; prematchMaxAgeMs is the same 600000 as the dataHealth copy connection-status.js reads. The',
      'other 6 now seed the form that re-runs the scan.',
    ].join(' '),
    measuredBy: 'the settings the page does take over are 6 of 11',
  },
  {
    id: 'unread-leg-money',
    covers: [
      'opportunities[].legs[].outcome', 'opportunities[].legs[].payout',
      'middles[].legs[].payout',
      'positiveEv[].legs[].payout', 'positiveEv[].legs[].profit',
    ],
    reason: [
      'The 5 with no reader and no restatement. This group had 8 covers and lost 3 to a measurement:',
      'arbitrage.js:103 prints the book own page off every leg and arbitrage.js reads the middle',
      'leg stake off the same rows, so eventUrl on the 3 arbitrage legs and the 4 middle legs, and',
      'middles[].legs[].stake beside them, have a reader — verifySignal still reads neither. outcome is',
      'what verifySignal derives from the selection, never what it reads. payout and stake on a middle',
      'leg restate the parent totalStake.',
    ].join(' '),
    measuredBy: 'eventUrl rides every leg and is read by the page, not by verifySignal',
  },
  {
    id: 'contract-descriptor',
    covers: ['opportunities[].family', 'opportunities[].period', 'opportunities[].line'],
    reason: [
      'Which contract the engine resolved. The driven workspace exercises 1 contract family, so this',
      'census does NOT claim the field is constant — it records the family that produced the run. The',
      'page prints marketKey, the provider own name for the same market.',
    ].join(' '),
    measuredBy: 'the descriptor is resolved per contract family, not fixed',
  },
  {
    id: 'allocation-detail',
    covers: ['opportunities[].inverseSum'],
    reason: [
      'The input to a number the row already prints, and recoverable from it. On the',
      'driven arbitrage inverseSum is 0.61453 and (1 - inverseSum) * 100 is 38.55, the exact',
      'marginPercent on screen. Derived in market-contracts.mjs, both operands read. Two fields',
      'left this group when the ArbEdge console landed: worstCasePayout is printed on the foot of',
      'every arbitrage card, and the rounding flag is marked on the row — neither is reconstructible',
      'from the margin, which is why the flag was never in this group.',
    ].join(' '),
    measuredBy: 'the margin on screen is computed from the inverse sum',
  },
  {
    id: 'middle-money',
    covers: ['middles[].guaranteedProfit'],
    reason: [
      'withBankroll writes guaranteedProfit: null on every middle by construction — a middle can lose,',
      'so there is no guaranteed profit to quote. All 2 middles of the driven run carry null, which is',
      'the 2 of 2. Two more fields left this group when the ArbEdge console landed: totalStake and',
      'league are both printed on its middle row, and neither is reconstructible from what the row',
      'already shows.',
    ].join(' '),
    measuredBy: 'no middle has a guaranteed profit to publish',
  },
  {
    id: 'ev-money',
    covers: ['positiveEv[].roiPercent', 'positiveEv[].totalStake', 'positiveEv[].guaranteedProfit'],
    reason: [
      'withBankroll mirrors the arb shape onto a signal with no arbitrage in it, and all 3 mirrors',
      'hold on 8 of the 8 driven positive-EV records: roiPercent is evPercent, which the EV column',
      'already prints, guaranteedProfit is null on all 8, and totalStake is the capped-Kelly stake',
      'whose per-leg copy the page does read.',
    ].join(' '),
    measuredBy: 'the mirrored fields repeat what the EV column already shows',
  },
];

// ---------------------------------------------------------------------------
// The census.
// ---------------------------------------------------------------------------

test('every family is populated, so an empty one cannot hide a leaf behind it', async () => {
  const scan = await driveScan();
  for (const family of ['opportunities', 'middles', 'positiveEv', 'lowHold']) {
    assert.ok(
      Array.isArray(scan[family]) && scan[family].length > 0,
      `${family} came back empty, so its leaves would be missing from the census as absences`,
    );
  }
  assert.equal(Object.keys(scan).length, 15, 'the envelope, the five families, the summary and the route flag');
});

test('the published set is 172 leaves, and the reader is not reporting zeros', async () => {
  const doc = await publishedScan();
  const published = new Set();
  leaves(doc, '', published);
  assert.equal(published.size, 172, 'the leaf count moved: a field was added or dropped upstream');

  const { perPage } = await readPaths();
  // A reader that threw records almost nothing, and a census built on its
  // silence would report every field it never reached as unread. The floors are
  // per reader because the readers are not the same size: connection-status
  // decides a banner from two fields, the scanner page draws four tables.
  assert.deepEqual(Object.keys(perPage).sort(), Object.keys(FLOOR).sort(), 'a reader was added or dropped');
  for (const [page, floor] of Object.entries(FLOOR)) {
    assert.ok(perPage[page] > floor, `${page} touched ${perPage[page]} paths, under its floor of ${floor}: it threw, and the census would be reading its silence`);
  }
});

test('the reader set is derived from the pages, and prose is not a call', () => {
  assert.deepEqual(SCAN_CONSUMERS, ['ai.js', 'analytics.js', 'arbitrage.js', 'bookies.js', 'dashboard.js', 'live.js', 'scanner.js', 'scrape.js'],
    'the set of pages that fetch this route moved: the new one has to be read, not assumed');

  // Both directions of the rule, because a derivation is only worth its cost if
  // it cannot pass on either side. The masker is what makes the second one
  // necessary: scrape.js names this route in three sentences of prose, one of
  // them on a line that would match without it.
  assert.ok(isConsumer("const s = await arbiterApi.get('/api/scan');"),
    'the rule stopped matching a real call to the route');
  assert.equal(isConsumer("// the page calls arbiterApi.get('/api/scan') on load\n"), false,
    'a comment was counted as a consumer of the route');

  // And the rule's blind spot is fenced rather than assumed: every line of code
  // that names the route has to be a call on arbiterApi, so a sixth consumer
  // spelled differently stops here instead of vanishing from the census.
  const unexplained = [];
  for (const f of PAGE_NAMES) {
    codeOnly(read(`public/js/pages/${f}`)).split(/\r?\n/).forEach((line, i) => {
      if (line.includes("'/api/scan'") && !line.includes('arbiterApi.')) {
        unexplained.push(`${f}:${i + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(unexplained, [], 'a line names this route without a call the reader set can see');
});

test('the route comment counts the consumers this census runs', () => {
  // It said "four pages" and was right — for exactly as long as the list of
  // readers was typed by hand and agreed with it. The two drifted together, so
  // the comment could never have caught the omission; now the number in the
  // comment is the number measured here, and a sixth consumer breaks both.
  const route = read('src/router.mjs');
  const start = route.indexOf("'GET /api/scan'");
  const block = route.slice(start, start + 700);
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  assert.ok(start > 0, 'the route key is no longer in router.mjs, so this comment cannot be pinned to it');
  assert.match(block, new RegExp(`here ${WORDS[SCAN_CONSUMERS.length]} page`),
    'the route comment still counts the pages by hand, and now says a different number than this census runs');
});

test('the lifted page reads the document it fetches', async () => {
  const { perPage, perPagePaths } = await readPaths();

  // Five of the eleven paths this page touches are payload paths; `.length` and
  // `then` are the machinery the proxy walks to reach them. Pinned by name
  // because a floor cannot tell "reads the four families and the flag" from
  // "touched something" — and this is the consumer whose reads were missing.
  assert.deepEqual(
    perPagePaths['scrape.js'].filter((p) => !NOT_PAYLOAD.test(p)),
    ['lowHold', 'middles', 'opportunities', 'positiveEv', 'published'],
    'scrape.js no longer reads exactly the document it fetches',
  );
  assert.ok(perPage['scrape.js'] > FLOOR['scrape.js'],
    `scrape.js touched ${perPage['scrape.js']} paths, under its floor: the lift is not reaching the page's own code`);

  // The lift runs the page's declarations, so a helper typed into the harness
  // cannot stand in for one the page has.
  const lifted = liftedSource('scrape.js', LIFTED_READERS['scrape.js']);
  assert.equal(lifted.dollar, read('public/js/pages/scrape.js').split(/\r?\n/)[1],
    'the lift stopped using the page\'s own `$`, so the harness would be drawing through a helper scrape.js does not have');
});

test('the reader instrument finds reads it is supposed to find', async () => {
  // Not vacuous. Each of these is read by a page today, and has to be found by
  // the same executed search that finds the absences, or the census is a list
  // of things the instrument failed to see.
  const { hits } = await readPaths();
  for (const name of [
    'opportunities[].marginPercent', 'opportunities[].legs[].stake',
    'middles[].riskPercent', 'middles[].gap',
    'positiveEv[].evPercent', 'positiveEv[].consensusProbability',
    'lowHold[].holdPercent', 'lowHold[].selectionCount',
    'dataHealth.actionableSourceCount', 'dataHealth.prematchMaxAgeMs',
    'verificationSummary.unconfirmed', 'opportunities[].verification.reason',
    'options.bankroll', 'options.liveMaxAgeMs', 'published', 'scrapeRunId',
  ]) {
    assert.ok(hits.has(name), `${name} is read today and the instrument that must find it does not`);
  }
});

test('every field the scan publishes is read by a page, or is named with a reason', async () => {
  const doc = await publishedScan();
  const published = new Set();
  leaves(doc, '', published);
  const inScope = [...published].filter((p) => !isSourceBranch(p)).sort();
  const { hits } = await readPaths();
  const unread = inScope.filter((p) => !hits.has(p));

  const excused = new Map();
  for (const group of UNREAD_BY_DESIGN) {
    for (const name of group.covers) {
      assert.ok(!excused.has(name), `${name} is excused twice: ${excused.get(name)} and ${group.id}`);
      excused.set(name, group.id);
    }
  }

  const unaccounted = unread.filter((p) => !excused.has(p));
  assert.deepEqual(unaccounted, [], `no page reads these and no reason covers them: ${unaccounted.join(', ')}`);

  const stale = [...excused.keys()].filter((p) => !unread.includes(p));
  assert.deepEqual(stale, [], `excused but now read, so the reason stopped holding: ${stale.join(', ')}`);

  // A reason with no number in it is an opinion. This runs before any length
  // check so a long sentence cannot stand in for a measurement.
  //
  // `measuredBy` naming a test that does not exist is the same failure one step
  // along: the excuse looks backed, and nothing ever checks the back. So the
  // name has to be a `test('…')` declaration in this file, read out of this
  // file's own source — the census cannot enumerate its siblings at runtime.
  const selfSource = read('test/scan-fields-census.test.mjs');
  for (const group of UNREAD_BY_DESIGN) {
    assert.match(group.reason, /\d/, `${group.id} needs a measurement, not an opinion`);
    assert.ok(group.reason.length > 60, `${group.id} needs a reason, not a word`);
    assert.ok(group.measuredBy, `${group.id} names no test that measures its claim`);
    const named = group.measuredBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      selfSource,
      new RegExp(`test\\('${named}'`),
      `${group.id} is backed by "${group.measuredBy}", which is not a test in this file`,
    );
  }
  // 73 was 8 excused leg fields of which 3 turned out to have a reader once the
  // harness could actually run the pages, so 70 is 73 minus exactly those 3.
  // 66 is then 70 minus the 4 `type` fields: the console classifies every row it
  // draws - that classification picks the card colour and the market chip - so
  // the kind of signal stopped being structural and became a field it reads.
  // 67 adds middles[].verification.legs[].side, which rides along inside the
  // re-quote overlay: the pass copies the input legs there and the page shows
  // the verdict, not the legs it was handed.
  assert.equal(unread.length, 67, `the unread set moved: ${unread.length} — ${unread.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The measurements the reasons above rest on.
// ---------------------------------------------------------------------------

test('the verification pass reads the leg names it is excused for', async () => {
  await driveScan();
  const { leg } = serverReads();
  assert.equal(leg.length, 11, `verifySignal now reads ${leg.length} leg names: ${leg.join(', ')}`);
  for (const name of ['marketId', 'providerEventId', 'selectionId', 'kickoff', 'live']) {
    assert.ok(leg.includes(name), `${name} was read before and the excuse credits the pass for it`);
  }
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'requote-scope');
  for (const path of group.covers) {
    const field = path.split('.').pop();
    assert.ok(leg.includes(field), `${path} is excused as re-quote scope but verifySignal does not read ${field}`);
  }
});

test('the overlay is the pass output, and no page reads below its status', async () => {
  await driveScan();
  assert.deepEqual(OVERLAY_NAMES.overlay, ['status', 'reason', 'legs'], 'the merge changed shape');
  assert.deepEqual(OVERLAY_NAMES.summary, ['confirmed', 'rejected', 'expired', 'unconfirmed', 'at']);
  const { hits } = await readPaths();
  for (const family of ['opportunities[]', 'middles[]']) {
    assert.ok(hits.has(`${family}.verification.status`), `the overlay status on ${family} is read`);
  }
  const belowStatus = [...hits].filter((p) => /verification\.[a-z]+\[\]/.test(p));
  assert.deepEqual(belowStatus, [], `a page reads inside the re-quote record: ${belowStatus.join(', ')}`);
});

test('the positive-EV leg restates its parent on every driven record', async () => {
  const scan = await driveScan();
  const stats = restatements();
  assert.equal(stats.positiveEv.equal.length, 10, `restatements moved: ${stats.positiveEv.equal.join(', ')}`);
  assert.equal(stats.positiveEv.legs, 8, 'the positive-EV sample shrank, so the count means less');
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'ev-leg-restatement');
  // 8, not the 10 the restatement measurement finds: `sourceId` and `odds` are
  // still byte-identical to their parent, but a page now reads both, so they are
  // no longer unread by design and do not belong in this excuse.
  assert.equal(group.covers.length, 8);
  for (const path of group.covers) {
    const field = path.split('.').pop();
    assert.ok(stats.positiveEv.equal.includes(field), `${path} is excused as a restatement but ${field} differs from its parent`);
  }
});

test('every family carries exactly one type value', async () => {
  const scan = await driveScan();
  assert.deepEqual(distinct(scan.opportunities.map((o) => o.type)), ['arb']);
  assert.deepEqual(distinct(scan.middles.map((m) => m.type)), ['middle']);
  assert.deepEqual(distinct(scan.positiveEv.map((e) => e.type)), ['positive_ev']);
  assert.deepEqual(distinct(scan.lowHold.map((l) => l.type)), ['low_hold']);
});

test('the scan contract already requires both envelope keys', async () => {
  const contract = codeOnly(read('test/scan-contract.test.mjs'));
  for (const key of UNREAD_BY_DESIGN.find((g) => g.id === 'envelope-marker').covers) {
    assert.match(contract, new RegExp(`'${key}'`), `${key} is excused as an envelope marker the contract does not require`);
  }
});

test('the two windows carry the same value', async () => {
  const scan = await driveScan();
  assert.equal(scan.dataHealth.liveMaxAgeMs, scan.options.liveMaxAgeMs);
  assert.equal(scan.dataHealth.prematchMaxAgeMs, scan.options.prematchMaxAgeMs);
  assert.equal(scan.options.liveMaxAgeMs, 90000);
  assert.equal(scan.options.prematchMaxAgeMs, 600000);
});

test('the settings the page does take over are 6 of 11', async () => {
  const scan = await driveScan();
  const settings = Object.keys(scan.options);
  assert.equal(settings.length, 11, `options changed shape: ${settings.join(', ')}`);
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'unreached-settings');
  assert.equal(group.covers.length, 4);
  for (const path of group.covers) {
    assert.ok(settings.includes(path.split('.').pop()), `${path} is excused but options no longer publishes it`);
  }
});

test('eventUrl rides every leg and is read by the page, not by verifySignal', async () => {
  await driveScan();
  const { leg } = serverReads();
  assert.ok(!leg.includes('eventUrl'), 'verifySignal reads eventUrl now, so the excuse is stale');
  const { perPagePaths } = await readPaths();
  const reading = Object.entries(perPagePaths)
    .filter(([, paths]) => paths.some((p) => p.endsWith('.eventUrl')))
    .map(([page]) => page)
    .sort();
  // Measured: arbitrage.js is the only page that reads it, off both families —
  // `arbitrage.js:103` decides between the capture feed and the book own page and
  // links whichever it is. It used to read nowhere, and this is the assertion
  // that would have said so: the count was 0 only because the harness threw
  // before the pages could draw, and the excuse it supported was already false
  // in the source.
  assert.deepEqual(reading, ['arbitrage.js'], 'the set of pages reading eventUrl moved');
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'unread-leg-money');
  for (const path of ['opportunities[].legs[].eventUrl', 'middles[].legs[].eventUrl']) {
    assert.ok(!group.covers.includes(path), `${path} is read now, so it is not excused`);
  }
});

test('no middle has a guaranteed profit to publish', async () => {
  const scan = await driveScan();
  assert.ok(scan.middles.length > 0);
  for (const m of scan.middles) {
    assert.equal(m.guaranteedProfit, null, 'a middle now claims a guaranteed profit');
    assert.ok(Number.isFinite(m.totalStake));
  }
});

test('the mirrored fields repeat what the EV column already shows', async () => {
  const scan = await driveScan();
  assert.ok(scan.positiveEv.length > 0);
  // The count is quoted in the reason, so it is pinned here: a reason whose
  // number cannot move with the fixture is a number somebody typed once.
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'ev-money');
  assert.equal(group.covers.length, 3);
  assert.match(group.reason, new RegExp(`${scan.positiveEv.length} of the ${scan.positiveEv.length}`), 'the reason quotes a count the run no longer produces');
  for (const e of scan.positiveEv) {
    assert.equal(e.roiPercent, e.evPercent);
    assert.equal(e.guaranteedProfit, null);
    assert.equal(e.totalStake, (e.legs || [])[0]?.stake);
  }
});

test('the margin on screen is computed from the inverse sum', async () => {
  const scan = await driveScan();
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'allocation-detail');
  assert.deepEqual(group.covers, ['opportunities[].inverseSum']);
  for (const o of scan.opportunities) {
    const recomputed = (1 - o.inverseSum) * 100;
    assert.ok(
      Math.abs(recomputed - o.marginPercent) < 0.01,
      `marginPercent ${o.marginPercent} is not 1 - the inverse sum ${o.inverseSum} rounded, so the excuse is wrong`,
    );
    assert.ok(
      Math.abs(o.worstCasePayout - (o.totalStake + o.guaranteedProfit)) < 0.01,
      `worstCasePayout ${o.worstCasePayout} is not the stake plus the profit, so the excuse is wrong`,
    );
  }
  // A run proves an identity on its own records. It cannot tell a derivation
  // from a hardcoded coincidence, so the two claims the reason makes about
  // market-contracts.mjs are pinned against its source as well. Both hold on
  // the driven run; this says they hold because of the code.
  //
  // It used to pin three literals and assert a fourth, `const theoreticalProfit
  // = total * (1 / inverseSum - 1)`, as the backing for a claim about a
  // theoretical profit. That const had no reader — ESLint's no-unused-vars
  // reported it, and the value it computed was never on the published document
  // — so it was deleted. Pinning a dead line would have made the census refuse
  // the only correct repair, which is why the third literal is gone with it.
  const contracts = codeOnly(read('src/scanner/market-contracts.mjs'));
  assert.match(contracts, /marginPercent: round2\(\(1 - inverseSum\) \* 100\)/, 'the margin is no longer derived from the inverse sum');
  assert.match(contracts, /const guaranteedProfit = round2\(worstCasePayout - total\)/, 'the worst case is no longer the stake plus the profit');
  assert.doesNotMatch(contracts, /theoreticalProfit/, 'a theoretical profit is computed here again without being published');
});

test('the rounding flag is read by a page, not excused', async () => {
  // It used to sit in the allocation-detail excuse, described as a number
  // "describing the cent-level rounding of the stake split". The allocator
  // writes a flag (`roundingRisk: guaranteedProfit < 0`, event-arbs.mjs
  // typedefs it boolean), the excuse described a field that does not exist, and
  // the measurement meant to back it failed on Number.isFinite(false). So it was
  // measured instead of argued: the flag fires on real allocations, a page
  // cannot reconstruct it from what it already prints, and it is now marked on
  // the row. See bankroll-allocation.test.mjs for the reachability sweep.
  //
  // Scope, so this is not read as a claim that nothing disclosed the flag:
  // event-detail-modal.js:380 already renders it, on the /api/event-detail
  // payload, whose arbitrage plans come from src/scanner/event-arbs.mjs. That
  // page is not a reader of this document, which is the whole point of the
  // finding — one engine flag, disclosed on one surface, silent on the other.
  const group = UNREAD_BY_DESIGN.find((g) => g.id === 'allocation-detail');
  assert.ok(!group.covers.includes('opportunities[].roundingRisk'), 'the flag is excused again');
  assert.ok(!group.reason.includes('roundingRisk is'), 'and the reason describes it as a number again');
  assert.match(
    read('public/js/pages/event-detail-modal.js'),
    /arb\.roundingRisk \|\| guaranteed < 0/,
    'the sibling disclosure moved, so the note above it is wrong',
  );

  const scan = await driveScan();
  for (const o of scan.opportunities) {
    assert.equal(typeof o.roundingRisk, 'boolean', 'if this is a number again, the page badge is wrong');
  }
  const { hits } = await readPaths();
  assert.ok(hits.has('opportunities[].roundingRisk'), 'no page reads the flag, so the excuse was right after all');
});

test('the descriptor is resolved per contract family, not fixed', async () => {
  const scan = await driveScan();
  // The one thing this excuse must NOT claim is that family/period/line are
  // constant: the driven workspace only exercises MATCH_ODDS, so a test that
  // read constancy off it would be reading the fixture, not the engine.
  assert.deepEqual(distinct(scan.opportunities.map((o) => o.family)), ['MATCH_ODDS']);
  const engine = codeOnly(read('src/scanner/engine.mjs'));
  assert.match(engine, /family: b\.contract\.family/, 'the family is read off the resolved contract');
  assert.match(engine, /period: b\.contract\.period/);
});