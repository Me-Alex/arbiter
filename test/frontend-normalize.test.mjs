/**
 * frontend-normalize.test.mjs — the rules that decide what a row is allowed to
 * claim.
 *
 * The React shell spends a lot of its job deciding what the trader is allowed
 * to believe: whether a figure is an expected edge or a claim nobody can
 * reconcile, whether two legs are the same market, whether a surebet is
 * guaranteed when the backend refused its contract. Those decisions live in
 * `frontend/src/api.ts`, and until now nothing tested them — the backend suite
 * is thorough and the shell was not covered at all.
 *
 * Node strips TypeScript types natively, so this imports the real module the
 * browser runs, with no bundler and no new dependency. `api.ts` has no runtime
 * imports, which is the only reason it is reachable from here; `App.tsx` and
 * `worker.ts` are not (one needs React, the other needs `self`).
 *
 * The tests below are about claims, not formatting. A label that stops being
 * earned is a defect the type checker will never report, because every one of
 * these strings typechecks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScan, normalizeLowHold, normalizeSport, formatBookmakerName, bookActivity } from '../frontend/src/api.ts';
import { alertable, profitLabel, rankOpportunities, slipSummary, surebetCounts, titleClaim, verifiedFigures } from '../frontend/src/claims.ts';

const EVENT = 'football|2026-10-17T11:30:00.000Z|home|away';

/** A surebet's raw shape, as `scan.opportunities` publishes one. */
function surebet(overrides = {}) {
  return {
    type: 'arb',
    // A confirmed contract is what the backend publishes for a surebet it has
    // checked, and most fixtures below describe one. No verification at all is
    // a different state -- `unverified` -- so a fixture that wants it passes
    // `verification: undefined`. Defaulting to silence is what let the shell
    // read we never asked as we asked and it held.
    verification: { status: 'confirmed', reason: 'all legs re-priced within tolerance' },
    family: 'OVER_UNDER',
    period: 'fulltime',
    line: '2.5',
    marketKey: 'OVER_UNDER_2_5',
    eventKey: EVENT,
    sport: 'Football',
    homeTeam: 'Home',
    awayTeam: 'Away',
    marginPercent: 4,
    legs: [
      { sourceId: 'favbet', selection: 'Over', odds: 2.1 },
      { sourceId: 'betano', selection: 'Sub 2.5', odds: 2.02 },
    ],
    ...overrides,
  };
}

/** A +EV row. `odds` and `consensusProbability` are the two prices multiplied. */
function positiveEv(overrides = {}) {
  return {
    type: 'positive_ev',
    marketKey: '1x2',
    eventKey: EVENT,
    sport: 'Football',
    selection: '1',
    odds: 2.7143,
    consensusProbability: 0.3774,
    evPercent: 2.43,
    legs: [{ sourceId: '5gringos', selection: '1', odds: 2.7143 }],
    ...overrides,
  };
}

const only = (scan) => normalizeScan(scan);

test('the controls: the fixtures produce rows, so an empty tree cannot pass below', () => {
  // The failures this file exists to prevent are silent ones — a rule that
  // matches nothing reports nothing. These four shapes have to survive
  // normalization before any assertion about them means anything.
  assert.equal(only({ opportunities: [surebet()] }).length, 1);
  assert.equal(only({ positiveEv: [positiveEv()] }).length, 1);
  assert.equal(only({ middles: [surebet({ type: 'middle' })] }).length, 1);
  assert.equal(only({ opportunities: [surebet()], positiveEv: [positiveEv()] }).length, 2);
});

test('a leg with no line of its own inherits the market it belongs to', () => {
  const [row] = only({ opportunities: [surebet()] });
  // Favbet publishes `Over` and carries the line only on the parent market, so
  // it used to render as a bare `Total Goals` beside a Betano leg reading
  // `Total Goals 2.5` — two legs of one bet naming different markets, which is
  // the same mismatch the blocked-contract tag warns about.
  assert.deepEqual(row.legs.map((leg) => leg.marketName), ['Total Goals 2.5', 'Total Goals 2.5']);
  assert.equal(row.marketName, 'Total Goals 2.5 · FT');
});

test("a middle's leg keeps the line it was paired on", () => {
  // A middle pairs two different lines, so the leg's own handicap is the point
  // and must not be overwritten by the parent's.
  const middle = surebet({
    type: 'middle',
    legs: [
      { sourceId: 'favbet', selection: 'Over 1.5', odds: 2.3, handicap: '1.5' },
      { sourceId: 'admiral', selection: 'Sub 2.5', odds: 1.9, handicap: '2.5' },
    ],
  });
  const [row] = only({ middles: [middle] });
  assert.deepEqual(row.legs.map((leg) => leg.marketName), ['Total Goals 1.5', 'Total Goals 2.5']);
});

test('the subject overrules a market key that disagrees with it', () => {
  // A corners line inherits the `OVER_UNDER_*` key, so it used to render as
  // "Total Goals 3.5 3.5 Corners" — a goals market with a corners label bolted
  // on, naming two different bets at once.
  const corners = surebet({ marketKey: 'OVER_UNDER_3_5', subject: 'corners', line: '3.5', period: 'half1' });
  const [row] = only({ opportunities: [corners] });
  assert.equal(row.marketName, 'Corners 3.5 · HALF1');
  assert.deepEqual(row.legs.map((leg) => leg.marketName), ['Corners 3.5', 'Corners 3.5']);
});

test('a goals subject is left alone, because the market name already says it', () => {
  // The rule above must not fire on the subject the key already names, or every
  // goal line would drop the word "Total" it is correctly known by.
  const goals = surebet({ subject: 'goals' });
  const [row] = only({ opportunities: [goals] });
  assert.equal(row.marketName, 'Total Goals 2.5 · FT');
});

