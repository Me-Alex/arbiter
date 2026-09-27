/**
 * smoke-trend.mjs — fail on a book that has been failing, not only on one
 * that is failing today.
 *
 * The gate in scripts/smoke-live.mjs reports the present: a book that returns
 * nothing fails this run, and the run is looked at, and then it is forgotten.
 * That is the right behaviour for a single check and the wrong one for a
 * schedule — a provider that starts returning nothing on Monday fails every
 * run from Monday onward, but nothing connects those failures, so the signal
 * arrives as noise rather than as a pattern.
 *
 * This reads the archived reports and asks the question the daily check
 * cannot: has this book been failing repeatedly? It fails when a book is
 * inside a window of recent runs and has failed often enough within it to be
 * a pattern rather than a bad day.
 *
 * The rule is deliberately about a *majority* of recent runs, and it needs
 * enough history to mean anything. A book that fails once after a week of
 * passing is not a trend; a book failing most of the last five is, and the
 * difference between the two is exactly what a single-run gate throws away.
 *
 * Usage:
 *   node scripts/smoke-trend.mjs                 # read ./data-health-history
 *   node scripts/smoke-trend.mjs --dir path      # read somewhere else
 *   node scripts/smoke-trend.mjs --window 5 --threshold 3
 *
 * Exits 0 when no book is trending towards failure, 1 otherwise. Exits 0 with
 * a note when there is not enough history to say anything, because "no data"
 * is not "all clear" and should not be reported as one.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
let dir = join(ROOT, 'data-health-history');
let window = 5;
let threshold = 3;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir') dir = args[++i];
  else if (args[i] === '--window') window = Number(args[++i]);
  else if (args[i] === '--threshold') threshold = Number(args[++i]);
}

// Each file is one run's report, as produced by scripts/smoke-live.mjs.
//
// The filename is a run timestamp with `:` replaced by `-`: an ISO stamp
// contains colons, which Windows does not allow in a filename, so a history
// built from the raw stamp would be readable on Linux and silently empty on
// the machine that wrote it. The same substitution applies to the report body
// when it is read, so either spelling works here.
const STAMP = /^\d{4}-\d{2}-\d{2}[T_][\d-]+Z?\.json$/;

let files;
try {
  files = (await fs.readdir(dir)).filter((f) => STAMP.test(f)).sort();
} catch {
  console.log(`no report history at ${dir}; nothing to trend-check yet`);
  process.exit(0);
}

if (files.length === 0) {
  console.log(`no reports in ${dir}; nothing to trend-check yet`);
  process.exit(0);
}

const runs = [];
for (const f of files.slice(-window)) {
  try {
    runs.push(JSON.parse(await fs.readFile(join(dir, f), 'utf8')));
  } catch {
    // A truncated or hand-edited report is skipped rather than counted as a
    // pass: guessing either way would put noise into a signal meant to be
    // small.
  }
}

if (runs.length < Math.min(window, 3)) {
  console.log(`${runs.length} run(s) of history available; need at least 3 in a window of ${window} to call anything a trend`);
  process.exit(0);
}

const seen = new Map();
for (const run of runs) {
  for (const job of run.jobs || []) {
    if (!seen.has(job.id)) seen.set(job.id, []);
    seen.get(job.id).push(job.verdict);
  }
}

const trending = [];
for (const [id, verdicts] of seen) {
  if (verdicts.length < 3) continue; // a book seen once cannot be trending
  const recent = verdicts.slice(-window);
  const failures = recent.filter((v) => v !== 'ok').length;
  if (failures >= threshold) {
    trending.push({ id, failures, of: recent.length, recent });
  }
}

console.log(`\nsmoke trend — ${runs.length} run(s) in a window of ${window}, threshold ${threshold}\n`);
for (const [id, verdicts] of [...seen].sort()) {
  const recent = verdicts.slice(-window);
  const failures = recent.filter((v) => v !== 'ok').length;
  const mark = trending.some((t) => t.id === id) ? '  <-- trending' : '';
  console.log(`  ${id.padEnd(16)} ${recent.map((v) => (v === 'ok' ? 'ok  ' : 'FAIL')).join(' ')}  ${failures}/${recent.length}${mark}`);
}

if (trending.length === 0) {
  console.log('\nno book is failing repeatedly');
  process.exit(0);
}

console.log(`\n${trending.length} book(s) failing repeatedly:`);
for (const t of trending) {
  console.log(`  ${t.id}: failed ${t.failures} of the last ${t.of} runs`);
}
console.log('\nA single failing run is a bad day. This many is a feed that moved, '
  + 'a parser that drifted, or an endpoint that was retired — it needs a look, '
  + 'not another rerun.');
process.exit(1);
