import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The measurement journal is the point of `npm run measure`, not a side
 * effect: the numbers quoted in docs/no-arbitrage-root-cause.md should be
 * reproducible by running a command, not by re-deriving them by hand.
 *
 * A measurement that overwrites its history is a measurement that can only
 * ever describe today. These assertions pin the two properties that make the
 * series worth having: rows accumulate, and each row is self-describing enough
 * to be cited later.
 *
 * The shape of a row is checked here rather than by running a scrape, so the
 * suite does not reach the network to verify a file format.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'measure.mjs');
const JOURNAL = join(ROOT, 'data', 'measurements.jsonl');

const source = await readFile(SCRIPT, 'utf8');

test('the tool appends rather than overwrites', () => {
  // appendFile, not writeFile: a series that replaces its own history is a
  // series of one, however often it is run.
  assert.match(source, /appendFile\(JOURNAL/, 'the journal is appended to');
  assert.doesNotMatch(source, /writeFile\(JOURNAL/, 'the journal is never rewritten');
});

test('each round is recorded as one JSON line', () => {
  // JSONL rather than a JSON array: appending does not require reading and
  // rewriting, and a truncated final line does not lose the rounds before it.
  assert.match(source, /\.map\(\(r\) => JSON\.stringify\(r\)\)\.join\('\\n'\)/, 'rows are joined one per line');
});

test('a row carries what a later reader needs to cite it', () => {
  for (const field of ['at:', 'books:', 'events:', 'crossFeedPairs:', 'best,', 'errors,']) {
    assert.ok(source.includes(field), `the recorded row includes ${field}`);
  }
});

test('a failed scraper is recorded, not silently dropped', () => {
  // The failure mode this whole session kept hitting is a scraper that
  // collects nothing; a book that errors must appear in the row so a quiet
  // series is not mistaken for a healthy one.
  assert.match(source, /errors\.push/, 'a per-book failure is captured');
  assert.match(source, /errors: r\.errors|errors,/, 'errors are part of the row');
});

test('a negative return is reported as a finding, not a failure', () => {
  // The market is arbitraged, so the expected result is negative. Exiting
  // non-zero would make the tool useless as a routine, and would train
  // people to ignore it.
  assert.doesNotMatch(source, /process\.exit\(1\)/, 'a negative return does not fail the run');
  assert.match(source, /not a failure|expected shape of an arbitraged market/, 'the outcome says so explicitly');
});

test('the journal lives where a scheduled run cannot dirty the tree', async () => {
  const ignore = await readFile(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^data\/measurements\.jsonl$/m, 'the journal is gitignored');
});

test('the journal, when present, is parseable line by line', async () => {
  let text;
  try {
    text = await readFile(JOURNAL, 'utf8');
  } catch {
    return; // nothing measured yet; the format is asserted above
  }
  const lines = text.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'a non-empty journal has at least one row');
  for (const [i, line] of lines.entries()) {
    let row;
    assert.doesNotThrow(() => { row = JSON.parse(line); }, `row ${i + 1} is valid JSON`);
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/, `row ${i + 1} is timestamped`);
    assert.ok(Array.isArray(row.books) && row.books.length > 0, `row ${i + 1} names the books it measured`);
    assert.equal(typeof row.events, 'number', `row ${i + 1} records how many events arrived`);
    assert.equal(typeof row.crossFeedPairs, 'number', `row ${i + 1} records the pairings found`);
    assert.ok(Array.isArray(row.errors), `row ${i + 1} records any scraper failures`);
  }
});

test('the tool runs as npm run measure', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.measure || '', /scripts\/measure\.mjs/, 'the tool is reachable without a path');
});

test('an unknown book is skipped, and records nothing', async (t) => {
  // Two things at once, because they are the same guarantee from two sides:
  // the tool does not treat a book that does not exist as a failure, and it
  // does not write a row for it either. A row here would read as "the market
  // had nothing that day" rather than "nothing was asked", and this test would
  // have grown the real journal by one row on every `npm test` — which is
  // exactly what it had been doing.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-measure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = await journalRows();

  // The tool reads config/scrapers.json to know which books exist, so the
  // fixture root needs one. A copy of the real config is enough: the book under
  // test is deliberately absent from it, which is the case being checked.
  await fs.mkdir(join(dir, 'config'), { recursive: true });
  await fs.copyFile(join(ROOT, 'config', 'scrapers.json'), join(dir, 'config', 'scrapers.json'));

  const result = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, 'definitely-not-a-book', '--rounds', '1'],
      { cwd: dir, env: { ...process.env, ARBITER_ROOT: dir }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });

  assert.equal(result.code, 0, 'an unknown book is skipped, not treated as a failure');
  assert.match(result.stdout, /not recorded/, 'the tool says it recorded nothing');
  assert.match(result.stdout, /nothing to append/, 'and that there was nothing to append');

  const after = await journalRows();
  assert.deepEqual(after, before, 'the journal did not grow');
});

/** The real journal's contents, so "did not grow" is checked against it. */
async function journalRows() {
  try {
    const text = await readFile(JOURNAL, 'utf8');
    return text.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
