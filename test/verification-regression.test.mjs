import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/scanner/engine.mjs';
import { verifySignal } from '../src/verification.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

// The identity key is built by eventIdentityKey, which is
// `sport|kickoffDate|home|away`. Carrying the same value in `eventKey` is what
// lets groupByEvent pair the two books, so the fixture is built from the real
// identity rather than a hand-written string.
const BASE = { sport: 'Football', kickoff: '1970-01-01T00:00:00Z', homeTeam: 'Home', awayTeam: 'Away' };
const IDENTITY = eventIdentityKey(BASE);

const events = ['a', 'b'].map((sourceId) => ({
  ...BASE,
  sourceId,
  eventKey: IDENTITY,
  markets: [{ key: 'MATCH_ODDS', period: 'fulltime', selections: [{ name: '1', odds: 3.1 }, { name: 'X', odds: 3.1 }, { name: '2', odds: 3.1 }] }],
}));
const target = {
  type: 'arb',
  eventKey: IDENTITY,
  marketKey: 'MATCH_ODDS',
  roiPercent: 3,
  legs: ['1', 'X', '2'].map((selection, i) => ({
    sourceId: i ? 'b' : 'a', selection, odds: 3.1, marketKey: 'MATCH_ODDS', eventKey: IDENTITY,
  })),
};

test('verification indexes available selections even without fresh signals', () => {
  assert.equal(typeof engine.buildSelectionIndex, 'function');
  const index = engine.buildSelectionIndex(events);
  const result = verifySignal(target, { options: { bankroll: 1000 }, opportunities: [] }, { index });
  assert.equal(result.status, 'confirmed');
  assert.ok(result.allocation.guaranteedProfit > 0);
});

test('verification rejects negative ROI inside odds drift tolerance', () => {
  const t = { ...target, roiPercent: 0.1, legs: target.legs.map(l => ({ ...l, odds: 3.003 })) };
  const index = new Map(t.legs.map(l => [`${t.eventKey}::MATCH_ODDS::${l.selection.toLowerCase()}`, [{ ...l, odds: 2.99 }]]));
  assert.equal(verifySignal(t, { options: { bankroll: 1000 } }, { index }).status, 'rejected');
});

test('opaque inferred candidates cannot be confirmed without a supported contract', () => {
  // FEG keys are `ufo:mtyp:<sport>-<marketType>`, and only type `00` ("Meci")
  // settles like a full-time 1X2. Type `04` is "Pauza sau Final" — half-time OR
  // full-time — a different payoff function, so its 1/X/2 selection set must
  // never be bucketed as MATCH_ODDS.
  for (const key of ['ufo:mtyp:00-04', 'ufo:mtyp:00-01', 'ufo:mtyp:00-0u', 'ufo:mtyp:00-1c']) {
    const input = events.map(e => ({
      ...e,
      markets: e.markets.map(m => ({ ...m, key, period: 'fulltime' })),
    }));
    assert.equal(
      engine.findArbitrage(engine.groupByEvent(input)).length, 0,
      `${key} is not a full-time 1X2 contract and must not produce a candidate`,
    );
  }
  // And nothing for them can reach verification either.
  const idx = engine.buildSelectionIndex(events.map(e => ({
    ...e,
    markets: e.markets.map(m => ({ ...m, key: 'ufo:mtyp:00-04' })),
  })));
  assert.equal(idx.size, 0, 'a half-time-or-full-time market is not indexed as a 1X2 contract');
});

test('the FEG match-result key is accepted as a full-time 1X2 contract', () => {
  // `ufo:mtyp:00-00` is "Meci": the full-time result market. It must reach the
  // candidate list, which it could not before the market-type field was read
  // from the right position in the key.
  const input = events.map(e => ({
    ...e,
    markets: e.markets.map(m => ({ ...m, key: 'ufo:mtyp:00-00', period: 'unknown' })),
  }));
  const [candidate] = engine.findArbitrage(engine.groupByEvent(input));
  assert.ok(candidate, 'a full-time FEG match-result market is arbitraged');
  assert.equal(candidate.marketKey, 'ufo:mtyp:00-00');
});

test('a market period of "unknown" is treated as full-time', () => {
  // The FEG family publishes period: 'unknown' on every market. A non-empty
  // string used to be read as a real settlement period, which silently
  // dropped all of them.
  const full = engine.findArbitrage(engine.groupByEvent(events)).length;
  const unknown = engine.findArbitrage(engine.groupByEvent(
    events.map(e => ({ ...e, markets: e.markets.map(m => ({ ...m, period: 'unknown' })) })),
  )).length;
  assert.equal(unknown, full);
});

test('verification rejects ambiguous duplicate selections', () => {
  const index = engine.buildSelectionIndex([...events, events[0]]);
  assert.equal(verifySignal(target, {}, { index }).status, 'rejected');
});

test('verification rejects a changed selection line', () => {
  const index = engine.buildSelectionIndex(events.map(e => ({ ...e, markets: e.markets.map(m => ({ ...m, selections: m.selections.map(s => ({ ...s, handicap: 1 })) })) })));
  assert.equal(verifySignal(target, {}, { index }).status, 'rejected');
});

test('canonical result markets with first-half period are not full-time contracts', () => {
  const input = events.map(e => ({ ...e, markets: e.markets.map(m => ({ ...m, period: 'firsthalf' })) }));
  assert.equal(engine.findArbitrage(engine.groupByEvent(input)).length, 0);
});
