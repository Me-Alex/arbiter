// The /api/events channel census.
//
// The other payloads in this tree are censused from the producer: the names a
// loader writes, read out of the loader. This channel publishes no document, it
// publishes a stream, so a census has to ask two different questions and both
// are answered by running the thing:
//
//   1. What can reach the wire? Driven, not searched. A real scrape is run end
//      to end — orchestrator, scraper batch, scanner, verification pass — with
//      the collection layer of two bookmakers replaced and everything else real,
//      and a real StateBroadcaster writes into a fake response. The frame types
//      and their payloads come back off the bytes, not out of a grep of the
//      emitters, so a type that is emitted from a branch nothing reaches, or a
//      leaf a payload only sometimes carries, is simply absent from the census
//      instead of being excused on theory.
//
//   2. Who reads it? Executed, for the reason the scan census records: `sse.js`
//      dispatches through `JSON.parse(e.data)`, so a recording Proxy handed to a
//      handler would be discarded and the reader would report zero. The
//      recording has to happen at the parse — that is the only place the wire
//      bytes become the object a page touches. The first version of this probe
//      wrapped the object instead and duly reported 0 reads across 106 leaves.
//
// The subscriber set is measured the same way: a recording EventSource inside a
// vm, so "the page listens for it" is answered by what `sse.js` registers rather
// than by reading its source.
//
// Two runs, not one. The first finds an arbitrage and therefore runs the
// verification pass, which is where six of the eight frame types come from; the
// second fails a book, which is the only way `jobs[].error` and a
// `completed-with-errors` status get onto the wire. One run's union would have
// excused both as unread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { ScrapeOrchestrator } from '../src/scrape-orchestrator.mjs';
import { StateBroadcaster } from '../src/state-broadcaster.mjs';
import Superbet from '../src/scrapers/superbet.mjs';
import Betano from '../src/scrapers/betano.mjs';
import { sanitizeResult } from '../src/shared/sanitize.mjs';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// The producer, driven.
// ---------------------------------------------------------------------------

/** Two books, one event, prices that leave room under the 1X2 inverse sum. */
const EVENT = (sourceId, odds) => ({
  id: `${sourceId}-e1`, sourceId, eventKey: 'k-arb', providerEventId: `p-${sourceId}`,
  sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
  homeTeam: 'Home', awayTeam: 'Away',
  markets: [{
    key: 'MATCH_ODDS', id: 'm1',
    selections: [
      { id: 's1', name: 'H', odds: odds[0] },
      { id: 's2', name: 'D', odds: odds[1] },
      { id: 's3', name: 'A', odds: odds[2] },
    ],
  }],
});

