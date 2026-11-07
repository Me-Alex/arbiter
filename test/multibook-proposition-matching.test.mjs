import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContract,
  bucketKeyForContract,
  teamFor,
  subjectFor,
  canonicalOutcomeFor,
} from '../src/scanner/market-contracts.mjs';
import { findArbitrage, groupByEvent } from '../src/scanner/engine.mjs';

test('proposition corners total: Unibet, Betano, and Favbet unify into identical bucket keys', () => {
  const eventKey = 'soccer_arsenal_chelsea_20261015';

  // 1. Betano corners market
  const betanoCorners = {
    id: 'betano_cnou_9_5',
    key: 'CNOU',
    name: 'Cornere Peste/Sub',
    period: 'fulltime',
    selections: [
      { id: 'b1', name: 'Peste 9.5', odds: 2.05, handicap: 9.5 },
      { id: 'b2', name: 'Sub 9.5', odds: 1.85, handicap: 9.5 },
    ],
  };

  // 2. Unibet corners market
  const unibetCorners = {
    id: 'unibet_cnou_9_5',
    key: 'CNOU',
    name: 'Total cornere',
    period: 'fulltime',
    line: 9.5,
    selections: [
      { id: 'u1', name: 'Over 9.5', odds: 1.88, handicap: '9.5' },
      { id: 'u2', name: 'Under 9.5', odds: 2.02, handicap: '9.5' },
    ],
  };

  // 3. Favbet corners market
  const favbetCorners = {
    id: 'favbet_cnou_9_5',
    key: 'CNOU',
    name: 'Total cornere',
    period: 'fulltime',
    line: 9.5,
    selections: [
      { id: 'f1', name: 'Over 9.5', odds: 1.90, handicap: 9.5 },
      { id: 'f2', name: 'Under 9.5', odds: 1.95, handicap: 9.5 },
    ],
  };

  const cBetano = resolveContract(betanoCorners);
  const cUnibet = resolveContract(unibetCorners);
  const cFavbet = resolveContract(favbetCorners);

  assert.ok(cBetano, 'Betano corners must resolve to contract');
  assert.ok(cUnibet, 'Unibet corners must resolve to contract');
  assert.ok(cFavbet, 'Favbet corners must resolve to contract');

  for (const c of [cBetano, cUnibet, cFavbet]) {
    assert.equal(c.family, 'OVER_UNDER');
    assert.equal(c.subject, 'corners');
    assert.equal(c.team, 'match');
    assert.equal(c.period, 'fulltime');
    assert.equal(c.lineKey, '9.5');
    assert.deepEqual(c.outcomes, ['over', 'under']);
  }

  const bKeyBetano = bucketKeyForContract(eventKey, cBetano);
  const bKeyUnibet = bucketKeyForContract(eventKey, cUnibet);
  const bKeyFavbet = bucketKeyForContract(eventKey, cFavbet);

  assert.equal(bKeyBetano, bKeyUnibet, 'Betano and Unibet corners must produce identical bucket key');
  assert.equal(bKeyBetano, bKeyFavbet, 'Betano and Favbet corners must produce identical bucket key');
  assert.equal(bKeyBetano, `${eventKey}::OVER_UNDER::fulltime::9.5::over+under::corners::match`);
});

