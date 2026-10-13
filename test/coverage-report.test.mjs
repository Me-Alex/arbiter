// Tests for the coverage report's own bookkeeping — the part of
// scripts/market-coverage.mjs that decides whether two books "meet" on a line.
//
// This logic ran at import, inside a 24-book scrape, which is why the wrong
// event key sat in it for as long as it did: nothing could fail on it. The
// report is now guarded by an entry-module check and exports the two pure
// functions below, so the choice is pinned here instead of by inspection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  indexEventsByContract,
  buildCoverageRows,
  independentPairs,
} from '../scripts/market-coverage.mjs';
import { groupByEvent } from '../src/scanner/engine.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

test('the report only scrapes when it is the entry point', () => {
  // A STRUCTURAL TRIPWIRE, not behavioural coverage, and the distinction matters.
  // Every assertion in this file runs against the exported pure functions, so
  // none of them can notice the scrape that used to sit at module level — a
  // mutation that deletes the guard leaves all of them green, measured: 8 of 9
  // mutations caught, this one surviving. It cannot be caught behaviourally
  // either, because Node caches the module: by the time an assertion runs, the
  // import has already happened and a re-import is a no-op.
  //
  // So the guard is pinned in the source. What it buys is concrete — without it
  // `import '../scripts/market-coverage.mjs'` in this file fires 11 live
  // requests, which is why these tests could not exist until the guard did.
  const source = readFileSync(fileURLToPath(new URL('../scripts/market-coverage.mjs', import.meta.url)), 'utf8');
  assert.match(source, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{/,
    'the scrape and the report must stay behind the entry-module guard, or this test file scrapes 11 books on import');
});

/** A football event as an adapter emits it, with the adapter's own eventKey. */
function bookEvent({ bookKey, home, away, kickoff, marketKey = 'default', selections }) {
  return {
    eventKey: bookKey,
    providerEventId: bookKey,
    homeTeam: home,
    awayTeam: away,
    kickoff,
    sport: 'Football',
    league: 'Premier League',
    markets: [{ key: marketKey, id: `${marketKey}-1`, name: 'Meci', period: 'fulltime', selections }],
  };
}

const RESULT_1X2 = [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.3 }, { name: '2', odds: 3.4 }];

test('two books meet on a fixture even when their own event keys differ', () => {
  // The regression. Every adapter writes its own `eventKey`, so superbet and
  // excelbet list the same match under different strings. The report used to
  // record the adapter key, which made those pairs read as disjoint: measured on
  // one frozen 24-book download, 535 book pairs scored as overlapping against
  // 1419 on the identity key, and among INDEPENDENT pairs 298 against 1153.
  // `MATCH_ODDS::fulltime::_::home+draw+away::_::_` between superbet and excelbet
  // shared no adapter
  // eventKey at all, yet `groupByEvent` puts 182 of their fixtures together.
  const superbet = [bookEvent({
    bookKey: 'sb:1001', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2,
  })];
  const excelbet = [bookEvent({
    bookKey: 'XL-778812', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2,
  })];

  const books = new Map([
    ['superbet', indexEventsByContract(superbet)],
    ['excelbet', indexEventsByContract(excelbet)],
  ]);
  const rows = buildCoverageRows(books);
  assert.equal(rows.length, 1, 'one contract line');
  assert.equal(rows[0].key, 'MATCH_ODDS::fulltime::_::home+draw+away::_::_');
  assert.equal(rows[0].overlapping, 1,
    'the two books quote 1/X/2 on the same fixture, so the pair must count as meeting');
  // The negative and the positive readings of this number are in the two tests
  // that follow: a pair on different fixtures reads 0, and a pair inside one
  // feed reads 0. A count of 1 here can only mean "these two, on this match".
});