const JOBS = [
  { id: 'superbet', enabled: true, validationStatus: 'validated', engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' },
  { id: 'betano', enabled: true, validationStatus: 'validated', engine: 'top-events-v2-json', transport: 'betano-top-events-json', script: 'betano.mjs' },
];

/**
 * Replace a bookmaker's collection layer and nothing else.
 *
 * `fetchRaw`, `normalize` and `extractEvents` are the three steps that would
 * touch the network. Everything after them — the odds and settlement checks,
 * the atomic write, the staging promote, the envelope — is the real code, so
 * the workspace the scanner reads is a workspace the server actually wrote.
 *
 * `sourceUrl` is stamped here because the real adapter stamps it inside
 * `fetchRaw`, and the scanner's provenance gate (scanner.mjs:88) demotes a
 * snapshot without it to `partial` — which finds no opportunities, skips the
 * verification pass, and would have left six of the eight frame types out of
 * the census for a reason that has nothing to do with them.
 */
function patchCollection(Cls, events, fail) {
  const proto = Cls.prototype;
  const saved = { f: proto.fetchRaw, n: proto.normalize, e: proto.extractEvents };
  return {
    apply() {
      proto.fetchRaw = async function fetchRaw() {
        if (fail) { const err = new Error('collection failed'); err.code = 'EUPSTREAM'; throw err; }
        this.sourceUrl = `https://${this.id}.example/offer`;
        this.observedAt = new Date().toISOString();
        return { events: [] };
      };
      proto.normalize = function normalize() { return events; };
      proto.extractEvents = function extractEvents(raw) { return raw; };
    },
    restore() { proto.fetchRaw = saved.f; proto.normalize = saved.n; proto.extractEvents = saved.e; },
  };
}

function fakeResponse(chunks) {
  return {
    setHeader() {}, writeHead() {}, on() {},
    write(s) { chunks.push(s); return true; },
    end() {},
  };
}

/** The frames, parsed back off the bytes the broadcaster wrote. */
function parseFrames(chunks) {
  const frames = [];
  for (const chunk of chunks) {
    for (const block of String(chunk).split('\n\n')) {
      const event = /^event: (.+)$/m.exec(block);
      if (!event) continue;
      const data = /^data: (.*)$/m.exec(block);
      if (!data) continue;
      frames.push({ event: event[1], data: data[1], payload: JSON.parse(data[1]) });
    }
  }
  return frames;
}

async function oneRun({ failBook = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-events-census-'));
  await mkdir(join(dir, 'workspace'), { recursive: true });
  const configPath = join(dir, 'custom.json');
  await writeFile(configPath, JSON.stringify({ jobs: JOBS }));

  const patched = [
    patchCollection(Superbet, [EVENT('superbet', [2.10, 4.20, 4.60])], failBook === 'superbet'),
    patchCollection(Betano, [EVENT('betano', [2.05, 4.50, 5.00])], failBook === 'betano'),
  ];
  for (const p of patched) p.apply();

  const chunks = [];
  const broadcaster = new StateBroadcaster();
  broadcaster.add(fakeResponse(chunks));
  const orchestrator = new ScrapeOrchestrator({ dataDir: dir, configPath, broadcaster });
  let error = null;
  try {
    await orchestrator.launch({ bookIds: ['superbet', 'betano'], scanOptions: { bankroll: 1000 } });
    await orchestrator._pipeline;
  } catch (err) {
    error = err;
  } finally {
    for (const p of patched) p.restore();
  }

  const state = JSON.parse(await readFile(join(dir, 'scrape-state.json'), 'utf8'));
  const runReport = JSON.parse(await readFile(join(dir, 'latest-scrape-run.json'), 'utf8'));
  const frames = parseFrames(chunks);
  await rm(dir, { recursive: true, force: true });
  return { frames, state, runReport, error };
}

/**
 * The heartbeat, executed rather than read.
 *
 * The interval body is captured by wrapping `setInterval` around `start()` and
 * invoked directly, which is the same 25-second body the server runs — waiting
 * for it would have added 25 seconds to the suite to learn one line's shape.
 */
function heartbeatFrames() {
  const chunks = [];
  let tick = null;
  const real = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  try {
    const broadcaster = new StateBroadcaster();
    broadcaster.add(fakeResponse(chunks));
    broadcaster.start();
    assert.ok(tick, 'the broadcaster installed no heartbeat interval');
    tick();
  } finally {
    globalThis.setInterval = real;
  }
  return parseFrames(chunks).filter((f) => f.event === 'heartbeat');
}

const runA = await oneRun({});
const runB = await oneRun({ failBook: 'betano' });
const heartbeats = heartbeatFrames();

const ALL_FRAMES = [...runA.frames, ...runB.frames];

// Control beside the census: a driven run that silently published nothing would
// report "the server publishes no frame types" and every excuse below would
// pass for the wrong reason.
test('the driven runs actually produced frames', () => {
  const types = new Set(ALL_FRAMES.map((f) => f.event));
  assert.ok(ALL_FRAMES.length > 30, `only ${ALL_FRAMES.length} frames were captured`);
  for (const type of ['scrape-update', 'scan-update', 'verify-start', 'verify-batch-start', 'verify-job-start', 'verify-job-complete', 'verify-batch-end', 'verify-end']) {
    assert.ok(types.has(type), `the driven run never emitted ${type}`);
  }
  // The arbitrage the fixture is built to produce is what makes the second half
  // of the pipeline run at all.
  const scanUpdate = runA.frames.filter((f) => f.event === 'scan-update').map((f) => JSON.parse(f.data));
  assert.equal(scanUpdate[0].opportunities, 1, 'the driven run found no arbitrage, so no verification pass ran');
  // And the failing run is what puts an error on the wire.
  assert.ok(
    runB.frames.some((f) => f.event === 'scrape-update' && JSON.parse(f.data).jobs.some((j) => j.error)),
    'no driven run published a job error',
  );
});

// ---------------------------------------------------------------------------
// Published leaves, per frame type.
// ---------------------------------------------------------------------------

function leaves(value, prefix, out) {
  if (value === undefined) return;
  if (Array.isArray(value)) { for (const item of value) leaves(item, `${prefix}[]`, out); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.add(prefix);
}

const wire = new Map();
for (const frame of ALL_FRAMES) {
  if (!wire.has(frame.event)) wire.set(frame.event, []);
  wire.get(frame.event).push({ ...frame, payload: JSON.parse(frame.data) });
}

/** frame type → every leaf path any of its frames carries. */
const PUBLISHED = new Map();
for (const [type, frames] of wire) {
  const set = new Set();
  for (const f of frames) leaves(f.payload, '', set);
  PUBLISHED.set(type, set);
}

// ---------------------------------------------------------------------------
// The reader, executed.
// ---------------------------------------------------------------------------

const NOT_PAYLOAD = /(^$)|(\.(constructor|length|map|filter|sort|slice|then|forEach|reduce|concat|join|indexOf|includes|push|find|some|every|values|entries|keys|toFixed|replace|split|toLocaleString|toLocaleDateString|toISOString|prototype)$)/;

function record(value, path, hits) {
  if (value === null || typeof value !== 'object') return value;
  hits.add(path);
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      const child = path ? `${path}.${prop}` : String(prop);
      hits.add(child);
      const raw = target[prop];
      if (typeof raw === 'function') return (...args) => raw.apply(record(target, path, hits), args);
      return record(raw, child, hits);
    },
  });
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
  dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector() { return node(); }, querySelectorAll() { return []; }, nextElementSibling: null,
  remove() {}, appendChild() {}, insertAdjacentHTML() {},
});

