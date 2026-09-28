// Cross-book pairing tests for the new contract families (DC, BTTS, O/U, AH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';

function fixture(events) {
  // Mock eventIdentityKey by giving every event a fully normalised pair,
  // so groupByEvent puts them into the same identity group.
  return groupByEvent(events);
}

function ev(sourceId, home, away, period = 'fulltime') {
  return {
    sourceId,
    eventKey: `football|2026-10-12|${sourceId}|${home}|${away}`,
    providerEventId: `${sourceId}-${home}-${away}`,
    kickoff: '2026-10-12T15:00:00.000Z',
    sport: 'Football',
    league: 'Liga 1',
    homeTeam: home,
    awayTeam: away,
    live: false,
    markets: [],
  };
}

test('BTTS: cross-book arb on a 2-way YES/NO contract', () => {
  const a = ev('bookA', 'Poli', 'Craiova');
  a.markets.push({
    key: 'BOTH_TEAMS_SCORE', period: 'fulltime', name: 'Both Teams To Score',
    selections: [{ id: 'a1', name: 'Yes', odds: 1.7 }, { id: 'a2', name: 'No', odds: 2.45 }],
  });
  const b = ev('bookB', 'Poli', 'Craiova');
  b.markets.push({
    key: 'BTTS', period: 'fulltime', name: 'Ambele Marcheaza',
    selections: [{ id: 'b1', name: 'Da', odds: 1.85 }, { id: 'b2', name: 'Nu', odds: 2.3 }],
  });
  // bookA yes@1.70 + bookB no@2.30 => 1/1.70 + 1/2.30 = 0.5882 + 0.4348 = 1.0229 (no arb)
  // bookA yes@1.85 + bookB no@2.45 = 0.5405 + 0.4082 = 0.9487 -> +5.40%
  a.markets[0].selections = [{ id: 'a1', name: 'Yes', odds: 1.85 }, { id: 'a2', name: 'No', odds: 2.45 }];
  const grouped = fixture([a, b]);
  const out = findArbitrage(grouped);
  const btts = out.find((o) => o.family === 'BTTS');
  assert.ok(btts, 'expected a BTTS arb');
  assert.equal(btts.legs.length, 2);
  assert.equal(btts.period, 'fulltime');
  assert.match(btts.marketKey, /BOTH_TEAMS_SCORE|BTTS/);
});

test('DOUBLE_CHANCE: recognized as a family but NOT arb-eligible (overlapping outcomes)', () => {
  // The 1X/12/X2 outcomes overlap: each leg pays on two of the three 1X2
  // results. Backing all three is not a surebet because a single 1X2 winner
  // pays out at exactly two of the three legs simultaneously, not three — so
  // the inverse-sum < 1 test would either miss real arbs or invent ones that
  // can't exist. The engine recognizes DC for cataloging but skips it in
  // findArbitrage. See market-contracts.mjs arbEligible flag.
  const a = ev('bookA', 'Poli', 'Craiova');
  a.markets.push({
    key: 'DOUBLE_CHANCE', period: 'fulltime', name: 'Double Chance',
    selections: [{ id: 'a1', name: '1X', odds: 1.6 }, { id: 'a2', name: '12', odds: 1.3 }, { id: 'a3', name: 'X2', odds: 1.8 }],
  });
  const b = ev('bookB', 'Poli', 'Craiova');
  b.markets.push({
    key: 'DBLC', period: 'fulltime', name: 'Dubla sansa',
    selections: [{ id: 'b1', name: '1X', odds: 1.7 }, { id: 'b2', name: '12', odds: 1.4 }, { id: 'b3', name: 'X2', odds: 1.9 }],
  });
  const grouped = fixture([a, b]);
  const out = findArbitrage(grouped);
  const dc = out.find((o) => o.family === 'DOUBLE_CHANCE');
  assert.equal(dc, undefined, 'DC contracts must not produce arb opportunities');
});

test('OVER_UNDER: lines DO NOT collide across books', () => {
  const a = ev('bookA', 'Poli', 'Craiova');
  a.markets.push({
    key: 'total_goals', period: 'fulltime', name: 'Total goals',
    selections: [{ id: 'a1', name: 'Peste (2.5)', odds: 1.9 }, { id: 'a2', name: 'Sub (2.5)', odds: 2.0 }],
  });
  const b = ev('bookB', 'Poli', 'Craiova');
  b.markets.push({
    key: 'OUH1', period: 'fulltime', name: 'Ou half 1',
    selections: [{ id: 'b1', name: 'Peste 3.5', odds: 1.95 }, { id: 'b2', name: 'Sub 3.5', odds: 1.95 }],
  });
  const grouped = fixture([a, b]);
  const out = findArbitrage(grouped);
  const ou = out.find((o) => o.family === 'OVER_UNDER');
  assert.equal(ou, undefined, 'OVER 2.5 from bookA and OVER 3.5 from bookB must NOT pair — different lines');
});

test('ASIAN_HANDICAP: same line, opposite sides, different books — can produce a cross-book arb', () => {
  // Two books quote the SAME AH -1.5 / +1.5 on the same event but with
  // inverted prices that clear break-even. This is the canonical AH arb.
  const a = ev('bookA', 'Poli', 'Craiova');
  a.markets.push({
    key: 'game_handicap', period: 'fulltime', name: 'Asian handicap',
    selections: [
      { id: 'a1', name: '1 (-1.5)', odds: 1.95, handicap: -1.5 },
      { id: 'a2', name: '2 (+1.5)', odds: 2.10, handicap: 1.5 },
    ],
  });
  const b = ev('bookB', 'Poli', 'Craiova');
  b.markets.push({
    key: 'game_handicap', period: 'fulltime', name: 'Asian handicap',
    selections: [
      { id: 'b1', name: '1 (-1.5)', odds: 2.10, handicap: -1.5 },
      { id: 'b2', name: '2 (+1.5)', odds: 1.95, handicap: 1.5 },
    ],
  });
  const grouped = fixture([a, b]);
  const out = findArbitrage(grouped);
  const ah = out.find((o) => o.family === 'ASIAN_HANDICAP');
  assert.ok(ah, 'expected an AH arb');
  assert.equal(ah.legs.length, 2);
  assert.equal(ah.line, '-1.5/1.5');
});

test('ASIAN_HANDICAP: different lines DO NOT collide', () => {
  const a = ev('bookA', 'Poli', 'Craiova');
  a.markets.push({
    key: 'game_handicap', period: 'fulltime', name: 'AH',
    selections: [
      { id: 'a1', name: '1 (-0.5)', odds: 1.85, handicap: -0.5 },
      { id: 'a2', name: '2 (+0.5)', odds: 2.05, handicap: 0.5 },
    ],
  });
  const b = ev('bookB', 'Poli', 'Craiova');
  b.markets.push({
    key: 'game_handicap', period: 'fulltime', name: 'AH',
    selections: [
      { id: 'b1', name: '1 (-1.5)', odds: 1.95, handicap: -1.5 },
      { id: 'b2', name: '2 (+1.5)', odds: 1.95, handicap: 1.5 },
    ],
  });
  const grouped = fixture([a, b]);
  const out = findArbitrage(grouped);
  const ah = out.find((o) => o.family === 'ASIAN_HANDICAP');
  assert.equal(ah, undefined, 'AH -0.5 and AH -1.5 are different contracts; must not pair');
});