test('proposition cards total: Unibet and Betano unify into identical bucket keys', () => {
  const eventKey = 'soccer_barcelona_real_madrid_20261016';

  const betanoCards = {
    id: 'betano_tcou_4_5',
    key: 'TCOU',
    name: 'Total cartonașe Peste/Sub',
    period: 'fulltime',
    selections: [
      { id: 'b1', name: 'Peste 4.5', odds: 2.15, handicap: 4.5 },
      { id: 'b2', name: 'Sub 4.5', odds: 1.75, handicap: 4.5 },
    ],
  };

  const unibetCards = {
    id: 'unibet_tcou_4_5',
    key: 'TCOU',
    name: 'Total cartonașe',
    period: 'fulltime',
    line: 4.5,
    selections: [
      { id: 'u1', name: 'Over 4.5', odds: 1.80, handicap: '4.5' },
      { id: 'u2', name: 'Under 4.5', odds: 2.10, handicap: '4.5' },
    ],
  };

  const cBetano = resolveContract(betanoCards);
  const cUnibet = resolveContract(unibetCards);

  assert.ok(cBetano, 'Betano cards must resolve to contract');
  assert.ok(cUnibet, 'Unibet cards must resolve to contract');

  assert.equal(cBetano.subject, 'cards');
  assert.equal(cUnibet.subject, 'cards');
  assert.equal(cBetano.lineKey, '4.5');
  assert.equal(cUnibet.lineKey, '4.5');

  const bKeyBetano = bucketKeyForContract(eventKey, cBetano);
  const bKeyUnibet = bucketKeyForContract(eventKey, cUnibet);

  assert.equal(bKeyBetano, bKeyUnibet, 'Betano and Unibet cards must produce identical bucket key');
  assert.equal(bKeyBetano, `${eventKey}::OVER_UNDER::fulltime::4.5::over+under::cards::match`);
});