const I18N = read('public/js/i18n.js');

function pageContext(api) {
  const byId = new Map();
  const get = (id) => { if (!byId.has(id)) byId.set(id, node()); return byId.get(id); };
  const json = { parse: (s) => JSON.parse(s), stringify: (v) => JSON.stringify(v) };
  const ctx = {
    JSON: json,
    document: {
      getElementById: get, querySelector: () => node(), querySelectorAll: () => [],
      addEventListener() {}, createElement: () => node(), documentElement: {}, body: node(),
    },
    escapeHtml, console: { log() {}, warn() {}, error() {} }, createDropdown() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }), location: { href: '' },
  };
  ctx.window = {
    arbiterConnectionStatus: null, arbiterApp: { mount() {} }, arbiterFormat: null, addEventListener() {},
    setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {},
  };
  ctx.arbiterApp = ctx.window.arbiterApp;
  ctx.arbiterFormat = null;
  ctx.arbiterApi = api;
  ctx.globalThis = ctx;
  vm.runInNewContext(I18N, Object.assign(ctx, {
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? 'en' : null), setItem() {} },
  }));
  ctx.arbiterI18n = ctx.window.arbiterI18n;
  return ctx;
}

/** Load the real sse.js over a recording EventSource: what is subscribed is measured. */
function sseClient(context) {
  const listeners = new Map();
  class FakeEventSource {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    }
    close() {}
  }
  context.EventSource = FakeEventSource;
  vm.runInNewContext(read('public/js/sse.js'), context);
  // In a browser `window` IS the global, so a page sees a bare `arbiterSse`. The
  // stub keeps them apart, so the binding is copied across.
  context.arbiterSse = context.window.arbiterSse;
  return listeners;
}

/**
 * The pages that subscribe to this channel, derived from the pages themselves.
 *
 * The list was five names written out by hand, and it was right — which is the
 * part that made it dangerous. Nothing held it: a sixth page that called
 * `arbiterSse.connect` would have joined the channel without joining the census,
 * and every frame it read would have been reported as read by nobody while the
 * suite stayed green. The comment above this file says the subscriber set is
 * "measured the same way"; the set itself was not.
 *
 * The rule is the call, over code with the comments blanked. Three things it has
 * to get right, and each one is checked by a control below rather than argued for
 * here: prose is not a call (`connection-status.js` names `arbiterSse.connect()`
 * in a comment and in its own wrapper); the window publishes the client as
 * `window.arbiterSse` while a page sees a bare `arbiterSse`, so both spellings
 * have to match; and connection-status.js is not a page — it wraps `connect` to
 * register a state callback and subscribes to no frame of its own, so counting it
 * would put a page in this census that reads nothing.
 */
const SSE_CONNECT = /\b(?:window\.)?arbiterSse\s*\.\s*connect\s*\(/;

function sseConsumers() {
  const dir = join(ROOT, 'public/js/pages');
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    if (SSE_CONNECT.test(codeOnly(readFileSync(join(dir, file), 'utf8'), true))) found.push(file);
  }
  return found;
}

const PAGE_FILES = sseConsumers();

const READS = new Map();      // frame type → leaf paths any page touched
const READ_BY = new Map();    // frame type → pages that touched it
const SUBSCRIBED = new Map(); // page → frame types it registered for
const HITS_PER_PAGE = new Map();
const DELIVERED_PER_PAGE = new Map();

const EMPTY_SCAN = {
  opportunities: [], middles: [], positiveEv: [], lowHold: [], sources: [], published: false,
  options: {}, dataHealth: { status: 'empty', sources: {}, actionableSourceCount: 0 },
};

/**
 * The subscriber list is a measurement, and the measurement can see.
 *
 * Four controls, each aimed at one way the rule above could be wrong. A rule that
 * matches nothing would make this census vacuous and the rest of the file would
 * still pass, which is the failure mode that costs the most: five pages quietly
 * stop subscribing, the loop below iterates over nothing, and every assertion in
 * this file is satisfied by an empty set.
 */
