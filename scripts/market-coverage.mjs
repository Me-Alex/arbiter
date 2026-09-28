/**
 * market-coverage.mjs — which markets can actually be arbitraged today, and why
 * the others cannot.
 *
 * Adding a market to the scanner is only half the question. A market is
 * arbitrable when two *independent* feeds both publish it for the same event:
 * a pairing between two brands resold from one provider is one price counted
 * twice, and pairing those is how the scanner reports an arbitrage that does
 * not exist.
 *
 * So this reports, per market: how many books publish it, how many of those are
 * independent of each other, and how many independent pairs that leaves. A
 * market with a single book, or with only books that share a feed, is present
 * in the data and still useless — which is a fact worth stating rather than
 * leaving to be rediscovered.
 *
 * It is deliberately a measurement and not a gate: a market that is
 * un-arbitrable today may become so the moment a new feed carries it, and the
 * next run will say so.
 *
 * Usage:
 *   npm run market:coverage
 *   npm run market:coverage -- fortuna,admiral,excelbet
 *
 * Exits 0 even when nothing is arbitrable: a thin market is a finding, not a
 * failure.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_BOOKS = 'fortuna,casa-pariurilor,admiral,maxbet,excelbet,winboss,superbet,netbet,don';

const args = process.argv.slice(2);
const wanted = (args[0] || DEFAULT_BOOKS).split(',').map((b) => b.trim()).filter(Boolean);
const maxEvents = Number(args[1]) || 200;

const cfg = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
const byId = new Map(cfg.jobs.map((j) => [j.id, j]));

/**
 * Load one book and index, per market key, the events that carry it.
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function loadBook(id) {
  const job = byId.get(id);
  if (!job || job.enabled === false) return null;
  const scraper = instantiate(id, { jobConfig: job, dataDir: join(ROOT, 'data'), maxEvents, timeoutMs: 60_000 });
  const events = scraper.extractEvents(scraper.normalize(await scraper.fetchRaw()));
  const byMarket = new Map();
  for (const e of events) {
    for (const m of e.markets || []) {
      if (!byMarket.has(m.key)) byMarket.set(m.key, new Set());
      byMarket.get(m.key).add(e.eventKey);
    }
  }
  return byMarket;
}

const books = new Map();
const failures = [];

for (const id of wanted) {
  const started = Date.now();
  try {
    const byMarket = await loadBook(id);
    if (byMarket) {
      books.set(id, byMarket);
      process.stdout.write(`  ${id.padEnd(16)} ${(Date.now() - started) / 1000}s\n`);
    }
  } catch (err) {
    failures.push({ id, error: String(err.message).slice(0, 90) });
    process.stdout.write(`  ${id.padEnd(16)} failed: ${String(err.message).slice(0, 70)}\n`);
  }
}

/** Books that publish a market, grouped so shared feeds are not counted twice. */
function independentPairs(publishers) {
  let pairs = 0;
  const groups = [];
  for (const a of publishers) {
    let placed = false;
    for (const g of groups) {
      if (isSharedFeed(g[0], a)) { g.push(a); placed = true; break; }
    }
    if (!placed) groups.push([a]);
  }
  for (let i = 0; i < groups.length; i += 1) {
    for (let k = i + 1; k < groups.length; k += 1) pairs += groups[i].length * groups[k].length;
  }
  return { pairs, groups };
}

// market key -> book -> event keys
const markets = new Map();
for (const [book, byMarket] of books) {
  for (const [key, events] of byMarket) {
    if (!markets.has(key)) markets.set(key, new Map());
    markets.get(key).set(book, events);
  }
}

const rows = [];
for (const [key, publishers] of markets) {
  const ids = [...publishers.keys()];
  const { pairs, groups } = independentPairs(ids);
  let overlapping = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let k = i + 1; k < ids.length; k += 1) {
      const a = publishers.get(ids[i]);
      const b = publishers.get(ids[k]);
      for (const ev of a) if (b.has(ev)) { overlapping += 1; break; }
    }
  }
  rows.push({ key, books: ids.length, ids, pairs, groups, overlapping });
}

rows.sort((a, b) => b.pairs - a.pairs || b.books - a.books || a.key.localeCompare(b.key));

console.log(`\nmarket coverage — ${books.size} book(s), ${rows.length} distinct market(s)\n`);
console.log('  market key            books  independent pairs  note');
console.log('  ' + '-'.repeat(66));

for (const r of rows) {
  const note = r.pairs > 0
    ? 'arbitrable'
    : r.books > 1
      ? `all ${r.books} share one feed (${r.groups.map((g) => g.join('+')).join(', ')})`
      : 'single book';
  console.log(
    `  ${r.key.padEnd(20)} ${String(r.books).padStart(5)}  ${String(r.pairs).padStart(17)}  ${note}`,
  );
}

const arbitrable = rows.filter((r) => r.pairs > 0);
console.log(`\n${arbitrable.length} of ${rows.length} market(s) can be paired across independent feeds.`);
if (arbitrable.length === 0) {
  console.log('None. Adding a market to the scanner would add rows but no arbitrage —');
  console.log('the missing ingredient is a second, independent feed carrying it.');
} else {
  console.log('Markets present but un-arbitrable:');
  for (const r of rows.filter((x) => x.pairs === 0)) {
    const note = r.books > 1 ? `all ${r.books} share one feed` : 'single book';
    console.log(`  ${r.key.padEnd(20)} ${r.books} book(s) — ${note}`);
  }
}
for (const f of failures) console.log(`\n  ${f.id} did not answer: ${f.error}`);