test('a subject no key names renders a word, not the backend token', () => {
  // `rounds` and `legs` are derived by the engine from provider text, and no
  // market key or family names either. The subject fell through to
  // `raw.subject`, `subjectWins` promoted it over the market name, and the
  // card was titled "rounds 21.5": the scanner token, drawn as a market.
  const rounds = surebet({ marketKey: 'OVER_UNDER_21_5', subject: 'rounds', line: '21.5' });
  const [roundsRow] = only({ opportunities: [rounds] });
  assert.equal(roundsRow.marketName, 'Rounds 21.5 · FT');
  assert.deepEqual(roundsRow.legs.map((leg) => leg.marketName), ['Rounds 21.5', 'Rounds 21.5']);

  const legs = surebet({ marketKey: 'OVER_UNDER_2_5', subject: 'legs', line: '2.5' });
  const [legsRow] = only({ opportunities: [legs] });
  assert.equal(legsRow.marketName, 'Legs 2.5 · FT');
  assert.deepEqual(legsRow.legs.map((leg) => leg.marketName), ['Legs 2.5', 'Legs 2.5']);
});

test('a +EV row whose two prices describe the same bet keeps its edge', () => {
  // 0.3774 consensus against 2.7143 implied 36.84% is a ratio of 1.02: a real
  // disagreement about value, which is what an expected edge is.
  const [row] = only({ positiveEv: [positiveEv()] });
  assert.equal(row.evConsensusSuspect, false);
  assert.equal(row.type, 'positive_ev');
  assert.equal(row.profitPercent, 2.43);
});

test('a +EV row priced far above its own consensus is flagged, not dropped', () => {
  // The shape the bucket-key defect produced: an outcome one book priced at
  // 5.00 while consensus sat at 0.30, giving a ratio of 1.5 and an "edge" of
  // +247%. It stays in the list — dropping it would hide the disagreement —
  // but it must not be counted as an edge anybody can expect.
  const [row] = only({ positiveEv: [positiveEv({ odds: 5.0, consensusProbability: 0.3, evPercent: 50 })] });
  assert.equal(row.evConsensusSuspect, true);
  assert.equal(row.profitPercent, 50, 'the figure is still carried, not quietly removed');
});

test('a +EV row priced far below its own consensus is flagged too', () => {
  // The same multiplication, run the other way: odds 1.50 imply 0.667, and a
  // consensus of 0.50 is not a book disagreeing about value — it is a different
  // bet being priced against this one.
  const [row] = only({ positiveEv: [positiveEv({ odds: 1.5, consensusProbability: 0.5, evPercent: 40 })] });
  assert.equal(row.evConsensusSuspect, true);
});

test('a row with no consensus cannot be reconciled, so it is never asserted as one', () => {
  const [row] = only({ positiveEv: [positiveEv({ consensusProbability: undefined })] });
  assert.equal(row.evConsensusSuspect, false, 'no ratio means no mismatch to report');
});

test('a rejected contract keeps the backend\'s reason and blocks the guarantee', () => {
  // The reason is the backend's verdict verbatim. The shell may not soften it,
  // and may not present the margin as guaranteed while it stands.
  const [row] = only({
    opportunities: [surebet({ verification: { status: 'rejected', reason: 'settlement equivalence not established' } })],
  });
  assert.equal(row.ruleSafety.severity, 'blocked');
  assert.equal(row.ruleSafety.ruleMismatchReason, 'settlement equivalence not established');
});

test('a warning keeps its own severity, and an absent verification is not safe', () => {
  const [warned] = only({ opportunities: [surebet({ verification: { reason: 'push rules differ' } })] });
  assert.equal(warned.ruleSafety.severity, 'warning');
  // Silence is the one case that used to be read as compatibility, and it is the
  // state every middle and every +EV row arrives in, so this branch decided most
  // of the board.
  const [plain] = only({ opportunities: [surebet({ verification: undefined })] });
  assert.equal(plain.ruleSafety.severity, 'unverified');
  assert.equal(plain.ruleSafety.isCompatible, false, 'an unasked question is not a yes');
});

test('a confirmed contract stays placeable even though the verifier sends a reason with it', () => {
  // The verifier emits exactly one reason for a confirmed contract: its success
  // message, "all legs re-priced within tolerance". Reading any reason as a
  // settlement caveat therefore turned every confirmed arb into a rule hazard --
  // the board listed a +4.43% guarantee beside "0 / actionable", and the warning
  // banner's body said every leg had been re-priced inside tolerance. The reason
  // has to be read together with the status that produced it.
  const verification = { status: 'confirmed', reason: 'all legs re-priced within tolerance' };
  assert.ok(verification.reason.length > 0, 'the fixture must carry the success reason, or this test proves nothing');
  const [row] = only({ opportunities: [surebet({ verification })] });
  assert.equal(row.ruleSafety.severity, 'safe');
  assert.equal(row.ruleSafety.isCompatible, true);
  assert.equal(
    row.ruleSafety.ruleMismatchReason,
    undefined,
    'a confirmed contract must not carry a mismatch reason into the warning banner',
  );
  assert.equal(surebetCounts([row]).actionable, 1, 'a confirmed arb is placeable and must be counted as such');
});

test('+EV rows recover the teams from the event key instead of inventing Home vs Away', () => {
  // Positive EV publishes no team names at all. Rendering those rows as
  // "Home vs Away" would be a lie about what the trader is looking at.
  const [row] = only({ positiveEv: [positiveEv({ eventKey: 'football|2026-10-16T22:20:00.000Z|recoleta|rubio nu' })] });
  assert.equal(row.homeTeam, 'Recoleta');
  assert.equal(row.awayTeam, 'Rubio Nu');
});