test('team-side total goals: Unibet, Superbet, Betano, EveryMatrix, and FEG unify correctly', () => {
  const eventKey = 'soccer_belgium_turkey_20261017';
  const ctx = { homeTeam: 'Belgia', awayTeam: 'Turcia' };

  // 1. Superbet Home & Away team totals (detail market ids 544 & 535)
  const sbHome = {
    key: 'sb:544:Total goluri Belgia',
    name: 'Total goluri Belgia',
    team: 'home',
    period: 'fulltime',
    selections: [
      { id: 'sb_h_u', name: 'Sub 1.5', odds: 2.05 },
      { id: 'sb_h_o', name: 'Peste 1.5', odds: 1.80 },
    ],
  };
  const sbAway = {
    key: 'sb:535:Total goluri Turcia',
    name: 'Total goluri Turcia',
    team: 'away',
    period: 'fulltime',
    selections: [
      { id: 'sb_a_u', name: 'Sub 1.5', odds: 1.65 },
      { id: 'sb_a_o', name: 'Peste 1.5', odds: 2.25 },
    ],
  };

  // 2. Unibet Home & Away team totals
  const unibetHome = {
    key: 'TOTAL',
    name: 'Total Goluri Echipa 1',
    team: 'home',
    period: 'fulltime',
    line: 1.5,
    selections: [
      { id: 'u_h_o', name: 'Over 1.5', odds: 2.10, handicap: '1.5' },
      { id: 'u_h_u', name: 'Under 1.5', odds: 1.75, handicap: '1.5' },
    ],
  };
  const unibetAway = {
    key: 'TOTAL',
    name: 'Total Goluri Echipa 2',
    team: 'away',
    period: 'fulltime',
    line: 1.5,
    selections: [
      { id: 'u_a_o', name: 'Over 1.5', odds: 1.85, handicap: '1.5' },
      { id: 'u_a_u', name: 'Under 1.5', odds: 1.95, handicap: '1.5' },
    ],
  };

  // 3. Betano team totals (HTGOT / ATGOT or name-derived)
  const betanoHome = {
    key: 'HTGOT',
    name: 'Total goluri Gazde Peste/Sub',
    period: 'fulltime',
    selections: [
      { id: 'b_h_o', name: 'Peste 1.5', odds: 2.02, handicap: 1.5 },
      { id: 'b_h_u', name: 'Sub 1.5', odds: 1.82, handicap: 1.5 },
    ],
  };

  // 4. FEG team total (UFO:MTYP:00-10 Home)
  const fegHome = {
    key: 'UFO:MTYP:00-10',
    name: 'Echipa 1 Total goluri 1.5',
    period: 'fulltime',
    selections: [
      { id: 'f_h_o', name: '+ 1.5', odds: 2.08 },
      { id: 'f_h_u', name: '- 1.5', odds: 1.76 },
    ],
  };

  // 5. EveryMatrix team total (key TOTAL_GOALS with team: home)
  const emHome = {
    key: 'TOTAL_GOALS',
    name: 'Echipa 1 Total goluri 1.5',
    team: 'home',
    period: 'fulltime',
    selections: [
      { id: 'em_h_o', name: 'Peste 1.5', odds: 2.04 },
      { id: 'em_h_u', name: 'Sub 1.5', odds: 1.80 },
    ],
  };

  const cSbHome = resolveContract(sbHome, ctx);
  const cSbAway = resolveContract(sbAway, ctx);
  const cUnibetHome = resolveContract(unibetHome, ctx);
  const cUnibetAway = resolveContract(unibetAway, ctx);
  const cBetanoHome = resolveContract(betanoHome, ctx);
  const cFegHome = resolveContract(fegHome, ctx);
  const cEmHome = resolveContract(emHome, ctx);

  assert.ok(cSbHome && cSbAway && cUnibetHome && cUnibetAway && cBetanoHome && cFegHome && cEmHome);

  // All Home team totals must agree
  for (const c of [cSbHome, cUnibetHome, cBetanoHome, cFegHome, cEmHome]) {
    assert.equal(c.family, 'OVER_UNDER');
    assert.equal(c.subject, 'goals');
    assert.equal(c.team, 'home');
    assert.equal(c.period, 'fulltime');
    assert.equal(c.lineKey, '1.5');
  }

  // All Away team totals must agree
  for (const c of [cSbAway, cUnibetAway]) {
    assert.equal(c.family, 'OVER_UNDER');
    assert.equal(c.subject, 'goals');
    assert.equal(c.team, 'away');
    assert.equal(c.period, 'fulltime');
    assert.equal(c.lineKey, '1.5');
  }

  // Bucket keys for all home variants must be strictly identical
  const bKeyHome = `${eventKey}::OVER_UNDER::fulltime::1.5::over+under::goals::home`;
  assert.equal(bucketKeyForContract(eventKey, cSbHome), bKeyHome);
  assert.equal(bucketKeyForContract(eventKey, cUnibetHome), bKeyHome);
  assert.equal(bucketKeyForContract(eventKey, cBetanoHome), bKeyHome);
  assert.equal(bucketKeyForContract(eventKey, cFegHome), bKeyHome);
  assert.equal(bucketKeyForContract(eventKey, cEmHome), bKeyHome);

  // Home vs Away and Home vs Match must never collide
  const bKeyAway = `${eventKey}::OVER_UNDER::fulltime::1.5::over+under::goals::away`;
  assert.equal(bucketKeyForContract(eventKey, cSbAway), bKeyAway);
  assert.equal(bucketKeyForContract(eventKey, cUnibetAway), bKeyAway);
  assert.notEqual(bKeyHome, bKeyAway, 'Home team totals must never bucket with Away team totals');

  const cMatch = resolveContract({
    key: 'TOTAL_GOALS',
    name: 'Total goluri 1.5',
    period: 'fulltime',
    selections: [{ name: 'Peste 1.5' }, { name: 'Sub 1.5' }],
  });
  const bKeyMatch = bucketKeyForContract(eventKey, cMatch);
  assert.notEqual(bKeyHome, bKeyMatch, 'Home team totals must never bucket with Match totals');
});