test('the report counts the engine\'s grouping, not the adapter\'s own key', () => {
  // The control the previous test deliberately could not give: with sourceId
  // set, the engine puts the two events in one bucket AND the report counts the
  // pair. If either side drifted, the two assertions would disagree.
  const a = { ...bookEvent({ bookKey: 'sb:1001', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 }), sourceId: 'superbet' };
  const b = { ...bookEvent({ bookKey: 'XL-778812', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 }), sourceId: 'excelbet' };
  assert.notEqual(a.eventKey, b.eventKey, 'the fixture only means something while the two adapters disagree');

  const grouped = groupByEvent([a, b]);
  assert.equal(grouped.size, 1, 'the engine groups the two into one bucket');
  assert.equal([...grouped.values()][0].length, 2, 'both events are in it');

  const books = new Map([
    ['superbet', indexEventsByContract([a])],
    ['excelbet', indexEventsByContract([b])],
  ]);
  const [row] = buildCoverageRows(books);
  assert.equal(row.overlapping, 1, 'and the report counts the pair as meeting, on the engine\'s key');

  // The identity key is what the report must be storing, and it is the engine's
  // own function, so the two cannot drift apart.
  assert.ok(row.keys.includes('default'), 'the provider spellings are still reported');
  const stored = indexEventsByContract([a]).get('MATCH_ODDS::fulltime::_::home+draw+away::_::_').events;
  assert.deepEqual([...stored], [eventIdentityKey(a)]);
  assert.notEqual(eventIdentityKey(a), a.eventKey, 'and that key is not the adapter key');
});

test('two books that never share a fixture do not count as meeting', () => {
  // The negative control, so the number above is not produced by a predicate
  // that always says yes. Different teams, same day, same market.
  const a = bookEvent({ bookKey: 'sb:1', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 });
  const b = bookEvent({ bookKey: 'XL-1', home: 'Everton', away: 'Liverpool', kickoff: '2026-10-03T16:30:00Z', selections: RESULT_1X2 });
  const books = new Map([
    ['superbet', indexEventsByContract([a])],
    ['excelbet', indexEventsByContract([b])],
  ]);
  const [row] = buildCoverageRows(books);
  assert.equal(row.pairs, 1, 'the pair exists — both books publish the line');
  assert.equal(row.overlapping, 0, 'but they are on different fixtures, so there is no arbitrage');
});