test('each family keeps its own headline figure', () => {
  // A surebet's number is its margin, a middle's is its ROI, a +EV row's is its
  // expected edge. Reading all three off one field is how a middle used to be
  // shown as money in hand.
  const [arb] = only({ opportunities: [surebet({ marginPercent: 4, guaranteedProfit: 40 })] });
  assert.equal(arb.profitPercent, 4);
  const [mid] = only({ middles: [surebet({ type: 'middle', marginPercent: 4, roiPercent: 128 })] });
  assert.equal(mid.profitPercent, 128);
  const [ev] = only({ positiveEv: [positiveEv({ evPercent: 7.5, marginPercent: 4 })] });
  assert.equal(ev.profitPercent, 7.5);
});

test('a market key no label resolves still yields a name, never an empty badge', () => {
  const [row] = only({ opportunities: [surebet({ marketKey: 'SOME_UNMAPPED_KEY', family: undefined, line: undefined })] });
  assert.ok(row.marketName && row.marketName.length > 0);
});

test('the control: a scan with legs produces book activity, so the counts below mean something', () => {
  // An empty map would make every "no prices in this scan" assertion pass, which
  // is the same empty-tree false pass the rest of this file guards against.
  const activity = bookActivity(only({ opportunities: [surebet()] }));
  assert.ok(activity.size >= 2, `expected both fixture books, got ${[...activity.keys()].join(',') || 'none'}`);
});

test('a book is reported only when it priced a leg in this scan', () => {
  // The book matrix used to print a hardcoded "Online" for all four books, so a
  // feed where a book had priced nothing all night still read as healthy.
  // `dataHealth.sources` cannot settle this — it is a histogram of how many
  // sources fell in each freshness bucket, not a map of which source did.
  const activity = bookActivity(only({ opportunities: [surebet()] }));
  assert.equal(activity.get('favbet')?.pricedLegs, 1);
  assert.equal(activity.get('betano')?.pricedLegs, 1);
  assert.equal(activity.has('betfair'), false, 'a book that priced nothing is absent, not shown as online');
});

test('one book on two legs of the same bet counts two legs but one opportunity', () => {
  // A same-book dutch is two legs the trader still considers one market, so the
  // matrix must not claim the book was in twice.
  const activity = bookActivity(only({
    opportunities: [surebet({
      legs: [
        { sourceId: 'maxbet', selection: '1', odds: 3.65 },
        { sourceId: 'maxbet', selection: '2', odds: 2.14 },
      ],
    })],
  }));
  assert.equal(activity.get('maxbet')?.pricedLegs, 2);
  assert.equal(activity.get('maxbet')?.opportunities, 1);
});

test('an empty scan yields no activity at all, rather than every book online', () => {
  assert.equal(bookActivity(only({ opportunities: [], middles: [], positiveEv: [] })).size, 0);
});

// The label rules used to live in `App.tsx`, which no test could reach. These
// feed the *normalized* row into `profitLabel`, so they catch the disagreement
// that actually shipped: a headline computed from one field and a card label
// read from another. Asserting on hand-built objects would miss that, because
// the two would be built consistently by hand.

test('the label figure is the headline figure, for every family', () => {
  // The defect these catch: a middle's headline read `marginPercent` while its
  // label read `roiPercent`, so one row showed "+4.00%" beside a slip claiming
  // 128%. Driving the label from the normalized row makes that unreachable.
  const [arb] = only({ opportunities: [surebet({ marginPercent: 4 })] });
  const [mid] = only({ middles: [surebet({ type: 'middle', marginPercent: 4, roiPercent: 128 })] });
  const [ev] = only({ positiveEv: [positiveEv({ evPercent: 7.5, marginPercent: 4 })] });
  for (const [row, expected] of [[arb, '4.00'], [mid, '128.00'], [ev, '7.50']]) {
    assert.equal(profitLabel(row, pct).value, `+${expected}%`);
    assert.equal(profitLabel(row, pct).value, `+${row.profitPercent.toFixed(2)}%`, 'the label and the headline must not disagree');
  }
});

test('only a rule-safe surebet may call itself guaranteed', () => {
  // "Guaranteed" is a settlement claim. A rejected contract still carries the
  // margin the arithmetic produced, but the guarantee is exactly what is
  // missing, so it must not be the word on the card.
  const [safe] = only({ opportunities: [surebet()] });
  assert.equal(profitLabel(safe, pct).qualifier, 'appClaimGuaranteed');
  assert.equal(profitLabel(safe, pct).tone, '');
  const [warned] = only({ opportunities: [surebet({ verification: { reason: 'push rules differ' } })] });
  assert.equal(profitLabel(warned, pct).qualifier, 'appClaimRuleHazard');
  assert.equal(profitLabel(warned, pct).tone, 'muted');
  const [blocked] = only({ opportunities: [surebet({ verification: { status: 'rejected', reason: 'not established' } })] });
  assert.equal(profitLabel(blocked, pct).qualifier, 'appClaimBlockedContract');
  assert.equal(profitLabel(blocked, pct).tone, 'muted');
});

test('an unreconcilable +EV row keeps its number but drops the "expected" claim', () => {
  // The figure stays visible — dropping it would hide the disagreement — but it
  // may not be described as an expectation nobody could reconcile.
  const [clean] = only({ positiveEv: [positiveEv()] });
  assert.equal(profitLabel(clean, pct).qualifier, 'appClaimExpectedEdge');
  const [suspect] = only({ positiveEv: [positiveEv({ odds: 5.0, consensusProbability: 0.3, evPercent: 50 })] });
  assert.equal(profitLabel(suspect, pct).qualifier, 'appClaimUnverifiedConsensus');
  assert.equal(profitLabel(suspect, pct).tone, 'muted');
  assert.equal(profitLabel(suspect, pct).value, '+50.00%', 'the number is carried, not quietly removed');
});