test('engine arbitrage pairing: generates cross-book proposition arbitrage opportunities', () => {
  const fixtureKey = 'football|premier-league|2026-10-20t19:00:00z|arsenal|chelsea';
  // Construct two cross-book event instances on the same fixture
  const betanoEvent = {
    id: 'b_ev1',
    eventKey: fixtureKey,
    sourceId: 'betano',
    sport: 'Football',
    league: 'Premier League',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    kickoff: '2026-10-20T19:00:00Z',
    markets: [
      // Corners: Betano offers Under 9.5 @ 2.05
      {
        key: 'CNOU',
        name: 'Cornere Peste/Sub',
        period: 'fulltime',
        selections: [
          { id: 'b_c_o', name: 'Peste 9.5', odds: 1.85, handicap: 9.5 },
          { id: 'b_c_u', name: 'Sub 9.5', odds: 2.05, handicap: 9.5 },
        ],
      },
      // Team Total: Betano offers Home Under 1.5 @ 2.10
      {
        key: 'HTGOT',
        name: 'Total goluri Gazde Peste/Sub',
        period: 'fulltime',
        selections: [
          { id: 'b_tt_o', name: 'Peste 1.5', odds: 1.80, handicap: 1.5 },
          { id: 'b_tt_u', name: 'Sub 1.5', odds: 2.10, handicap: 1.5 },
        ],
      },
    ],
  };

  const unibetEvent = {
    id: 'u_ev1',
    eventKey: fixtureKey,
    sourceId: 'unibet',
    sport: 'Football',
    league: 'Premier League',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    kickoff: '2026-10-20T19:00:00Z',
    markets: [
      // Corners: Unibet offers Over 9.5 @ 2.05
      {
        key: 'CNOU',
        name: 'Total cornere',
        period: 'fulltime',
        line: 9.5,
        selections: [
          { id: 'u_c_o', name: 'Over 9.5', odds: 2.05, handicap: '9.5' },
          { id: 'u_c_u', name: 'Under 9.5', odds: 1.85, handicap: '9.5' },
        ],
      },
      // Team Total: Unibet offers Home Over 1.5 @ 2.05
      {
        key: 'TOTAL',
        name: 'Total Goluri Echipa 1',
        team: 'home',
        period: 'fulltime',
        line: 1.5,
        selections: [
          { id: 'u_tt_o', name: 'Over 1.5', odds: 2.05, handicap: '1.5' },
          { id: 'u_tt_u', name: 'Under 1.5', odds: 1.80, handicap: '1.5' },
        ],
      },
    ],
  };

  const grouped = groupByEvent([betanoEvent, unibetEvent]);
  const arbs = findArbitrage(grouped);

  assert.ok(arbs.length >= 2, `expected at least 2 proposition arbs, got ${arbs.length}`);

  const cornersArb = arbs.find((a) => a.subject === 'corners');
  assert.ok(cornersArb, 'must generate corners proposition arb');
  assert.equal(cornersArb.family, 'OVER_UNDER');
  assert.equal(cornersArb.line, '9.5');
  assert.equal(cornersArb.subject, 'corners');
  assert.ok(cornersArb.marginPercent > 0, 'corners arb must have positive profit margin');
  assert.equal(cornersArb.legs.length, 2);
  const cornersSources = new Set(cornersArb.legs.map((l) => l.sourceId));
  assert.ok(cornersSources.has('betano') && cornersSources.has('unibet'), 'must pair Betano against Unibet');

  const teamTotalArb = arbs.find((a) => a.subject === 'goals' && a.team === 'home');
  assert.ok(teamTotalArb, 'must generate team-side goal total arb');
  assert.equal(teamTotalArb.family, 'OVER_UNDER');
  assert.equal(teamTotalArb.line, '1.5');
  assert.equal(teamTotalArb.team, 'home');
  assert.ok(teamTotalArb.marginPercent > 0, 'team total arb must have positive profit margin');
  assert.equal(teamTotalArb.legs.length, 2);
  const ttSources = new Set(teamTotalArb.legs.map((l) => l.sourceId));
  assert.ok(ttSources.has('betano') && ttSources.has('unibet'), 'must pair Betano against Unibet for team total');
});

/**
 * Side detection reads the team's name out of the market text, and the two
 * spellings of that name do not have to agree. On the 2026-10-22 board favbet
 * published "Total individual Osters IF" (ASCII) on an event whose own awayTeam
 * is "Östers IF"; the exact, case-sensitive substring test failed, teamFor fell
 * through to its `match` default, and a ONE-TEAM total was bucketed AS the match
 * total. The engine then priced "Over @2.06" off that team total against
 * excelbet's match "Under 1.5 @4.9", which is the published 31.05% "arbitrage"
 * (and 8 more like it, up to 37.97%).
 *
 * Written against the engine rather than the resolver alone: a resolver that
 * answers `away` while the engine still pairs them is exactly what published.
 */
