import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold, buildSelectionIndex } from '../src/scanner/engine.mjs';

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

test('findArbitrage matches provider-specific 1X2 keys when selections are 1/X/2', () => {
  // Each provider emits its own market key for the same 1X2 contract.
  // superbet=547, winner=1, netbet=default, betano=MRES, fortuna=ufo:mtyp:00-00,
  // maxbet=Final. Selections are literally '1'/'X'/'2' with 3 outcomes, so the
  // scanner must treat them as MATCH_ODDS.
  const providerKeys = ['547', '1', 'default', 'MRES', 'ufo:mtyp:00-00', 'Final', '200537', '835'];
  for (const key of providerKeys) {
    const grouped = groupByEvent([
      makeEvent('a', 'k1', key, [
        { name: '1', odds: 2.10 },
        { name: 'X', odds: 4.30 },
        { name: '2', odds: 4.60 },
      ]),
      makeEvent('b', 'k1', key, [
        { name: '1', odds: 2.02 },
        { name: 'X', odds: 4.50 },
        { name: '2', odds: 5.20 },
      ]),
    ]);
    const opps = findArbitrage(grouped);
    assert.equal(opps.length, 1, `expected 1 arb for key ${key}`);
    assert.equal(opps[0].marketKey, key);
    const inv = opps[0].legs.reduce((acc, l) => acc + 1 / l.odds, 0);
    assert.ok(inv < 1, `expected inverse sum < 1 for key ${key}, got ${inv}`);
  }
});

test('findArbitrage still rejects a provider key whose selections are NOT 1/X/2', () => {
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'default', [
      { name: 'Over 2.5', odds: 1.95 }, { name: 'Under 2.5', odds: 1.95 },
    ]),
    makeEvent('b', 'k1', 'default', [
      { name: 'Over 2.5', odds: 1.90 }, { name: 'Under 2.5', odds: 1.90 },
    ]),
  ]);
  assert.equal(findArbitrage(grouped).length, 0);
});

test('findArbitrage does not combine full-time and first-half 1/X/2 markets', () => {
  // Full-time 1X2 (provider key 547) must NOT be arbitraged against a
  // first-half result market that also uses 1/X/2 labels — they settle
  // differently, so the combination is not a valid hedge.
  const base = { eventKey: 'football|l1|2030-01-01T12:00:00Z|home|away', sport: 'Football', league: 'L1', kickoff: '2030-01-01T12:00:00Z', homeTeam: 'Home', awayTeam: 'Away' };
  const ft = { ...base, id: 'a', sourceId: 'a', markets: [{ key: '547', period: 'fulltime', selections: [
    { name: '1', odds: 2.10 }, { name: 'X', odds: 3.00 }, { name: '2', odds: 3.00 },
  ] }] };
  const fh = { ...base, id: 'b', sourceId: 'b', markets: [{ key: 'HALF_RESULT', period: 'firsthalf', selections: [
    { name: '1', odds: 1.80 }, { name: 'X', odds: 4.50 }, { name: '2', odds: 5.20 },
  ] }] };
  assert.equal(findArbitrage(groupByEvent([ft, fh])).length, 0);
});

test('findArbitrage still pairs full-time 1/X/2 across provider keys (period guard)', () => {
  const base = { eventKey: 'football|l1|2030-01-01T12:00:00Z|home|away', sport: 'Football', league: 'L1', kickoff: '2030-01-01T12:00:00Z', homeTeam: 'Home', awayTeam: 'Away' };
  const a = { ...base, id: 'a', sourceId: 'a', markets: [{ key: '547', period: 'fulltime', selections: [
    { name: '1', odds: 2.10 }, { name: 'X', odds: 4.30 }, { name: '2', odds: 4.60 },
  ] }] };
  const b = { ...base, id: 'b', sourceId: 'b', markets: [{ key: '1', period: 'fulltime', selections: [
    { name: '1', odds: 2.02 }, { name: 'X', odds: 4.50 }, { name: '2', odds: 5.20 },
  ] }] };
  const opps = findArbitrage(groupByEvent([a, b]));
  assert.equal(opps.length, 1);
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

test('findMiddles does not pair the two sides of one bookmaker handicap market', () => {
  // Home -1 and Away +1 from the same book are a single market, not a middle.
  // The totals branch already rejected this via sourceId; the handicap branch
  // must agree, otherwise the book's own vig is reported as a middle with a
  // 100% ROI.
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'AH_HOME_-1', [
      { name: 'Home -1', odds: 2.10, handicap: -1 },
    ]),
    makeEvent('a', 'k1', 'AH_HOME_+1', [
      { name: 'Away +1', odds: 1.90, handicap: 1 },
    ]),
  ]);
  assert.equal(findMiddles(grouped, { maxMiddleRiskPercent: 50, minMiddleRoiPercent: 0 }).length, 0);
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
  // The consensus is built from the other books only, so book a's 2.50 Home
  // (implied 0.40) is measured against the ~0.49 median of b and c, and flagged.
  // minEvPercent is the +EV threshold; it is deliberately not minRoiPercent,
  // which stays at 0 for arbitrage.
  const evs = findPositiveEV(grouped, { minEvPercent: 0 });
  assert.ok(evs.length >= 1);
});

test('findPositiveEV does not report a leg that merely matches consensus', () => {
  // Two books quoting identical odds: each leg is exactly at the consensus, so
  // there is no edge. Including the leg under test in its own consensus median
  // used to make every two-book market report evPercent 0 back to the caller.
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.00 },
      { name: 'Draw', odds: 3.40 },
      { name: 'Away', odds: 3.60 },
    ]),
    makeEvent('b', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.00 },
      { name: 'Draw', odds: 3.40 },
      { name: 'Away', odds: 3.60 },
    ]),
  ]);
  // A leg priced exactly at the consensus is not an edge, so it is not
  // reported even at a 0% threshold.
  assert.equal(findPositiveEV(grouped, { minEvPercent: 2 }).length, 0);
  assert.equal(findPositiveEV(grouped, { minEvPercent: 0 }).length, 0);
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

test('findLowHold skips markets with a missing or malformed odds value', () => {
  // 1/undefined is NaN, and NaN fails both threshold comparisons, so the
  // market used to be published with holdPercent: null.
  const grouped = groupByEvent([
    makeEvent('a', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 1.96 },
      { name: 'Away' },
    ]),
  ]);
  assert.equal(findLowHold(grouped, { maxHoldPercent: 4 }).length, 0);
});

test('buildSelectionIndex maps (event,market,selection) → every book that quotes it', () => {
  // This is the index verification re-prices against, so it must carry one
  // entry per source rather than only the legs of a signal that already
  // existed — a second opinion built from the first opinion confirms nothing.
  const events = [
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
  ];
  const idx = buildSelectionIndex(events);
  assert.ok(idx.size >= 3, 'one key per selection per event');

  const homeKey = [...idx.keys()].find((k) => k.endsWith('::home'));
  assert.ok(homeKey, 'the home selection is indexed');
  const sources = idx.get(homeKey).map((c) => c.sourceId).sort();
  assert.deepEqual(sources, ['a', 'b'], 'both books quoting that selection are present');
  assert.equal(idx.get(homeKey).find((c) => c.sourceId === 'b').odds, 2.5);
});
