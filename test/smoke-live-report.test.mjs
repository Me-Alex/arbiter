import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SMOKE = join(ROOT, 'scripts', 'smoke-live.mjs');

/**
 * The gate publishes its result rather than only printing it.
 *
 * A line in a log is invisible a week later, and the whole point of a
 * scheduled gate is that someone learns a book stopped returning events
 * without remembering to go and look. So the run leaves two artefacts: a
 * per-book table in the job summary, and a machine-readable report.
 *
 * The point of these tests is the contract of those artefacts, not the
 * scraping itself — every assertion here runs offline, with a threshold that
 * cannot be met, so no network is involved.
 */

function runSmoke(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SMOKE, 'superbet', '--min-events', '999999'],
      { cwd: ROOT, env: { ...process.env, ...env }, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

test('the gate writes a report and a job summary', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-smoke-report-'));
  const summary = join(dir, 'summary.md');
  const report = join(dir, 'report.json');
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A threshold no book can meet makes the run fail, which is the interesting
  // case: the artefacts have to be written *anyway*, or a failure is exactly
  // when there is nothing to look at.
  const result = await runSmoke({ GITHUB_STEP_SUMMARY: summary, SMOKE_REPORT_PATH: report });

  assert.equal(result.code, 1, 'an unmet threshold must fail the gate');
  assert.match(result.stdout, /0\/1 jobs passed/, 'the console line still reports the outcome');

  const md = await readFile(summary, 'utf8');
  assert.match(md, /### Live smoke/, 'the summary is headed so it reads as a report');
  assert.match(md, /\| Book \| Verdict \| Events \| Time \| Note \|/, 'one row per book, with a verdict');
  assert.match(md, /\| superbet \| \*\*FAIL\*\* \|/, 'a failing book is marked as such');
  assert.match(md, /stopped returning usable events/, 'the summary says what a failure means');

  const json = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(json.ok, false);
  assert.equal(json.passed, 0);
  assert.equal(json.total, 1);
  assert.match(json.finishedAt, /^\d{4}-\d{2}-\d{2}T/, 'the report is timestamped');
  assert.equal(json.jobs.length, 1);
  assert.equal(json.jobs[0].id, 'superbet');
  assert.equal(json.jobs[0].verdict, 'FAIL');
  assert.match(json.jobs[0].why, /expected >= 999999/, 'the reason names the threshold that was missed');
});

test('the report is written even without a CI environment', async (t) => {
  // A developer running the gate locally should still get a file to look at,
  // and the default path must not be somewhere that pollutes the repository
  // without being ignored.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-smoke-local-'));
  const report = join(dir, 'report.json');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await runSmoke({ SMOKE_REPORT_PATH: report, GITHUB_STEP_SUMMARY: '' });
  assert.equal(result.code, 1);

  const json = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(json.ok, false);
  assert.doesNotMatch(result.stdout, /cannot write/, 'a writable path is not reported as a failure');
});

test('a default run writes data-health.json, and git ignores it', async () => {
  // The default path is what CI uses, so the artefact lands in the working
  // tree. It must be ignored, or every scheduled run leaves the tree dirty.
  const ignore = await fs.readFile(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^data-health\.json$/m, 'the default report path is gitignored');

  const source = await fs.readFile(SMOKE, 'utf8');
  assert.match(source, /data-health\.json/, 'the default report path is documented in the script');
  assert.match(source, /could not write/, 'an unwritable path warns instead of failing the gate');
});
