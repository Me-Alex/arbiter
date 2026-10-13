/**
 * sports-payload-census.test.mjs — `GET /api/sports` from both ends: the body
 * the real router serves, the pages that fetch it, and the reads they make on
 * it, with both ends executed rather than read off the source.
 *
 * The route is three lines in src/router.mjs and it was the one served payload
 * in this tree with no read-side check at all: settings-page-wiring.test.mjs
 * stubs `arbiterApi.get` with `{ sports: [] }`, which is a fixture the page in
 * that test never reads, so nothing ever compared the real body against a real
 * reader. Three pages fetch it (derived below by grep over public/ and
 * electron/, then confirmed by execution), and one of them — settings.js —
 * turns out to fetch it and store the envelope without touching a single node
 * of it, which no test would have surfaced either.
 *
 * Three instruments, one per claim:
 *
 *   served   buildRouter + route() with a real req/res, so the body is what a
 *            client receives. The expectation is not a literal: it is derived
 *            from sportOptions(), the registry the route calls, so adding a
 *            field the registry does not produce fails here.
 *   fetched  a page executed in a vm with a recording arbiterApi. grep and
 *            execution are compared in both directions, because grep cannot
 *            see `'/api/' + 'sports'` and execution cannot see a page nobody
 *            runs.
 *   read     every property access on the served body, classified against that
 *            same body. A read of a key the payload does not carry is a phantom
 *            (the frontend waiting on a field the backend stopped sending); a
 *            served node nobody reads is silence (the backend publishing what
 *            the frontend ignores). Both directions are asserted.
 *
 * What this file cannot see: a page that fetches the payload inside a handler
 * that never runs during load. The consumer census executes each page once, at
 * load — that is the moment all three current consumers fetch — so a fetch
 * behind a click would show up as "mentioned in code, never fetched" and the
 * sentence here would be wrong rather than silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ENDPOINT = '/api/sports';
const PAGE_DIR = 'public/js/pages';

const posix = (p) => p.replace(/\\/g, '/');

/* ── served side: the router, executed ────────────────────────────────────── */

/**
 * Dispatch `GET /api/sports` through the real router and return what a client
 * would receive. `sendJson(null, …)` returns `{ status, body }` internally, but
 * the route is called through `route()` rather than reached inside the handler
 * object so that the local-only check, the rate limiter and the dispatch itself
 * are part of the measurement too — a route that stopped matching would fail
 * here instead of failing in a test that imports the handler directly.
 *
 * @returns {Promise<{status: number, payload: object}>}
 */
async function serveSports() {
  const { buildRouter } = await import('../src/router.mjs');
  const route = buildRouter({
    dataDir: join(ROOT, 'data'),
    publicDir: join(ROOT, 'public'),
    configPath: join(ROOT, 'data', 'config.json'),
    profilesPath: join(ROOT, 'data', 'profiles.json'),
  });
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { chunks.push(chunk); },
  };
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  await route(req, res, new URL(`http://127.0.0.1:3080${ENDPOINT}`));
  const raw = chunks.join('');
  return { status: res.statusCode, payload: JSON.parse(raw) };
}

/**
 * Every node of a payload as a normalised path: `sports`, `sports[]`,
 * `sports[].id`. Branches count as nodes because a page that reads only the
 * envelope has read the envelope — leaving it out would make `d.sports` look
 * like a read of nothing.
 *
 * @param {*} value
 * @param {string} [path]
 * @param {Set<string>} [out]
 * @returns {Set<string>}
 */
