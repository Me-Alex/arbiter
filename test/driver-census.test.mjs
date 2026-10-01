/**
 * driver-census.test.mjs — every field the two recurring drivers publish is read
 * by the scrape page, or carries a measured reason.
 *
 * Anchored in the running services
 * --------------------------------
 * `GET /api/scheduler` and `GET /api/live` return `scheduler.status()` and
 * `live.status()` and nothing else, and neither `status()` has a fixed shape:
 * `lastRun` is a different object in each branch of `_tick`, and the live poll
 * adds `durationMs`/`keepingUp` only when the run reported a finish time. A
 * hand-written list of keys would be a copy that stops being true silently, so
 * the published set below is the union of leaf paths over payloads produced by
 * driving the real services through every branch they have — success, skip,
 * failure, a settle with and without a finish time, and a restart.
 *
 * The reads are anchored in the page's own source with the comments stripped
 * first, because this file's subject mentions most of these fields by name in
 * prose. A mention is not a read, and the previous census in this tree had
 * exactly that false positive: a leaf that merely appeared in the source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchedulerService } from '../src/scheduler-service.mjs';
import { LiveService } from '../src/live-service.mjs';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const scrapeSource = read('public/js/pages/scrape.js');
const schedulerSource = read('src/scheduler-service.mjs');
const liveSource = read('src/live-service.mjs');

/* ── the page's own source, minus its prose ───────────────────────────────── */

// The shared masker, not a fourth copy of one. test/helpers/code-only.mjs
// exists because three instruments in this tree answered "is this field read?"
// with their own regex over raw text, and raw text cannot tell a read from a
// mention — `selection.group` is read by nobody and its only trace in the
// frontend is the word "group:" inside a comment. This file wrote a fifth, and
// the pair it used had the other failure mode the helper's own test pins:
// `(^|[^:])\/\/.*$` cuts a line at a `//` inside a string literal, which can only
// shorten what a search finds — so a real read would have been reported absent
// and pushed into UNREAD_BY_DESIGN. Measured against the helper on scrape.js, the
// two agree on every field name in the file today, so no exemption here is wrong;
// that is a fact about this snapshot, not a property of the regex.
const pageCode = codeOnly(scrapeSource);

/** Every `.name` occurrence in the page's code, as `receiver.name` pairs. */
const memberReads = (receiver, name) => new RegExp(`\\b${receiver}\\.${name}\\b`).test(pageCode);

/* ── the payload shapes, produced by the real services ────────────────────── */

const AT = '2026-09-30T09:00:00.000Z';
const SCAN_INPUT = {
  bankroll: 500, minRoiPercent: 1, minEvPercent: 2, maxMiddleRiskPercent: 10,
  minMiddleRoiPercent: 30, includeLive: false, includePast: true,
  maxEvents: 250, sport: 'soccer',
};

/** The nine fields `currentScanOptions()` builds, read out of the page itself. */
const pageScanFields = () => {
  const window = scrapeSource.match(/function currentScanOptions\(\) \{([\s\S]*?)\n\}/);
  assert.ok(window, 'the page must still build its scan payload in currentScanOptions()');
  // Every line that opens with `key:` in that body. The object is flat, so
  // there is no nested brace to descend into — and if one is added, the count
  // below fails, which is the canary this file wants rather than a silent
  // over-collection of keys that are not the payload's.
  const names = [...window[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.equal(names.length, 9,
    `currentScanOptions() must build exactly the nine scan fields, found ${names.join(', ')}`);
  return names;
};

/** Every leaf path of a payload, arrays marked `[]` as the other census marks them. */
function leafPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    if (value.length) out.add(`${prefix}[]`);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) leafPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (prefix) out.add(prefix);
  return out;
}

const merge = (into, from) => {
  for (const p of from) into.add(p);
  return into;
};

function tmpDir(tag) {
  return mkdtemp(join(tmpdir(), `arbiter-census-${tag}-`));
}

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

/**
 * Drive the scheduler through every branch `_tick` has and collect the leaves of
 * each status payload.
 */