test('an engine-derived equivalence names itself instead of leaking its slug', () => {
  // `X2_VS_HOME` is the engine pairing "draw or away" against "home wins". It
  // publishes that slug as both market key and line, so raw it reached the trader
  // as "Equivalent Market X2_VS_HOME" — a name nothing can be placed on.
  const [row] = only({ opportunities: [surebet({
    marketKey: 'SYNTHETIC_X2_VS_HOME',
    family: 'SYNTHETIC_EQUIVALENCE',
    line: 'X2_VS_HOME',
    legs: [
      { sourceId: 'maxbet', selection: '2 (0.5)', odds: 1.9, marketKey: 'ASIAN_HANDICAP', handicap: 0.5 },
      { sourceId: 'unibet', selection: '1', odds: 2.05, marketKey: '1x2', handicap: null },
    ],
  })] });
  assert.equal(row.marketName, 'Draw or Away vs Home Win · FT');
  assert.ok(!/X2_VS_HOME/.test(row.marketName), 'no slug may reach the trader');
  assert.ok(!row.legs.some((leg) => /X2_VS_HOME/.test(leg.marketName)), `no leg may inherit the slug, got ${row.legs.map((leg) => leg.marketName).join(' / ')}`);
});

test('an equivalence names the card but still names each leg\'s own market', () => {
  // This is the one case where a multi-leg position really is two markets: the
  // pair is an Away +0.5 handicap against a home win. Forcing the card's name
  // onto both legs would hide what the trader is actually placing.
  const [row] = only({ opportunities: [surebet({
    marketKey: 'SYNTHETIC_X2_VS_HOME',
    family: 'SYNTHETIC_EQUIVALENCE',
    line: 'X2_VS_HOME',
    legs: [
      { sourceId: 'maxbet', selection: '2 (0.5)', odds: 1.9, marketKey: 'ASIAN_HANDICAP', handicap: 0.5 },
      { sourceId: 'unibet', selection: '1', odds: 2.05, marketKey: '1x2', handicap: null },
    ],
  })] });
  assert.deepEqual(row.legs.map((leg) => leg.marketName), ['Asian Handicap 0.5', 'Match Result']);
});

test('an unrecognised synthetic contract still reads as derived, not as a slug', () => {
  const [row] = only({ opportunities: [surebet({ marketKey: 'SYNTHETIC_SOMETHING_NEW', family: 'SYNTHETIC_EQUIVALENCE', line: 'SOMETHING_NEW' })] });
  assert.ok(!/SOMETHING_NEW/.test(row.marketName), `got ${row.marketName}`);
  assert.match(row.marketName, /Derived/i);
});

test('a multi-leg position labels every leg as the market it is part of', () => {
  // A surebet's legs are one bet priced by different books. A leg whose own key
  // names a different market made a `Match Result` card show one Favbet leg as
  // `Match Odds` beside two reading `Match Result`, and a corners card show one
  // leg as `Match Odds` beside two reading `Corners 3.5`.
  const [row] = only({ opportunities: [surebet({
    marketKey: 'MATCH_ODDS',
    family: 'MATCH_ODDS',
    line: undefined,
    legs: [
      { sourceId: 'maxbet', selection: '1', odds: 3.65, marketKey: 'MATCH_ODDS' },
      { sourceId: 'favbet', selection: 'X', odds: 4.83, marketKey: 'MATCH_ODDS_FAMILY_KEY' },
      { sourceId: 'netbet', selection: '2', odds: 1.78, marketKey: 'MATCH_ODDS' },
    ],
  })] });
  const names = row.legs.map((leg) => leg.marketName);
  assert.equal(new Set(names).size, 1, `legs of one bet must share a market, got ${names.join(' / ')}`);
  assert.equal(names[0], row.marketName.replace(' · FT', ''), 'the legs must read as the market on the card');
});

test('a FEG market key names its market, not a corner band', () => {
  // Live feed: ufo:mtyp:00-00 arrives with family MATCH_ODDS and legs 1/X/2,
  // and the card read `Cornere 00–00 · FT` — a corner market nobody
  // was betting on. FEG keys are ufo:mtyp:<sportId>-<marketType>
  // (docs/no-arbitrage-root-cause.md), so the pair is a sport and a market
  // type, never a line. The backend resolves it into `family`, and that is
  // the only name the frontend may use.
  const [row] = only({ opportunities: [surebet({
    marketKey: 'ufo:mtyp:00-00',
    family: 'MATCH_ODDS',
    line: undefined,
    legs: [
      { sourceId: 'favbet', selection: 'X', odds: 7.08, marketKey: 'MATCH_ODDS' },
      { sourceId: 'casa-pariurilor', selection: '1', odds: 1.29, marketKey: 'ufo:mtyp:00-00' },
      { sourceId: 'casa-pariurilor', selection: '2', odds: 14.06, marketKey: 'ufo:mtyp:00-00' },
    ],
  })] });
  assert.ok(!/corner/i.test(row.marketName), `a 1X2 market must not read as corners, got ${row.marketName}`);
  assert.match(row.marketName, /Match Odds/);
  const names = row.legs.map((leg) => leg.marketName);
  assert.equal(new Set(names).size, 1, `legs of one bet must share a market, got ${names.join(' / ')}`);
  assert.ok(!names.some((name) => /corner/i.test(name)), `no leg may claim corners, got ${names.join(' / ')}`);
});

