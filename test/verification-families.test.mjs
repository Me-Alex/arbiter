// Family-aware verification tests. The existing verification suite only
// covers MATCH_ODDS; BTTS / OVER_UNDER / ASIAN_HANDICAP opportunities used to
// fall through to "incomplete or unsupported contract" and be silently rejected.
// These tests pin that they survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignal } from '../src/verification.mjs';

function makeOpportunity({ marketKey, family, period = 'fulltime', line = null, legs, subject = null, team = null, marginPercent = null }) {
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
      // Published by findArbitrage, and read by the settlement comparison:
      // `subject` decides whether a cards key contradicts a goals target,
      // `team` is the scope the legs are supposed to be priced in.
      ...(subject ? { subject } : {}),
      ...(team ? { team } : {}),
      ...(marginPercent === null ? {} : { marginPercent }),
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
    // Candidates accumulate per key, as the real index does: two books quoting the
    // same selection of the same market are two candidates, not a replacement.
    // Overwriting here silently dropped one book, which made a duplicate-selection
    // pair look like a re-scrape coverage gap instead of the contract it is.
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ sourceId: leg.sourceId, odds: leg.odds, handicap: leg.handicap ?? null,
      kickoff: leg.kickoff || '2026-10-12T15:00:00.000Z',
      providerEventId: leg.providerEventId || `pid-${leg.sourceId}`,
      marketId: leg.marketId || `mid-${leg.sourceId}`,
      selectionId: leg.selectionId || `sid-${leg.sourceId}`,
      // The scope the re-quoted price belongs to, as buildSelectionIndex now
      // records it. Absent means "this candidate names no scope".
      team: leg.team ?? null });
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

