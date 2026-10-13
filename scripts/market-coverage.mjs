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
 *   npm run market:coverage -- --workspace data-market-run/workspace football
 * Workspace mode measures historical coverage only; it does not publish a scan
 * or make the saved prices fresh/actionable.
 *
 * Exits 0 even when nothing is arbitrable: a thin market is a finding, not a
 * failure.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';
import { canonicalSport, eventIdentityKey } from '../src/shared/text.mjs';
import { groupByEvent } from '../src/scanner/engine.mjs';
import {
  resolveContract,
  bucketKeyForContract,
  isTradablePeriod,
} from '../src/scanner/market-contracts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The books measured by default. Every entry here is an enabled job that
// publishes a first-class 1X2, chosen to span the independent feeds rather than
// to list every configured brand: one representative per provider is enough to
// measure a contract, and extra brands inside a feed add no independent pairs.
//
// unibet and betano are here because both are enabled, both publish totals,
// BTTS and (betano) the Asian handicap, and both are independent of every other
// feed below. Leaving them out understated the Asian handicap as 6 books when
// the live captures carry it on a 7th independent feed, and understated totals
// and BTTS by two publishers each. Pass an explicit list to measure others.
const DEFAULT_BOOKS = 'fortuna,casa-pariurilor,admiral,maxbet,excelbet,winboss,superbet,netbet,don,unibet,betano';

const args = process.argv.slice(2);
const workspaceMode = args[0] === '--workspace';
if (workspaceMode && !args[1]) throw new Error('Usage: --workspace <directory> [sport]');
const workspace = workspaceMode ? args[1] : null;
const wanted = workspace
  ? (await fs.readdir(workspace)).filter((f) => f.endsWith('_events.json')).sort().map((f) => f.slice(0, -12))
  : (args[0] || DEFAULT_BOOKS).split(',').map((b) => b.trim()).filter(Boolean);
const maxEvents = Number(args[1]) || 200;
// The sport to measure. Pass as the third positional argument:
//   npm run market:coverage -- fortuna,netbet,unibet,betano 200 basketball
// The scrape service always supplies a sport, so the adapters receive the same
// request this report makes. Counting the same fixture under one sport label
// across books is what proves two independent feeds quote the same contract.
const SPORT = String(args[2] || 'football').trim().toLowerCase();

const cfg = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
const byId = new Map(cfg.jobs.map((j) => [j.id, j]));

/**
 * Scrape one book and return its football events, indexed per CONTRACT.
 *
 * The indexing itself lives in indexEventsByContract below, where it can be
 * tested; what stays here is the fetch and the sport filter.
 *
 * @returns {Promise<Map<string, {events: Set<string>, keys: Set<string>}>>}
 */
