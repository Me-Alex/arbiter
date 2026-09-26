/**
 * sync-measurements.mjs — regenerate the measured-outcome table in
 * docs/no-arbitrage-root-cause.md from the journal, instead of maintaining it
 * by hand.
 *
 * The table is the evidence behind the document's central claim: the market
 * is arbitraged, so the best cross-feed return is negative. A table edited by
 * hand drifts from the runs that produced it, and nobody can tell which of
 * the two is true. So the journal is the source and the table is derived.
 *
 * The hand-written rows from before this tool existed are kept, and marked as
 * such: they were taken on a different book set, and discarding measurements
 * that were actually made would be its own kind of dishonesty. Everything
 * after them comes from the journal.
 *
 * It also refuses to write a table that is not what the journal says. The
 * guard below is the whole point — a generator that quietly produces a
 * different table is worse than no generator.
 *
 * Usage:
 *   node scripts/sync-measurements.mjs           # check only, exit 1 on drift
 *   node scripts/sync-measurements.mjs --write   # rewrite the table
 *
 * Exits 0 when the document matches the journal, 1 otherwise.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Resolved from the working directory rather than the script's own location,
// so the tool can be pointed at a copy of the tree — which is how its
// behaviour on a tampered or empty journal is tested. A script-relative root
// would silently read the real journal and pass, which is the failure this
// tool exists to prevent.
const ROOT = process.env.ARBITER_ROOT
  ? process.env.ARBITER_ROOT
  : process.cwd();
const JOURNAL = join(ROOT, 'data', 'measurements.jsonl');
const DOC = join(ROOT, 'docs', 'no-arbitrage-root-cause.md');

const WRITE = process.argv.includes('--write');

// The table this tool owns, between these two markers.
const TABLE_START = '<!-- measurements:begin -->';
const TABLE_END = '<!-- measurements:end -->';

const HEADER = [
  '| Round | Source | Books | Events | Cross-feed pairs | Best ROI |',
  '|---|---|---|---|---|---|',
];

/** Rounds taken before the journal existed, kept because they were real. */
const HISTORICAL = [
  ['1', '14:51', 6, 600, 50, '−1.94%'],
  ['2', '14:54', 6, 600, 50, '−1.94%'],
  ['3', '14:57', 6, 600, 50, '−1.94%'],
  ['4', '14:55', 7, 700, 50, '−1.94%'],
  ['5', '14:59', 7, 700, 49, '−2.12%'],
  ['6', '15:00', 7, 700, 49, '−2.12%'],
  ['7', '14:48', 10, 1000, 203, '−1.80%'],
  ['8', '18:57', 3, 300, 31, '−3.64%'],
  ['9', '19:00', 3, 300, 31, '−3.64%'],
  ['10', '19:17', 4, 300, 12, '−3.64%'],
  ['11', '19:18', 4, 400, 33, '−3.26%'],
];

/** The historical rows carry a wall-clock time; the journal carries an ISO stamp. */
function buildTable(rows) {
  const lines = [TABLE_START, ...HEADER];
  for (const [id, time, books, events, pairs, roi] of HISTORICAL) {
    lines.push(`| ${id} | ${time}, before the journal | ${books} | ${events} | ${pairs} | ${roi} |`);
  }
  rows.forEach((r, i) => {
    // A negative return is the expected shape, so it is printed with the sign
    // it has; a positive one would mean the table is telling a new story.
    const roi = r.best ? `${r.best.roiPercent > 0 ? '+' : '−'}${Math.abs(r.best.roiPercent).toFixed(2)}%` : 'n/a';
    const time = r.at.slice(11, 16);
    lines.push(`| ${HISTORICAL.length + i + 1} | ${time}, from the journal | ${r.books.length} | ${r.events} | ${r.crossFeedPairs} | ${roi} |`);
  });
  lines.push(TABLE_END);
  return lines.join('\n');
}

let text;
try {
  text = await fs.readFile(JOURNAL, 'utf8');
} catch {
  console.error(`no journal at ${JOURNAL}; run \`npm run measure\` first`);
  process.exit(1);
}

const rows = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const measured = rows.filter((r) => r.events > 0);
if (measured.length === 0) {
  console.error('the journal has no round that collected anything; nothing to write');
  process.exit(1);
}

const table = buildTable(measured);
const doc = await fs.readFile(DOC, 'utf8');

if (!doc.includes(TABLE_START) || !doc.includes(TABLE_END)) {
  console.error(`the document is missing the ${TABLE_START} / ${TABLE_END} markers`);
  process.exit(1);
}

const current = doc.slice(doc.indexOf(TABLE_START), doc.indexOf(TABLE_END) + TABLE_END.length);

if (current === table) {
  console.log(`the table already matches the journal (${HISTORICAL.length} historical + ${measured.length} recorded rounds)`);
  process.exit(0);
}

if (!WRITE) {
  console.error('the table in docs/no-arbitrage-root-cause.md does not match data/measurements.jsonl');
  console.error('run: node scripts/sync-measurements.mjs --write');
  process.exit(1);
}

await fs.writeFile(DOC, doc.replace(current, table));
console.log(`rewrote the table: ${HISTORICAL.length} historical + ${measured.length} recorded rounds`);
