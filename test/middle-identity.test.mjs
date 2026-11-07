import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findMiddles } from '../src/scanner/engine.mjs';

// The middles bucket is the RESOLVED contract, not the provider's spelling of
// the market key. Each test below pins one term of that key.
//
// The fixtures are two-sided because the resolver refuses a one-sided totals
// market: with no opposing selection it cannot establish which line the market
// is about, so a single "Over 1.5" market never resolves and never reaches a
// bucket. That refusal is itself load-bearing and is covered by the
// market-contracts tests, not here.
//
// Several of these assert a zero, so each one carries a positive control: the
// same fixture with the one differing dimension made equal must produce a row.
// Without the control a zero would also pass if the fixture were simply broken.

const WIDE = { maxMiddleRiskPercent: 1000, minMiddleRoiPercent: 0 };

const twoSided = (line) => [
  { name: `Over ${line}`, odds: 1.9 },
  { name: `Sub ${line}`, odds: 1.9 },
];

function totalsEvent(sourceId, { key = 'TOTAL_GOALS', name = 'Total Goals', team, line }) {
  return {
    id: `${sourceId}-k1`,
    sourceId,
    eventKey: 'k1',
    sport: 'Football',
    league: 'Liga 1',
    kickoff: new Date('2030-01-01').toISOString(),
    homeTeam: 'Home',
    awayTeam: 'Away',
    markets: [{ key, name, team, selections: twoSided(line) }],
  };
}

const mids = (...events) => findMiddles(groupByEvent(events), WIDE);

test('the four provider spellings of one totals market share a bucket', () => {
  // Measured on the 105-book capture: TOTAL_GOALS, total_goals, TOTAL and
  // OVER_UNDER_2_5 are one bet under four spellings. The bucket used to be a
  // two-word prefix of the raw key, so a book writing one spelling could only
  // ever be paired with a book writing the same one - every one of the 410
  // middles on the published board was spelled TOTAL_GOALS, and unibet, netbet,
  // superbet, favbet, betfair, fortuna and casa-pariurilor contributed none.
  const found = mids(
    totalsEvent('a', { key: 'TOTAL_GOALS', line: 2.5 }),
    totalsEvent('b', { key: 'total_goals', line: 2.5 }),
    totalsEvent('c', { key: 'TOTAL', line: 2.5 }),
    totalsEvent('d', { key: 'OVER_UNDER_2_5', line: 2.5 }),
    totalsEvent('e', { key: 'TOTAL_GOALS', line: 3.5 }),
  );
  assert.equal(found.length, 4, 'each of the four spellings pairs with the 3.5 book');
  for (const row of found) {
    assert.deepEqual(
      row.legs.map((leg) => leg.handicap),
      [2.5, 3.5],
      'every pairing is the 2.5 over against the 3.5 under',
    );
  }
});

test('a first-half total never pairs with the full-time total of the same market', () => {
  // The raw prefix carried no period, so 9,099 half1 and 3,813 half2 totals
  // shared buckets with the 73,703 full-time ones. On the 105-book capture that
  // put 1,927 first-half legs against full-time legs. It also manufactured
  // guaranteed profit: a first-half "Over 1.5" is priced near 2.45 while a
  // full-time "Under 2.5" is priced near 2.00, so the inverse sum fell below 1
  // and the pair was stamped as a surebet that does not exist.
  assert.equal(
    mids(
      totalsEvent('a', { name: 'Total Goals', line: 1.5 }),
      totalsEvent('b', { name: '1st Half Total Goals', line: 2.5 }),
    ).length,
    0,
    'the gates are wide open and the two periods still must not pair',
  );
  assert.equal(
    mids(
      totalsEvent('a', { name: 'Total Goals', line: 1.5 }),
      totalsEvent('b', { name: 'Total Goals', line: 2.5 }),
    ).length,
    1,
    'positive control: the same two prices pair once both are full time',
  );
});

test('a team-total middle publishes the team and the subject it is about', () => {
  // A team's own total was titled as the match total because the middles row
  // carried neither field. The row now names both, read from the resolved
  // contract exactly as the arbitrage builder does.
  const found = mids(
    totalsEvent('a', { team: 'home', line: 1.5 }),
    totalsEvent('b', { team: 'home', line: 2.5 }),
  );
  assert.equal(found.length, 1, 'positive control: two home totals do pair');
  assert.equal(found[0].team, 'home', 'the row names the side it is about');
  assert.equal(found[0].subject, 'goals');
});