test('verifySignal confirms a synthetic instead of rejecting its family outright', () => {
  // Every SYNTHETIC_EQUIVALENCE opportunity used to come back `rejected` with
  // "settlement equivalence not established": the family had no outcome model,
  // so the first rejection branch fired before anything about the opportunity
  // was examined. Measured on the 2026-10-20 board, a synthetic whose legs
  // resolved to nothing carried the same verdict as the published one, so the
  // status distinguished nothing. 1/1.88 + 1/2.25 = 0.9763 → 2.36% ROI.
  const legs = [
    { sourceId: 'betano', marketKey: 'FAHC', selection: 'CS Dinamo București +0.5', odds: 1.88, handicap: 0.5, outcome: 'home_or_draw', eventKey: 'event1' },
    { sourceId: 'unibet', marketKey: 'MATCH_ODDS', selection: '2', odds: 2.25, outcome: 'away', eventKey: 'event1' },
  ];
  const target = {
    type: 'arb',
    family: 'SYNTHETIC_EQUIVALENCE',
    period: 'fulltime',
    line: '1X_VS_AWAY',
    marketKey: 'SYNTHETIC_1X_VS_AWAY',
    synthetic: true,
    syntheticType: '1X_VS_AWAY',
    eventKey: 'event1',
    homeTeam: 'CS Dinamo București',
    awayTeam: 'Skanderborg Aarhus',
    roiPercent: 1,
    totalStake: 1000,
    legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
});

test('verifySignal rejects a synthetic leg that claims a half the model has no source for', () => {
  // A totals leg can never be half of a draw/win equivalence. This is what the
  // family comparison used to be doing by accident, now done on purpose.
  const legs = [
    { sourceId: 'bookA', marketKey: 'TOTAL_GOALS', selection: 'Peste 2.5', odds: 1.90, outcome: 'over', eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'MATCH_ODDS', selection: '2', odds: 2.20, outcome: 'away', eventKey: 'event1' },
  ];
  const target = {
    type: 'arb',
    family: 'SYNTHETIC_EQUIVALENCE',
    period: 'fulltime',
    line: '1X_VS_AWAY',
    marketKey: 'SYNTHETIC_1X_VS_AWAY',
    synthetic: true,
    syntheticType: '1X_VS_AWAY',
    eventKey: 'event1',
    homeTeam: 'Poli',
    awayTeam: 'Craiova',
    roiPercent: 1,
    totalStake: 1000,
    legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'unsupported contract: settlement equivalence not established');
});

test('verifySignal rejects a synthetic whose legs do not cover the type pair', () => {
  // Both legs are home moneylines that each pay the half they claim, so the
  // leg-fit guard passes both and the pair still fails to cover X2 + home.
  const legs = [
    { sourceId: 'bookA', marketKey: 'MATCH_ODDS', selection: '1', odds: 2.10, outcome: 'home', eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'MATCH_ODDS', selection: '1', odds: 2.10, outcome: 'home', eventKey: 'event1' },
  ];
  const target = {
    type: 'arb',
    family: 'SYNTHETIC_EQUIVALENCE',
    period: 'fulltime',
    line: 'X2_VS_HOME',
    marketKey: 'SYNTHETIC_X2_VS_HOME',
    synthetic: true,
    syntheticType: 'X2_VS_HOME',
    eventKey: 'event1',
    homeTeam: 'Poli',
    awayTeam: 'Craiova',
    roiPercent: 1,
    totalStake: 1000,
    legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /incomplete or unsupported contract/);
});

test('verifySignal rejects a synthetic leg whose claimed half it does not pay', () => {
  // The published 2026-10-20 fabrication, in the shape it was recorded: betano
  // FAHC "Skanderborg Aarhus -0.5" claimed as draw_or_away next to a home
  // moneyline. That leg pays only on an away win, so a draw loses it, and the
  // home moneyline loses it too: a draw lost BOTH legs while the row advertised
  // a guaranteed +69.74. The family alone cannot catch this - a handicap market
  // can legitimately pay draw_or_away - so the check is whether the leg covers
  // the half it claims. Side comes from the team name, start from the line.
  const legs = [
    { sourceId: 'betano', marketKey: 'FAHC', selection: 'Skanderborg Aarhus -0.5', odds: 1.93, handicap: -0.5, outcome: 'draw_or_away', eventKey: 'event1' },
    { sourceId: 'unibet', marketKey: 'MATCH_ODDS', selection: '1', odds: 2.40, outcome: 'home', eventKey: 'event1' },
  ];
  const target = {
    type: 'arb',
    family: 'SYNTHETIC_EQUIVALENCE',
    period: 'fulltime',
    line: 'X2_VS_HOME',
    marketKey: 'SYNTHETIC_X2_VS_HOME',
    synthetic: true,
    syntheticType: 'X2_VS_HOME',
    eventKey: 'event1',
    homeTeam: 'Dinamo',
    awayTeam: 'Skanderborg Aarhus',
    roiPercent: 6.52,
    totalStake: 1000,
    legs,
  };
  const v = verifySignal(target, { options: { minRoiPercent: 0 } }, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'unsupported contract: settlement equivalence not established');
});

test('verifySignal confirms an OVER_UNDER opportunity now that the family has its own outcomes', () => {
  // 1/2.06 + 1/4.9 = 0.4854 + 0.2041 = 0.6895 -> 31.05% margin. This is the real
  // NUMBERS off the 2026-10-22 board, used here as a legitimate pair on purpose:
  // the defect these tests pin is not "totals always rejected", it is that a
  // totals target expected [home, away] while canonicalOutcomeFor produces
  // [over, under], so no totals opportunity could ever be confirmed. Before the
  // fix this assertion failed with "incomplete or unsupported contract".
  const legs = [
    { sourceId: 'bookA', marketKey: 'OVER_UNDER_1_5', selection: 'Peste 1.5', odds: 2.06, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'OVER_UNDER_1_5', selection: 'Sub 1.5', odds: 4.9, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'OVER_UNDER_1_5', family: 'OVER_UNDER', line: '1.5', subject: 'goals', legs, marginPercent: 31.05 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
  assert.equal(v.legs.length, 2);
});

test('a cards total is not a goals total, even though both are OVER_UNDER', () => {
  // Same family, same line, different subject: the key spells CARDS and the
  // target says goals. Comparing families alone would call this equivalent.
  const legs = [
    { sourceId: 'bookA', marketKey: 'CARDS_OVER_UNDER_4_5', selection: 'Peste 4.5', odds: 2.10, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'CARDS_OVER_UNDER_4_5', selection: 'Sub 4.5', odds: 2.10, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'CARDS_OVER_UNDER_4_5', family: 'OVER_UNDER', line: '4.5', subject: 'goals', legs, marginPercent: 4 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'unsupported contract: settlement equivalence not established');
});

test('a corners total on the right line is NOT foreign to a corners target', () => {
  // The control for the test above: the subject comparison must not swallow the
  // case it exists for. CNOU is opaque on purpose - it is what betano publishes
  // for a corners total, and an unrecognised key is not evidence of anything.
  const legs = [
    { sourceId: 'bookA', marketKey: 'CORNERS_OVER_UNDER_9_5', selection: 'Peste 9.5', odds: 2.05, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'CNOU', selection: 'Sub 9.5', odds: 2.05, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'CORNERS_OVER_UNDER_9_5', family: 'OVER_UNDER', line: '9.5', subject: 'corners', legs, marginPercent: 2 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
});

test('a 2.5 line does not settle the 1.5 the target was priced on', () => {
  const legs = [
    { sourceId: 'bookA', marketKey: 'OVER_UNDER_2_5', selection: 'Peste 2.5', odds: 2.06, eventKey: 'event1' },
    { sourceId: 'bookB', marketKey: 'OVER_UNDER_1_5', selection: 'Sub 1.5', odds: 4.9, eventKey: 'event1' },
  ];
  const opp = makeOpportunity({ marketKey: 'OVER_UNDER_1_5', family: 'OVER_UNDER', line: '1.5', subject: 'goals', legs, marginPercent: 20 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'unsupported contract: settlement equivalence not established');
});

test('a leg re-quoted from a one-team total cannot confirm a match total', () => {
  // The 2026-10-22 fabrication, at the verification layer. The target is a MATCH
  // totals contract (no team field, which is how findArbitrage publishes the
  // match scope); the re-scrape says the price it re-quoted belongs to the AWAY
  // team's total. One team's goal count and the match's are different numbers on
  // the same line, so this pair settles against a total the target never claimed.
  const legs = [
    { sourceId: 'favbet', marketKey: 'OVER_UNDER_1_5', selection: 'Over', odds: 2.06, handicap: 1.5, eventKey: 'event1', team: 'away' },
    { sourceId: 'excelbet', marketKey: 'TOTAL_GOALS', selection: 'Under 1.5', odds: 4.9, eventKey: 'event1', team: 'match' },
  ];
  const opp = makeOpportunity({ marketKey: 'TOTAL_GOALS', family: 'OVER_UNDER', line: '1.5', subject: 'goals', legs, marginPercent: 31.05 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'rejected');
  assert.equal(v.reason, 'favbet leg re-quoted from away-scope, not match-scope');
});

test('a one-team total target confirms when every leg re-quotes in that same scope', () => {
  // The control for the scope check: it must reject a CROSS-scope pair without
  // rejecting a team total that genuinely is one.
  const legs = [
    { sourceId: 'bookA', marketKey: 'OVER_UNDER_1_5', selection: 'Over', odds: 2.06, handicap: 1.5, eventKey: 'event1', team: 'away' },
    { sourceId: 'bookB', marketKey: 'OVER_UNDER_1_5', selection: 'Under', odds: 2.06, handicap: 1.5, eventKey: 'event1', team: 'away' },
  ];
  const opp = makeOpportunity({ marketKey: 'OVER_UNDER_1_5', family: 'OVER_UNDER', line: '1.5', subject: 'goals', team: 'away', legs, marginPercent: 2 });
  const v = verifySignal(opp.target, opp.confirmationScan, { index: makeIndex(legs) });
  assert.equal(v.status, 'confirmed', v.reason);
});

test('verifySignal confirms a 3-way 1X2_AH05 synthetic and rejects an AH -1.5 masquerading as home win', () => {
  const validLegs = [
    { sourceId: 'betano', marketKey: 'ASIAN_HANDICAP', selection: 'Poli -0.5', odds: 2.35, handicap: -0.5, outcome: 'home', eventKey: 'event1' },
    { sourceId: 'unibet', marketKey: 'MATCH_ODDS', selection: 'X', odds: 3.70, outcome: 'draw', eventKey: 'event1' },
    { sourceId: 'favbet', marketKey: 'MATCH_ODDS', selection: '2', odds: 3.60, outcome: 'away', eventKey: 'event1' },
  ];
  const target = {
    type: 'arb',
    family: 'SYNTHETIC_EQUIVALENCE',
    period: 'fulltime',
    line: '1X2_AH05',
    marketKey: 'SYNTHETIC_1X2_AH05',
    synthetic: true,
    syntheticType: '1X2_AH05',
    eventKey: 'event1',
    homeTeam: 'Poli',
    awayTeam: 'Craiova',
    marginPercent: 2.6,
    totalStake: 1000,
    legs: validLegs,
  };
  const v = verifySignal(target, { options: { minMarginPercent: 0 } }, { index: makeIndex(validLegs) });
  assert.equal(v.status, 'confirmed', v.reason);
  assert.equal(v.legs.length, 3);

  const invalidLegs = [
    { sourceId: 'betano', marketKey: 'ASIAN_HANDICAP', selection: 'Poli -1.5', odds: 3.40, handicap: -1.5, outcome: 'home', eventKey: 'event1' },
    { sourceId: 'unibet', marketKey: 'MATCH_ODDS', selection: 'X', odds: 3.70, outcome: 'draw', eventKey: 'event1' },
    { sourceId: 'favbet', marketKey: 'MATCH_ODDS', selection: '2', odds: 3.60, outcome: 'away', eventKey: 'event1' },
  ];
  const vInvalid = verifySignal({ ...target, legs: invalidLegs }, { options: { minMarginPercent: 0 } }, { index: makeIndex(invalidLegs) });
  assert.equal(vInvalid.status, 'rejected');
  assert.equal(vInvalid.reason, 'unsupported contract: settlement equivalence not established');
});