test('the subscriber list is derived from the pages, and the rule sees a call', () => {
  const dir = join(ROOT, 'public/js/pages');
  const every = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  // Vacuous in both directions, because both leave every assertion in this file
  // satisfied by a set nobody chose. A rule that matches nothing and a rule that
  // matches everything produce the same green suite, and the first version of
  // this control only caught the second: `every.length > PAGE_FILES.length` is
  // true for an empty list, which is how a rule that stopped matching at all
  // went unreported until a mutation found it.
  assert.ok(PAGE_FILES.length > 0,
    'the rule matched no page at all — every assertion in this file is satisfied by an empty set');
  assert.ok(every.length > PAGE_FILES.length,
    'every page in the directory subscribes, which this rule cannot tell apart from a rule that matches everything');

  // Forward: a real call is a consumer, including the `window.` spelling the
  // client publishes under. Both are taken from pages that are in the list.
  for (const page of PAGE_FILES) {
    const src = readFileSync(join(dir, page), 'utf8');
    assert.ok(/\barbiterSse\s*\.\s*connect\s*\(/.test(src),
      `${page} is in the subscriber list and no longer calls arbiterSse.connect — the list outlived the call`);
  }
  const dotted = every.find((f) => /window\.arbiterSse\s*\.\s*connect\s*\(/.test(codeOnly(readFileSync(join(dir, f), 'utf8'), true)));
  if (dotted) assert.ok(PAGE_FILES.includes(dotted),
    `a page subscribes through window.arbiterSse and was left out: ${dotted}`);

  // Reverse: prose is not a call. connection-status.js names the function in a
  // comment and wraps it to register a state callback; it subscribes to no frame
  // of its own, and counting it would put a silent page in the census. The pair
  // of lines below is the control: the same file, the same text, and the only
  // difference between matching and not matching is the comment blanking.
  const raw = readFileSync(join(ROOT, 'public/js/connection-status.js'), 'utf8');
  assert.ok(/\/\*[\s\S]*?arbiterSse\.connect\(\)/.test(raw),
    'connection-status.js no longer names connect in prose — the reverse control would have nothing to reject');
  assert.ok(SSE_CONNECT.test(raw),
    'the raw text of connection-status.js no longer matches the rule at all — blanking is not what is rejecting it');
  const status = codeOnly(raw, true);
  assert.ok(!SSE_CONNECT.test(status),
    'a file that is not a page joined the subscriber list through its own comment');
  assert.ok(!PAGE_FILES.includes('connection-status.js'),
    'a file that is not a page joined the subscriber list');

  // Completeness: every line of page code that mentions the channel has to be a
  // call on it. This is the one that catches the rule being too narrow, which is
  // the direction that loses a reader — `const sse = arbiterSse; sse.connect(…)`
  // would subscribe a page this file would not count.
  for (const page of every) {
    const lines = codeOnly(readFileSync(join(dir, page), 'utf8'), true).split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (!/arbiterSse/.test(line)) continue;
      assert.ok(/\b(?:window\.)?arbiterSse\s*\.\s*connect\s*\(/.test(line),
        `public/js/pages/${page}:${i + 1} names arbiterSse without calling connect on it — ${line.trim()}`);
    }
  }
});

for (const page of PAGE_FILES) {
  const api = {
    async get(path) {
      if (path === '/api/scan') return JSON.parse(JSON.stringify(EMPTY_SCAN));
      if (path === '/api/profiles') return { profiles: [] };
      if (path === '/api/sports') return { sports: [] };
      if (path === '/api/catalog') return { markets: [], events: [] };
      if (path === '/api/scrape-run') return { runId: null, status: 'idle', jobs: [] };
      if (path === '/api/live') return { enabled: false, intervalSeconds: 60, books: [], lastRun: null };
      return {};
    },
    async post() { return {}; },
  };
  const context = pageContext(api);
  const listeners = sseClient(context);
  vm.runInNewContext(read(`public/js/pages/${page}`), context);
  SUBSCRIBED.set(page, new Set(listeners.keys()));

  // sse.js parses the wire bytes, so the recording has to happen there: a Proxy
  // handed to the handler is thrown away by `JSON.parse` and the page reports
  // nothing. The dispatch runs through the real sse.js either way.
  const byWire = new Map();
  const original = context.JSON.parse;
  context.JSON.parse = (s) => (byWire.has(s) ? byWire.get(s) : original(s));

  const hits = new Set();
  let delivered = 0;
  for (const [type, frames] of wire) {
    const handlers = listeners.get(type);
    if (!handlers) continue;                     // never delivered to this page
    const typeHits = new Set();
    for (const frame of frames) {
      const data = frame.data;
      byWire.set(data, record(frame.payload, '', typeHits));
      for (const handler of handlers) { handler({ data }); delivered += 1; }
    }
    if (!READS.has(type)) { READS.set(type, new Set()); READ_BY.set(type, new Set()); }
    READ_BY.get(type).add(page);
    for (const path of typeHits) {
      const normalised = path.replace(/\.\d+/g, '[]');
      if (!NOT_PAYLOAD.test(normalised)) { READS.get(type).add(normalised); hits.add(normalised); }
    }
  }
  await new Promise((r) => setTimeout(r, 25));
  HITS_PER_PAGE.set(page, hits.size);
  DELIVERED_PER_PAGE.set(page, delivered);
}

// Absence is not proof, and a page that threw on load would report as a page
// that reads nothing.
//
// The control is on delivered frames, not on fields read, because three of the
// five pages use the frame as a "something changed" signal and never touch the
// payload: scanner.js, analytics.js and ai.js all reconnect their own fetch on
// a `scan-update` and read no field of it. Demanding a field read from them
// would be demanding the wrong thing; what has to hold is that every page was
// really handed frames, which is the property a broken instrument would lose.
test('every page in the census was really handed frames', () => {
  for (const [page, delivered] of DELIVERED_PER_PAGE) {
    assert.ok(delivered > 0, `${page} was handed no frame at all — the reader half of this census is broken, not the channel`);
  }
  // And a named read beside it, so a detector that has lost the ability to see a
  // read cannot pass the lines above.
  assert.ok(READS.get('scrape-update').has('status'), 'the census lost a field it is demonstrably reading');
  assert.ok(READS.get('scan-update').has('opportunities'), 'the census lost the scan-update field the page reads');
  assert.ok(READS.get('verify-end').has('confirmed'), 'the census lost the verdict field the page reads');

  // The three pages that read nothing are named so the number above is a fact
  // about this tree and not an accident of the fixture.
  //
  // Sorted on both sides because `PAGE_FILES` is derived now, and a derived set
  // carries no order to compare against. The names below were written down from
  // the order the hand-written list happened to have; what they claim is which
  // pages read nothing, and that is a set.
  const silent = PAGE_FILES.filter((p) => HITS_PER_PAGE.get(p) === 0).sort();
  assert.deepEqual(silent, ['ai.js', 'analytics.js', 'scanner.js'],
    'the set of pages that use an SSE frame only as a refresh signal has changed');
});

// ---------------------------------------------------------------------------
// What the server emits and what any page listens for.
// ---------------------------------------------------------------------------

/**
 * The one frame the server pushes and no page subscribes to, with the reason.
 *
 * `verify-job-start` carries an empty record — `toProgressJob` fills ten fields
 * with zero, false, null and an empty list before the book has been scraped
 * (scraper-service.mjs:157) — so it says only which book is about to be
 * re-quoted, and `verify-job-complete` carries that book a frame or two later
 * with its result. It is listed here rather than deleted from `sse.js` because
 * the server emits it whatever a client subscribes to — the claim being tested
 * is that every frame on the wire is either delivered or excused, not that the
 * wire is tidy.
 */
const UNSUBSCRIBED = ['verify-job-start'];

test('every frame the server emits is either subscribed to or excused', () => {
  // The heartbeat is listed beside the JSON frames rather than among them: it is
  // emitted, but its payload is a timestamp, so it contributes no leaves to the
  // census below and is only ever compared here.
  const emitted = [...PUBLISHED.keys(), 'heartbeat'];
  const subscribed = new Set();
  for (const types of SUBSCRIBED.values()) for (const t of types) subscribed.add(t);

  assert.deepEqual(
    emitted.filter((t) => !subscribed.has(t)).sort(),
    [...UNSUBSCRIBED].sort(),
    'the server emits a frame no page listens for and no excuse names — see UNSUBSCRIBED',
  );
  assert.deepEqual(
    [...subscribed].filter((t) => !emitted.includes(t)).sort(),
    [],
    'a page listens for a frame the server never sends',
  );
  assert.ok(heartbeats.length > 0, 'the driven broadcaster produced no heartbeat frame');

  // Named, because this one is the direction a set comparison reports least
  // clearly. It used to be a listener on every page for a frame the
  // orchestrator has never broadcast: it folds a completed job into the state
  // it publishes as `scrape-update`, so the branch that read it could not run,
  // and the per-book log line it printed never appeared.
  assert.equal(subscribed.has('job-complete'), false,
    'a page is still listening for job-complete, which the server does not emit');
});

// The heartbeat carries no payload. `data:` is a bare `Date.now()`, so the one
// frame every client receives on a timer is a number rather than an object — a
// page that assumed a payload on every frame gets `undefined.status` here, and
// that is the contract rather than an accident.
test('the heartbeat is a timestamp, not a payload', () => {
  for (const frame of heartbeats) {
    assert.match(frame.data, /^\d+$/, `the heartbeat data is not a bare timestamp: ${frame.data}`);
    const decoded = JSON.parse(frame.data);
    assert.equal(typeof decoded, 'number', 'the heartbeat stopped being a timestamp');
    assert.ok(Math.abs(Date.now() - decoded) < 60_000, 'the heartbeat timestamp is not the clock');
  }
  // It is subscribed for the keepalive on purpose, which is why the set
  // comparison above counts it as emitted rather than as a gap.
  for (const [page, types] of SUBSCRIBED) {
    assert.ok(types.has('heartbeat'), `${page} dropped its heartbeat listener`);
  }
});

// ---------------------------------------------------------------------------
// Published by the channel, read by no page, with the reason it is allowed.
// ---------------------------------------------------------------------------

/**
 * The excuse is that every frame of a verification pass carries the SSE event
 * name inside its own payload, the phase marker the orchestrator routes on, and
 * the run id the whole pass shares.
 *
 * The type is the sharpest of the three: `addEventListener('verify-start', …)`
 * matches on the frame's `event:` line, so a client can never receive one of
 * these frames without already knowing its name. It is redundant by the
 * construction of the transport, not by accident.
 */
const FRAME_ENVELOPE = [
  'verify-start.type', 'verify-start.phase',
  'verify-batch-start.type', 'verify-batch-start.phase', 'verify-batch-start.runId',
  'verify-job-start.type', 'verify-job-start.phase', 'verify-job-start.runId',
  'verify-job-complete.type', 'verify-job-complete.phase', 'verify-job-complete.runId',
  'verify-batch-end.type', 'verify-batch-end.phase', 'verify-batch-end.runId',
  'verify-end.type', 'verify-end.phase',
];

/**
 * `verify-batch-start` publishes the concurrency the pass ASKED for; the report
 * at `verify-batch-end` publishes the one it RAN with, which is that figure
 * clamped to the number of books (scraper-service.mjs:133). The page draws the
 * second. Drawing both would put two different numbers for one pass on the same
 * screen, and the wrong one first.
 *
 * Measured on the driven run: 12 requested, 2 books, 2 published.
 */
const REQUESTED_PARALLEL = ['verify-batch-start.parallel'];

/**
 * `verify-job-start` publishes the job record the batch builds before it runs
 * it, and that record is empty: no events, no duration, no error, no source ids,
 * a null start and a null finish. It says a book is about to be re-quoted, which
 * the counter already knows because it counts the books that finished.
 */
const ZEROED_REQUOTE_JOB = [...PUBLISHED.get('verify-job-start')].map((p) => `verify-job-start.${p}`);

/**
 * `verify-batch-end` publishes the re-quote's own batch report, and the page
 * draws four of its leaves: the status the batch reached, its two timestamps and
 * the concurrency it ran with. What is left is a rollup of figures two other
 * frames already carried — `runId` and `books` are the ones
 * `verify-batch-start` published, and the job list is the per-job records the
 * `verify-job-complete` frames published, one record per book.
 *
 * The list is derived from the census rather than written out, so a field added
 * to the report is covered by the same argument instead of failing the census
 * as uncovered.
 */
const REQUOTE_REPORT_ROLLUP = [
  'verify-batch-end.report.runId',
  'verify-batch-end.report.books[]',
  ...[...PUBLISHED.get('verify-batch-end')]
    .filter((p) => p.startsWith('report.jobs[]'))
    .map((p) => `verify-batch-end.${p}`),
];

/**
 * The bookkeeping on a re-quoted job's result on the wire.
 *
 * The page draws five of the nine fields on this record: name, valid, status,
 * events and durationMs. The other four are here because the sanitizer carries
 * them, not because the page wants them — `sanitizeResult` names the fields a
 * result is made of, and `id`, `rawSize` and the two timestamps are four of the
 * nine.
 *
 * This group used to name six leaves and stood on a canary: `outputs[]` — an
 * absolute path on the server's filesystem — reached every browser because the
 * broadcast handed the raw result straight to the wire, and the group asserted
 * that bypass so it would die with the defect. It did: the wire is now reduced
 * by `sanitizeResult` in state-broadcaster.mjs, `outputs` and `sourceIds` are
 * gone from the frame, and what is left here is four leaves that are simply not
 * drawn. The test below now pins the reduced shape instead, including the count
 * that a sanitizer reading only the array shape of `events` would have zeroed.
 */
const REQUOTE_BOOKKEEPING = [
  'verify-job-complete.result.id',
  'verify-job-complete.result.startedAt',
  'verify-job-complete.result.finishedAt',
  'verify-job-complete.result.rawSize',
];

const EXCUSES = [
  {
    id: 'frame-envelope',
    covers: FRAME_ENVELOPE,
    reason: [
      'The transport already carries these. A verification frame names itself in the SSE `event:` line, which',
      'is the string `addEventListener` matched on, so no client can be handed one without already knowing',
      'its type. `phase` is the marker the orchestrator routes on when it decides whether to re-broadcast',
      '(scrape-orchestrator.mjs:401), not page data, and `runId` is one value shared by the whole pass.',
      'Measured on every captured frame: 8 of 8 carry type, 8 of 8 carry phase, and the pass uses a',
      'single distinct run id.',
    ].join(' '),
    measuredBy: 'every re-broadcast frame names itself and carries the one run id',
  },
  {
    id: 'zeroed-requote-job',
    covers: ZEROED_REQUOTE_JOB,
    reason: [
      'The frame that says a book is about to be re-quoted, carrying a record with nothing in it:',
      'sourceIds [], valid false, status "pending", events 0, durationMs 0, error null, and both',
      'timestamps null. Measured across every captured frame, the record is the identical empty shape and',
      'its id and its name are both the jobId beside it, so the frame says one thing — the book — which',
      '`verify-job-complete` carries too.',
    ].join(' '),
    measuredBy: 'every re-quote job-start frame is the same empty record',
  },
  {
    id: 'requested-parallel',
    covers: REQUESTED_PARALLEL,
    reason: [
      'The concurrency the re-quote asked for. The batch runs it clamped to the books it actually has',
      '(scraper-service.mjs:133) and the page draws that clamped figure, on the report frame: asking for',
      'twelve slots and re-quoting two books means two books at a time, and one screen should not carry',
      'both numbers for one pass.',
      'Measured on the driven run: `verify-batch-start.parallel` is 12, the report publishes 2 for 2 books.',
    ].join(' '),
    measuredBy: 'the batch reports the concurrency it ran with, not the one it asked for',
  },
  {
    id: 'requote-report-rollup',
    covers: REQUOTE_REPORT_ROLLUP,
    reason: [
      'The re-quote batch report, minus the four leaves the page draws. Its `jobs` is the list of records the',
      'per-job frames already published, one record per book — the same thirteen fields, field for field, on',
      'the same book — and its run id and book list are the ones `verify-batch-start` already published.',
      'Measured on the driven run: the report’s job list is deep-equal, book by book, to the `result` values',
      'on `verify-job-complete`, and its run id and books are those of the start frame.',
    ].join(' '),
    measuredBy: 'the re-quote report repeats what the per-job frames already sent',
  },
  {
    id: 'requote-bookkeeping',
    covers: REQUOTE_BOOKKEEPING,
    reason: [
      'The page draws five of the nine fields on a re-quoted job: name, valid, status, events and durationMs.',
      'The other four are on the wire because the result is put through `sanitizeResult`',
      '(shared/sanitize.mjs:21) on its way to the broadcaster, and that function names the',
      'fields a result is made of. Measured: every result on the wire has exactly the nine keys',
      'the sanitizer produces, and none of them is a path on this machine.',
    ].join(' '),
    measuredBy: 'the wire carries the sanitized result and no host path',
  },
  {
    id: 'state-document',
    // Covered by function, because the frame is the state document and the list
    // of its unread leaves belongs to the census that already rules on that
    // document. Naming them here would be a second list to rot.
    coversFn: (type) => (type === 'scrape-update'
      ? [...PUBLISHED.get('scrape-update')].map((p) => `scrape-update.${p}`)
      : []),
    reason: [
      '`scrape-update` is not a payload of its own: it is the orchestrator’s `scrapeState`, the same object',
      '`persistState` writes to scrape-state.json and the state route serves. Measured here: the last',
      'frame of a run deep-equals the file that run persisted. The leaves no page reaches over SSE are',
      'therefore the leaves of a document field-census.test.mjs already censuses field by field, with its',
      'own measured exemptions — this file does not repeat them.',
    ].join(' '),
    measuredBy: 'the last scrape-update frame is the state document on disk',
  },
];

const coveredBy = (type, path) => {
  const full = `${type}.${path}`;
  for (const excuse of EXCUSES) {
    const covers = excuse.coversFn ? excuse.coversFn(type) : excuse.covers;
    if (covers.includes(full)) return excuse;
  }
  return null;
};

test('every leaf the channel publishes is either read or excused', () => {
  const unaccounted = [];
  let published = 0;
  let read = 0;
  for (const [type, paths] of PUBLISHED) {
    for (const path of paths) {
      published += 1;
      if (READS.get(type)?.has(path)) { read += 1; continue; }
      if (!coveredBy(type, path)) unaccounted.push(`${type} › ${path}`);
    }
  }
  assert.deepEqual(unaccounted, [], `published, read by nobody, excused by nothing: ${unaccounted.join(', ')}`);

  // And the control beside it: an excuse must not quietly widen into a place
  // where fields go to be quiet. Every entry a group names has to still be
  // unread, so a group cannot outlive the reason it was written for.
  for (const excuse of EXCUSES) {
    if (excuse.id === 'state-document') continue;
    const nowRead = excuse.covers.filter((full) => {
      // First dot, not last: a path is `<type>.<leaf>` and a leaf has dots of its
      // own (`verify-job-complete.result.name`). Splitting on the last one made
      // this lookup ask READS for a frame type called `…result`, which is never
      // present — so the control below could not fire on any dotted leaf, which
      // is most of the verify frames' fields.
      const at = full.indexOf('.');
      return READS.get(full.slice(0, at))?.has(full.slice(at + 1));
    });
    assert.deepEqual(nowRead, [], `${excuse.id} now covers leaves a page reads: ${nowRead.join(', ')} — delete them from the group`);
  }

  // The floor was 100 when the wire carried the raw result. It is 98 now, and
  // the drop is measured rather than tolerated: the sanitized result no longer
  // has `sourceIds[]` or `outputs[]`, and `error`/`reason` became optional keys,
  // which took four leaves off `verify-job-complete` and four off the batch
  // report's job list. A count below that means the driven runs published less
  // than the frames the assertions above name.
  assert.ok(published > 90, `the census collected only ${published} leaves — the driven runs published less than expected`);
  assert.ok(read > 0, 'no leaf at all is read, so every group above would be passing vacuously');
});

test('the counts the excuse reasons quote are the counts this census measured', () => {
  const reBroadcast = [...wire].flatMap(([event, frames]) => frames.map((f) => ({ event, payload: f.payload })))
    .filter((f) => f.payload && f.payload.phase === 'verification');
  const withType = reBroadcast.filter((f) => f.payload.type === f.event);
  assert.equal(reBroadcast.length, 8, `the driven runs re-broadcast ${reBroadcast.length} frames, not the 8 the reasons quote`);
  assert.equal(withType.length, 8, 'a re-broadcast frame does not name itself');

  const withRunId = reBroadcast.filter((f) => f.payload.runId !== null && f.payload.runId !== undefined);
  const runIds = new Set(withRunId.map((f) => f.payload.runId));
  assert.deepEqual([...runIds].length, 1, 'the re-quote pass used more than one run id');
});

// ---------------------------------------------------------------------------
// The measurements the reasons rest on.
// ---------------------------------------------------------------------------

const VERIFY = (type) => runA.frames.filter((f) => f.event === type).map((f) => f.payload);
/** The re-quote job record, minus the two fields that are the jobId. */
const ZEROED_JOB = {
  sourceIds: [], valid: false, status: 'pending',
  events: 0, durationMs: 0, error: null, startedAt: null, finishedAt: null,
};

test('every re-quote job-start frame is the same empty record', () => {
  const starts = VERIFY('verify-job-start');
  assert.ok(starts.length >= 2, 'the driven run re-quoted no books');
  for (const payload of starts) {
    const { id, name, ...rest } = payload.job;
    assert.deepEqual(rest, ZEROED_JOB,
      `the job record on verify-job-start is no longer empty: ${JSON.stringify(rest)}`);
    // The only two fields that say anything are the book, and the frame says it
    // twice beside itself — which is why nothing here is a reason to subscribe.
    assert.equal(id, payload.jobId, 'the job record carries an id of its own beside jobId');
    assert.equal(name, payload.jobId, 'the job record name no longer matches jobId');
  }
});

test('the re-quote report repeats what the per-job frames already sent', () => {
  const [batchStart] = VERIFY('verify-batch-start');
  const [frame] = VERIFY('verify-batch-end');
  const results = VERIFY('verify-job-complete').map((p) => p.result);
  assert.ok(frame && results.length, 'the driven run published no re-quote report');
  const report = frame.report;

  // Book by book, not position by position: the report is built from the queue
  // order (scraper-service.mjs:147) and the per-job frames arrive in completion
  // order, and with two books on two slots those two orders are not guaranteed
  // to agree. Sorted by book, the records are the same field for field.
  const byBook = (list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  assert.deepEqual(byBook(report.jobs), byBook(results),
    'the re-quote report is no longer the same list the per-job frames published');
  assert.equal(report.runId, batchStart.runId);
  assert.deepEqual(report.books, batchStart.books);
});

test('the batch reports the concurrency it ran with, not the one it asked for', () => {
  const [batchStart] = VERIFY('verify-batch-start');
  const [frame] = VERIFY('verify-batch-end');
  assert.ok(batchStart && frame, 'the driven run published no re-quote batch');
  const report = frame.report;

  assert.equal(report.parallel, Math.max(1, Math.min(batchStart.parallel, report.books.length)),
    'the reported concurrency is no longer the requested one clamped to the book count');
  assert.ok(report.parallel < batchStart.parallel,
    'the fixture stopped distinguishing requested from actual concurrency, so the exemption above proves nothing');
});

test('the wire carries the sanitized result and no host path', () => {
  const SANITIZED = ['durationMs', 'events', 'finishedAt', 'id', 'name', 'rawSize', 'startedAt', 'status', 'valid'];
  const jobs = VERIFY('verify-job-complete');
  assert.ok(jobs.length, 'the driven run published no re-quoted job');

  for (const payload of jobs) {
    assert.deepEqual(Object.keys(payload.result).sort(), SANITIZED,
      `the result on the wire is no longer the sanitizer's output: ${JSON.stringify(payload.result)}`);
    // The count has to survive the trip. `sanitizeResult` read `events` as an
    // array for its whole life and the envelope carries a number, so routing the
    // broadcast through it unchanged would have printed zero events beside every
    // book — a page that looks right and counts nothing.
    assert.ok(payload.result.events > 0,
      `a re-quoted book reached the wire claiming no events: ${JSON.stringify(payload.result)}`);
  }

  // The batch report carries the same records, so it gets the same treatment:
  // `outputs[]` was on the wire twice, once per frame and once per report entry.
  const [frame] = VERIFY('verify-batch-end');
  assert.ok(frame, 'the driven run published no re-quote report');
  for (const job of frame.report.jobs) {
    assert.deepEqual(Object.keys(job).sort(), SANITIZED,
      `a report entry on the wire is no longer the sanitizer's output: ${JSON.stringify(job)}`);
  }

  // And the finding this replaced, stated so it cannot come back unnoticed: no
  // published leaf on the whole channel is a path on this machine.
  for (const [type, paths] of PUBLISHED) {
    for (const path of paths) {
      assert.doesNotMatch(path, /outputs/i,
        `${type}.${path} is on the wire again — a scraper envelope path has no business in a browser`);
    }
  }
});

test('the last scrape-update frame is the state document on disk', () => {
  const last = runA.frames.filter((f) => f.event === 'scrape-update').pop();
  assert.ok(last, 'the driven run published no scrape-update frame');
  assert.deepEqual(last.payload, runA.state,
    'the last scrape-update frame is not the state the run persisted — the state-document exemption no longer applies');
  assert.equal(runA.state.status, 'completed');
});