async function loadBook(id) {
  if (workspace) {
    const snapshot = JSON.parse(await fs.readFile(join(workspace, `${id}_events.json`), 'utf8'));
    return indexEventsByContract((snapshot.events || []).filter((e) => canonicalSport(e.sport) === SPORT));
  }
  const job = byId.get(id);
  if (!job || job.enabled === false) return null;
  // `sport` mirrors what the scrape service passes in production
  // (scraper-service.mjs:112) and what every enabled job declares in
  // `supportedSports`. Omitting it did not merely widen the event count: netbet
  // falls back to `ALL_SPORTS` when no sport is given, so this report was
  // measuring basketball points totals, tennis game totals, baseball runs and
  // American football points as football O/U lines — 84 of 132 rows in the
  // 2026-09-29 run, all of them un-pairable. `eventKey` does contain the sport,
  // so those could never form a false arbitrage; they only buried the football
  // signal this report exists to show. Measuring the football path means
  // asking for football.
  const scraper = instantiate(id, { jobConfig: job, dataDir: join(ROOT, 'data'), maxEvents, sport: SPORT, timeoutMs: 60_000 });
  const allEvents = scraper.extractEvents(scraper.normalize(await scraper.fetchRaw()));
  // Passing `sport` above is a REQUEST, not a filter, and only some adapters
  // honour it: netbet drops to the one sport, but the FEG catalogue traversal
  // walks every sport in the feed and betano/unibet answer with the whole
  // site. Those events carry their own sport, so they resolve to perfectly
  // good contracts — a basketball points total, a tennis games total, an ice
  // hockey puck line — and the row key drops the event component on purpose
  // (this report pairs publishers across books, not within one event), so they
  // land in the same rows as the football markets they resemble.
  //
  // Measured 2026-09-29 at maxEvents 3000: betano returned 286 events of which
  // 35 were football, and 69 of its 77 contract lines were another sport;
  // fortuna 892/768 with 19 foreign lines, casa-pariurilor 894/770 with 19,
  // unibet 989/738 with 4. betano was reading as the second largest book in
  // this report on the strength of basketball and esports. None of it can pair —
  // `eventKey` carries the sport, so a basketball total never meets a football
  // one — so the pair counts were already right and the LINE counts were not.
  // The engine never sees this because it groups by event first; a report that
  // counts publishers by contract alone has to do the sport scoping itself.
  const events = allEvents.filter((e) => canonicalSport(e.sport) === SPORT);
  if (events.length !== allEvents.length) {
    process.stdout.write(`  ${id.padEnd(16)} ${allEvents.length - events.length}/${allEvents.length} event(s) outside ${SPORT}\n`);
  }
  return indexEventsByContract(events);
}

/**
 * Index one book's football events by CONTRACT, keeping the set of fixtures the
 * contract was seen on.
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
 * The row key is the engine's own bucket key, so the report counts exactly what
 * the engine can arbitrate. It used to be `${family}/${lineKey}`, which folded
 * the settlement period away and applied no full-time guard: unibet publishes
 * "Total goluri" and "Total Goluri - Repriză a 1-a" under the same key `TOTAL`,
 * so a first-half 2.5 was reported as a second full-time publisher of 2.5. A row
 * can now only be filled by markets the scanner would actually pair, because the
 * period in the key is the one the engine buckets on.
 *
 * Split out of loadBook and exported so it can be tested without a scrape: the
 * choice of event key is the whole content of this function, and an untestable
 * script is how the wrong key survived in the first place.
 *
 * @param {object[]} events football events of a single book
 * @returns {Map<string, {events: Set<string>, keys: Set<string>}>}
 */
