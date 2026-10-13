// Tests for the new contract families in src/scanner/market-contracts.mjs
// Run via: node --test test/market-contracts-families.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContract,
  canonicalOutcomeFor,
  bucketKeyForContract,
  isFullTimeMarket,
  canonicalPeriod,
  extractPeriodFromName,
  isDeclaredFullTimeMarket,
  isTradablePeriod,
  TRADABLE_PERIODS,
} from '../src/scanner/market-contracts.mjs';

test('MATCH_ODDS family: explicit key, opaque 547 key, default key', () => {
  for (const key of ['MATCH_ODDS', '1x2', '547', 'default', 'MRES', '100001']) {
    const c = resolveContract({ key, period: 'fulltime', selections: [
      { name: '1' }, { name: 'X' }, { name: '2' },
    ] });
    assert.equal(c?.family, 'MATCH_ODDS', `key=${key}`);
    assert.deepEqual(c?.outcomes, ['home', 'draw', 'away']);
    assert.equal(c?.period, 'fulltime');
    assert.equal(c?.lineKey, '_');
  }
});

test('DOUBLE_CHANCE family: DC key and FEG opaque ufo:mtyp:00-01', () => {
  const a = resolveContract({ key: 'DOUBLE_CHANCE', period: 'fulltime', selections: [
    { name: '1X' }, { name: '12' }, { name: 'X2' },
  ] });
  assert.equal(a.family, 'DOUBLE_CHANCE');
  assert.deepEqual(a.outcomes, ['home_or_draw', 'home_or_away', 'draw_or_away']);
  const b = resolveContract({ key: 'ufo:mtyp:00-01', period: 'unknown', selections: [
    { name: '1X' }, { name: '12' }, { name: 'X2' },
  ] });
  assert.equal(b.family, 'DOUBLE_CHANCE');
});

test('BTTS family: alt names per book (Da/Nu, Yes/No, BTTS key)', () => {
  const keys = ['BOTH_TEAMS_SCORE', 'btts', 'BTSC'];
  for (const key of keys) {
    const c = resolveContract({ key, period: 'fulltime', selections: [{ name: 'Yes' }, { name: 'No' }] });
    assert.equal(c?.family, 'BTTS', `key=${key}`);
    assert.deepEqual(c?.outcomes, ['yes', 'no']);
  }
  // Romanian legend
  const c2 = resolveContract({ key: 'btts', period: 'fulltime', selections: [{ name: 'Da' }, { name: 'Nu' }] });
  assert.equal(c2?.family, 'BTTS');
});

test('OVER_UNDER family: bundled totals extract line from selection names (not key)', () => {
  // favbet total_goals / FEG ufo:mtyp:00-0u / HCTG / TGOT / OUH1 all publish
  // lines in selection names, not in the key. The contract must read it
  // from the selections so OVER 2.5 in one market never buckets with
  // OVER 3.5 (a real prior bug on multi-line bundles).
  const c = resolveContract({
    key: 'total_goals', period: 'fulltime',
    selections: [{ name: 'Peste (2.5)' }, { name: 'Sub (2.5)' }],
  });
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '2.5');
});