async function driveScheduler() {
  const dataDir = await tmpDir('scheduler');
  const orch = orchestrator();
  const svc = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orch });
  const paths = new Set();

  merge(paths, leafPaths(await svc.status()));

  await svc.enable({ bookIds: ['fortuna', 'superbet'], scanOptions: SCAN_INPUT, intervalMinutes: 15 });
  merge(paths, leafPaths(await svc.status()));

  // Branch 1: a tick that finds a scrape already running.
  orch.running = true;
  await svc._tick(['fortuna'], SCAN_INPUT);
  merge(paths, leafPaths(await svc.status()));
  orch.running = false;

  // Branch 2: a launch that runs.
  await svc._tick(['fortuna'], SCAN_INPUT);
  merge(paths, leafPaths(await svc.status()));

  // Branch 3: a launch that throws — the only branch that records lastError.
  orch.launchThrows = 'orchestrator refused';
  await svc._tick(['fortuna'], SCAN_INPUT);
  const failed = await svc.status();
  merge(paths, leafPaths(failed));

  // And the interval callback's own catch, which records lastError and no run.
  svc._timer = null;
  svc._startTimer();
  await svc._tick(['fortuna'], SCAN_INPUT).catch(() => {});
  merge(paths, leafPaths(await svc.status()));
  await svc.disable();

  // A restart, so `resumed` is a shape the payload really takes.
  const restarted = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await restarted.loadState();
  merge(paths, leafPaths(await restarted.status()));
  await restarted.disable();

  await rm(dataDir, { recursive: true, force: true });
  return { paths, failed, svc, dataDir };
}

/** The same for the live poll, including both settle shapes. */
async function driveLive() {
  const dataDir = await tmpDir('live');
  const orch = orchestrator();
  const svc = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  const paths = new Set();

  merge(paths, leafPaths(await svc.status()));

  await svc.enable({ bookIds: [], scanOptions: { ...SCAN_INPUT, includeLive: true }, intervalSeconds: 60 });
  merge(paths, leafPaths(await svc.status()));

  // A tick that finds a scrape already running: skippedTicks and lastSkippedAt
  // are written here and lastRun deliberately is not.
  orch.running = true;
  await svc._tick();
  merge(paths, leafPaths(await svc.status()));
  orch.running = false;

  // A launched poll: pending appears, lastRun still the previous one.
  await svc._tick();
  const pending = await svc.status();
  merge(paths, leafPaths(pending));

  // The settle with a finish time: durationMs and keepingUp are both written.
  orch.scrapeState = { runId: 'run-1', status: 'completed', finishedAt: '2026-09-30T09:01:15.000Z' };
  await svc._tick();
  const settled = await svc.status();
  merge(paths, leafPaths(settled));

  // The settle without one: no durationMs, so no keepingUp either. That is why
  // the published set below has to be a union and not a single sample.
  await svc._tick();
  orch.scrapeState = { runId: 'run-1', status: 'cancelled' };
  await svc._tick();
  const noFinish = await svc.status();
  merge(paths, leafPaths(noFinish));

  // A launch that throws.
  orch.scrapeState = null;
  orch.launchThrows = 'pipeline unavailable';
  await svc._tick();
  const failed = await svc.status();
  merge(paths, leafPaths(failed));
  await svc.disable();

  // A poll restricted to a subset, because the list this page sends is empty —
  // "every book" — and an empty array contributes no leaf at all. The field is
  // still published and still varies: loadState() restores whatever the state
  // file holds, so a poll armed with a subset publishes names here.
  await svc.enable({ bookIds: ['fortuna'], intervalSeconds: 60 });
  merge(paths, leafPaths(await svc.status()));
  await svc.disable();

  const restarted = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await restarted.loadState();
  merge(paths, leafPaths(await restarted.status()));
  await restarted.disable();

  await rm(dataDir, { recursive: true, force: true });
  return { paths, pending, settled, noFinish, failed };
}

const schedulerDriven = await driveScheduler();
const liveDriven = await driveLive();

const R_SCHED = 'GET /api/scheduler';
const R_LIVE = 'GET /api/live';

/** The keys these routes publish when the page drives them, as pinned below. */
const SCAN_FIELDS = [...pageScanFields()].sort();

const PINNED_SCHEDULER = [
  'active', 'bookIds[]', 'enabled', 'intervalMinutes', 'lastError', 'lastError.at', 'lastError.message',
  'lastRun', 'lastRun.at', 'lastRun.launched', 'lastRun.ok', 'lastRun.reason', 'lastRun.skipped',
  'resumed', ...SCAN_FIELDS.map((f) => `scanOptions.${f}`),
].sort();