export function indexEventsByContract(events) {
  const byMarket = new Map();
  for (const e of events) {
    for (const m of e.markets || []) {
      const contract = resolveContract(m);
      // A market that resolves to nothing is not arbitrable at all, and one
      // flagged arbEligible:false (double chance) never is — both are counted
      // nowhere rather than in a row that suggests they might be.
      if (!contract || contract.arbEligible === false) continue;
      // The settlement guard the engine applies — but on the CONTRACT's period,
      // which is what `bucketKeyForContract` keys on, not on the market's declared
      // `period` field. The row key below already carries the corrected period, so
      // a first-half line is counted as a first-half line and cannot be confused
      // with the full-time line of the same number.
      //
      // This used to apply `isFullTimeMarket` to the market, which dropped every
      // first-half market and made the report say the scanner would refuse them —
      // true at the time, and no longer. betano hardcodes `period: 'fulltime'` on
      // every market it emits, so its first-half totals passed the guard on the
      // strength of a field this codebase documents as untrustworthy, while
      // unibet's and the everymatrix pair's first-half totals declared `half1` and
      // were dropped. The report then showed OVER_UNDER::half1::0.5/1.5/2.5 as
      // betano-only, 1 publisher and 0 pairs, on lines three independent feeds
      // were quoting. The guard is now the engine's, so the report can only be
      // filled by markets the scanner would actually pair.
      if (!isTradablePeriod(contract.period)) continue;
      // The engine's own key, with the (unused here) event component dropped:
      // this report pairs publishers across books, not within one event.
      const key = bucketKeyForContract('', contract).replace(/^::/, '');
      if (!byMarket.has(key)) byMarket.set(key, { events: new Set(), keys: new Set(), fixtures: new Set() });
      // The event is recorded under the SAME key the engine groups by, not under
      // the adapter's own `eventKey`. This is what makes the `overlapping`
      // column mean "these two books really quote this line on the same match".
      //
      // It used to add `e.eventKey`, and every adapter writes its own — so the
      // column was measuring the wrong set twice over. Books that SHARE a feed
      // (getsbet+contibet, fortuna+casa-pariurilor, the exalogic four) collide
      // by construction and scored as overlapping, while the independent pairs
      // the engine can actually arbitrage never collided and scored as not
      // overlapping. Measured on one frozen 24-book download, 10540 events and
      // 51799 markets: 535 pairs scored as overlapping on the adapter key
      // against 1419 on the identity key, and among INDEPENDENT pairs 298
      // against 1153 — a 3.9x undercount of exactly the pairs that are tradable.
      // `MATCH_ODDS::fulltime::_` between superbet and excelbet shares no
      // adapter eventKey at all, yet `groupByEvent` puts 182 fixtures of that
      // pair in one bucket; the old column reported the pair as disjoint.
      //
      // The identity key is the engine's own (`shared/text.mjs`), so the report
      // cannot drift from the grouping it is reporting on.
      byMarket.get(key).events.add(eventIdentityKey(e));
      byMarket.get(key).fixtures.add(e);
      byMarket.get(key).keys.add(m.key);
    }
  }
  return byMarket;
}