test('no FEG key is turned into a corner band', () => {
  // Every one of these matches the digit-digit shape the removed derivation
  // keyed on, and each is a real sport/market pair: 00-01 double chance,
  // 02-04 a set winner, 03-03 a cards total, 07-00 rugby result, 14-02 MMA
  // rounds. None of them is a line.
  for (const marketKey of ['ufo:mtyp:00-01', 'ufo:mtyp:02-04', 'ufo:mtyp:03-03', 'ufo:mtyp:07-00', 'ufo:mtyp:14-02']) {
    const [row] = only({ opportunities: [surebet({ marketKey, line: undefined })] });
    assert.ok(!/corner/i.test(row.marketName), `${marketKey} must not read as corners, got ${row.marketName}`);
    assert.ok(!/corner/i.test(row.legs[0].marketName), `${marketKey} leg must not read as corners, got ${row.legs[0].marketName}`);
  }
});

test('a single-leg +EV row keeps the market its own leg names', () => {
  // There is no paired position here, so the leg's own key is the market. Forcing
  // the parent's label instead would be the mirror-image error.
  const [row] = only({ positiveEv: [positiveEv({
    marketKey: 'UNKNOWN_PARENT_KEY',
    legs: [{ sourceId: '5gringos', selection: '1', odds: 2.7143, marketKey: 'MATCH_ODDS' }],
  })] });
  assert.equal(row.legs[0].marketName, 'Match Odds', "the leg's own key names the market when there is no paired position");
});

test('the three families never wear the same qualifier', () => {
  const [arb] = only({ opportunities: [surebet()] });
  const [mid] = only({ middles: [surebet({ type: 'middle', roiPercent: 128 })] });
  const [ev] = only({ positiveEv: [positiveEv()] });
  const qualifiers = [profitLabel(arb, pct), profitLabel(mid, pct), profitLabel(ev, pct)].map((label) => label.qualifier);
  assert.equal(new Set(qualifiers).size, 3, `expected three distinct qualifiers, got ${qualifiers.join(' / ')}`);
});

// The execution slip is the half of the screen that talks the trader into
// staking money, so it has to agree with the card about the same row.
// Neither formatter may reach for a locale here: this file runs in Node with no
// interface language, and the point of every assertion below is the figure and
// the claim around it, not the separator it is printed with. `App.tsx` supplies
// the real, locale-aware pair; these two are the plain stand-ins.
const money = (value) => `${value.toFixed(2)} RON`;
const pct = (value, digits = 2) => `${value.toFixed(digits)}%`;
const worstCase = (over = {}) => ({ worstCaseProfit: 9.45, worstCaseRoi: 0.95, totalStaked: 1000, ...over });

test('the slip never calls an unreconcilable +EV row an expected profit', () => {
  // The card calls these "unverified consensus" while the slip used to print
  // "Expected profit" and "Model probability" for the very same row, so the two
  // halves of one screen disagreed about whether the figure meant anything.
  const [suspect] = only({ positiveEv: [positiveEv({ odds: 5.0, consensusProbability: 0.3, evPercent: 50 })] });
  const summary = slipSummary(suspect, 1000, worstCase(), money, pct);
  assert.equal(summary.unreconciled, true);
  assert.equal(summary.aLabel, 'appClaimQuotedEdge');
  assert.notEqual(summary.aLabel, 'appClaimExpectedProfit', 'no label may assert an expectation that cannot be reconciled');
  // The word 'unreconciled' is now a qualifier the slip translates, not a
  // suffix welded onto the number; the value itself has to stay a figure.
  assert.equal(summary.bQualifier, 'appClaimUnreconciled');
  assert.match(summary.bValue, /^\d+(?:\.\d+)?%$/, 'the quoted value stays a plain percentage');
  const [clean] = only({ positiveEv: [positiveEv()] });
  const cleanSummary = slipSummary(clean, 1000, worstCase(), money, pct);
  assert.equal(cleanSummary.unreconciled, false);
  assert.equal(cleanSummary.aLabel, 'appClaimExpectedProfit');
  assert.equal(cleanSummary.bQualifier, null, 'a reconciled row carries no qualifier');
});

test('the slip quotes the stake it lists, not the bankroll the trader typed', () => {
  // Under any rounding mode the placed stake differs from the typed bankroll,
  // and the slip lists the rounded figure two lines above the quote. Quoting
  // profit on the typed number describes a bet that was never placed.
  const [ev] = only({ positiveEv: [positiveEv({ evPercent: 10 })] });
  assert.equal(slipSummary(ev, 1000, worstCase(), money, pct).aValue, '100.00 RON');
  assert.equal(slipSummary(ev, 995, worstCase(), money, pct).aValue, '99.50 RON');
});

test('a blocked surebet states its stake but refuses to state a worst case', () => {
  // The backend could not establish that the legs settle together, so the
  // payout if they do not is unknown — not zero, and not the arithmetic margin.
  const [blocked] = only({ opportunities: [surebet({ verification: { status: 'rejected', reason: 'not established' } })] });
  const summary = slipSummary(blocked, 1000, worstCase(), money, pct);
  assert.equal(summary.blocked, true);
  assert.equal(summary.bLabel, 'appClaimWorstCase');
  assert.equal(summary.bValue, '—');
  assert.equal(summary.bQualifier, 'appClaimNotEstablished', 'the reason is a translated qualifier, not a value');
  assert.ok(!/\d/.test(summary.bValue), 'an unknown worst case must not be rendered as a number');
});

test('a rule-safe surebet is the only family that reports a worst case and rounding ROI', () => {
  const [safe] = only({ opportunities: [surebet()] });
  const summary = slipSummary(safe, 1000, worstCase({ worstCaseProfit: -12.5, worstCaseRoi: -1.25 }), money, pct);
  assert.equal(summary.aLabel, 'appClaimWorstCase');
  assert.equal(summary.aValue, '-12.50 RON');
  assert.equal(summary.bLabel, 'appClaimRoiAfterRounding');
  assert.equal(summary.bValue, '-1.25%');
});

