// Tests for the full-surface market coverage (the second-pass extension).
// Each test maps a real book/publisher shape (taken from data/workspace) to a
// non-null contract. These are *regression* tests: if a future change breaks
// any, that book/publisher loses a slice of the reachable surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContract, classifyAndExtractLine, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

function ev(key, selections) {
  return { key, period: 'fulltime', name: '', selections };
}

test('netbet game_handicap with line in name → ASIAN_HANDICAP', () => {
  const c = resolveContract(ev('game_handicap', [
    { name: '1 (-7.5)' }, { name: '2 (7.5)' },
  ]));
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '-7.5/7.5');
});

test('netbet handicap with player prefix → ASIAN_HANDICAP', () => {
  const c = resolveContract(ev('handicap', [
    { name: 'Zsombor Piros -4.5' }, { name: 'Benjamin Hassan +4.5' },
  ]));
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '-4.5/4.5');
});

test('netbet total_games with line in name → OVER_UNDER', () => {
  const c = resolveContract(ev('total_games', [
    { name: 'Peste (17.5)' }, { name: 'Sub (17.5)' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '17.5');
});

test('netbet total_points with line in name → OVER_UNDER', () => {
  const c = resolveContract(ev('total_points', [
    { name: 'Peste (171.5)' }, { name: 'Sub (171.5)' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '171.5');
});

test('betano FHOT (signed +/- X.X) → ASIAN_HANDICAP', () => {
  const c = resolveContract(ev('FHOT', [
    { name: '+10.5' }, { name: '-10.5' },
  ]));
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '10.5/-10.5');
});

test('betano FTGO (Peste X.X / Sub X.X) → OVER_UNDER', () => {
  const c = resolveContract(ev('FTGO', [
    { name: 'Peste 22.5' }, { name: 'Sub 22.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '22.5');
});

test('betano TGOT (P X.X / S X.X) → OVER_UNDER', () => {
  const c = resolveContract(ev('TGOT', [
    { name: 'P 5.5' }, { name: 'S 5.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '5.5');
});

test('FEG ufo:mtyp:02-06 (CS total rounds +/-) → OVER_UNDER', () => {
  const c = resolveContract(ev('ufo:mtyp:02-06', [
    { name: '+ 21.5' }, { name: '- 21.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '21.5');
});

test('FEG ufo:mtyp:14-02 (MMA total rounds) → OVER_UNDER', () => {
  const c = resolveContract(ev('ufo:mtyp:14-02', [
    { name: '+ 9.5' }, { name: '- 9.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
});

test('FEG ufo:mtyp:04-01 (Dota 2 team-vs-team) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('ufo:mtyp:04-01', [
    { name: 'BB Team' }, { name: 'OG' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('superbet 919 (1|2 cricket) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('919', [
    { name: '1' }, { name: '2' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('betano H2HT (tennis player names) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('H2HT', [
    { name: 'ENCE' }, { name: 'Aimhaus' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
  // With ctx provided, ENCE matches homeTeam → 'home'
  assert.equal(canonicalOutcomeFor('ENCE', c, { homeTeam: 'ENCE', awayTeam: 'Aimhaus' }), 'home');
  assert.equal(canonicalOutcomeFor('Aimhaus', c, { homeTeam: 'ENCE', awayTeam: 'Aimhaus' }), 'away');
});

test('betano DNOB (draw no bet) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('DNOB', [
    { name: 'Belgia' }, { name: 'Franța' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('betano BTSC (BTTS yes/no in Romanian) → BTTS', () => {
  const c = resolveContract(ev('BTSC', [
    { name: 'Da (GG)' }, { name: 'Nu (NG)' },
  ]));
  assert.equal(c.family, 'BTTS');
  assert.deepEqual(c.outcomes, ['yes', 'no']);
});

test('betano 4191 (winner) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('4191', [
    { name: 'Chicago Bears' }, { name: 'Philadelphia Eagles' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('generic fallback: any 2 clean non-totals names → MATCH_ODDS 2-way', () => {
  // Anything not literals peste/sub/over/under/handicap with two distinct non-
  // empty names resolves as a 2-way match winner.
  const c = resolveContract(ev('XYZZY', [
    { name: 'Falcons' }, { name: 'Eagles' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('generic fallback: 2 distinct names that look like totals → still OVER_UNDER', () => {
  // If the names contain peste/sub, the resolver prefers the O/U family even
  // on a non-whitelisted key.
  const c = resolveContract(ev('XYZZY', [
    { name: 'Peste 1.5' }, { name: 'Sub 1.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
});

test('classifyAndExtractLine: half-line AH half rejected (whole line)', () => {
  const result = classifyAndExtractLine(
    [{ name: '1 (-1)' }, { name: '2 (+1)' }],
    { kind: 'AH' },
  );
  assert.equal(result, null, 'whole-line AH is excluded (push semantics differ)');
});

test('classifyAndExtractLine: half-line AH half accepted', () => {
  const result = classifyAndExtractLine(
    [{ name: '1 (-1.5)' }, { name: '2 (+1.5)' }],
    { kind: 'AH' },
  );
  assert.ok(result);
  assert.equal(result.family, 'ASIAN_HANDICAP');
  assert.equal(result.lineKey, '-1.5/1.5');
});

test('classifyAndExtractLine: OU signed +/- converts to a single magnitude', () => {
  const result = classifyAndExtractLine(
    [{ name: '+ 17.5' }, { name: '- 17.5' }],
    { kind: 'OU' },
  );
  assert.equal(result.family, 'OVER_UNDER');
  assert.equal(result.lineKey, '17.5');
});

test('FEG American Football DC (ufo:mtyp:0c-01) → DOUBLE_CHANCE on any sport', () => {
  // FEG encodes DC per sport (00 football, 11 handball, 0c American football,
  // ...). All variants share the {1X/12/X2} selection shape. Spot-check that
  // the resolver accepts any sportId when the shape matches.
  const c = resolveContract({
    key: 'ufo:mtyp:0c-01',
    period: 'unknown',
    selections: [{ name: '1X' }, { name: '12' }, { name: 'X2' }],
  });
  assert.equal(c.family, 'DOUBLE_CHANCE');
  assert.equal(c.arbEligible, false);
});

test('FEG degraded DC: 2 of 3 outcomes is catalogued but flagged', () => {
  // FEG feeds sometimes publish a DC market with only 2 of 3 outcomes
  // (e.g. X2 missing). The engine cannot arb this — backing 2 double-chances
  // is not a surebet — but the contract is recognised so the catalogue sees
  // it.
  const c = resolveContract({
    key: 'ufo:mtyp:11-0t',
    period: 'unknown',
    selections: [{ name: '1X' }, { name: '12' }],
  });
  assert.equal(c.family, 'DOUBLE_CHANCE');
  assert.equal(c.degraded, true);
  assert.equal(c.arbEligible, false);
});

test('current_frame_winner (snooker frame 2-way) → MATCH_ODDS 2-way', () => {
  // Defensive — explicit shape acceptance for snooker frame winner. The literal
  // "1" / "2" labels make this a clean 2-way match winner regardless of key.
  const c = resolveContract({
    key: 'current_frame_winner',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: '2' }],
  });
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});
