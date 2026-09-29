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

/**
 * First-half markets are compared with each other, not skipped.
 *
 * The engine used to gate every market on `isFullTimeMarket(m)`, which reads the
 * `period` field the ADAPTER wrote. That field is documented as untrustworthy in
 * `canonicalPeriod`'s own comment, and betano hardcodes `period: 'fulltime'` on
 * everything it emits. So the gate discriminated on the one signal it should not
 * have used: betano's first-half goals totals reached the engine as half1
 * contracts, while unibet's and the everymatrix pair's — same contract line, same
 * events, declared `half1` — were dropped. Measured over the 24 live books,
 * OVER_UNDER::half1::0.5/1.5/2.5 was priced by three independent feeds and
 * reachable from one of them, and market-coverage.mjs reported it as betano-only.
 *
 * `bucketKeyForContract` already carries the corrected period, so the key itself
 * is what keeps a first-half line apart from the full-time line of the same
 * number. These tests pin that isolation rather than the removal: admitting a
 * market is only safe while the two cannot meet.
 */

/** A football event on one contract line, with a declared period and a name. */
function periodEvent(sourceId, eventKey, { period, name, marketKey, selections }) {
  return {
    id: `${sourceId}-${eventKey}`, sourceId, eventKey,
    sport: 'Football', league: 'Liga 1', kickoff: new Date('2030-01-01').toISOString(),
    homeTeam: 'Home', awayTeam: 'Away',
    markets: [{ key: marketKey, name, period, selections }],
  };
}

// The prices are INVERTED, and the best price for each outcome sits on a
// different book, so every pair below is a real arbitrage with one exception:
// the settlement window. 1/1.50 + 1/3.20 = 0.979 < 1.
//
// This matters more than it looks. A first version of these tests used the same
// un-inverted prices on both books, the first-half pair returned nothing, and the
// reason was arithmetic — the tests were measuring "no arbitrage" and reading it
// as "the periods were kept apart". They would have passed just as happily if the
// period had been thrown away entirely. The period is the ONLY variable now.
const OVER_A = { name: 'Peste 0.5', odds: 1.50 };
const UNDER_A = { name: 'Sub 0.5', odds: 2.60 };
const OVER_B = { name: 'Peste 0.5', odds: 1.45 };
const UNDER_B = { name: 'Sub 0.5', odds: 3.20 };

test('two publishers of the same first-half total pair, whatever they declared', () => {
  // The asymmetry this fixes: unibet declares `half1` and betano declares
  // `fulltime` on markets that are both "first half, over/under 0.5". Before the
  // change only betano's reached the engine, so no pair was possible.
  const declared = findArbitrage(groupByEvent([
    periodEvent('unibet', 'k1', { period: 'half1', name: 'Total Goluri - Repriză a 1-a', marketKey: 'TOTAL', selections: [OVER_A, UNDER_A] }),
    periodEvent('betano', 'k1', { period: 'fulltime', name: 'Goluri prima repriză Peste/Sub', marketKey: 'OUH1', selections: [OVER_B, UNDER_B] }),
  ]));
  assert.equal(declared.length, 1, 'the first-half line pairs across both publishers');
  assert.equal(declared[0].period, 'half1', 'and it is bucketed as first-half');
  assert.equal(declared[0].family, 'OVER_UNDER');
  assert.equal(declared[0].line, '0.5');
  // The leg that came from the book which DECLARES `fulltime` is still first-half:
  // the name is what corrected it, and the declared field never decided anything.
  assert.deepEqual(declared[0].legs.map((l) => l.sourceId).sort(), ['betano', 'unibet']);
  assert.ok(declared[0].inverseSum < 1, 'the pair is a real arbitrage, not a counted match');
});

test('a first-half total never pairs with the full-time total of the same line', () => {
  // The invariant the whole change rests on. The prices are inverted and
  // cross-book, so the only thing stopping an arbitrage report is the period:
  // 1/1.50 + 1/3.20 = 0.979, and these two settle on different windows.
  const crossed = findArbitrage(groupByEvent([
    periodEvent('a', 'k1', { period: 'half1', name: 'Total Goluri - Repriză a 1-a', marketKey: 'TOTAL', selections: [OVER_A, UNDER_A] }),
    periodEvent('b', 'k1', { period: 'fulltime', name: 'Total goluri', marketKey: 'TOTAL_GOALS', selections: [OVER_B, UNDER_B] }),
  ]));
  assert.equal(crossed.length, 0, 'a first-half price and a full-time price are not the same contract');

  // And the same holds for the halves against each other.
  const halves = findArbitrage(groupByEvent([
    periodEvent('a', 'k1', { period: 'half1', name: 'Goluri prima repriza', marketKey: 'OUH1', selections: [OVER_A, UNDER_A] }),
    periodEvent('b', 'k1', { period: 'half2', name: 'Goluri a doua repriza', marketKey: 'OUH2', selections: [OVER_B, UNDER_B] }),
  ]));
  assert.equal(halves.length, 0, 'first half and second half are separate contracts');
});