test('one team total never pairs with the match total at the same lines', () => {
  // 25,797 team-scoped totals arrive per capture (13,274 home, 12,523 away), so
  // this is a live collision and not a hypothetical one. The match total and a
  // single team's total are different bets however close the prices are.
  assert.equal(
    mids(
      totalsEvent('a', { team: 'home', line: 1.5 }),
      totalsEvent('b', { line: 2.5 }),
    ).length,
    0,
    'a home total is not the match total',
  );
  assert.equal(
    mids(
      totalsEvent('a', { team: 'home', line: 1.5 }),
      totalsEvent('b', { team: 'away', line: 2.5 }),
    ).length,
    0,
    'a home total is not the away total either',
  );
});

test('a match total publishes no team, so the field only ever names a side', () => {
  // A resolved contract reports `team: 'match'` for the match total. That is the
  // absence of a team scope rather than a scope of its own: `family` already says
  // the row is a total and `subject` says what it counts, so publishing it would
  // put the word "Match" in front of every ordinary total and name nothing the
  // reader did not already have. Measured on the 105-book capture, 12 of the 51
  // middles name a side and 39 are match totals that publish no team at all.
  // Both builders read this through the same predicate, so the arbitrage and
  // middles families cannot come to mean different things by the same field.
  const found = mids(
    totalsEvent('a', { line: 1.5 }),
    totalsEvent('b', { line: 2.5 }),
  );
  assert.equal(found.length, 1, 'positive control: two match totals do pair');
  assert.ok(!('team' in found[0]), 'a match total names no side, so it carries no team');
  assert.equal(found[0].subject, 'goals', 'the subject is still published');
});

test('a quarter or whole line is refused rather than priced as a push-free band', () => {
  // The band a middle is priced from is a partition only when neither line can
  // push: below the low line only the under pays, above the high line only the
  // over pays, in between both do. A whole line pushes on the number and a
  // quarter line half-pushes on it, which leaves a result where neither leg
  // pays and the inverse-sum test no longer describes the pair. 123 of the
  // 2,050 rows the prefix scan published were quarter lines - TOTAL_GOALS at
  // 2.25 from betway, betinia and campobet.
  assert.equal(
    mids(
      totalsEvent('a', { key: 'TOTAL', line: 2.25 }),
      totalsEvent('b', { key: 'TOTAL', line: 3.25 }),
    ).length,
    0,
    'a quarter line half-pushes on the number',
  );
  assert.equal(
    mids(
      totalsEvent('a', { key: 'TOTAL', line: 2 }),
      totalsEvent('b', { key: 'TOTAL', line: 3 }),
    ).length,
    0,
    'a whole line pushes outright',
  );
  assert.equal(
    mids(
      totalsEvent('a', { key: 'TOTAL', line: 2.5 }),
      totalsEvent('b', { key: 'TOTAL', line: 3.5 }),
    ).length,
    1,
    'positive control: the half lines that bracket them do pair',
  );
});

test('a goals total never pairs with a corners total', () => {
  // Both are two-sided over/under markets on the same event and period, so
  // nothing but the subject distinguishes them - and they are counted in
  // different units. Pairing them would produce a band over an event where the
  // two legs are not alternatives at all.
  assert.equal(
    mids(
      totalsEvent('a', { key: 'TOTAL_GOALS', name: 'Total Goals', line: 1.5 }),
      totalsEvent('b', { key: 'TOTAL_CORNERS', name: 'Total Corners', line: 2.5 }),
    ).length,
    0,
    'goals and corners are different counters, not two quotes of one bet',
  );
  assert.equal(
    mids(
      totalsEvent('a', { key: 'TOTAL_CORNERS', name: 'Total Corners', line: 1.5 }),
      totalsEvent('b', { key: 'TOTAL_CORNERS', name: 'Total Corners', line: 2.5 }),
    ).length,
    1,
    'positive control: two corners markets do pair',
  );
});
