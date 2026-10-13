// test/driver-route-wiring.test.mjs — GET/POST /api/live and GET/POST
// /api/scheduler, the four routes behind the scrape page's scheduler and live
// panels. All four had live consumers and no test that ever asked the route for
// anything: the leaf censuses (test/driver-census.test.mjs) drive the services
// directly and read the page's source, and neither side ever met on the wire.
//
// This file meets them there. The services are real, the router is real, the
// POST bodies are the ones the page actually sends (measured from the page, not
// restated), and the GET answers are compared against the service driving them
// — so a field the page posts and the route never reads, or a field the route
// drops on the way out, fails here rather than on a reader's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import { SchedulerService } from '../src/scheduler-service.mjs';
import { LiveService } from '../src/live-service.mjs';
import { resolveScanRequest } from '../src/scrape-orchestrator.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const pageSource = readFileSync(new URL('../public/js/pages/scrape.js', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router.mjs', import.meta.url), 'utf8');

/** The scan payload the page's form builds, measured out of the page itself. */
const pageScanFields = () => {
  const win = /function currentScanOptions\(\) \{([\s\S]*?\n\})/.exec(pageSource);
  assert.ok(win, 'the page must still build its scan payload in currentScanOptions()');
  return [...win[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
};

const SCAN_INPUT = {
  bankroll: 500, minRoiPercent: 1, minEvPercent: 2, maxMiddleRiskPercent: 10,
  minMiddleRoiPercent: 30, includeLive: false, includePast: true,
  maxEvents: 250, sport: 'soccer',
};

/** An orchestrator a service can be driven against, with settable behaviour. */
function orchestrator() {
  return {
    running: false,
    launchThrows: null,
    launches: [],
    scrapeState: null,
    isRunning() { return this.running; },
    async launch(args) {
      this.launches.push(args);
      if (this.launchThrows) throw new Error(this.launchThrows);
      return { runId: 'run-1' };
    },
  };
}

/** The body of a function in the page, comments stripped. */
function pageWindow(name) {
  const at = pageSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(at, -1, `the page lost ${name}() — this test pins it`);
  const end = pageSource.indexOf('\n}', at);
  const body = pageSource.slice(at, end);
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const readsIn = (win, receiver) => [...new Set([...win.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();
const secondLevelIn = (win, receiver) => [...new Set([...win.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)\\.(\\w+)`, 'g'))].map((m) => `${m[1]}.${m[2]}`))].sort();

/**
 * What each GET payload's readers read, measured from the page.
 *
 * `schedulerLastRunText` and `lastErrorSegment` are shared helpers that take
 * either payload under `s`, so their reads count for both routes — the same
 * measurement test/driver-census.test.mjs makes, redone here because this file
 * asserts against the socket answer rather than the service.
 */
const SCHEDULER_READS = () => [
  ...readsIn(pageWindow('refreshScheduler'), 's'),
  ...['lastRun.at', 'lastRun.ok', 'lastRun.skipped', 'lastRun.reason', 'lastError.at', 'lastError.message'],
];
const LIVE_READS = () => [
  ...readsIn(pageWindow('refreshLive'), 'l'),
  ...readsIn(pageWindow('renderLiveMeasured'), 'l'),
  ...secondLevelIn(pageWindow('renderLiveMeasured'), 'l'),
  // `last` is the local alias renderLiveMeasured takes `l.lastRun` apart into.
  ...secondLevelIn(pageWindow('renderLiveMeasured'), 'last').map((p) => `lastRun.${p.split('.')[1]}`),
];

/** Every leaf path of a value, arrays marked `[]` whether or not they hold rows. */
function leafPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
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
 * Does the answer carry what the page reads?
 *
 * A read of a branch (`l.lastRun`, used as a truthiness test before the helper
 * that takes it apart) is carried by any leaf under it, because that is what
 * the page does with it: it reads the branch to decide whether to render, and
 * the leaves to render. `bookIds[]` covers a read of `bookIds` whether the list
 * holds rows or is the empty "every book" the page itself posts.
 */
function carries(leaves, read) {
  if (leaves.has(read)) return true;
  if (read === 'bookIds' && leaves.has('bookIds[]')) return true;
  for (const leaf of leaves) if (leaf.startsWith(`${read}.`)) return true;
  return false;
}

/** The status as the wire would carry it: JSON drops `undefined`-valued keys. */
const asJson = (value) => JSON.parse(JSON.stringify(value));

/** Every POST body key the page sends, read by brace depth out of the call site. */
function postedKeys(anchor) {
  const at = pageSource.indexOf(anchor);
  assert.notEqual(at, -1, `the page lost its ${anchor} call — this test pins it`);
  const open = pageSource.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < pageSource.length; end++) {
    if (pageSource[end] === '{') depth++;
    else if (pageSource[end] === '}') { depth--; if (depth === 0) break; }
  }
  const body = pageSource.slice(open + 1, end).replace(/\/\/[^\n]*/g, '');
  const keys = [];
  let d = 0;
  for (const piece of body.split(/([{},])/)) {
    if (piece === '{') d++;
    if (piece === '}') d--;
    if (d === 0) {
      const m = /^\s*(\w+)\s*[:,]/.exec(piece) || /^\s*(\w+)\s*$/.exec(piece);
      if (m) keys.push(m[1]);
    }
  }
  return [...new Set(keys)];
}

/**
 * The router over a socket, with the real services the four routes delegate to.
 */
async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), 'arb-drivers-'));
  const live = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator(), logger: () => {} });
  const scheduler = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator(), logger: () => {} });
  const route = buildRouter({
    dataDir,
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    scanService: { async readLatestScan() { return {}; } },
    orchestrator: { scrapeState: { status: 'idle', jobs: [] } },
    scheduler,
    live,
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
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // The writes are CSRF-guarded, so the token is taken the way the page takes
  // it — without it the POST answers 403 and reads as a route that refuses
  // writes rather than as a test that forgot the handshake.
  const token = async () => (await (await fetch(`${base}/api/csrf`)).json()).token;
  return {
    dataDir,
    live,
    scheduler,
    async get(path) {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async post(path, body) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-arbiter-token': await token() },
        body: JSON.stringify(body ?? {}),
      });
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

const readState = (dataDir, file) => JSON.parse(readFileSync(join(dataDir, file), 'utf8'));

/* ── the write path: what the page posts is what the engine keeps ─────────── */

test('the live save the page posts keeps the interval the page typed', async () => {
  const srv = await serve();
  try {
    // The body scrape.js:1935 builds: the interval from the form, an explicit
    // empty book list (which the service reads as "all"), and the scan options
    // with includeLive forced on.
    const posted = {
      enabled: true,
      intervalSeconds: 90,
      bookIds: [],
      scanOptions: { ...SCAN_INPUT, includeLive: true },
    };
    const { status, json } = await srv.post('/api/live', posted);
    assert.equal(status, 200, `the route answered ${status}`);
    assert.equal(json.enabled, true, 'the engine did not come back enabled');
    // The load-bearing one: the page renders this number, so a route that read
    // a different field name would leave the engine on its default while the
    // panel showed the number the operator typed.
    assert.equal(json.intervalSeconds, 90,
      `the route answered intervalSeconds ${json.intervalSeconds} for a posted 90`);
    assert.deepEqual(json.bookIds, [], 'the empty book list means every runnable book');
    assert.equal(json.scanOptions.includeLive, true, 'the live flag is forced on the way in');
    // And the write really happened: the state file on disk, not only the answer.
    const onDisk = readState(srv.dataDir, 'live-state.json');
    assert.equal(onDisk.enabled, true, 'the state file does not say enabled');
    assert.equal(onDisk.intervalSeconds, 90, 'the state file kept a different interval');
  } finally {
    await srv.close();
  }
});

test('the scheduler save the page posts keeps its interval and its books', async () => {
  const srv = await serve();
  try {
    const posted = {
      enabled: true,
      intervalMinutes: 30,
      bookIds: ['fortuna', 'superbet'],
      scanOptions: SCAN_INPUT,
    };
    const { status, json } = await srv.post('/api/scheduler', posted);
    assert.equal(status, 200, `the route answered ${status}`);
    assert.equal(json.enabled, true, 'the scheduler did not come back enabled');
    assert.equal(json.intervalMinutes, 30,
      `the route answered intervalMinutes ${json.intervalMinutes} for a posted 30`);
    assert.deepEqual(json.bookIds, ['fortuna', 'superbet'],
      'the book list the page sent is not the one the engine kept');
    const onDisk = readState(srv.dataDir, 'scheduler-state.json');
    assert.equal(onDisk.intervalMinutes, 30, 'the state file kept a different interval');
    assert.deepEqual(onDisk.bookIds, ['fortuna', 'superbet'], 'the state file kept different books');
  } finally {
    await srv.close();
  }
});

test('the toggle-off the page posts stops the engine, on the answer and on disk', async () => {
  const srv = await serve();
  try {
    await srv.post('/api/live', { enabled: true, intervalSeconds: 90, bookIds: [], scanOptions: { ...SCAN_INPUT, includeLive: true } });
    // The page's save handler posts `enabled` on every save, including the
    // off one (scrape.js:1923), and the route answers that branch by calling
    // disable rather than enable — a route that ran `enabled: false` through
    // enable() would leave the poll running with the panel saying stopped.
    const { status, json } = await srv.post('/api/live', { enabled: false });
    assert.equal(status, 200, `the route answered ${status}`);
    assert.equal(json.enabled, false, 'the answer still says enabled');
    assert.equal(readState(srv.dataDir, 'live-state.json').enabled, false, 'the state file still says enabled');
    const after = await srv.get('/api/live');
    assert.equal(after.json.enabled, false, 'a later read does not agree with the save');
  } finally {
    await srv.close();
  }
});

/* ── the read path: what the engine keeps is what the route publishes ─────── */

/**
 * Drive the live poll through the branches that fill the payload — a skip (a
 * scrape already running), a launch, and a settle with a finish time — and
 * collect the route's answer after each one. The same drives
 * test/driver-census.test.mjs makes against the service, redone here because
 * the assertion below is about the route, not the service.
 *
 * The leaves are merged across states rather than read off the last one because
 * the payload's shape is a union of branches: `lastRun.durationMs` exists only
 * after a settle and `lastRun.skipped` only in a skip, and a single snapshot
 * would fail on one of them whichever state it happens to be taken in.
 */
async function liveLeavesAcrossStates(srv) {
  const leaves = new Set();
  const ask = async () => {
    const { json } = await srv.get('/api/live');
    for (const leaf of leafPaths(json)) leaves.add(leaf);
  };
  const orch = srv.live.orchestrator;
  await srv.live.enable({ bookIds: [], scanOptions: resolveScanRequest({ ...SCAN_INPUT, includeLive: true }), intervalSeconds: 60 });
  await ask();
  orch.running = true;
  await srv.live._tick();
  await ask();
  orch.running = false;
  await srv.live._tick();
  orch.scrapeState = { runId: 'run-1', status: 'completed', finishedAt: new Date(Date.now() + 1000).toISOString() };
  await srv.live._tick();
  await ask();
  return leaves;
}

async function schedulerLeavesAcrossStates(srv) {
  const leaves = new Set();
  const ask = async () => {
    const { json } = await srv.get('/api/scheduler');
    for (const leaf of leafPaths(json)) leaves.add(leaf);
  };
  const orch = srv.scheduler.orchestrator;
  await srv.scheduler.enable({ bookIds: ['fortuna'], scanOptions: resolveScanRequest(SCAN_INPUT), intervalMinutes: 15 });
  await ask();
  // The skip branch: lastRun.skipped and lastRun.reason exist here and nowhere
  // else.
  orch.running = true;
  await srv.scheduler._tick(['fortuna'], SCAN_INPUT);
  await ask();
  orch.running = false;
  await srv.scheduler._tick(['fortuna'], SCAN_INPUT);
  await ask();
  // The throwing launch: the only branch that records lastError.
  orch.launchThrows = 'orchestrator refused';
  await srv.scheduler._tick(['fortuna'], SCAN_INPUT);
  await ask();
  orch.launchThrows = null;
  return leaves;
}

test('GET /api/live answers with the service status, whole', async () => {
  const srv = await serve();
  try {
    // One drive, enough state to be worth comparing: enabled, a skipped tick, a
    // launched poll and a settled one.
    const orch = srv.live.orchestrator;
    await srv.live.enable({ bookIds: [], scanOptions: resolveScanRequest({ ...SCAN_INPUT, includeLive: true }), intervalSeconds: 60 });
    orch.running = true;
    await srv.live._tick();
    orch.running = false;
    await srv.live._tick();
    orch.scrapeState = { runId: 'run-1', status: 'completed', finishedAt: new Date(Date.now() + 1000).toISOString() };
    await srv.live._tick();
    const { status, json } = await srv.get('/api/live');
    assert.equal(status, 200, `the route answered ${status}`);
    // Whole, and not a snapshot of it: the route delegates to live.status(), so
    // the answer is whatever the service holds at that moment. A field the route
    // held back — a trimmed copy, a stale envelope — fails here, and the page's
    // readers of that field render nothing. The comparison is against the
    // status as JSON carries it, because that is the only form the answer has:
    // an in-memory status holds keys whose value is `undefined` (the two
    // optional scan caps) and the wire cannot.
    assert.deepEqual(json, asJson(await srv.live.status()),
      'the route published something other than the whole service status');
  } finally {
    await srv.close();
  }
});

test('GET /api/scheduler answers with the service status, whole', async () => {
  const srv = await serve();
  try {
    const orch = srv.scheduler.orchestrator;
    await srv.scheduler.enable({ bookIds: ['fortuna'], scanOptions: resolveScanRequest(SCAN_INPUT), intervalMinutes: 15 });
    orch.running = true;
    await srv.scheduler._tick(['fortuna'], SCAN_INPUT);
    orch.running = false;
    await srv.scheduler._tick(['fortuna'], SCAN_INPUT);
    const { status, json } = await srv.get('/api/scheduler');
    assert.equal(status, 200, `the route answered ${status}`);
    assert.deepEqual(json, asJson(await srv.scheduler.status()),
      'the route published something other than the whole service status');
  } finally {
    await srv.close();
  }
});

test('every field the page reads off GET /api/live is on the answer it gets', async () => {
  const srv = await serve();
  try {
    const leaves = await liveLeavesAcrossStates(srv);
    const reads = LIVE_READS();
    assert.ok(reads.length > 0, 'the measurement found no reads — the extractor is broken, not the page');
    for (const read of reads) {
      assert.ok(carries(leaves, read),
        `the page reads ${read} and the route's answer does not carry it in any state`);
    }
    // A pulling check rather than a pushing one: the driven service really went
    // through the settle branch, so the reads above were not checked against
    // an engine that never ran.
    assert.ok(leaves.has('lastRun.durationMs'),
      'the driven service never settled a poll — the reads were checked against an empty engine');
  } finally {
    await srv.close();
  }
});

test('every field the page reads off GET /api/scheduler is on the answer it gets', async () => {
  const srv = await serve();
  try {
    const leaves = await schedulerLeavesAcrossStates(srv);
    const reads = SCHEDULER_READS();
    assert.ok(reads.length > 0, 'the measurement found no reads — the extractor is broken, not the page');
    for (const read of reads) {
      assert.ok(carries(leaves, read),
        `the page reads ${read} and the route's answer does not carry it in any state`);
    }
    assert.ok(leaves.has('lastRun.skipped') && leaves.has('lastError.message'),
      'the driven scheduler never reached the skip and failure branches');
  } finally {
    await srv.close();
  }
});

/* ── the two halves agree: what the page posts is what the route reads ────── */

test('every key the page posts to a driver route is read by that route', async () => {
  const handlers = [
    ['POST /api/live', postedKeys("arbiterApi.post('/api/live', {")],
    ['POST /api/scheduler', postedKeys("arbiterApi.post('/api/scheduler', {")],
  ];
  for (const [route, keys] of handlers) {
    const body = new RegExp(`'${route}': async \\(req\\) => \\{([\\s\\S]*?)\\n    \\},`).exec(routerSource);
    assert.ok(body, `the router lost its ${route} handler — this test pins it`);
    for (const key of keys) {
      assert.ok(new RegExp(`\\bbody\\.${key}\\b`).test(body[1]),
        `${route} never reads body.${key}, though the page posts it — the save would land on a default`);
    }
  }
});

test('the readers the page draws these panels with ask the routes and are called', async () => {
  for (const [fn, route] of [['refreshLive', '/api/live'], ['refreshScheduler', '/api/scheduler']]) {
    const win = pageWindow(fn);
    assert.ok(win.includes(`arbiterApi.get('${route}')`),
      `${fn} no longer asks for ${route}`);
    const callSites = [...pageSource.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))].length;
    assert.ok(callSites >= 1, `${fn} is defined and never called (${callSites} call sites)`);
  }
});