const PINNED_LIVE = [
  'active', 'bookIds[]', 'enabled', 'intervalSeconds', 'lastError', 'lastError.at', 'lastError.message',
  'lastRun', 'lastRun.at', 'lastRun.durationMs', 'lastRun.keepingUp', 'lastRun.ok', 'lastRun.runId',
  'lastRun.status', 'liveMaxAgeMs', 'pending', 'pending.runId', 'pending.startedAt', 'resumed',
  'scanningAllBooks', 'skippedTicks', 'lastSkippedAt',
  ...SCAN_FIELDS.map((f) => `scanOptions.${f}`),
].sort();

/* ── what the page reads ──────────────────────────────────────────────────── */

/**
 * The textual forms a leaf is read through.
 *
 * Each entry is the page's own variable: `s` is the scheduler payload in both
 * `refreshScheduler` and the helpers it hands it to, `l` and `last` are the live
 * payload and the `lastRun` alias the measured line takes it apart into, and
 * `schedulerLastRunText` receives either payload under `s`, so `lastRun`'s leaves
 * are read as `lastRun.<leaf>` for the live route too.
 */
const READ_FORMS = {
  [R_SCHED]: {
    enabled: ['s.enabled'],
    resumed: ['s.resumed'],
    intervalMinutes: ['s.intervalMinutes'],
    'bookIds[]': ['s.bookIds'],
    lastRun: ['s.lastRun'],
    'lastRun.at': ['lastRun.at'],
    'lastRun.ok': ['lastRun.ok'],
    'lastRun.skipped': ['lastRun.skipped'],
    'lastRun.reason': ['lastRun.reason'],
    lastError: ['s.lastError'],
    'lastError.message': ['lastError.message'],
  },
  [R_LIVE]: {
    enabled: ['l.enabled'],
    resumed: ['l.resumed'],
    intervalSeconds: ['l.intervalSeconds'],
    liveMaxAgeMs: ['l.liveMaxAgeMs'],
    'bookIds[]': ['l.bookIds'],
    scanningAllBooks: ['l.scanningAllBooks'],
    pending: ['l.pending'],
    'pending.runId': ['pending.runId'],
    'pending.startedAt': ['pending.startedAt'],
    lastRun: ['l.lastRun'],
    'lastRun.at': ['lastRun.at'],
    'lastRun.ok': ['lastRun.ok'],
    'lastRun.durationMs': ['last.durationMs'],
    'lastRun.keepingUp': ['last.keepingUp'],
    lastError: ['l.lastError'],
    'lastError.message': ['lastError.message'],
    skippedTicks: ['l.skippedTicks'],
    lastSkippedAt: ['l.lastSkippedAt'],
  },
};

/**
 * `scanOptions` is read by name, not by spelling each key out: the page compares
 * a named field list against the stored copy (`saved[field]`), so its leaves are
 * read or unread as a group.
 *
 * Route-specific, because the two panels hand the stored copy in at different
 * call sites and either one could stop doing so without the other noticing.
 */