test('ASIAN_HANDICAP family: line comes from selection handicap, key is generic', () => {
  const c = resolveContract({
    key: 'game_handicap', period: 'fulltime',
    selections: [
      { name: '1 (-1.5)', handicap: -1.5 },
      { name: '2 (+1.5)', handicap: 1.5 },
    ],
  });
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '-1.5/1.5');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('a "H1"/"H2" handicap resolves as a handicap, never as a goals total', () => {
  // nsoft labels its handicap legs "H1 -0.5" / "H2 0.5". The auto-detector's
  // handicap keyword only matches names starting with 1 or 2, so on these names
  // it fell through to the equal-magnitude fallback and returned OVER_UNDER —
  // bucketing a 0.5 handicap into the same line as a 0.5 goals total, two
  // contracts with opposite payouts reported as one. The explicit key routes
  // on the adapter's own assertion instead of on the spelling.
  for (const [line, legs] of [['-0.5', ['H1 -0.5', 'H2 0.5']], ['0.5', ['H1 0.5', 'H2 -0.5']]]) {
    const c = resolveContract({ key: 'ASIAN_HANDICAP', period: 'fulltime', line, selections: legs.map((name) => ({ name })) });
    assert.equal(c.family, 'ASIAN_HANDICAP', `${line} must price as a handicap`);
    assert.equal(c.lineKey, `${line}/${-Number(line)}`);
    assert.deepEqual(c.outcomes, ['home', 'away']);
  }
});

test('a whole-line handicap is not arbitrable: the stake is returned, not settled', () => {
  // The half-line guard lives in the `kind: 'AH'` hint. Without it a whole-line
  // "H1 -1"/"H2 1" pair would resolve to a contract whose two legs can both push.
  assert.equal(resolveContract({
    key: 'ASIAN_HANDICAP', period: 'fulltime', line: '-1',
    selections: [{ name: 'H1 -1' }, { name: 'H2 1' }],
  }), null);
  // And a pair whose legs are not exact opposites is refused outright.
  assert.equal(resolveContract({
    key: 'ASIAN_HANDICAP', period: 'fulltime', line: '-0.5',
    selections: [{ name: 'H1 -0.5' }, { name: 'H2 -0.5' }],
  }), null);
});

test('bucket key isolates by period and line — critical for cross-book correctness', () => {
  const cFt = resolveContract({ key: 'BTTS', period: 'fulltime', selections: [{ name: 'Yes' }, { name: 'No' }] });
  const cH1 = resolveContract({ key: 'BTTS', period: 'half1', selections: [{ name: 'Yes' }, { name: 'No' }] });
  assert.notEqual(
    bucketKeyForContract('event1', cFt),
    bucketKeyForContract('event1', cH1),
    'first-half BTTS must not collide with full-time BTTS',
  );
  const ou25 = resolveContract({ key: 'total_goals', period: 'fulltime', selections: [{ name: 'Peste 2.5' }, { name: 'Sub 2.5' }] });
  const ou35 = resolveContract({ key: 'total_goals', period: 'fulltime', selections: [{ name: 'Peste 3.5' }, { name: 'Sub 3.5' }] });
  assert.ok(ou25 && ou35, 'both lines should resolve to contracts');
  assert.notEqual(
    bucketKeyForContract('event1', ou25),
    bucketKeyForContract('event1', ou35),
    'OVER 2.5 must never bucket with OVER 3.5 (the multi-line bug from older ufo:mtyp:00-0u)',
  );
});

test('a half-time total is refused by the full-time gate and buckets apart', () => {
  // Measured live on unibet: one provider key (`TOTAL`) carries BOTH readings,
  // and their line ranges overlap — "Total goluri" quoted 0.5–6.5 and "Total
  // Goluri - Repriză a 1-a" quoted 0.5–3.5, so 2.5 exists at both periods on
  // the same fixture. The family and the line are therefore identical and only
  // the period separates them.
  const ft = {
    key: 'TOTAL', name: 'Total goluri', period: 'fulltime', line: '2.5',
    selections: [{ name: 'Peste 2.5' }, { name: 'Sub 2.5' }],
  };
  const h1 = {
    key: 'TOTAL', name: 'Total Goluri - Repriză a 1-a', period: 'half1', line: '2.5',
    selections: [{ name: 'Peste 2.5' }, { name: 'Sub 2.5' }],
  };

  const cFt = resolveContract(ft);
  const cH1 = resolveContract(h1);
  assert.ok(cFt && cH1, 'both readings must resolve to a goals total');
  assert.equal(cFt.lineKey, cH1.lineKey, 'the line really is the same on both periods');
  assert.notEqual(
    bucketKeyForContract('event1', cFt),
    bucketKeyForContract('event1', cH1),
    'a first-half 2.5 must not bucket with a full-time 2.5',
  );

  // The gate the engine applies before it will price a market at all, and the
  // one scripts/market-coverage.mjs now applies so the report cannot count a
  // pair the scanner would refuse to book.
  assert.equal(isFullTimeMarket(ft), true);
  assert.equal(isFullTimeMarket(h1), false);
});

test('canonicalOutcomeFor routes by family', () => {
  // 1X2
  const mo = resolveContract({ key: '1x2', period: 'fulltime', selections: [{ name: '1' }, { name: 'X' }, { name: '2' }] });
  assert.equal(canonicalOutcomeFor('1', mo), 'home');
  assert.equal(canonicalOutcomeFor('2', mo), 'away');
  assert.equal(canonicalOutcomeFor('X', mo), 'draw');
  // DOUBLE_CHANCE
  const dc = resolveContract({ key: 'DOUBLE_CHANCE', period: 'fulltime', selections: [{ name: '1X' }, { name: 'X2' }, { name: '12' }] });
  assert.equal(canonicalOutcomeFor('1X', dc), 'home_or_draw');
  assert.equal(canonicalOutcomeFor('X2', dc), 'draw_or_away');
  assert.equal(canonicalOutcomeFor('12', dc), 'home_or_away');
  // BTTS Romanian
  const b = resolveContract({ key: 'btts', period: 'fulltime', selections: [{ name: 'Da' }, { name: 'Nu' }] });
  assert.equal(canonicalOutcomeFor('Da', b), 'yes');
  assert.equal(canonicalOutcomeFor('Nu', b), 'no');
});

// This drove `isDoubleChanceMarket` / `isBttsMarket` / `isAsianHandicapMarket`,
// three one-line wrappers over `resolveContract(market)?.family === …` that
// nothing but this file called, under a comment naming base.mjs, the README and
// the UI as their readers — none of which mention them. The shapes are the ones
// worth keeping, so they are asked of the resolver the production path uses.
const familyOf = (market) => resolveContract(market)?.family;

test('guards reject the wrong-shaped family', () => {
  assert.notEqual(familyOf({ key: '1x2', selections: [{ name: '1' }, { name: 'X' }, { name: '2' }] }), 'DOUBLE_CHANCE');
  assert.equal(familyOf({ key: 'DOUBLE_CHANCE', selections: [{ name: '1X' }, { name: 'X2' }, { name: '12' }] }), 'DOUBLE_CHANCE');
  assert.equal(familyOf({ key: 'btts', selections: [{ name: 'Yes' }, { name: 'No' }] }), 'BTTS');
  assert.notEqual(familyOf({ key: 'btts', selections: [{ name: 'Yes' }] }), 'BTTS', 'BTTS with single outcome is not a 2-way market');
  assert.equal(familyOf({ key: 'game_handicap', selections: [
    { name: '1 (-1.5)', handicap: -1.5 },
    { name: '2 (+1.5)', handicap: 1.5 },
  ] }), 'ASIAN_HANDICAP');
  assert.notEqual(familyOf({ key: 'game_handicap', selections: [
    { name: '1 (-1)', handicap: -1 },
    { name: '2 (+1)', handicap: 1 },
  ] }), 'ASIAN_HANDICAP', 'whole-line handicaps excluded (push semantics differ)');
});

test('alt-markets (corners, cards, points): resolve contract with correct subject', () => {
  const cornersContract = resolveContract({
    key: 'CORNERS_OVER_UNDER_9_5',
    name: 'Total cornere 9.5',
    period: 'fulltime',
    line: 9.5,
    selections: [{ name: 'Peste 9.5' }, { name: 'Sub 9.5' }],
  });
  assert.ok(cornersContract, 'corners market must resolve to a contract');
  assert.equal(cornersContract.family, 'OVER_UNDER');
  assert.equal(cornersContract.subject, 'corners');
  assert.equal(cornersContract.lineKey, '9.5');

  const cardsContract = resolveContract({
    key: 'CARDS_OVER_UNDER_4_5',
    name: 'Total cartonașe 4.5',
    period: 'fulltime',
    line: 4.5,
    selections: [{ name: 'Over 4.5' }, { name: 'Under 4.5' }],
  });
  assert.ok(cardsContract, 'cards market must resolve to a contract');
  assert.equal(cardsContract.family, 'OVER_UNDER');
  assert.equal(cardsContract.subject, 'cards');
  assert.equal(cardsContract.lineKey, '4.5');

  const pointsContract = resolveContract({
    key: 'POINTS_OVER_UNDER_155_5',
    name: 'Total puncte 155.5',
    period: 'fulltime',
    line: 155.5,
    selections: [{ name: 'Peste 155.5' }, { name: 'Sub 155.5' }],
  });
  assert.ok(pointsContract, 'points market must resolve to a contract');
  assert.equal(pointsContract.family, 'OVER_UNDER');
  assert.equal(pointsContract.subject, 'points');
  assert.equal(pointsContract.lineKey, '155.5');

  // Subjects must never collide in bucket keys
  const goalsContract = resolveContract({
    key: 'OVER_UNDER_9_5',
    name: 'Total goluri 9.5',
    period: 'fulltime',
    line: 9.5,
    selections: [{ name: 'Peste 9.5' }, { name: 'Sub 9.5' }],
  });
  assert.notEqual(
    bucketKeyForContract('ev1', cornersContract),
    bucketKeyForContract('ev1', goalsContract),
    'corners total must not bucket with goals total',
  );
});

test('per-team totals: resolve with correct team side and isolate from match totals', () => {
  const homeTotals = resolveContract({
    key: 'TOTAL_GOALS',
    name: 'Total Goluri Gazde 1.5',
    team: 'home',
    period: 'fulltime',
    line: 1.5,
    selections: [{ name: 'Peste 1.5' }, { name: 'Sub 1.5' }],
  });
  assert.ok(homeTotals, 'home team total must resolve');
  assert.equal(homeTotals.team, 'home');
  assert.equal(homeTotals.lineKey, '1.5');

  const awayTotals = resolveContract({
    key: 'TOTAL_GOALS',
    name: 'Total Goluri Oaspeti 1.5',
    team: 'away',
    period: 'fulltime',
    line: 1.5,
    selections: [{ name: 'Peste 1.5' }, { name: 'Sub 1.5' }],
  });
  assert.ok(awayTotals, 'away team total must resolve');
  assert.equal(awayTotals.team, 'away');

  const matchTotals = resolveContract({
    key: 'TOTAL_GOALS',
    name: 'Total Goluri 1.5',
    period: 'fulltime',
    line: 1.5,
    selections: [{ name: 'Peste 1.5' }, { name: 'Sub 1.5' }],
  });
  assert.equal(matchTotals.team, 'match');

  assert.notEqual(
    bucketKeyForContract('ev1', homeTotals),
    bucketKeyForContract('ev1', awayTotals),
    'home team total must not bucket with away team total',
  );
  assert.notEqual(
    bucketKeyForContract('ev1', homeTotals),
    bucketKeyForContract('ev1', matchTotals),
    'home team total must not bucket with match total',
  );
});

test('basketball and tennis: 2-way moneyline, spreads, and totals resolution', () => {
  // 2-way moneyline with 2 selections
  const ml2way = resolveContract({
    key: 'MONEYLINE',
    name: 'Castigator meci',
    period: 'fulltime',
    selections: [{ name: 'Los Angeles Lakers' }, { name: 'Golden State Warriors' }],
  });
  assert.ok(ml2way, '2-way moneyline must resolve');
  assert.equal(ml2way.family, 'MATCH_ODDS');
  assert.deepEqual(ml2way.outcomes, ['home', 'away']);

  const matchWinner = resolveContract({
    key: 'MATCH_ODDS',
    name: 'Match Odds',
    period: 'fulltime',
    selections: [{ name: 'Jannik Sinner' }, { name: 'Carlos Alcaraz' }],
  });
  assert.ok(matchWinner, 'tennis match odds 2-way must resolve');
  assert.equal(matchWinner.family, 'MATCH_ODDS');
  assert.deepEqual(matchWinner.outcomes, ['home', 'away']);

  // Basketball spread / point handicap
  const spread = resolveContract({
    key: 'BASKETBALL_HANDICAP',
    name: 'Handicap Puncte (-4.5)',
    period: 'fulltime',
    selections: [{ name: '1 (-4.5)', handicap: -4.5 }, { name: '2 (+4.5)', handicap: 4.5 }],
  });
  assert.ok(spread, 'point spread must resolve');
  assert.equal(spread.family, 'ASIAN_HANDICAP');
  assert.deepEqual(spread.outcomes, ['home', 'away']);
  assert.equal(spread.lineKey, '-4.5/4.5');

  // Tennis games total
  const gamesTotal = resolveContract({
    key: 'FTGO',
    name: 'Total Game-uri 22.5',
    period: 'fulltime',
    line: 22.5,
    selections: [{ name: 'Peste 22.5' }, { name: 'Sub 22.5' }],
  });
  assert.ok(gamesTotal, 'games total must resolve');
  assert.equal(gamesTotal.family, 'OVER_UNDER');
  assert.equal(gamesTotal.subject, 'games');
  assert.equal(gamesTotal.lineKey, '22.5');
});

test('canonicalOutcomeFor: maps Asian Handicap selections across various notation formats (H1/H2, AH1/AH2, 1/2, Gazde/Oaspeti, Home/Away)', () => {
  const c = resolveContract({
    key: 'ASIAN_HANDICAP',
    period: 'fulltime',
    selections: [{ name: 'H1 -1.5' }, { name: 'H2 1.5' }],
  });
  assert.ok(c);
  assert.equal(c.family, 'ASIAN_HANDICAP');

  // H1 / H2 notation (NSoft and regional feeds)
  assert.equal(canonicalOutcomeFor('H1 -1.5', c), 'home');
  assert.equal(canonicalOutcomeFor('H2 1.5', c), 'away');
  assert.equal(canonicalOutcomeFor('H1 (-1.5)', c), 'home');
  assert.equal(canonicalOutcomeFor('H2 (+1.5)', c), 'away');
  assert.equal(canonicalOutcomeFor('h1', c), 'home');
  assert.equal(canonicalOutcomeFor('h2', c), 'away');

  // AH1 / AH2 notation
  assert.equal(canonicalOutcomeFor('AH1 -1.5', c), 'home');
  assert.equal(canonicalOutcomeFor('AH2 +1.5', c), 'away');
  assert.equal(canonicalOutcomeFor('ah1 (-0.5)', c), 'home');
  assert.equal(canonicalOutcomeFor('ah2 (0.5)', c), 'away');

  // Standard 1 / 2 notation
  assert.equal(canonicalOutcomeFor('1 (-1.5)', c), 'home');
  assert.equal(canonicalOutcomeFor('2 (+1.5)', c), 'away');

  // Home / Away text
  assert.equal(canonicalOutcomeFor('Home (-1.5)', c), 'home');
  assert.equal(canonicalOutcomeFor('Away (+1.5)', c), 'away');

  // Romanian Gazde / Oaspeti labels
  assert.equal(canonicalOutcomeFor('Gazde (-1.5)', c), 'home');
  assert.equal(canonicalOutcomeFor('Oaspeti (+1.5)', c), 'away');
  assert.equal(canonicalOutcomeFor('Oaspeți (+1.5)', c), 'away');
});

test('Asian Handicap cross-book bucket parity between 1/2, H1/H2, and AH1/AH2 formats', () => {
  const cNumbered = resolveContract({
    key: 'game_handicap',
    period: 'fulltime',
    selections: [{ name: '1 (-1.5)' }, { name: '2 (1.5)' }],
  });
  const cHFormat = resolveContract({
    key: 'ASIAN_HANDICAP',
    period: 'fulltime',
    selections: [{ name: 'H1 -1.5' }, { name: 'H2 1.5' }],
  });
  const cAHFormat = resolveContract({
    key: 'ASIAN_HANDICAP',
    period: 'fulltime',
    selections: [{ name: 'AH1 -1.5' }, { name: 'AH2 1.5' }],
  });

  assert.ok(cNumbered && cHFormat && cAHFormat);
  assert.equal(cNumbered.lineKey, '-1.5/1.5');
  assert.equal(cHFormat.lineKey, '-1.5/1.5');
  assert.equal(cAHFormat.lineKey, '-1.5/1.5');

  const bNumbered = bucketKeyForContract('eventX', cNumbered);
  const bHFormat = bucketKeyForContract('eventX', cHFormat);
  const bAHFormat = bucketKeyForContract('eventX', cAHFormat);

  assert.equal(bNumbered, bHFormat, 'Numbered and H1/H2 formats must bucket identically');
  assert.equal(bNumbered, bAHFormat, 'Numbered and AH1/AH2 formats must bucket identically');
});

test('Asian Handicap carries subject when present and isolates in bucket keys', () => {
  const goalAh = resolveContract({
    key: 'ASIAN_HANDICAP',
    period: 'fulltime',
    selections: [{ name: '1 (-1.5)' }, { name: '2 (1.5)' }],
  });
  const cornerAh = resolveContract({
    key: 'ASIAN_HANDICAP',
    period: 'fulltime',
    subject: 'corners',
    selections: [{ name: '1 (-1.5)' }, { name: '2 (1.5)' }],
  });
  const pointsAh = resolveContract({
    key: 'POINT_SPREAD',
    period: 'fulltime',
    subject: 'points',
    selections: [{ name: '1 (-5.5)' }, { name: '2 (5.5)' }],
  });

  assert.ok(goalAh && cornerAh && pointsAh);
  assert.equal(cornerAh.subject, 'corners');
  assert.equal(pointsAh.subject, 'points');

  const bGoal = bucketKeyForContract('ev1', goalAh);
  const bCorner = bucketKeyForContract('ev1', cornerAh);
  assert.notEqual(bGoal, bCorner, 'corners handicap must not bucket with standard goals handicap');
});

test('canonicalPeriod: recognizes sets and quarters across name and period formats', () => {
  // Tennis sets from period field
  assert.equal(canonicalPeriod({ period: 'set1' }), 'set1');
  assert.equal(canonicalPeriod({ period: 'set2' }), 'set2');
  assert.equal(canonicalPeriod({ period: '1st_set' }), 'set1');

  // Tennis sets from market name
  assert.equal(canonicalPeriod({ name: 'Set 1 Câștigător', period: 'fulltime' }), 'set1');
  assert.equal(canonicalPeriod({ name: '2. set total games', period: 'unknown' }), 'set2');
  assert.equal(canonicalPeriod({ name: '1st Set Winner' }), 'set1');

  // Basketball quarters from period field
  assert.equal(canonicalPeriod({ period: 'q1' }), 'q1');
  assert.equal(canonicalPeriod({ period: 'quarter2' }), 'q2');
  assert.equal(canonicalPeriod({ period: '3rd_quarter' }), 'q3');

  // Basketball quarters from market name
  assert.equal(canonicalPeriod({ name: 'Sfert 1 Total Puncte', period: 'fulltime' }), 'q1');
  assert.equal(canonicalPeriod({ name: 'Quarter 2 Winner', period: 'unknown' }), 'q2');
  assert.equal(canonicalPeriod({ name: 'Q3 Handicap (-2.5)' }), 'q3');
  assert.equal(canonicalPeriod({ name: 'Sfertul 4 Total Puncte' }), 'q4');

  // isTradablePeriod includes sets and quarters
  assert.ok(isTradablePeriod('set1'));
  assert.ok(isTradablePeriod('set2'));
  assert.ok(isTradablePeriod('q1'));
  assert.ok(isTradablePeriod('q4'));
  assert.ok(!isTradablePeriod('unknown_period'));

  // TRADABLE_PERIODS census pinning
  assert.ok(TRADABLE_PERIODS.has('fulltime'));
  assert.ok(TRADABLE_PERIODS.has('half1'));
  assert.ok(TRADABLE_PERIODS.has('set1'));
  assert.ok(TRADABLE_PERIODS.has('q1'));
});

test('period isolation: tennis set and basketball quarter markets never collide with full-time buckets', () => {
  const ftWinner = resolveContract({
    key: 'MATCH_ODDS',
    name: 'Castigator meci',
    period: 'fulltime',
    selections: [{ name: 'Jannik Sinner' }, { name: 'Carlos Alcaraz' }],
  });
  const set1Winner = resolveContract({
    key: 'MATCH_ODDS',
    name: 'Set 1 Castigator',
    period: 'fulltime',
    selections: [{ name: 'Jannik Sinner' }, { name: 'Carlos Alcaraz' }],
  });
  const set2Winner = resolveContract({
    key: 'MATCH_ODDS',
    name: 'Set 2 Castigator',
    period: 'fulltime',
    selections: [{ name: 'Jannik Sinner' }, { name: 'Carlos Alcaraz' }],
  });

  assert.ok(ftWinner && set1Winner && set2Winner);
  assert.equal(ftWinner.period, 'fulltime');
  assert.equal(set1Winner.period, 'set1');
  assert.equal(set2Winner.period, 'set2');

  const bFt = bucketKeyForContract('ev1', ftWinner);
  const bSet1 = bucketKeyForContract('ev1', set1Winner);
  const bSet2 = bucketKeyForContract('ev1', set2Winner);

  assert.notEqual(bFt, bSet1, 'Set 1 winner must NOT bucket with full-time match winner');
  assert.notEqual(bSet1, bSet2, 'Set 1 winner must NOT bucket with Set 2 winner');

  // isDeclaredFullTimeMarket refuses set and quarter names even when declared fulltime
  assert.equal(isDeclaredFullTimeMarket({ name: 'Set 1 Castigator', period: 'fulltime' }), false);
  assert.equal(isDeclaredFullTimeMarket({ name: 'Sfert 1 Total Puncte', period: 'fulltime' }), false);
  assert.equal(isDeclaredFullTimeMarket({ name: 'Q1 Winner', period: 'fulltime' }), false);
  assert.equal(isDeclaredFullTimeMarket({ name: 'Castigator Meci', period: 'fulltime' }), true);
});

test('DRAW_NO_BET: recognized via explicit keys and Romanian labels, always arbEligible: false', () => {
  // Explicit keys
  for (const key of ['DNB', 'DRAW_NO_BET', 'DNOB', 'DRAW_NO_BET_2WAY', 'ASIAN_HANDICAP_0', 'AH_0', 'AH0']) {
    const c = resolveContract({
      key,
      period: 'fulltime',
      selections: [{ name: '1' }, { name: '2' }],
    });
    assert.ok(c, `key=${key} should resolve`);
    assert.equal(c.family, 'DRAW_NO_BET', `key=${key}`);
    assert.equal(c.arbEligible, false, `key=${key} must be arbEligible: false`);
  }

  // Romanian natural labels
  for (const name of ['Victorie fara egal', 'Niciun pariu pe egal', 'Pariu fara egal', 'Fara egal']) {
    const c = resolveContract({
      key: 'generic_key',
      name,
      period: 'fulltime',
      selections: [{ name: 'FCSB' }, { name: 'Dinamo' }],
    });
    assert.ok(c, `name=${name} should resolve`);
    assert.equal(c.family, 'DRAW_NO_BET', `name=${name}`);
    assert.equal(c.arbEligible, false, `name=${name} must be arbEligible: false`);
  }
});

test('multi-sport totals: sport-aware subject assignment for Basketball, Tennis, and Handball', () => {
  // Basketball total resolves as points even without "puncte" in name
  const bballTotal = resolveContract(
    { key: 'TOTAL', name: 'Total', selections: [{ name: 'Peste 210.5' }, { name: 'Sub 210.5' }] },
    { sport: 'basketball' },
  );
  assert.ok(bballTotal);
  assert.equal(bballTotal.family, 'OVER_UNDER');
  assert.equal(bballTotal.subject, 'points');
  assert.equal(bballTotal.lineKey, '210.5');

  // Tennis total resolves as games
  const tennisTotal = resolveContract(
    { key: 'TOTAL', name: 'Peste/Sub', selections: [{ name: 'Peste 22.5' }, { name: 'Sub 22.5' }] },
    { sport: 'tennis' },
  );
  assert.ok(tennisTotal);
  assert.equal(tennisTotal.family, 'OVER_UNDER');
  assert.equal(tennisTotal.subject, 'games');
  assert.equal(tennisTotal.lineKey, '22.5');

  // Handball total resolves as goals
  const handballTotal = resolveContract(
    { key: 'TOTAL', name: 'Total Goluri', selections: [{ name: 'Peste 55.5' }, { name: 'Sub 55.5' }] },
    { sport: 'handball' },
  );
  assert.ok(handballTotal);
  assert.equal(handballTotal.family, 'OVER_UNDER');
  assert.equal(handballTotal.subject, 'goals');
  assert.equal(handballTotal.lineKey, '55.5');

  // FEG sport-routed totals
  const fegBball = resolveContract({
    key: 'ufo:mtyp:02-06',
    selections: [{ name: 'Peste 180.5' }, { name: 'Sub 180.5' }],
  });
  assert.ok(fegBball);
  assert.equal(fegBball.family, 'OVER_UNDER');
  assert.equal(fegBball.subject, 'points');
});

test('multi-sport handicaps: sport-aware subject assignment and cross-book parity', () => {
  // Basketball point spread
  const bballSpread = resolveContract(
    { key: 'HANDICAP', name: 'Handicap', selections: [{ name: '1 (-5.5)' }, { name: '2 (5.5)' }] },
    { sport: 'basketball' },
  );
  assert.ok(bballSpread);
  assert.equal(bballSpread.family, 'ASIAN_HANDICAP');
  assert.equal(bballSpread.subject, 'points');

  // Tennis game handicap
  const tennisHcap = resolveContract(
    { key: 'HANDICAP', name: 'Handicap', selections: [{ name: '1 (-2.5)' }, { name: '2 (2.5)' }] },
    { sport: 'tennis' },
  );
  assert.ok(tennisHcap);
  assert.equal(tennisHcap.family, 'ASIAN_HANDICAP');
  assert.equal(tennisHcap.subject, 'games');

  // Football handicap stays default (subject undefined, bucketKey uses _)
  const footballHcap = resolveContract(
    { key: 'HANDICAP', name: 'Handicap', selections: [{ name: '1 (-1.5)' }, { name: '2 (1.5)' }] },
    { sport: 'football' },
  );
  assert.ok(footballHcap);
  assert.equal(footballHcap.family, 'ASIAN_HANDICAP');
  assert.equal(footballHcap.subject, undefined);

  // Bucket isolation across sports
  const bBball = bucketKeyForContract('ev1', bballSpread);
  const bTennis = bucketKeyForContract('ev1', tennisHcap);
  const bFootball = bucketKeyForContract('ev1', footballHcap);

  assert.ok(bBball.includes('::points::_'), 'basketball spread key carries points');
  assert.ok(bTennis.includes('::games::_'), 'tennis handicap key carries games');
  assert.ok(bFootball.includes('::_::_'), 'football handicap key carries default _');
});

test('canonicalPeriod and resolveContract: Romanian set/quarter names and SET_WINNER / QUARTER_WINNER keys', () => {
  // SET_WINNER key
  const setContract = resolveContract({
    key: 'SET_WINNER',
    name: 'Câștigător Setul 1',
    selections: [{ name: '1' }, { name: '2' }],
  });
  assert.ok(setContract);
  assert.equal(setContract.family, 'MATCH_ODDS');
  assert.equal(setContract.period, 'set1');
  assert.deepEqual(setContract.outcomes, ['home', 'away']);

  // QUARTER_WINNER key
  const qContract = resolveContract({
    key: 'QUARTER_WINNER',
    name: 'Câștigător Sfertul 2',
    selections: [{ name: '1' }, { name: '2' }],
  });
  assert.ok(qContract);
  assert.equal(qContract.family, 'MATCH_ODDS');
  assert.equal(qContract.period, 'q2');
  assert.deepEqual(qContract.outcomes, ['home', 'away']);

  // Romanian natural language: primul set, al doilea set
  assert.equal(canonicalPeriod({ name: 'Primul set - Câștigător', period: 'fulltime' }), 'set1');
  assert.equal(canonicalPeriod({ name: 'Al doilea set - Câștigător', period: 'fulltime' }), 'set2');
  assert.equal(canonicalPeriod({ name: 'Primul sfert - Câștigător', period: 'fulltime' }), 'q1');
  assert.equal(canonicalPeriod({ name: 'Al doilea sfert - Câștigător', period: 'fulltime' }), 'q2');

  // Bucket isolation between match odds and set winner
  const ftContract = resolveContract({
    key: 'MATCH_ODDS',
    name: 'Câștigător meci',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: '2' }],
  });
  const ftKey = bucketKeyForContract('ev1', ftContract);
  const set1Key = bucketKeyForContract('ev1', setContract);
  assert.ok(ftKey.includes('::MATCH_ODDS::fulltime::_'));
  assert.ok(set1Key.includes('::MATCH_ODDS::set1::_'));
  assert.notEqual(ftKey, set1Key);
});

