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
 * Rows are the resolved contract (family + line), not the provider's market
 * key, because that is the unit arbitrage is actually found on: netbet's
 * `game_handicap` and the FEG feed's `ufo:mtyp:0c-02` are the same contract
 * and pair with each other, but counting them as two separate rows reported
 * the Asian handicap as 3 books / 2 pairs when it is 4 books and 7 pairable
 * lines. The provider keys behind each row are still printed.
 *
 * Markets that resolve to no contract, and double chance, which is never a
 * surebet, are excluded from the rows entirely rather than shown as thin.
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
import { resolveContract } from '../src/scanner/market-contracts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_BOOKS = 'fortuna,casa-pariurilor,admiral,maxbet,excelbet,winboss,superbet,netbet,don';

const args = process.argv.slice(2);
const wanted = (args[0] || DEFAULT_BOOKS).split(',').map((b) => b.trim()).filter(Boolean);
const maxEvents = Number(args[1]) || 200;

const cfg = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
const byId = new Map(cfg.jobs.map((j) => [j.id, j]));

/**
 * Load one book and index, per CONTRACT, the events that carry it.
 *
 * Indexed by the resolved contract (family + line), not by the provider's own
 * market key. Two books that spell the same market differently are the same
 * contract and must be counted together: grouping by raw key reported
 * ASIAN_HANDICAP as 3 books / 2 pairs when it is really 4 books and 7
 * pairable lines, because netbet calls it `game_handicap` and the FEG feed
 * calls it `ufo:mtyp:0c-02`. That understates the arbitrage exactly where it
 * matters — the number this script exists to produce.
 *
 * The provider keys that resolve to each contract are kept alongside it, so
 * the report still says which spellings are in play.
 *
 * @returns {Promise<Map<string, {events: Set<string>, keys: Set<string>}>>}
 */
async function loadBook(id) {
  const job = byId.get(id);
  if (!job || job.enabled === false) return null;
  const scraper = instantiate(id, { jobConfig: job, dataDir: join(ROOT, 'data'), maxEvents, timeoutMs: 60_000 });
  const events = scraper.extractEvents(scraper.normalize(await scraper.fetchRaw()));
  const byMarket = new Map();
  for (const e of events) {
    for (const m of e.markets || []) {
      const contract = resolveContract(m);
      // A market that resolves to nothing is not arbitrable at all, and one
      // flagged arbEligible:false (double chance) never is — both are counted
      // nowhere rather than in a row that suggests they might be.
      if (!contract || contract.arbEligible === false) continue;
      const key = `${contract.family}/${contract.lineKey ?? '_'}`;
      if (!byMarket.has(key)) byMarket.set(key, { events: new Set(), keys: new Set() });
      byMarket.get(key).events.add(e.eventKey);
      byMarket.get(key).keys.add(m.key);
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

// contract key -> book -> { events, keys }
const markets = new Map();
for (const [book, byMarket] of books) {
  for (const [key, entry] of byMarket) {
    if (!markets.has(key)) markets.set(key, new Map());
    markets.get(key).set(book, entry);
  }
}

const rows = [];
for (const [key, publishers] of markets) {
  const ids = [...publishers.keys()];
  const { pairs, groups } = independentPairs(ids);
  let overlapping = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let k = i + 1; k < ids.length; k += 1) {
      const a = publishers.get(ids[i]).events;
      const b = publishers.get(ids[k]).events;
      for (const ev of a) if (b.has(ev)) { overlapping += 1; break; }
    }
  }
  const keys = new Set();
  for (const entry of publishers.values()) for (const k of entry.keys) keys.add(k);
  rows.push({ key, books: ids.length, ids, pairs, groups, overlapping, keys: [...keys].sort() });
}

rows.sort((a, b) => b.pairs - a.pairs || b.books - a.books || a.key.localeCompare(b.key));

console.log(`\nmarket coverage — ${books.size} book(s), ${rows.length} arbitrable contract line(s)\n`);
console.log('  contract              books  independent pairs  provider keys / note');
console.log('  ' + '-'.repeat(92));

for (const r of rows) {
  const note = r.pairs > 0
    ? r.keys.join(', ')
    : r.books > 1
      ? `all ${r.books} share one feed (${r.groups.map((g) => g.join('+')).join(', ')})`
      : 'single book';
  console.log(
    `  ${r.key.padEnd(22)} ${String(r.books).padStart(5)}  ${String(r.pairs).padStart(17)}  ${note}`,
  );
}

const arbitrable = rows.filter((r) => r.pairs > 0);
console.log(`\n${arbitrable.length} of ${rows.length} contract line(s) can be paired across independent feeds.`);
console.log(`${arbitrable.reduce((n, r) => n + r.pairs, 0)} independent pair(s) in total.`);
if (arbitrable.length === 0) {
  console.log('None. Adding a market to the scanner would add rows but no arbitrage —');
  console.log('the missing ingredient is a second, independent feed carrying it.');
} else {
  console.log('Present but un-arbitrable:');
  for (const r of rows.filter((x) => x.pairs === 0)) {
    const note = r.books > 1 ? `all ${r.books} share one feed` : 'single book';
    console.log(`  ${r.key.padEnd(22)} ${r.ids.join(', ')} — ${note}`);
  }
}
for (const f of failures) console.log(`\n  ${f.id} did not answer: ${f.error}`);
