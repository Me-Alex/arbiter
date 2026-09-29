// Tests for the new contract families in src/scanner/market-contracts.mjs
// Run via: node --test test/market-contracts-families.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContract,
  isDoubleChanceMarket,
  isBttsMarket,
  isAsianHandicapMarket,
  canonicalOutcomeFor,
  bucketKeyForContract,
  isFullTimeMarket,
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

test('guards reject the wrong-shaped family', () => {
  assert.equal(isDoubleChanceMarket({ key: '1x2', selections: [{ name: '1' }, { name: 'X' }, { name: '2' }] }), false);
  assert.equal(isDoubleChanceMarket({ key: 'DOUBLE_CHANCE', selections: [{ name: '1X' }, { name: 'X2' }, { name: '12' }] }), true);
  assert.equal(isBttsMarket({ key: 'btts', selections: [{ name: 'Yes' }, { name: 'No' }] }), true);
  assert.equal(isBttsMarket({ key: 'btts', selections: [{ name: 'Yes' }] }), false, 'BTTS with single outcome is not a 2-way market');
  assert.equal(isAsianHandicapMarket({ key: 'game_handicap', selections: [
    { name: '1 (-1.5)', handicap: -1.5 },
    { name: '2 (+1.5)', handicap: 1.5 },
  ] }), true);
  assert.equal(isAsianHandicapMarket({ key: 'game_handicap', selections: [
    { name: '1 (-1)', handicap: -1 },
    { name: '2 (+1)', handicap: 1 },
  ] }), false, 'whole-line handicaps excluded (push semantics differ)');
});