function payloadNodes(value, path = '', out = new Set()) {
  if (value === null || typeof value !== 'object') {
    if (path) out.add(path);
    return out;
  }
  if (path) out.add(path);
  if (Array.isArray(value)) {
    for (const element of value) payloadNodes(element, `${path}[]`, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    payloadNodes(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/**
 * Resolve one recorded access against the payload it was recorded on.
 *
 * Three outcomes, and the middle one is the reason this is a walk rather than a
 * string compare: `.map`, `.length` and `then` are recorded by the proxy but
 * are not payload keys, and reporting them as phantoms would make the census
 * red on ordinary iteration. A key the payload does not carry is different —
 * that is the frontend reading a field the backend does not send.
 *
 * @param {object} payload
 * @param {string} readPath e.g. `sports.0.id`
 * @returns {{kind: 'node'|'phantom'|'method', path?: string}}
 */
function classify(payload, readPath) {
  let current = payload;
  // Built as a string rather than as parts joined with '.', because the array
  // marker belongs to the segment before it: `sports` + `[]` + `id` is
  // `sports[].id`, and joining parts would print `sports.[].id` — which is not
  // a path payloadNodes ever produces, so every array read would report as
  // unread while the page that made it sat green two tests away.
  let path = '';
  for (const segment of readPath.split('.')) {
    if (current === null || typeof current !== 'object') return { kind: 'method' };
    if (Array.isArray(current)) {
      // `length`, `map`, `filter` are array machinery; an index is data.
      if (!/^\d+$/.test(segment)) return { kind: 'method' };
      if (!(segment in current)) return { kind: 'phantom', path: readPath };
      path = `${path}[]`;
      current = current[segment];
      continue;
    }
    const next = current[segment];
    if (typeof next === 'function') return { kind: 'method' };
    if (!(segment in current) && next === undefined) return { kind: 'phantom', path: readPath };
    path = path ? `${path}.${segment}` : segment;
    current = next;
  }
  return { kind: 'node', path };
}

/* ── consumer side: each page executed against a recording arbiterApi ─────── */

/** Reads that are artefacts of awaiting/creating the proxy, not payload keys. */
const SYNTHETIC = new Set(['(root)', 'then']);

/**
 * Wrap a payload so every property access lands in `hits`. Same recorder as
 * api-gateway-census.test.mjs: array methods run with `this` bound to the
 * wrapper, which is what makes element reads (`sports.0.id`) visible at all.
 *
 * @param {*} value
 * @param {string} path
 * @param {Set<string>} hits
 * @returns {*}
 */
function record(value, path, hits) {
  if (value === null || typeof value !== 'object') return value;
  hits.add(path || '(root)');
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      const child = path ? `${path}.${String(prop)}` : String(prop);
      hits.add(child);
      const raw = target[prop];
      if (typeof raw === 'function') {
        const self = record(target, path, hits);
        return (...args) => raw.apply(self, args);
      }
      return record(raw, child, hits);
    },
  });
}

function nodeStub() {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    checked: false,
    hidden: false,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    querySelector() { return nodeStub(); },
    querySelectorAll() { return []; },
    nextElementSibling: null,
    options: [],
    appendChild() {},
    insertAdjacentHTML() {},
    remove() {},
    focus() {},
    click() {},
    scrollIntoView() {},
  };
}

const EMPTY_SCAN = {
  opportunities: [],
  middles: [],
  positiveEv: [],
  lowHold: [],
  sources: [],
  published: false,
  options: {},
  dataHealth: { status: 'empty', sources: {}, actionableSourceCount: 0 },
};

/**
 * Run one page script in a fresh vm and record what it did with `/api/sports`.
 *
 * Every other route answers a fixed empty document so a page reaches its
 * sports fetch instead of failing on the call before it; failures after that
 * point are caught and kept rather than thrown, because a page that breaks
 * mid-load is a fact about the page and the census reports it through the
 * claims below (a consumer that never fetches, a row that never reaches the
 * dropdown) rather than through an exception from the harness.
 *
 * @param {string} file file name inside PAGE_DIR
 * @param {object} servedPayload the real served body, handed to the recorder
 * @returns {Promise<{fetches: string[], hits: string[], dropdowns: {id: string, opts: *}[], error: Error|null}>}
 */
