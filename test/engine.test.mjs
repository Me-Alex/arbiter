import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold, buildSignalIndex } from '../src/scanner/engine.mjs';

function makeEvent(sourceId, eventKey, marketKey, selections) {
  return {
    id: `${sourceId}-${eventKey}`,
    sourceId,
    eventKey,
    sport: 'Football',
    league: 'Liga 1',
    kickoff: new Date('2030-01-01').toISOString(),
    homeTeam: 'Home',
    awayTeam: 'Away',
    markets: [{ key: marketKey, name: marketKey, selections }],
  };
}

test('findArbitrage flags a complete cross-book 3-way arb with sufficient ROI', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.10 },
      { name: 'Draw', odds: 4.20 },
      { name: 'Away', odds: 4.60 },
    ]),
    makeEvent('b', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.05 },
      { name: 'Draw', odds: 4.50 },
      { name: 'Away', odds: 5.00 },
    ]),
  ]);
  const opps = findArbitrage(grouped);
  assert.equal(opps.length, 1);
  assert.ok(opps[0].roiPercent > 0);
  assert.equal(opps[0].legs.length, 3);
  // inverse sum < 1
  const inv = opps[0].legs.reduce((acc, l) => acc + 1 / l.odds, 0);
  assert.ok(inv < 1, `expected inv<1, got ${inv}`);
});

test('findArbitrage rejects a complete market when every best leg is from one book', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.50 },
      { name: 'Draw', odds: 1.50 },
      { name: 'Away', odds: 1.50 },
    ]),
    makeEvent('b', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 1.40 },
      { name: 'Draw', odds: 1.40 },
      { name: 'Away', odds: 1.40 },
    ]),
  ]);
  assert.equal(findArbitrage(grouped).length, 0);
});

test('findArbitrage rejects incomplete or unsupported markets', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'PRICE_BOOST', [
      { name: 'Home', odds: 3.2 }, { name: 'Away', odds: 3.2 },
    ]),
    makeEvent('b', 'k1', 'PRICE_BOOST', [
      { name: 'Home', odds: 3.1 }, { name: 'Away', odds: 3.1 },
    ]),
  ]);
  assert.equal(findArbitrage(grouped).length, 0);
});

test('findArbitrage ignores tight markets (no arb)', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 1.90 },
      { name: 'Draw', odds: 3.60 },
      { name: 'Away', odds: 4.50 },
    ]),
  ]);
  const opps = findArbitrage(grouped);
  assert.equal(opps.length, 0);
});

test('findMiddles flags a wide enough handicap gap', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'AH_HOME_-2.5', [
      { name: 'Home -2.5', odds: 1.95, handicap: -2.5 },
    ]),
    makeEvent('b', 'k1', 'AH_HOME_+3.0', [
      { name: 'Home +3.0', odds: 1.91, handicap: 3.0 },
    ]),
  ]);
  const mids = findMiddles(grouped, { maxMiddleRiskPercent: 50, minMiddleRoiPercent: 0 });
  assert.ok(mids.length >= 1, 'expected at least one middle');
});

test('findPositiveEV finds a mispriced leg vs consensus', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.50 }, // implied 0.40
      { name: 'Draw', odds: 3.40 },
      { name: 'Away', odds: 2.80 },
    ]),
    makeEvent('b', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 1.90 }, // implied 0.526 → consensus ~0.46
      { name: 'Draw', odds: 3.50 },
      { name: 'Away', odds: 2.70 },
    ]),
    makeEvent('c', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.00 },
      { name: 'Draw', odds: 3.30 },
      { name: 'Away', odds: 2.90 },
    ]),
  ]);
  const evs = findPositiveEV(grouped, { minRoiPercent: 0 });
  assert.ok(evs.length >= 1);
});

test('findLowHold flags a thin-margin market', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 1.96 },
      { name: 'Away', odds: 2.04 },
    ]),
  ]);
  const lows = findLowHold(grouped, { maxHoldPercent: 4 });
  assert.ok(lows.length === 1);
  assert.ok(lows[0].holdPercent < 4);
});

test('buildSignalIndex maps (event,market,selection) → legs', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 3.0 },
      { name: 'Draw', odds: 4.0 },
      { name: 'Away', odds: 5.0 },
    ]),
    makeEvent('b', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.5 },
      { name: 'Draw', odds: 5.0 },
      { name: 'Away', odds: 6.0 },
    ]),
  ]);
  const arbs = findArbitrage(grouped, { minRoiPercent: 0 });
  const scan = { opportunities: arbs };
  const idx = buildSignalIndex(scan);
  assert.ok(idx.size >= 3);
});