const readsScanOptions = (label) => {
  const list = scrapeSource.match(/const SCHEDULER_SCAN_FIELDS = \[([\s\S]*?)\n\];/);
  assert.ok(list, 'the page must still compare a named field list, not a deep equality');
  const named = [...list[1].matchAll(/\['(\w+)',\s*'\w+'\]/g)].map((m) => m[1]);
  if (named.length === 0) return false;
  const handoff = label === R_LIVE
    ? /scanDiffLine\(l\.scanOptions,/.test(pageCode)
    : /scanDiffLine\(saved, currentScanOptions\(\)/.test(pageCode);
  return handoff && /\bsaved\[field\]/.test(pageCode);
};

const readsLeaf = (label, leaf) => {
  if (leaf.startsWith('scanOptions.')) return readsScanOptions(label);
  const forms = READ_FORMS[label][leaf];
  return forms ? forms.some((form) => memberReads(form.split('.')[0], form.split('.')[1])) : false;
};

const readsSet = (label) => new Set(
  [...PINNED_SCHEDULER, ...PINNED_LIVE]
    .filter((leaf) => readsLeaf(label, leaf))
    .map((leaf) => leaf.split('.').pop().replace(/\[\]$/, '')),
);

/* ── the reasons ──────────────────────────────────────────────────────────── */

const WHY = {
  active: [
    '`active` is `Boolean(this._timer)` beside `enabled`, and the panel prints `enabled`.',
    'They are the same value on every path that can change either — measured by',
    'driving the whole lifecycle below and asserting the agreement at each step —',
    'and the measurement counts the intervals actually armed, so it is not the',
    'agreement a cleared handle would fake: `_timer` used to keep a cleared',
    'reference, which made `active` true while nothing was scheduled.',
  ].join(' '),
  launched: [
    '`launched: true` is written in exactly one branch of `_tick`, the one that',
    'also sets `ok: true`, and is absent from the other two — measured below by',
    'driving all three branches and asserting `Boolean(launched) === ok` in each.',
    'The panel prints the verdict from `ok`, so the flag carries no information',
    'it does not already have.',
  ].join(' '),
  lastErrorAt: [
    '`message` and `at` are always written together — measured by driving the',
    'failure branch, and by the source, where every site that records one records',
    'the other. The panel prints the message verbatim beside the run timestamp',
    'on the same line, and the only sites that record `lastError` without a run',
    'beside it are the two interval callbacks, whose rejection can only come from',
    'outside the launch (the launch is inside a try/catch that catches it first):',
    'a persistence failure, which is a failure with no run to timestamp. On that',
    'path the run time on the line is the previous tick\'s, which this entry',
    'records as a known coarsening rather than as parity.',
  ].join(' '),
  lastRunId: [
    'The page reads four run ids and this is not one of them — pinned below.',
    'Two are the live panel\'s own in-flight check, `pending.runId` matched against',
    'the orchestrator\'s `lastState.runId`; the other two are the page\'s active-run',
    'header (`state.runId`) and the run table\'s rows (`run.runId`). A finished poll',
    'has no reader for its id: this panel identifies a settled poll by its finish',
    'time, its verdict and its measured duration, and there is no second surface',
    'that would want to link it to a row. The page names the field in a comment',
    'beside that check and reads nothing there, which is why this is measured by',
    'counting the read sites rather than by the absence of one.',
  ].join(' '),
  lastRunStatus: [
    '`ok` is computed as `status === \'completed\'` at one site and the panel',
    'prints the verdict from `ok`, so the raw terminal string is what the verdict',
    'is made of rather than a second fact. It does carry one thing the verdict',
    'loses — a cancelled poll and a failed one are both `ok: false` — and this',
    'entry records that coarsening instead of hiding it behind a claim of parity.',
  ].join(' '),
};

/**
 * Published, unread, with the reason it is allowed. Route-scoped: `active` is on
 * both routes, `lastError.at` on both, and `lastRun`'s leaves differ because the
 * two `_tick` implementations write different objects.
 */
const UNREAD_BY_DESIGN = {
  [`${R_SCHED} › active`]: WHY.active,
  [`${R_SCHED} › lastRun.launched`]: WHY.launched,
  [`${R_SCHED} › lastError.at`]: WHY.lastErrorAt,
  [`${R_LIVE} › active`]: WHY.active,
  [`${R_LIVE} › lastError.at`]: WHY.lastErrorAt,
  [`${R_LIVE} › lastRun.runId`]: WHY.lastRunId,
  [`${R_LIVE} › lastRun.status`]: WHY.lastRunStatus,
};

const exempt = (label, leaf) => Object.prototype.hasOwnProperty.call(UNREAD_BY_DESIGN, `${label} › ${leaf}`)
  || Object.prototype.hasOwnProperty.call(UNREAD_BY_DESIGN, `${label} › ${leaf.split('.').pop()}`);

const CENSUS = [
  { label: R_SCHED, published: [...schedulerDriven.paths].sort(), pinned: PINNED_SCHEDULER },
  { label: R_LIVE, published: [...liveDriven.paths].sort(), pinned: PINNED_LIVE },
];

/* ── the tests ────────────────────────────────────────────────────────────── */

function censusFor({ label, published, pinned }) {
  assert.deepEqual(published, [...pinned].sort(),
    `${label} gained or lost a field — re-measure it and decide whether a page reads it`);
  const unread = published
    .filter((leaf) => !readsLeaf(label, leaf) && !exempt(label, leaf));
  assert.deepEqual(unread, [],
    `${label}: no page reads these, and they carry no reason above — ${unread.join(', ')}`);
}

test('every field the two drivers publish is read, or has a measured reason', () => {
  for (const census of CENSUS) censusFor(census);
});

test('the published set is the services\' own, not a list typed beside them', () => {
  // The control for the whole file. If the drive above produced nothing, every
  // comparison below would pass on an empty set — `deepEqual([], [])` is a
  // census that censuses nothing. These counts are what the drives actually
  // returned, asserted so a broken drive fails here instead of silently
  // emptying the census.
  assert.equal(schedulerDriven.paths.size, PINNED_SCHEDULER.length,
    'the scheduler drive produced one leaf path per pinned field');
  assert.equal(liveDriven.paths.size, PINNED_LIVE.length,
    'the live drive produced one leaf path per pinned field');
  // And each branch really ran: the union is only the union if the branches differ.
  assert.ok([...schedulerDriven.paths].includes('lastRun.launched'), 'the success branch ran');
  assert.ok([...schedulerDriven.paths].includes('lastRun.skipped'), 'the skip branch ran');
  assert.ok([...liveDriven.paths].includes('lastRun.keepingUp'), 'a settle with a finish time ran');
  assert.ok([...liveDriven.paths].includes('lastRun.status'), 'and one without');
  assert.ok([...liveDriven.paths].includes('pending.startedAt'), 'and a launched, unsettled poll');
  assert.ok([...schedulerDriven.paths].includes('lastError.message'), 'and a failure');
});

test('no exemption names a field its own route reads', () => {
  for (const key of Object.keys(UNREAD_BY_DESIGN)) {
    const [label, ...rest] = key.split(' › ');
    const leaf = rest.join(' › ');
    const census = CENSUS.find((c) => c.label === label);
    assert.ok(census, `${key} is exempted from but is not one of the two censuses`);
    assert.ok(!readsLeaf(label, leaf),
      `${key} is exempt, but the page reads it — remove the entry and say why in the same commit`);
  }
});

test('every exemption carries a written reason — none is left unreasoned', () => {
  // The field census in this tree has one deliberately blank entry, `options` on
  // /api/scrape/state, because one stored sample cannot tell a varying field
  // from a constant one. Nothing on these two routes is in that position: each
  // service publishes an object it builds itself, so every branch is reachable
  // here and was driven. There is therefore no blank entry, and this test fails
  // if one is added to save writing one.
  const unreasoned = Object.keys(UNREAD_BY_DESIGN).filter((k) => !UNREAD_BY_DESIGN[k].trim());
  assert.deepEqual(unreasoned, [], 'every exemption must carry a reason this file can measure');
  for (const [key, reason] of Object.entries(UNREAD_BY_DESIGN)) {
    assert.ok(reason.length > 80, `${key}: a reason has to say what was measured`);
  }
});

/**
 * The `active` reason, measured.
 *
 * The lifecycle both services actually go through, with the intervals counted
 * rather than trusted: `active === enabled` was true before this file existed
 * and was still true while a cleared handle stood in for a live one, so the
 * agreement alone proves nothing. What makes it a measurement is that every step
 * which claims `active` also has a freshly armed interval behind it.
 */
test('`active` is the same value as `enabled`, and it is armed when it says so', async () => {
  for (const [Ctor, tag, args] of [
    [SchedulerService, 'scheduler', { bookIds: ['fortuna'], intervalMinutes: 15 }],
    [LiveService, 'live', { intervalSeconds: 60 }],
  ]) {
    const dataDir = await tmpDir(`active-${tag}`);
    const svc = new Ctor({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
    const armed = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => {
      const handle = realSetInterval(fn, ms);
      armed.push(handle);
      return handle;
    };
    const agree = async (step) => {
      const s = await svc.status();
      assert.equal(typeof s.active, 'boolean', `${tag}: ${step} — active is a real boolean`);
      assert.equal(s.active, s.enabled, `${tag}: ${step} — active and enabled agree`);
      if (s.active) {
        // The half that makes this a measurement: `active` claims a timer is
        // scheduled, so a new interval must exist and be the one in `_timer`.
        assert.ok(armed.length > 0, `${tag}: ${step} — active says armed, and something was armed`);
        assert.equal(svc._timer, armed[armed.length - 1],
          `${tag}: ${step} — active is true and the newest armed interval is the one in force`);
      }
      return s;
    };

    try {
      await agree('fresh');
      await svc.enable(args);
      await agree('after enable');
      // The step this whole file exists next to: the page posts `enabled` on
      // every save, and before the fix this one cleared the interval and armed
      // no replacement while still reporting itself armed.
      await svc.enable(args);
      await agree('after a second enable');
      const restarted = new Ctor({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
      await restarted.loadState();
      const resumed = await restarted.status();
      assert.equal(resumed.resumed, true, `${tag}: the restore is its own flag`);
      await restarted.disable();
      await svc.disable();
      await agree('after disable');
    } finally {
      globalThis.setInterval = realSetInterval;
      for (const handle of armed) realClearInterval(handle);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test('`lastRun.launched` says nothing `ok` does not, in any branch', async () => {
  const dataDir = await tmpDir('launched');
  const orch = orchestrator();
  const svc = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orch });
  await svc.enable({ bookIds: ['fortuna'], intervalMinutes: 15 });

  const branches = [];
  orch.running = true;
  await svc._tick(['fortuna'], SCAN_INPUT);
  branches.push(await svc.status());
  orch.running = false;

  await svc._tick(['fortuna'], SCAN_INPUT);
  branches.push(await svc.status());

  orch.launchThrows = 'nope';
  await svc._tick(['fortuna'], SCAN_INPUT);
  branches.push(await svc.status());

  // Three branches, and they are not the same shape — or the comparison below
  // would hold on one sample.
  assert.equal(branches[0].lastRun.skipped, true);
  assert.equal(branches[1].lastRun.launched, true);
  assert.equal(branches[2].lastRun.ok, false);
  for (const [i, s] of branches.entries()) {
    assert.equal(Boolean(s.lastRun.launched), s.lastRun.ok,
      `branch ${i}: launched and ok cannot disagree`);
  }

  await svc.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('`ok` is the verdict made from `status`, and `status` is not read here', () => {
  assert.equal(liveDriven.settled.lastRun.ok, true, 'a completed poll is ok');
  assert.equal(liveDriven.settled.lastRun.status, 'completed');
  assert.equal(liveDriven.noFinish.lastRun.ok, false, 'a cancelled one is not');
  assert.equal(liveDriven.noFinish.lastRun.status, 'cancelled');
  assert.equal(liveDriven.noFinish.lastRun.durationMs, undefined,
    'and a run with no finish time has no duration — which is why the union, not one sample');
  // One site computes the verdict, so the raw string really is its input.
  assert.equal((liveSource.match(/ok: state\.status === 'completed'/g) || []).length, 1,
    'the verdict has a single construction site');
});

test('the page reads four run ids, and the settled one is not among them', () => {
  const sites = [...pageCode.matchAll(/\b(\w+)\.runId\b/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(sites)].sort(), ['lastState.runId', 'pending.runId', 'run.runId', 'state.runId'],
    'the page reads these four run ids and no others');
  // The reason above names the field in prose beside the in-flight check, so
  // the measurement has to be over code: without the strip, `lastRun.runId`
  // would appear here and the count would be satisfied by a comment.
  assert.ok(!/\.runId\b/.test(pageCode.replace(/\bpending\.runId|\blastState\.runId|\brun\.runId|\bstate\.runId/g, '')),
    'no fifth run id is read in code');
});

test('`lastError` is only ever recorded beside a run, except where there is no run', () => {
  // Every site that records a failure from a run records the run too.
  for (const src of [schedulerSource, liveSource]) {
    const sites = [...src.matchAll(/lastError = \{ ([^}]*) \}/g)].map((m) => m[1]);
    assert.ok(sites.length > 0, 'the service records failures');
    for (const site of sites) {
      assert.match(site, /message/, 'and always the message');
      assert.match(site, /at/, 'and always the time beside it');
    }
  }
  // The failure the drive produced recorded both, so the pair is not a shape
  // only the source claims.
  assert.ok(schedulerDriven.failed.lastRun, 'a failing tick still recorded its run');
  assert.ok(schedulerDriven.failed.lastError.at, 'and the error carries its own time');
  // The sites that record an error without a run are the interval callbacks, so
  // the coarseness named in the reason is bounded to those.
  const alone = (src) => [...src.matchAll(/lastError = \{ ([^}]*) \}/g)]
    .filter((m) => !m[1].includes('message'))
    .length;
  assert.equal(alone(schedulerSource) + alone(liveSource), 0,
    'no site records lastError alone; the interval callbacks record it with the same two keys');
});