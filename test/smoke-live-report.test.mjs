import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { floorVerdict } from '../scripts/smoke-verdict.mjs';

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

/**
 * Write a scratch registry that differs from the real one only where this test
 * needs it to.
 *
 * The gate reads its registry from `SMOKE_CONFIG_PATH`, so a run can be given a
 * copy instead of the repository file. That matters beyond tidiness: this suite
 * runs its files in parallel, and most of them parse `config/scrapers.json` at
 * import. A test that rewrites the real file is therefore writing to a document
 * other files are reading, and the reader that arrives mid-write fails with
 * "Unexpected end of JSON input" — a red test in a bookmaker file, pointing at
 * the smoke gate, for a fault the smoke gate did not cause.
 */
async function scratchConfig(dir, edit) {
  const text = await readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8');
  const config = JSON.parse(text);
  edit(config);
  const path = join(dir, 'scrapers.json');
  await fs.writeFile(path, JSON.stringify(config, null, 2), 'utf8');
  return path;
}

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
  // The floor wording is pinned without the network in the last test. This
  // job is scraped for real, so it may also have failed in transport first,
  // and a timeout is not evidence about the floor either way.
  assert.match(json.jobs[0].why, /expected >= 999999|^status /,
    'the reason names the threshold that was missed, or the transport failure that pre-empted it');
});

test('a per-job minEvents floor overrides the global default', async (t) => {
  // The floor exists for a source whose own coverage is legitimately small,
  // where a global floor of 1 would still pass on a single stray event after
  // real coverage collapsed. That only works if the job's declared floor is
  // actually consulted, so this asserts the override directly.
  //
  // superbet declares no floor, so with --min-events 1 it must PASS; a scratch
  // config where superbet DOES declare a floor of 999999 must FAIL on that
  // floor even though the global default is 1. Without the override, a job
  // declaring a floor would be silently ignored.
  const configDir = await mkdtemp(join(tmpdir(), 'arbiter-smoke-floor-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));

  // The real registry is read to build the copy and then checked to still be
  // the same bytes. The gate is pointed at the copy, so nothing here edits the
  // shared file.
  const realPath = join(ROOT, 'config', 'scrapers.json');
  const realBefore = await readFile(realPath, 'utf8');
  const configPath = await scratchConfig(configDir, (config) => {
    const superbet = config.jobs.find((j) => j.id === 'superbet');
    assert.ok(superbet, 'the registry still declares superbet, which this test floors');
    superbet.minEvents = 999999;
  });

  const report = join(configDir, 'report.json');
  const result = await runSmoke({ SMOKE_CONFIG_PATH: configPath, SMOKE_REPORT_PATH: report });
  assert.equal(result.code, 1, "a job's own floor must fail the gate even when the global default is 1");

  const json = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(json.jobs[0].verdict, 'FAIL');
  // End-to-end proof when superbet answers; the override itself is proven
  // without the network below, so a timeout does not fail this test for a
  // reason that has nothing to do with the job floor.
  if (json.jobs[0].why.startsWith('collected')) {
    assert.match(json.jobs[0].why, /expected >= 999999/, 'the job floor is the threshold reported');
    assert.match(json.jobs[0].why, /job floor/, 'the report says which threshold applied');
  }

  assert.equal(await readFile(realPath, 'utf8'), realBefore,
    'the gate read the scratch registry; the repository one is unchanged');
});

test('the gate reads the registry it is pointed at, not the repository one', async (t) => {
  // Offline, and independent of the floor machinery: a scratch registry that
  // does not declare superbet makes the gate refuse the name before any
  // scraper is constructed. If SMOKE_CONFIG_PATH were ignored, the real
  // registry would be read, superbet would be found, the run would go to the
  // network and a report would be written. The refusal with no report is the
  // discriminator.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-smoke-scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const configPath = join(dir, 'scrapers.json');
  await fs.writeFile(configPath, JSON.stringify({ jobs: [{ id: 'fortuna', enabled: true }] }), 'utf8');
  const report = join(dir, 'report.json');

  const realPath = join(ROOT, 'config', 'scrapers.json');
  const realBefore = await readFile(realPath, 'utf8');
  const result = await runSmoke({ SMOKE_CONFIG_PATH: configPath, SMOKE_REPORT_PATH: report });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown bookmaker\(s\): superbet/,
    'the name is judged against the registry the gate was pointed at');
  await assert.rejects(readFile(report, 'utf8'),
    'a run refused before scraping writes no report');
  assert.equal(await readFile(realPath, 'utf8'), realBefore,
    'the repository registry is never the one under test');
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

test('the floor decides a verdict with no network involved', () => {
  // The gate scrapes a real book, and a book can fail in transport before its
  // floor is ever consulted: a superbet timeout records `status timeout` and
  // the floor is never consulted. That is a different outcome with a
  // different reason, and it used to fail these assertions through no fault
  // of the floor. The decision is a pure function now, so both branches and
  // the override are pinned here.
  const empty = floorVerdict({ job: {}, minEvents: 1, events: 0 });
  assert.equal(empty.verdict, 'FAIL');
  assert.equal(empty.why, 'collected 0 event(s), expected >= 1');

  const globalFloor = floorVerdict({ job: {}, minEvents: 999999, events: 3 });
  assert.equal(globalFloor.verdict, 'FAIL');
  assert.equal(globalFloor.why, 'collected 3 event(s), expected >= 999999');
  assert.doesNotMatch(globalFloor.why, /job floor/, 'the global floor is not reported as a job floor');

  // A declared floor overrides the global default, and the reason says which.
  const jobFloor = floorVerdict({ job: { minEvents: 999999 }, minEvents: 1, events: 3 });
  assert.equal(jobFloor.verdict, 'FAIL');
  assert.equal(jobFloor.floor, 999999);
  assert.equal(jobFloor.why, 'collected 3 event(s), expected >= 999999 (job floor)');

  // The control: meeting the floor exactly is a pass, with no reason attached.
  const passing = floorVerdict({ job: { minEvents: 5 }, minEvents: 1, events: 5 });
  assert.equal(passing.verdict, 'ok');
  assert.equal(passing.why, null);
});