async function runPage(file, servedPayload) {
  const hits = new Set();
  const fetches = [];
  const dropdowns = [];
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, nodeStub());
    return byId.get(id);
  };
  const api = {
    async get(path) {
      fetches.push(path);
      if (path === ENDPOINT) return record(servedPayload, '', hits);
      if (path === '/api/scan') return JSON.parse(JSON.stringify(EMPTY_SCAN));
      if (path === '/api/profiles') return { profiles: [] };
      if (path === '/api/catalog') return { markets: [], events: [] };
      if (path === '/api/scrape-run') return { runId: null, status: 'idle', jobs: [] };
      if (path === '/api/live') return { enabled: false, intervalSeconds: 60, books: [], lastRun: null };
      if (path === '/api/alerts') return { preferences: {}, alerts: [], schemaVersion: 1 };
      if (path === '/api/scheduler') return { enabled: false, intervalMinutes: 0, books: [], lastRun: null };
      if (path === '/api/scrape/state') return { state: {} };
      if (path === '/api/scrapers') return { jobs: [] };
      if (path === '/api/health') return { ok: true, uptimeSeconds: 1, timestamp: 'x' };
      return {};
    },
    async post() { return {}; },
    async put() { return {}; },
    async del() { return {}; },
  };

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: get,
      querySelector: () => nodeStub(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => nodeStub(),
      documentElement: {},
      body: nodeStub(),
    },
    escapeHtml: (v) => String(v ?? ''),
    createDropdown: (id, opts) => { dropdowns.push({ id, opts }); },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? 'en' : null), setItem() {}, removeItem() {} },
    location: { href: '' },
    history: {},
    prompt() {},
    alert() {},
    confirm() { return true; },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    queueMicrotask() {},
    JSON,
    Date,
    Math,
    URL,
    URLSearchParams,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  };
  ctx.window = {
    arbiterConnectionStatus: null,
    arbiterApp: { mount() {} },
    arbiterFormat: null,
    arbiterI18n: null,
    arbiterApi: api,
    arbiterSse: { connect() {} },
    addEventListener() {},
    showToast() {},
    setInterval() { return 0; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
    confirm() { return true; },
  };
  ctx.globalThis = ctx;
  ctx.arbiterApi = api;
  ctx.arbiterApp = ctx.window.arbiterApp;
  ctx.arbiterSse = ctx.window.arbiterSse;
  ctx.arbiterFormat = null;
  ctx.arbiterConnectionStatus = null;

  // i18n first: pages call arbiterI18n.t() while building their controls, and a
  // missing dictionary would stop a page before its sports fetch rather than
  // after it, which would be the harness failing, not the page.
  vm.runInNewContext(read('public/js/i18n.js'), ctx);
  ctx.arbiterI18n = ctx.window.arbiterI18n ?? ctx.arbiterI18n;
  ctx.window.arbiterI18n = ctx.arbiterI18n;

  let error = null;
  try {
    vm.runInNewContext(read(`${PAGE_DIR}/${file}`), ctx);
  } catch (e) {
    error = e;
  }
  await new Promise((resolve) => setTimeout(resolve, 60));

  return {
    fetches,
    hits: [...hits].filter((k) => !SYNTHETIC.has(k)).sort(),
    dropdowns,
    error,
  };
}

/** Every JS file a consumer could live in, relative to ROOT. */
function codeFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = posix(`${dir}/${entry.name}`);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(rel);
    }
  };
  walk('public');
  walk('electron');
  return out.sort();
}

/* ── measurements, taken once and asserted by every test below ────────────── */

const SERVED = await serveSports();
const PAGES = readdirSync(join(ROOT, PAGE_DIR)).filter((f) => f.endsWith('.js')).sort();
const RUNS = new Map();
for (const page of PAGES) RUNS.set(page, await runPage(page, SERVED.payload));

const CODE_FILES = codeFiles();
const GREP_CONSUMERS = new Set(
  CODE_FILES.filter((f) => codeOnly(read(f)).includes(ENDPOINT)),
);
// Both sets are keyed by the same thing — the path relative to ROOT — because
// the first version keyed the greps on `public/js/pages/scanner.js` and the
// executions on `scanner.js`, and two sets that cannot ever intersect report
// "mentioned but never fetched" for every consumer while the very next test
// proves all three fetched.
const EXEC_CONSUMERS = new Set(
  PAGES.filter((f) => RUNS.get(f).fetches.includes(ENDPOINT)).map((f) => posix(`${PAGE_DIR}/${f}`)),
);