test('extractPeriodFromName and explicit period totals resolution across sports', () => {
  // extractPeriodFromName checks
  assert.equal(extractPeriodFromName('Total puncte - Sfertul 1'), 'q1');
  assert.equal(extractPeriodFromName('Total puncte - Sfertul 3'), 'q3');
  assert.equal(extractPeriodFromName('Câștigător setul 1'), 'set1');
  assert.equal(extractPeriodFromName('Set 2 Winner'), 'set2');
  assert.equal(extractPeriodFromName('1x2 - Repriza 1'), 'half1');
  assert.equal(extractPeriodFromName('1x2 - Repriza 2'), 'half2');
  assert.equal(extractPeriodFromName('1st Half Total Goals'), 'half1');
  assert.equal(extractPeriodFromName('2nd Half Total Goals'), 'half2');
  assert.equal(extractPeriodFromName('Full Time Result'), null);

  // TOTAL_POINTS explicit key resolution with period
  const q1PointsTotal = resolveContract({
    key: 'TOTAL_POINTS',
    name: 'Total puncte - Sfertul 1',
    period: 'q1',
    line: 52.5,
    selections: [{ name: 'Peste 52.5' }, { name: 'Sub 52.5' }],
  });
  assert.ok(q1PointsTotal);
  assert.equal(q1PointsTotal.family, 'OVER_UNDER');
  assert.equal(q1PointsTotal.subject, 'points');
  assert.equal(q1PointsTotal.period, 'q1');
  assert.equal(q1PointsTotal.lineKey, '52.5');

  // Full-time points total
  const ftPointsTotal = resolveContract({
    key: 'TOTAL_POINTS',
    name: 'Total Puncte',
    period: 'fulltime',
    line: 215.5,
    selections: [{ name: 'Peste 215.5' }, { name: 'Sub 215.5' }],
  });
  assert.ok(ftPointsTotal);
  assert.equal(ftPointsTotal.period, 'fulltime');

  // Bucket isolation between Q1 total and fulltime total
  const q1Key = bucketKeyForContract('ev1', q1PointsTotal);
  const ftPointsKey = bucketKeyForContract('ev1', ftPointsTotal);
  assert.ok(q1Key.includes('::OVER_UNDER::q1::52.5::over+under::points::match'));
  assert.ok(ftPointsKey.includes('::OVER_UNDER::fulltime::215.5::over+under::points::match'));
  assert.notEqual(q1Key, ftPointsKey);

  // TOTAL_GAMES explicit key resolution with period
  const set1GamesTotal = resolveContract({
    key: 'TOTAL_GAMES',
    name: 'Total game-uri - Setul 1',
    period: 'set1',
    line: 9.5,
    selections: [{ name: 'Peste 9.5' }, { name: 'Sub 9.5' }],
  });
  assert.ok(set1GamesTotal);
  assert.equal(set1GamesTotal.family, 'OVER_UNDER');
  assert.equal(set1GamesTotal.subject, 'games');
  assert.equal(set1GamesTotal.period, 'set1');
  assert.equal(set1GamesTotal.lineKey, '9.5');

  const set1Key = bucketKeyForContract('ev1', set1GamesTotal);
  assert.ok(set1Key.includes('::OVER_UNDER::set1::9.5::over+under::games::match'));
});