test('the slip and the card agree on a middle\'s figure', () => {
  const [mid] = only({ middles: [surebet({ type: 'middle', marginPercent: 4, roiPercent: 128 })] });
  const summary = slipSummary(mid, 1000, worstCase(), money, pct);
  assert.equal(summary.aValue, profitLabel(mid, pct).value, 'card and slip must quote the same upside');
  assert.equal(summary.aLabel, 'appClaimUpsideIfLands');
  assert.equal(summary.blocked, false);
});

test('the control: the ranking fixture is genuinely out of order', () => {
  // A sort test on an already-sorted fixture passes whether or not a sort runs.
  // `normalizeScan` emits surebets, middles, then +EV — which is already the
  // certainty order — so the rows are fed in deliberately scrambled sequence.
  const rows = [
    ...only({ positiveEv: [
      positiveEv({ odds: 5.0, consensusProbability: 0.3, evPercent: 900 }),
      positiveEv({ evPercent: 1 }),
    ] }),
    ...only({ middles: [surebet({ type: 'middle', roiPercent: 128 })] }),
    ...only({ opportunities: [surebet({ marginPercent: 4 })] }),
  ];
  const ranked = rankOpportunities(rows);
  assert.ok(ranked.length >= 4, 'the fixture must produce rows before its order means anything');
  assert.notEqual(ranked.map((row) => row.id).join(','), rows.map((row) => row.id).join(','), 'the fixture must not already be ranked');
  assert.deepEqual(ranked.map((row) => row.type), ['surebet', 'middle', 'positive_ev', 'positive_ev'], 'certainty order, not payload order');
  assert.equal(ranked[3].evConsensusSuspect, true, 'the unreconcilable row sinks to the bottom');
});

test('a middle\'s conditional ROI never outranks a surebet\'s guaranteed margin', () => {
  // 511% conditional upside is not better money than a 4% guarantee. Ranking
  // every family on one column would put the least certain money in the feed at
  // the top of the list — the same mistake as reading all three headline figures
  // off one field, which the label rules were fixed for.
  const rows = only({
    opportunities: [surebet({ marginPercent: 4 })],
    middles: [surebet({ type: 'middle', roiPercent: 511 })],
  });
  const ranked = rankOpportunities(rows);
  assert.equal(ranked[0].type, 'surebet');
  assert.ok(ranked[0].profitPercent < ranked[1].profitPercent, 'the smaller, certain figure is deliberately first');
});

test('within one family the rows really do descend by edge', () => {
  const rows = only({ middles: [
    surebet({ type: 'middle', roiPercent: 12 }),
    surebet({ type: 'middle', roiPercent: 128 }),
    surebet({ type: 'middle', roiPercent: 40 }),
  ] });
  assert.deepEqual(rankOpportunities(rows).map((row) => row.profitPercent), [128, 40, 12]);
});

test('a row nobody can act on never outranks one they can', () => {
  // The 2,190 unreconciled +EV rows carry the largest figures in the payload.
  // Ranking purely by size would float every one of them to the top of the
  // list, which is exactly what flagging them was meant to prevent.
  const rows = only({ positiveEv: [
    positiveEv({ odds: 5.0, consensusProbability: 0.3, evPercent: 900 }),
    positiveEv({ evPercent: 1 }),
  ] });
  const ranked = rankOpportunities(rows);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].evConsensusSuspect, false);
  assert.equal(ranked[0].profitPercent, 1);
  assert.equal(ranked[1].profitPercent, 900);
  assert.ok(ranked[0].profitPercent < ranked[1].profitPercent, 'the smaller figure is deliberately first');
});

test('a blocked contract sorts below a rule-safe one of any size', () => {
  const rows = only({ opportunities: [
    surebet({ verification: { status: 'rejected', reason: 'not established' }, marginPercent: 40 }),
    surebet({ marginPercent: 2 }),
  ] });
  const ranked = rankOpportunities(rows);
  assert.equal(ranked[0].ruleSafety.severity, 'safe');
  assert.equal(ranked[1].ruleSafety.severity, 'blocked');
});

test('a blocked surebet sinks below a credible +EV row, whatever the figure', () => {
  // Both are in the unactionable tier, so the family ordering still applies: the
  // blocked contract is not lifted to the top by a 40% margin nobody can back.
  const rows = only({
    opportunities: [surebet({ verification: { status: 'rejected', reason: 'not established' }, marginPercent: 40 })],
    positiveEv: [positiveEv({ evPercent: 0.1 })],
  });
  const ranked = rankOpportunities(rows);
  assert.equal(ranked[0].type, 'positive_ev');
  assert.equal(ranked[1].type, 'surebet');
});

test('ranking is stable, so the list cannot reshuffle between renders', () => {
  const rows = only({ positiveEv: [positiveEv({ evPercent: 5 }), positiveEv({ evPercent: 5 }), positiveEv({ evPercent: 5 })] });
  const once = rankOpportunities(rows).map((row) => row.id);
  const again = rankOpportunities([...rows].reverse()).map((row) => row.id);
  assert.deepEqual(once, again);
});

test('the controls: the chime filter sees both a surebet and a middle, and parts them', () => {
  // `alertable` is a filter over a list, and a filter that matches nothing passes
  // every exclusion test below. Pin the population first.
  const rows = only({
    opportunities: [surebet()],
    middles: [surebet({ type: 'middle', roiPercent: 900, marginPercent: 900 })],
  });
  assert.equal(rows.length, 2);
  assert.equal(alertable(rows).length, 1);
});