test('a one-team total spelled differently from the event team cannot bucket as a match total', () => {
  const eventKey = 'football|2026-10-24T15:00:00.000Z|ik brage|osters if';

  // favbet: the away team's own goals, named without the diacritic.
  const favbetTeamTotal = {
    key: 'OVER_UNDER_1_5',
    name: 'Total individual Osters IF',
    period: 'fulltime',
    selections: [
      { id: 'fav_tt_o', name: 'Over', odds: 2.06, handicap: 1.5 },
      { id: 'fav_tt_u', name: 'Under', odds: 1.73, handicap: 1.5 },
    ],
  };
  // excelbet: the match total on the same line, spelled its own way.
  const excelbetMatchTotal = {
    key: 'TOTAL_GOALS',
    name: 'TOTAL GOALS',
    period: 'fulltime',
    selections: [
      { id: 'exb_mt_o', name: 'Over 1.5', odds: 1.12 },
      { id: 'exb_mt_u', name: 'Under 1.5', odds: 4.9 },
    ],
  };

  // The fixture must describe an arbitrage-SHAPED pair, or the negative
  // assertion below would pass for the wrong reason.
  assert.ok(1 / 2.06 + 1 / 4.9 < 1, 'fixture must be an arbitrage-shaped pair before the scope check');

  const favbetCtx = { homeTeam: 'IK Brage', awayTeam: 'Östers IF' };
  const excelbetCtx = { homeTeam: 'IK Brage', awayTeam: 'Osters IF' };

  const teamContract = resolveContract(favbetTeamTotal, favbetCtx);
  const matchContract = resolveContract(excelbetMatchTotal, excelbetCtx);
  assert.ok(teamContract && matchContract);
  assert.equal(teamContract.team, 'away', 'the one-team total must resolve to the side it counts');
  assert.equal(teamContract.family, 'OVER_UNDER');
  assert.equal(matchContract.team, 'match');
  assert.notEqual(
    bucketKeyForContract(eventKey, teamContract),
    bucketKeyForContract(eventKey, matchContract),
    'a one-team total must never share a bucket with the match total',
  );

  const favbetEvent = { id: 'fav_ev', eventKey, sourceId: 'favbet', sport: 'Football', league: 'Superettan', homeTeam: 'IK Brage', awayTeam: 'Östers IF', kickoff: '2026-10-24T15:00:00.000Z', markets: [favbetTeamTotal] };
  const excelbetEvent = { id: 'exb_ev', eventKey, sourceId: 'excelbet', sport: 'Football', league: 'Superettan', homeTeam: 'IK Brage', awayTeam: 'Osters IF', kickoff: '2026-10-24T15:00:00.000Z', markets: [excelbetMatchTotal] };

  const arbs = findArbitrage(groupByEvent([favbetEvent, excelbetEvent]));
  assert.equal(arbs.length, 0, `a one-team total must not be priced against the match total, got ${arbs.length} arb(s)`);
});

test('a one-team total whose side cannot be named is refused, never defaulted to match', () => {
  const selections = [{ name: 'Over', odds: 2.06 }, { name: 'Under', odds: 1.73 }];
  // favbet's wording without a nameable side, and with no event context at all:
  // the two ways the side used to come back as `match`.
  const unnameable = resolveContract({ key: 'OVER_UNDER_1_5', name: 'Total individual', period: 'fulltime', selections }, { homeTeam: 'IK Brage', awayTeam: 'Östers IF' });
  const noContext = resolveContract({ key: 'OVER_UNDER_1_5', name: 'Total individual Östers IF', period: 'fulltime', selections }, {});
  assert.equal(unnameable, null, 'an unnameable one-team total must be refused, not filed as a match total');
  assert.equal(noContext, null, 'a one-team total with no event context must be refused');

  // The refusal must not swallow the genuine match total it used to collide with.
  const match = resolveContract({ key: 'TOTAL_GOALS', name: 'Peste / Sub', period: 'fulltime', selections: [{ name: 'Over 1.5' }, { name: 'Under 1.5' }] }, { homeTeam: 'IK Brage', awayTeam: 'Östers IF' });
  assert.ok(match, 'a plain match total must still resolve');
  assert.equal(match.team, 'match');
});

