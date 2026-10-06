// Family-aware verification tests. The existing verification suite only
// covers MATCH_ODDS; BTTS / OVER_UNDER / ASIAN_HANDICAP opportunities used to
// fall through to "incomplete or unsupported contract" and be silently rejected.
// These tests pin that they survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignal } from '../src/verification.mjs';

function makeOpportunity({ marketKey, family, period = 'fulltime', line = null, legs }) {
  // The matched-legs map mirrors what the engine already feeds verification: a
  // path keyed by `${eventKey}::${marketKey}::${selection.toLowerCase()}`.
  // Each value is an array of { sourceId, odds, handicap, kickoff, providerEventId, marketId, selectionId }.
  return {
    target: {
      type: 'arb',
      family,
      period,
      line,
      marketKey,
      eventKey: 'event1',
      homeTeam: 'Poli',
      awayTeam: 'Craiova',
      roiPercent: 5,
      totalStake: 1000,
      legs,
    },
    index: new Map(),
    confirmationScan: { options: { minRoiPercent: 0 } },
  };
}

function makeIndex(legs) {
  const idx = new Map();
  for (const leg of legs) {
    // The scope is part of the key, exactly as `buildSelectionIndex` writes it.
    const k = `${leg.eventKey || 'event1'}::${leg.marketKey}::${leg.live === true ? 'live' : 'prematch'}::${String(leg.selection).toLowerCase()}`;
    idx.set(k, [{ sourceId: leg.sourceId, odds: leg.odds, handicap: leg.handicap ?? null,
      kickoff: leg.kickoff || '2026-10-12T15:00:00.000Z',
      providerEventId: leg.providerEventId || `pid-${leg.sourceId}`,
      marketId: leg.marketId || `mid-${leg.sourceId}`,
      selectionId: leg.selectionId || `sid-${leg.sourceId}` }]);
  }
  return idx;
}

test('verifySignal confirms a BTTS opportunity when both legs re-quote within 2%', () => {
  const legs = [
    { sourceId: 'bookA', marketKey: 'BOTH_TEAMS_SCORE', selection: 'Yes', odds: 1.85, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'BTTS',           selection: 'Nu',  odds: 2.40, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'BOTH_TEAMS_SCORE', family: 'BTTS', legs });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
  assert.equal(v.legs.length, 2);
});

test('verifySignal confirms an ASIAN_HANDICAP opportunity at -1.5/+1.5', () => {
  // 1/2.05 + 1/2.05 = 0.4878 + 0.4878 = 0.9756 → 2.50% ROI. Pre-target 1% so the
  // "drop not below original - 1%" floor leaves room for the re-price.
  const legs = [
    { sourceId: 'bookA', marketKey: 'game_handicap', selection: '1 (-1.5)', odds: 2.05, handicap: -1.5, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'game_handicap', selection: '2 (+1.5)', odds: 2.05, handicap: 1.5,  eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'game_handicap', family: 'ASIAN_HANDICAP', legs });
  opp.target.roiPercent = 1; // keep the drop floor at 0
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
});

test('verifySignal rejects a BTTS opportunity when one leg drifted past 2%', () => {
  const legs = [
    { sourceId: 'bookA', marketKey: 'BOTH_TEAMS_SCORE', selection: 'Yes', odds: 1.85, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'BTTS',           selection: 'Nu',  odds: 2.40, eventKey: 'event1' },
  ];
  const drifted = { ...legs[1], odds: 2.10 }; // ~12% drift on the away leg
  const index = makeIndex(legs.map((l) => (l === legs[1] ? drifted : l)));
  const opp = makeOpportunity({ marketKey: 'BOTH_TEAMS_SCORE', family: 'BTTS', legs });
  const v = verifySignal(opp.target, opp.confirmationScan, { index });
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /odds drift/);
});

test('verifySignal rejects a DOUBLE_CHANCE opportunity outright (overlapping outcomes)', () => {
  const legs = [
    { sourceId: 'bookA', marketKey: 'DOUBLE_CHANCE', selection: '1X', odds: 1.7, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'DBLC',          selection: 'X2', odds: 1.9, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'DOUBLE_CHANCE', family: 'DOUBLE_CHANCE', legs });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /unsupported contract/);
});

test('verifySignal still works on legacy opportunities that lack family/period/line', () => {
  // No family/period/line fields — pre-extension scan payloads. The resolver
  // must fall back to marketKey + selection shape and confirm a genuine arb.
  // 1/2.30 + 1/3.50 + 1/4.50 = 0.435 + 0.286 + 0.222 = 0.943 → 6.0% ROI.
  const legs = [
    { sourceId: 'bookA', marketKey: 'MATCH_ODDS', selection: '1', odds: 2.30, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'MATCH_ODDS', selection: 'X', odds: 3.50, eventKey: 'event1' },
    { sourceId: 'bookC', marketKey: 'MATCH_ODDS', selection: '2', odds: 4.50, eventKey: 'event1' },
  ];
  const target = {
    type: 'arb', marketKey: 'MATCH_ODDS', eventKey: 'event1',
    homeTeam: 'Poli', awayTeam: 'Craiova',
    roiPercent: 5, totalStake: 1000, legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
});

test('verifySignal re-allocates at the committed stake, not the full bankroll', () => {
  // The scan published totalStake: 100 (a capped scan), while the default
  // budget is 1000. Re-allocation must stay inside the committed stake:
  // verification may not silently re-stake at the full bankroll.
  const legs = [
    { sourceId: 'bookA', marketKey: 'MATCH_ODDS', selection: '1', odds: 2.30, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'MATCH_ODDS', selection: 'X', odds: 3.50, eventKey: 'event1' },
    { sourceId: 'bookC', marketKey: 'MATCH_ODDS', selection: '2', odds: 4.50, eventKey: 'event1' },
  ];
  const target = {
    type: 'arb', marketKey: 'MATCH_ODDS', eventKey: 'event1',
    homeTeam: 'Poli', awayTeam: 'Craiova',
    roiPercent: 5, totalStake: 100, legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
  assert.equal(v.allocation.totalStake, 100);
});