test('canonicalPeriod maps halftime, 1h, 2h, ht and Romanian Pauza to half1/half2 with bucket isolation', () => {
  assert.equal(canonicalPeriod({ period: 'halftime' }), 'half1');
  assert.equal(canonicalPeriod({ period: 'half_time' }), 'half1');
  assert.equal(canonicalPeriod({ period: '1h' }), 'half1');
  assert.equal(canonicalPeriod({ period: 'ht' }), 'half1');
  assert.equal(canonicalPeriod({ period: '2h' }), 'half2');

  // Romanian Pauză without sau final maps to half1
  assert.equal(canonicalPeriod({ name: 'Rezultat la Pauză' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'Total goluri pauză' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'Cornere la pauza' }), 'half1');

  // Pauză sau Final is NOT half1 (compound market)
  assert.notEqual(canonicalPeriod({ name: 'Pauză sau Final' }), 'half1');
  assert.notEqual(canonicalPeriod({ name: 'Pauza sau final - 1X2' }), 'half1');

  // Contract resolution and bucket isolation for Pauză (half1) vs Fulltime
  const pauza1x2 = resolveContract({
    key: '1X2',
    name: 'Rezultat la Pauză',
    selections: [{ name: '1' }, { name: 'X' }, { name: '2' }],
  });
  assert.ok(pauza1x2);
  assert.equal(pauza1x2.family, 'MATCH_ODDS');
  assert.equal(pauza1x2.period, 'half1');

  const ft1x2 = resolveContract({
    key: '1X2',
    name: 'Rezultat Final',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: 'X' }, { name: '2' }],
  });
  assert.ok(ft1x2);
  assert.equal(ft1x2.period, 'fulltime');

  const pauzaKey = bucketKeyForContract('ev1', pauza1x2);
  const ftKey = bucketKeyForContract('ev1', ft1x2);
  assert.notEqual(pauzaKey, ftKey);
  assert.match(pauzaKey, /::MATCH_ODDS::half1::/);
  assert.match(ftKey, /::MATCH_ODDS::fulltime::/);
});