test('a pair inside one feed group never counts as meeting', () => {
  // getsbet and contibet are the same everymatrix feed. They publish identical
  // event keys and identical fixtures, so on the adapter key they collide and
  // score as overlapping — but the scanner is forbidden from pairing them, so
  // counting that meeting would report arbitrage that cannot be booked. This is
  // the `overlapping = 1` the first version of the fix still produced for
  // OVER_UNDER::half1::3.5, a line with `pairs = 0`.
  const a = bookEvent({ bookKey: 'wm:555', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', marketKey: 'total_goals', selections: [{ name: 'Over 3.5', odds: 1.9 }, { name: 'Under 3.5', odds: 1.9 }] });
  const b = bookEvent({ bookKey: 'wm:555', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', marketKey: 'total_goals', selections: [{ name: 'Over 3.5', odds: 1.95 }, { name: 'Under 3.5', odds: 1.85 }] });
  const books = new Map([
    ['getsbet', indexEventsByContract([a])],
    ['contibet', indexEventsByContract([b])],
  ]);
  const [row] = buildCoverageRows(books);
  assert.equal(row.pairs, 0, 'one feed group yields no independent pair at all');
  assert.equal(row.overlapping, 0, 'and no meeting, however identical the two books look');
  assert.deepEqual(row.groups, [['getsbet', 'contibet']], 'they are reported as one feed, not two');

  // CONTROL: the same two fixtures under two INDEPENDENT feeds do meet, so the
  // zero above is about the feed, not about the predicate being dead.
  const books2 = new Map([
    ['getsbet', indexEventsByContract([a])],
    ['unibet', indexEventsByContract([b])],
  ]);
  const [row2] = buildCoverageRows(books2);
  assert.equal(row2.pairs, 1);
  assert.equal(row2.overlapping, 1);
});

test('independentPairs groups a shared feed and separates an independent one', () => {
  // The feed-grouping primitive the row builder rests on, pinned on its own so a
  // failure there is not diagnosed as a failure in the overlap logic.
  assert.deepEqual(independentPairs(['getsbet', 'contibet', 'unibet']), {
    pairs: 2,
    groups: [['getsbet', 'contibet'], ['unibet']],
  });
  assert.deepEqual(independentPairs(['getsbet', 'contibet']), { pairs: 0, groups: [['getsbet', 'contibet']] });
  assert.deepEqual(independentPairs(['unibet', 'superbet']), { pairs: 1, groups: [['unibet'], ['superbet']] });
  assert.deepEqual(independentPairs(['unibet']), { pairs: 0, groups: [['unibet']] });
});

test('a market the engine refuses is counted nowhere', () => {
  // The report's filter has to keep up with the resolver, or it advertises lines
  // the scanner will never trade. `ufo:mtyp:00-04` is "Pauza sau Final" — a
  // half-time OR full-time payoff, 633 rows on the 2026-10-03 download and the
  // single largest refused form in it.
  const market = bookEvent({
    bookKey: 'ufo:9', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z',
    marketKey: 'ufo:mtyp:00-04', selections: RESULT_1X2,
  });
  assert.equal(indexEventsByContract([market]).size, 0, 'a refused market produces no row at all');
});

test('a market whose period the engine cannot name is counted, but never paired with full-time', () => {
  // The report mirrors the engine's period guard. This market resolves as a
  // MATCH_ODDS whose period is 'unknown', because the declared period is
  // explicitly not full-time and names no half `canonicalPeriod` can read.
  // As of 2026-10-07 the engine admits unknown-period contracts, so the row
  // shows in the report rather than being refused outright.
  const market = { ...bookEvent({ bookKey: 'x', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 }) };
  market.markets[0].period = 'firsthalf';

  // CONTROL: the same market declared full-time does produce the row, so the
  // zero below is about the period and not about the fixture.
  const fulltime = { ...bookEvent({ bookKey: 'x', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 }) };
  assert.equal(indexEventsByContract([fulltime]).size, 1, 'the full-time market is counted');
  assert.equal(indexEventsByContract([market]).size, 1, 'the unnameable-period market is also counted under its own period bucket');
});

test('double chance is catalogued but never advertised as arbitrable', () => {
  // `resolveContract` answers with arbEligible:false rather than refusing, so
  // the report has to read that flag itself. Double chance cannot be arbitraged
  // — two of the three outcomes overlap, so the pair pays worst-case on the
  // non-overlapping result — and it is 3861 of the markets on a live download.
  const market = bookEvent({
    bookKey: 'x', home: 'Fulham', away: 'Arsenal', kickoff: '2026-10-03T14:00:00Z',
    marketKey: 'DBLC',
    selections: [{ name: '1X', odds: 1.25 }, { name: '12', odds: 1.44 }, { name: 'X2', odds: 6.5 }],
  });
  assert.equal(indexEventsByContract([market]).size, 0, 'arbEligible:false produces no row');
});

test('rows are ordered by the meetings they have, not by the pairs they could have', () => {
  // Three books that never share a fixture, against two that always do. The old
  // sort led with the potential count, so the line with 3 pairs and 0 meetings
  // came first and the line with 1 pair and 1 meeting — the only one in the
  // report that can actually be traded — came second. This is a report meant to
  // answer what can be arbitraged, so the real count has to lead.
  const totals = (bookKey, home, away) => bookEvent({
    bookKey, home, away, kickoff: '2026-10-03T14:00:00Z', marketKey: 'total_goals',
    selections: [{ name: 'Over 2.5', odds: 1.9 }, { name: 'Under 2.5', odds: 1.9 }],
  });
  const result = (bookKey, home, away) => bookEvent({ bookKey, home, away, kickoff: '2026-10-03T14:00:00Z', selections: RESULT_1X2 });

  const books = new Map([
    // Three books, three different fixtures: 3 pairs, 0 meetings.
    ['superbet', indexEventsByContract([totals('a', 'Fulham', 'Arsenal')])],
    ['unibet', indexEventsByContract([totals('b', 'Everton', 'Liverpool')])],
    ['netbet', indexEventsByContract([totals('c', 'Chelsea', 'Tottenham')])],
    // Two books, one shared fixture: 1 pair, 1 meeting.
    ['betano', indexEventsByContract([result('d', 'Brighton', 'Newcastle')])],
    ['favbet', indexEventsByContract([result('e', 'Brighton', 'Newcastle')])],
  ]);
  const rows = buildCoverageRows(books);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const totalsRow = byKey.get('OVER_UNDER::fulltime::2.5::over+under::goals::match');
  const resultRow = byKey.get('MATCH_ODDS::fulltime::_::home+draw+away::_::_');
  assert.equal(totalsRow.pairs, 3);
  assert.equal(totalsRow.overlapping, 0);
  assert.equal(resultRow.pairs, 1);
  assert.equal(resultRow.overlapping, 1);
  assert.equal(rows[0].key, 'MATCH_ODDS::fulltime::_::home+draw+away::_::_',
    'the line that meets on a fixture leads, whatever its potential');
});