test('a period this engine cannot name is refused, not defaulted to full-time', () => {
  // `canonicalPeriod` used to answer 'fulltime' for a declared period that is
  // explicitly not full-time and that it cannot read, which was harmless only
  // while `isFullTimeMarket` was still gating the engine. With the gate on the
  // contract's own period, that default would have bucketed a first-half market
  // with a full-time one — a false arbitrage. The two tests in
  // engine.test.mjs:108 and verification-regression.test.mjs:124 are the
  // regressions for it; this one names the boundary directly.
  //
  // No live adapter emits `firsthalf` — the declared values across the 24 books
  // are fulltime, unknown, half1, half2 and absent — so a census of the feeds
  // could not have found this. The synthetic spelling is the whole reason this
  // class of bug is testable at all.
  const unnameable = (sourceId, id) => periodEvent(sourceId, 'k1', {
    period: 'firsthalf', name: '', marketKey: 'TOTAL_GOALS',
    selections: sourceId === 'a' ? [OVER_A, UNDER_A] : [OVER_B, UNDER_B],
  });
  // POSITIVE CONTROL, on the same line and the same prices, correctly named:
  // this DOES pair, so the zero below is about the period and nothing else.
  const named = (sourceId) => periodEvent(sourceId, 'k1', {
    period: 'half1', name: 'Goluri prima repriza', marketKey: 'TOTAL_GOALS',
    selections: sourceId === 'a' ? [OVER_A, UNDER_A] : [OVER_B, UNDER_B],
  });
  assert.equal(findArbitrage(groupByEvent([named('a'), named('b')])).length, 1,
    'a nameable first-half line is tradable');
  assert.equal(findArbitrage(groupByEvent([unnameable('a'), unnameable('b')])).length, 0,
    'a period nobody can name must not be traded at all');
});

/**
 * The legacy opaque-key fallback is currently dead, and this is what keeps that
 * a measured fact rather than an assumption.
 *
 * findArbitrage keeps a defensive older path for a market `resolveContract`
 * declines: if `supportedContractForMarket` recognises the key and
 * `isMatchResultMarket` accepts the selection set, the market is treated as a
 * full-time 1X2. That path hardcodes `period: 'fulltime'`, so it is the one
 * place the declared-period gate still has to apply, and removing the gate there
 * breaks no test — which is exactly what a mutation run reported.
 *
 * A mutation that no test can catch is normally a missing test. Here it is a
 * dead branch, and this measures that instead of guessing it: for every key
 * `supportedContractForMarket` can match, with both a three-way and a two-way
 * selection set and every declared period, the branch is never taken, because
 * `resolveContract` has already answered by the time it is considered.
 *
 * If a future contract family is added to `supportedContractForMarket` without
 * being added to `resolveContract`, this fails and names the consequence: the
 * branch goes live, and it is the one place a period cannot be derived.
 */
test('the legacy full-time fallback in findArbitrage is unreachable, and stays that way', async () => {
  const { supportedContractForMarket, isMatchResultMarket } = await import('../src/scanner/market-contracts.mjs');
  const { resolveContract } = await import('../src/scanner/market-contracts.mjs');

  const threeWay = [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.3 }, { name: '2', odds: 3.4 }];
  const twoWay = [{ name: 'Over 2.5', odds: 1.9 }, { name: 'Under 2.5', odds: 1.9 }];
  const keys = ['MATCH_ODDS', '1X2', 'MRES', 'MR12', '547', '1', 'default', 'over_under_2_5', 'OVER_UNDER_1_5', 'over_under_9', 'ufo:mtyp:00-00', 'ufo:mtyp:0c-00', 'handicap', 'game_handicap', 'total_goals'];
  const periods = ['fulltime', 'unknown', 'half1', 'firsthalf', undefined];

  const reachable = [];
  let checked = 0;
  for (const key of keys) {
    if (!supportedContractForMarket(key)) continue;
    for (const selections of [threeWay, twoWay]) {
      for (const period of periods) {
        const market = { key, period, name: 'Meci', selections };
        checked += 1;
        if (!resolveContract(market) && isMatchResultMarket(market)) {
          reachable.push(`key=${key} period=${String(period)} selections=${selections.length}`);
        }
      }
    }
  }
  assert.equal(reachable.length, 0,
    `the legacy branch went live (${reachable.join('; ')}) — it hardcodes period 'fulltime', so the declared-period gate is load-bearing again`);

  // POSITIVE CONTROL: `isMatchResultMarket` must still be able to say yes, or
  // the zero above would only be proving that the predicate is permanently
  // false and would keep passing after the branch had become reachable.
  assert.equal(isMatchResultMarket({ key: '547', period: 'fulltime', name: 'Meci', selections: threeWay }), true,
    'the predicate still accepts a full-time 1/X/2 opaque key');
  assert.ok(checked >= 30, `the sweep actually ran (${checked} combinations)`);
});