test("a middle's huge ROI may not ring the chime a guaranteed surebet reserves", () => {
  // A live scan had middles at 128% ROI against a best guaranteed margin of
  // 3.17%. If the high-value tone ever compared those two figures it would fire
  // for conditional money that cannot be counted, which is the one thing the
  // sound says it will not do.
  const rows = only({ middles: [surebet({ type: 'middle', roiPercent: 128, marginPercent: 128 })] });
  assert.equal(rows[0].type, 'middle');
  assert.ok(rows[0].profitPercent > 3, 'the control figure would clear the high-value threshold');
  assert.deepEqual(alertable(rows), []);
});

test('a blocked contract is silent even when the backend found a large margin', () => {
  // Its arithmetic looks attractive and its settlement guarantee is exactly what
  // the backend refused, so it must not interrupt either.
  const rows = only({ opportunities: [surebet({ verification: { status: 'rejected', reason: 'not established' }, marginPercent: 40 })] });
  assert.deepEqual(alertable(rows), []);
});

test('a warned contract is quiet too: the hazard is unresolved, not absent', () => {
  const rows = only({ opportunities: [surebet({ verification: { reason: 'push rules differ' }, marginPercent: 40 })] });
  assert.deepEqual(alertable(rows), []);
});

test('a rule-safe surebet is the one row allowed to interrupt', () => {
  const rows = only({ opportunities: [surebet({ marginPercent: 4 })] });
  assert.equal(alertable(rows).length, 1);
});

test('the controls: a bigger expected edge must not overwrite the guaranteed one', () => {
  // The defect was a single number for both. Pin the population and the shape of
  // the input first: the +EV edge here is deliberately larger than the margin.
  const rows = only({
    opportunities: [surebet({ marginPercent: 3.17 })],
    positiveEv: [positiveEv({ evPercent: 9 })],
  });
  assert.equal(rows.length, 2);
  const figures = verifiedFigures(rows);
  assert.equal(figures.guaranteed, 3.17);
  assert.equal(figures.expectedEdge, 9);
});

test('a middle ROI cannot become the headline verified figure', () => {
  // Middles were never part of the summary, but they are the family with the
  // largest numbers in the feed, so any "best figure" that sweeps every type
  // will eventually land on one. This pins that they cannot.
  const rows = only({ opportunities: [surebet({ marginPercent: 3.17 })], middles: [surebet({ type: 'middle', roiPercent: 900 })] });
  assert.equal(verifiedFigures(rows).guaranteed, 3.17);
});

test('an excluded row contributes to neither summary figure', () => {
  // A blocked contract with a huge margin and an unreconcilable +EV edge are
  // both on the board and both unusable as a headline.
  const rows = only({
    opportunities: [surebet({ verification: { status: 'rejected', reason: 'not established' }, marginPercent: 60 })],
    positiveEv: [positiveEv({ evPercent: 80, consensusProbability: 0.02 })],
  });
  const figures = verifiedFigures(rows);
  assert.equal(figures.guaranteed, 0);
  assert.equal(figures.expectedEdge, 0);
});

test('the window title quotes the guaranteed figure and names it as guaranteed', () => {
  // A bare "+9.00%" in a tab carries no qualifier, and the reader supplies
  // "guaranteed" from the product name. The word has to be in the title.
  const rows = only({ opportunities: [surebet({ marginPercent: 3.17 })], positiveEv: [positiveEv({ evPercent: 9 })] });
  assert.deepEqual(titleClaim(verifiedFigures(rows)), { key: 'appTitleBestGuaranteed', value: 3.17 });
});

test('with no rule-safe surebet the title says so rather than quoting an expectation', () => {
  const rows = only({ positiveEv: [positiveEv({ evPercent: 9 })] });
  assert.equal(verifiedFigures(rows).guaranteed, 0);
  assert.deepEqual(titleClaim(verifiedFigures(rows)), { key: 'appTitleNoSurebets' });
});

test('an empty feed adds nothing to the title', () => {
  assert.deepEqual(titleClaim(verifiedFigures([])), { key: null });
});

test('the controls: every verdict is distinguishable in one scan', () => {
  // The reconciliation test below is worthless if the fixtures all collapse to
  // one verdict, so all four are built first and checked individually.
  const rows = only({
    opportunities: [
      surebet({ eventKey: EVENT.replace('home', 'h1') }),
      surebet({ eventKey: EVENT.replace('home', 'h2'), verification: { reason: 'push rules differ' } }),
      surebet({ eventKey: EVENT.replace('home', 'h3'), verification: { status: 'rejected', reason: 'not established' } }),
      surebet({ eventKey: EVENT.replace('home', 'h4'), verification: undefined }),
    ],
    middles: [surebet({ type: 'middle', eventKey: EVENT.replace('home', 'h5'), verification: undefined })],
    positiveEv: [positiveEv({ eventKey: EVENT.replace('home', 'h6') })],
  });
  assert.equal(rows.length, 6, 'all six fixtures survive normalization');
  assert.deepEqual(
    rows.map((row) => row.ruleSafety.severity),
    ['safe', 'warning', 'blocked', 'unverified', 'unverified', 'unverified'],
    'the untouched row, the middle and the +EV leg are all unverified: none of them was checked',
  );
});