test('canonicalPeriod maps PR, SR, prima rep, and a doua rep with negative lookaheads and bucket isolation', () => {
  // Explicit period codes
  assert.equal(canonicalPeriod({ period: 'pr' }), 'half1');
  assert.equal(canonicalPeriod({ period: 'sr' }), 'half2');
  assert.equal(canonicalPeriod({ period: 'prima_rep' }), 'half1');
  assert.equal(canonicalPeriod({ period: 'a_doua_rep' }), 'half2');

  // Name patterns
  assert.equal(canonicalPeriod({ name: 'PR 1X2' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'SR 1X2' }), 'half2');
  assert.equal(canonicalPeriod({ name: 'Prima Rep - Total Goluri' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'A doua Rep - Total Goluri' }), 'half2');
  assert.equal(canonicalPeriod({ name: 'Castigator PR' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'Handicap PR' }), 'half1');
  assert.equal(canonicalPeriod({ name: 'Handicap SR' }), 'half2');

  // Compound market negative lookahead
  assert.notEqual(canonicalPeriod({ name: 'PR sau Final' }), 'half1');

  // Resolution and deterministic bucket key isolation
  const prContract = resolveContract({
    key: '1X2',
    name: 'PR 1X2',
    selections: [{ name: '1' }, { name: 'X' }, { name: '2' }],
  });
  const srContract = resolveContract({
    key: '1X2',
    name: 'SR 1X2',
    selections: [{ name: '1' }, { name: 'X' }, { name: '2' }],
  });
  const ftContract = resolveContract({
    key: '1X2',
    name: 'Rezultat Final',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: 'X' }, { name: '2' }],
  });

  assert.ok(prContract);
  assert.ok(srContract);
  assert.ok(ftContract);
  assert.equal(prContract.period, 'half1');
  assert.equal(srContract.period, 'half2');
  assert.equal(ftContract.period, 'fulltime');

  const prBucket = bucketKeyForContract('evTest', prContract);
  const srBucket = bucketKeyForContract('evTest', srContract);
  const ftBucket = bucketKeyForContract('evTest', ftContract);

  assert.equal(prBucket, 'evTest::MATCH_ODDS::half1::_::home+draw+away::_::_');
  assert.equal(srBucket, 'evTest::MATCH_ODDS::half2::_::home+draw+away::_::_');
  assert.equal(ftBucket, 'evTest::MATCH_ODDS::fulltime::_::home+draw+away::_::_');

  assert.notEqual(prBucket, srBucket);
  assert.notEqual(prBucket, ftBucket);
  assert.notEqual(srBucket, ftBucket);
});