/** Books that publish a market, grouped so shared feeds are not counted twice. */
export function independentPairs(publishers) {
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

/**
 * Turn per-book indexes into report rows.
 *
 * `pairs` counts every book pair that publishes the line, however many feeds
 * they share. `overlapping` counts the subset that can actually be traded: two
 * books on DIFFERENT feeds that quote the line on the SAME fixture. It used to
 * count every book pair that shared an event key, shared feed or not, so a row
 * could look covered by a pair the scanner is forbidden from pairing.
 *
 * Exported for the same reason as indexEventsByContract — this is a pure
 * function over data a test can write by hand.
 *
 * @param {Map<string, Map<string, {events: Set<string>, keys: Set<string>}>>} books
 * @returns {object[]}
 */
export function buildCoverageRows(books) {
  // Group the full cohort once, exactly as the scanner does. Per-book rounded
  // timestamp keys cannot express a sliding window or detect rematch ambiguity.
  const originals = new Map();
  for (const [book, index] of books) for (const entry of index.values()) {
    for (const event of entry.fixtures || []) {
      if (!originals.has(event)) originals.set(event, {
        ...event, sourceId: event.sourceId || book, eventKey: event.eventKey || eventIdentityKey(event),
      });
    }
  }
  const fixtureKeys = new Map();
  for (const [key, events] of groupByEvent([...originals.values()])) {
    for (const event of events) fixtureKeys.set(event, key);
  }
  // contract key -> book -> { events, keys }
  const markets = new Map();
  for (const [book, byMarket] of books) {
    for (const [key, entry] of byMarket) {
      if (!markets.has(key)) markets.set(key, new Map());
      markets.get(key).set(book, entry.fixtures ? { ...entry,
        events: new Set([...entry.fixtures].map((event) => fixtureKeys.get(originals.get(event)))),
      } : entry);
    }
  }

  const rows = [];
  for (const [key, publishers] of markets) {
    const ids = [...publishers.keys()];
    const { pairs, groups } = independentPairs(ids);
    let overlapping = 0;
    for (let i = 0; i < ids.length; i += 1) {
      for (let k = i + 1; k < ids.length; k += 1) {
        // A pair inside one feed group cannot be arbitraged whatever it publishes,
        // so it must not be counted here — that is the whole difference between
        // "these two books overlap" and "this line has arbitrage".
        if (isSharedFeed(ids[i], ids[k])) continue;
        const a = publishers.get(ids[i]).events;
        const b = publishers.get(ids[k]).events;
        for (const ev of a) if (b.has(ev)) { overlapping += 1; break; }
      }
    }
    const keys = new Set();
    for (const entry of publishers.values()) for (const k of entry.keys) keys.add(k);
    rows.push({ key, books: ids.length, ids, pairs, groups, overlapping, keys: [...keys].sort() });
  }

  // Ordered by the number of book pairs that actually meet on a fixture, not by
  // the number of book pairs that exist. A line with 229 potential pairs and 34
  // meetings is a smaller arbitrage surface than a line with 14 and 14, and
  // sorting on the potential put the second one below the first — the report's
  // job is to answer what can be traded, so the real count leads. `pairs` still
  // breaks ties, because it is the wider measure when two lines meet equally.
  rows.sort((a, b) => b.overlapping - a.overlapping || b.pairs - a.pairs
    || b.books - a.books || a.key.localeCompare(b.key));
  return rows;
}

// The scrape and the report run only when this file is the entry point. Running
// them on import made every line above untestable, because importing the module
// fired 11 network requests; exporting the two pure functions above is what lets
// the event-key choice be pinned by a test instead of by inspection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (workspace) console.log(`Historical coverage only: ${workspace}. Saved prices are not live opportunities.`);
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

  const rows = buildCoverageRows(books);

  console.log(`\nmarket coverage — ${books.size} book(s), ${rows.length} arbitrable contract line(s)\n`);
// `pairs` is a count of book pairs; `events-shared` is how many of those pairs
// actually quote the line on the SAME fixture. The gap between the two columns
// is the number of book pairs that cannot meet, and a row whose `events-shared`
// is 0 has no arbitrage in it no matter how large `pairs` is.
console.log('  contract                    books  independent pairs   events-shared  provider keys / note');
console.log('  ' + '-'.repeat(104));

for (const r of rows) {
  const note = r.pairs > 0
    ? r.keys.join(', ')
    : r.books > 1
      ? `all ${r.books} share one feed (${r.groups.map((g) => g.join('+')).join(', ')})`
      : 'single book';
  console.log(
    `  ${r.key.padEnd(30)} ${String(r.books).padStart(5)}  ${String(r.pairs).padStart(17)}  ${String(r.overlapping).padStart(13)}  ${note}`,
  );
}

const arbitrable = rows.filter((r) => r.pairs > 0);
console.log(`\n${arbitrable.length} of ${rows.length} contract line(s) can be paired across independent feeds.`);
console.log(`${arbitrable.reduce((n, r) => n + r.pairs, 0)} independent pair(s) in total, of which `
  + `${arbitrable.reduce((n, r) => n + r.overlapping, 0)} quote the line on the same fixture.`);
const met = arbitrable.filter((r) => r.overlapping > 0);
if (met.length < arbitrable.length) {
  console.log(`Present but never met: ${arbitrable.length - met.length} line(s) are published by two or more`);
  console.log('independent books, yet no two of them quote the same line on the same match.');
  for (const r of arbitrable.filter((x) => x.overlapping === 0)) {
    console.log(`  ${r.key.padEnd(30)} ${r.ids.join(', ')}`);
  }
}
if (arbitrable.length === 0) {
  console.log('None. Adding a market to the scanner would add rows but no arbitrage —');
  console.log('the missing ingredient is a second, independent feed carrying it.');
} else {
  console.log('Present but un-arbitrable:');
  for (const r of rows.filter((x) => x.pairs === 0)) {
    const note = r.books > 1 ? `all ${r.books} share one feed` : 'single book';
    console.log(`  ${r.key.padEnd(30)} ${r.ids.join(', ')} — ${note}`);
  }
}
  for (const f of failures) console.log(`\n  ${f.id} did not answer: ${f.error}`);
}