test('the three surebet verdicts add up to the surebets on the board', () => {
  // The KPI used to print a total its own breakdown could not reach: 0
  // actionable and 54 blocked against 69 surebets, leaving 15 contracts that
  // existed on the board and on no line of the summary.
  const rows = only({
    opportunities: [
      surebet({ eventKey: EVENT.replace('home', 'h1') }),
      surebet({ eventKey: EVENT.replace('home', 'h2'), verification: { reason: 'push rules differ' } }),
      surebet({ eventKey: EVENT.replace('home', 'h3'), verification: { status: 'rejected', reason: 'not established' } }),
      surebet({ eventKey: EVENT.replace('home', 'h4') }),
    ],
    middles: [surebet({ type: 'middle', eventKey: EVENT.replace('home', 'h5') })],
    positiveEv: [positiveEv({ eventKey: EVENT.replace('home', 'h6') })],
  });
  const counts = surebetCounts(rows);
  assert.equal(counts.total, 4, 'only surebets are counted here');
  assert.equal(counts.actionable, 2);
  assert.equal(counts.hazard, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.unverified, 0);
  assert.equal(
    counts.actionable + counts.hazard + counts.blocked + counts.unverified,
    counts.total,
    'every surebet on the board is placeable, hazardous, blocked or unverified — none may fall through the summary',
  );
});

test('a middle and a +EV row are never counted as a surebet verdict', () => {
  const rows = only({
    middles: [surebet({ type: 'middle', verification: { status: 'rejected', reason: 'nope' } })],
    positiveEv: [positiveEv()],
  });
  assert.deepEqual(surebetCounts(rows), { total: 0, actionable: 0, blocked: 0, hazard: 0, unverified: 0 });
});

test('an unverified middle may not wear the badge a confirmed surebet earns', () => {
  // Vittsjoe IK Brage / IFK Varnamo shipped exactly this on the live board: two
  // total-goals legs the middles builder had paired across mismatched teams,
  // badged Rules safe and quoted at +263.50%, because the row carried no
  // verification and the shell read that silence as compatibility. Nothing had
  // checked the pair, and the pipeline still never passes middles to it.
  const [row] = only({ middles: [surebet({ type: 'middle', roiPercent: 263.5, verification: undefined })] });
  assert.equal(row.type, 'middle');
  assert.equal(row.ruleSafety.severity, 'unverified');
  assert.equal(row.ruleSafety.isCompatible, false);
  // The figure still says what a middle's figure says. What changes is the badge
  // above it: conditional upside is a claim about the window, not about two legs
  // settling the same way.
  assert.equal(profitLabel(row, (value, digits = 2) => value.toFixed(digits)).qualifier, 'appClaimUpsideIfLands');
});

test('an unverified row is quoted, and may not lend its margin to a guarantee', () => {
  const rows = only({ opportunities: [surebet({ verification: undefined, marginPercent: 40 })] });
  assert.equal(rows[0].ruleSafety.severity, 'unverified');
  assert.equal(
    profitLabel(rows[0], (value, digits = 2) => value.toFixed(digits)).qualifier,
    'appClaimUnverifiedContract',
    'a surebet whose contract nobody checked may not be labelled guaranteed',
  );
  assert.deepEqual(alertable(rows), [], 'and it may not ring the chime');
  assert.equal(verifiedFigures(rows).guaranteed, 0, 'nor supply the guaranteed headline');
  assert.deepEqual(titleClaim(verifiedFigures(rows)), { key: null }, 'so the title quotes no figure at all');
});

test('an unverified surebet is in the breakdown, so the total is still reached', () => {
  // The fourth bucket has to be counted somewhere, or the summary can reach its
  // total while overstating what one can back -- the exact defect the three-way
  // split was introduced to fix.
  const rows = only({
    opportunities: [
      surebet({ eventKey: EVENT.replace('home', 'h1') }),
      surebet({ eventKey: EVENT.replace('home', 'h2'), verification: undefined }),
    ],
  });
  const counts = surebetCounts(rows);
  assert.equal(counts.actionable, 1);
  assert.equal(counts.unverified, 1);
  assert.equal(counts.actionable + counts.hazard + counts.blocked + counts.unverified, counts.total);
});

test('multi-sport and multilingual provider names normalize to canonical Sport slugs', () => {
  assert.equal(normalizeSport('Fotbal'), 'football');
  assert.equal(normalizeSport('Football'), 'football');
  assert.equal(normalizeSport('Handball'), 'handball');
  assert.equal(normalizeSport('Handbal'), 'handball');
  assert.equal(normalizeSport('Boxing'), 'boxing');
  assert.equal(normalizeSport('American Football'), 'american-football');
  assert.equal(normalizeSport('Table Tennis'), 'table-tennis');
  assert.equal(normalizeSport('counter-strike-2'), 'esports');
  assert.equal(normalizeSport('Unmapped Custom Sport'), 'other');
});

test('bookmaker source IDs format cleanly for both cataloged and newly added scrapers', () => {
  assert.equal(formatBookmakerName('casa-pariurilor'), 'Casa Pariurilor');
  assert.equal(formatBookmakerName('superbet'), 'Superbet');
  assert.equal(formatBookmakerName('admiralbet-pl'), 'AdmiralBet PL');
  assert.equal(formatBookmakerName('new-book-ro'), 'New Book RO');
});

test('low-hold markets normalize with hold percentage, team identity, and readable market names', () => {
  const rows = normalizeLowHold({
    lowHold: [
      {
        eventKey: 'tennis|2026-10-26T15:00:00.000Z|swiatek|sabalenka',
        sport: 'Tenis',
        marketKey: 'TOTAL_GAMES',
        line: '21.5',
        holdPercent: 0.42,
        legs: [
          { sourceId: 'betano', selection: 'Over 21.5', odds: 1.98 },
          { sourceId: 'unibet', selection: 'Under 21.5', odds: 2.0 },
        ],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sport, 'tennis');
  assert.equal(rows[0].homeTeam, 'Swiatek');
  assert.equal(rows[0].awayTeam, 'Sabalenka');
  assert.equal(rows[0].holdPercent, 0.42);
  assert.equal(rows[0].legs[0].bookmakerName, 'Betano');
  assert.equal(rows[0].legs[0].marketName, 'Total Games 21.5');
});