const servedNodes = payloadNodes(SERVED.payload);
const phantoms = [];
const readNodes = new Set();
for (const run of RUNS.values()) {
  for (const hit of run.hits) {
    const verdict = classify(SERVED.payload, hit);
    if (verdict.kind === 'phantom') phantoms.push(hit);
    if (verdict.kind === 'node') readNodes.add(verdict.path);
  }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

test('GET /api/sports is served by the real router and equals the registry', async () => {
  assert.equal(SERVED.status, 200, `route answered ${SERVED.status}`);
  // Derived, not asserted as a literal: the route's contract is "whatever the
  // sport registry offers", so a field the registry does not produce (or a
  // field the route drops) is what fails here.
  const { sportOptions } = await import('../src/sports/registry.mjs');
  assert.deepEqual(SERVED.payload, { sports: sportOptions() });
  assert.ok(servedNodes.size > 0, 'the served body carried no nodes at all');
});

test('the consumer set agrees between grep and execution, and is not empty', () => {
  const onlyGrep = [...GREP_CONSUMERS].filter((f) => !EXEC_CONSUMERS.has(f)).sort();
  const onlyExec = [...EXEC_CONSUMERS].filter((f) => !GREP_CONSUMERS.has(f)).sort();
  assert.deepEqual(onlyGrep, [], 'mentioned in code but never fetched when the page is executed');
  assert.deepEqual(onlyExec, [], 'fetched when executed but the literal is not in any source file');
  assert.ok(GREP_CONSUMERS.size > 0, 'no page fetches GET /api/sports — the route has no reader');
});

test('every served node is read, and every read is a node the payload carries', () => {
  assert.deepEqual([...new Set(phantoms)].sort(), [], 'reads a key the payload does not carry');
  const unread = [...servedNodes].filter((n) => !readNodes.has(n)).sort();
  assert.deepEqual(unread, [], 'served but never read by any executed page');
});

/**
 * The one excuse in this file, with the three parts an excuse owes:
 *
 *   what      settings.js fetches GET /api/sports, stores the whole envelope in
 *             `state.sports`, and never reads a node of it. The fetch is real
 *             work that reaches no control — measured below, not remembered.
 *   measured  execution: the recorded hits for settings.js contain no payload
 *             node (the test that follows asserts exactly that, so the claim
 *             cannot rot), and settings.js:35/61 are the only lines that touch
 *             `sports` — a declaration and a write, no read.
 *   staleness the test below goes red the moment settings.js reads any node or
 *             stops fetching, which is the two ways this excuse expires: a
 *             reader appears (the excuse's "never reads" is then false) or the
 *             fetch goes away (the excuse's "fetches" is then false).
 *
 * Left in place rather than fixed because removing the fetch is a product
 * decision — the settings page may yet render a sport list — and a census that
 * quietly edits the page it is measuring is not a census.
 */
const SETTINGS_EXCUSE = {
  id: 'settings-fetches-without-reading',
  page: 'settings.js',
  reads: () => classifyNodes(RUNS.get('settings.js')),
  fetches: () => RUNS.get('settings.js').fetches.includes(ENDPOINT),
};

/** The payload nodes one page actually read, in sorted order. */
function classifyNodes(run) {
  const nodes = new Set();
  for (const hit of run.hits) {
    const verdict = classify(SERVED.payload, hit);
    if (verdict.kind === 'node') nodes.add(verdict.path);
  }
  return [...nodes].sort();
}

test('the settings.js excuse still describes settings.js', () => {
  assert.equal(
    SETTINGS_EXCUSE.fetches(),
    true,
    'settings.js no longer fetches GET /api/sports — the excuse claiming it does is stale',
  );
  assert.deepEqual(
    SETTINGS_EXCUSE.reads(),
    [],
    'settings.js now reads the payload — the excuse claiming it reads nothing is stale; update it or delete the fetch',
  );
});

test('every served row reaches the sport filter as one option', () => {
  const rows = SERVED.payload.sports;
  assert.ok(Array.isArray(rows) && rows.length > 0, 'no rows served: this rule would pass vacuously');

  const filterPages = CODE_FILES.filter((f) => codeOnly(read(f)).includes('sport-filter'));
  assert.ok(filterPages.length > 0, 'nothing builds a sport filter any more');

  for (const file of filterPages) {
    const page = posix(file).split('/').pop();
    const run = RUNS.get(page);
    assert.ok(run, `${file} mentions sport-filter but is not a page this census executes`);

    assert.ok(
      run.fetches.includes(ENDPOINT),
      `${page} builds a sport filter but never fetches ${ENDPOINT} — the control has no data source`,
    );

    const options = run.dropdowns.flatMap((d) => (Array.isArray(d.opts) ? d.opts : []));
    for (const row of rows) {
      const covered = options.some((option) => option && typeof option === 'object'
        && Object.entries(row).every(([key, value]) => option.value === value || option.text === value));
      assert.ok(
        covered,
        `${page} never passes a served row (${JSON.stringify(row)}) to the filter — ` +
        'a field the backend serves and the control does not carry is the gap this census exists for',
      );
    }
  }
});
