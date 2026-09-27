import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The daily gate answers "is anything broken today". It cannot answer "has this
 * been broken all week", because each run stands alone and nothing connects
 * them. A provider that starts returning nothing fails every run from that day
 * on, and the failure arrives as noise rather than as a pattern.
 *
 * These assertions pin the distinction the trend checker exists to draw: one
 * bad day is not a trend, a majority of recent runs is, and too little history
 * is neither.
 *
 * Run names carry `:` replaced by `-` because Windows forbids colons in
 * filenames. A history built from raw ISO stamps is readable on a Linux runner
 * and silently empty on the machine that wrote it — which is the failure this
 * naming rule prevents.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TREND = join(ROOT, 'scripts', 'smoke-trend.mjs');

/** A run's report, in the shape scripts/smoke-live.mjs writes. */
function report(verdicts) {
  const jobs = Object.entries(verdicts).map(([id, verdict]) => ({
    id,
    verdict,
    events: verdict === 'ok' ? 100 : 0,
    ms: 100,
    why: null,
  }));
  return JSON.stringify({
    finishedAt: '2030-02-01T10:00:00.000Z',
    passed: jobs.filter((j) => j.verdict === 'ok').length,
    total: jobs.length,
    ok: jobs.every((j) => j.verdict === 'ok'),
    minEvents: 1,
    jobs,
  });
}

async function withHistory(runs, run) {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-trend-'));
  try {
    runs.forEach((r, i) => {
      // Portably stamped, so the fixture works on the platform writing it too.
      const stamp = `2030-02-${String(i + 1).padStart(2, '0')}T10-00-00Z.json`;
      return fs.writeFile(join(dir, stamp), report(r));
    });
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTrend(dir, extra = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TREND, '--dir', dir, ...extra], { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('a book failing in most recent runs is a trend', async () => {
  await withHistory([
    { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'FAIL' }, { maxbet: 'FAIL' }, { maxbet: 'FAIL' },
  ], async (dir) => {
    const r = await runTrend(dir);
    assert.equal(r.code, 1, 'a pattern must fail the check');
    assert.match(r.stdout, /maxbet/, 'the failing book is named');
    assert.match(r.stdout, /3 of the last 5/, 'and how often it failed');
  });
});

test('one failing run in five is a bad day, not a trend', async () => {
  await withHistory([
    { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'FAIL' },
  ], async (dir) => {
    const r = await runTrend(dir);
    assert.equal(r.code, 0, 'a single failure must not fail the check');
    assert.match(r.stdout, /no book is failing repeatedly/, 'and the reason is stated');
  });
});

test('a healthy history passes', async () => {
  await withHistory([
    { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'ok' }, { maxbet: 'ok' },
  ], async (dir) => {
    const r = await runTrend(dir);
    assert.equal(r.code, 0);
  });
});

test('too little history reports that, rather than all-clear', async () => {
  await withHistory([{ maxbet: 'ok' }], async (dir) => {
    const r = await runTrend(dir);
    assert.equal(r.code, 0, 'no data is not a failure');
    assert.match(r.stdout, /need at least 3/, 'and it says it cannot conclude anything');
  });
});

test('a missing history directory is not an error', async () => {
  const r = await runTrend(join(tmpdir(), 'arbiter-no-such-history-'));
  assert.equal(r.code, 0, 'a first run has no history, which is expected');
  assert.match(r.stdout, /nothing to trend-check/, 'and says so');
});

test('the history names a run portably', async () => {
  // A colon in a filename is fine on Linux and fatal on Windows, so a history
  // written from a raw ISO stamp would be readable on a runner and empty on
  // the machine that produced it. The rule is simply: nothing builds a report
  // name out of a timestamp that still contains colons.
  const source = await fs.readFile(TREND, 'utf8');
  const stampPattern = source.match(/const STAMP = (.*);/);
  assert.ok(stampPattern, 'the accepted name shape is declared once, as a constant');
  assert.doesNotMatch(stampPattern[1], /\[0-9:\]/, 'and it does not accept colons in the time part');
  assert.doesNotMatch(stampPattern[1], /T\[:/, 'the ISO colon run is excluded from the accepted names');
});
