import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The measured-outcome table is the evidence behind the document's central
 * claim, and a hand-maintained table drifts from the runs that produced it.
 * Nobody can tell which of the two is true, which makes the claim weaker than
 * it looks.
 *
 * So the journal is the source and the table is derived. These assertions
 * cover the property that makes that worth doing: the tool notices when the
 * two disagree, and refuses to pass silently.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYNC = join(ROOT, 'scripts', 'sync-measurements.mjs');
const JOURNAL = join(ROOT, 'data', 'measurements.jsonl');
const DOC = join(ROOT, 'docs', 'no-arbitrage-root-cause.md');

function runSync(args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SYNC, ...args], { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('the document marks the region the tool owns', async () => {
  const doc = await readFile(DOC, 'utf8');
  assert.ok(doc.includes('<!-- measurements:begin -->'), 'a start marker delimits the generated table');
  assert.ok(doc.includes('<!-- measurements:end -->'), 'an end marker delimits it');
  assert.ok(
    doc.indexOf('<!-- measurements:begin -->') < doc.indexOf('<!-- measurements:end -->'),
    'the start marker precedes the end marker',
  );
});

test('the table currently matches the journal', async (t) => {
  // The check mode, not --write: this asserts agreement rather than producing
  // it, so a journal that grows without a re-sync fails here.
  //
  // The journal is gitignored, so a clean checkout — a CI runner, a fresh
  // clone — has none. There is nothing to compare against, and that is not
  // drift. The test asserts agreement when a journal exists and skips
  // otherwise, rather than failing on an absence it cannot fix.
  let journal;
  try {
    journal = await readFile(JOURNAL, 'utf8');
  } catch {
    t.skip('no journal in this checkout (it is gitignored); nothing to compare the table against');
    return;
  }
  const hasMeasurements = journal.trim().split('\n').filter(Boolean)
    .some((line) => JSON.parse(line).events > 0);
  if (!hasMeasurements) {
    t.skip('the journal has no round that collected anything; nothing to compare against');
    return;
  }
  const result = await runSync();
  assert.equal(result.code, 0, `the table has drifted from the journal: ${result.stderr.trim()}`);
});

test('the tool detects a hand-edited table rather than trusting it', async () => {
  // A copy of the document and journal, with the table changed by hand. The
  // tool must notice, which is the entire reason it exists.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-sync-'));
  try {
    const doc = await readFile(DOC, 'utf8');
    // Tamper with a number inside the generated region rather than a row
    // label, so the fixture does not depend on how a row happens to be worded.
    const start = doc.indexOf('<!-- measurements:begin -->');
    const end = doc.indexOf('<!-- measurements:end -->');
    assert.ok(start >= 0 && end > start, 'the document has a generated region');
    const region = doc.slice(start, end);
    const tamperedRegion = region.replace(/\| 7 \| (\d\d:\d\d[^|]*\| 10 \| )1000( \|)/,
      (m, mid, tail) => `| 7 | ${mid}9999${tail}`);
    assert.notEqual(tamperedRegion, region, 'the fixture was actually modified');
    const tampered = doc.slice(0, start) + tamperedRegion + doc.slice(end);

    // Point the tool at the tampered copy by running it in a directory that
    // mirrors the two paths it reads.
    //
    // The journal here is written by the test rather than copied: the real one
    // is gitignored, so a clean checkout has none, and a test that depends on
    // it fails for a reason that has nothing to do with what it checks.
    const journal = [
      { at: '2030-01-01T10:00:00.000Z', books: ['a', 'b'], events: 200, crossFeedPairs: 3, best: { roiPercent: -2.5, event: 'X v Y', books: ['a', 'b'] }, errors: [] },
      { at: '2030-01-01T10:05:00.000Z', books: ['a', 'b'], events: 200, crossFeedPairs: 3, best: { roiPercent: -2.5, event: 'X v Y', books: ['a', 'b'] }, errors: [] },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';

    await fs.mkdir(join(dir, 'docs'), { recursive: true });
    await fs.mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'docs', 'no-arbitrage-root-cause.md'), tampered);
    await writeFile(join(dir, 'data', 'measurements.jsonl'), journal);
    await fs.copyFile(SYNC, join(dir, 'sync-measurements.mjs'));

    const result = await new Promise((resolve) => {
      execFile(process.execPath, [join(dir, 'sync-measurements.mjs')], { cwd: dir, timeout: 60_000 },
        (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    });
    assert.equal(result.code, 1, 'a tampered table is reported, not accepted');
    assert.match(result.stderr, /does not match/, 'the message says the two disagree');
    assert.match(result.stderr, /--write/, 'the message says how to fix it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the tool refuses an empty journal rather than writing an empty table', async () => {
  // If no round collected anything, there is no evidence. Writing an empty
  // table would quietly delete the historical rows' context.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-sync-empty-'));
  try {
    await fs.mkdir(join(dir, 'docs'), { recursive: true });
    await fs.mkdir(join(dir, 'data'), { recursive: true });
    await fs.copyFile(DOC, join(dir, 'docs', 'no-arbitrage-root-cause.md'));
    await writeFile(join(dir, 'data', 'measurements.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), books: ['a'], events: 0, crossFeedPairs: 0, best: null, errors: [] }) + '\n');
    await fs.copyFile(SYNC, join(dir, 'sync-measurements.mjs'));

    const result = await new Promise((resolve) => {
      execFile(process.execPath, [join(dir, 'sync-measurements.mjs'), '--write'], { cwd: dir, timeout: 60_000 },
        (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    });
    assert.equal(result.code, 1, 'an empty journal is refused');
    assert.match(result.stderr, /no round that collected anything/, 'the reason is stated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
