/**
 * engine-flawless.test.mjs — comprehensive regression suite for the engine,
 * contract resolver, verification, and scraper fixes from the flawless pass.
 *
 * Every guard is paired with a positive control where meaningful so a filter
 * that blindly rejects everything cannot pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventIdentityKey, normalizeClubIdentity } from '../src/shared/text.mjs';
import { resolveContract, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold } from '../src/scanner/engine.mjs';
import { loadWorkspace } from '../src/scanner/scanner.mjs';
import { verifySignal } from '../src/verification.mjs';
import FavbetScraper from '../src/scrapers/favbet.mjs';
import TotalBetPlScraper from '../src/scrapers/totalbet-pl.mjs';
import BetfairScraper from '../src/scrapers/betfair.mjs';
import LvbetScraper from '../src/scrapers/lvbet.mjs';
import BetfanScraper from '../src/scrapers/betfan.mjs';

const KICKOFF = '2026-11-12T19:00:00.000Z';

function ev(sourceId, markets, extra = {}) {
  const sport = extra.sport || 'Football';
  const league = extra.league || 'Serie A';
  const homeTeam = extra.homeTeam || 'AC Milan';
  const awayTeam = extra.awayTeam || 'Inter Milan';
  const kickoff = extra.kickoff || KICKOFF;
  return {
    sourceId,
    sport,
    league,
    homeTeam,
    awayTeam,
    kickoff,
    eventKey: eventIdentityKey({ sport, kickoff, homeTeam, awayTeam }),
    markets,
    ...extra,
  };
}

const oneXTwo = (key, h, d, a) => ({
  key,
  name: 'Match Result',
  selections: [{ name: '1', odds: h }, { name: 'X', odds: d }, { name: '2', odds: a }],
});

const total = (key, line, over, under) => ({
  key,
  name: `Total Goals ${line}`,
  selections: [
    { name: `Over ${line}`, odds: over, handicap: line },
    { name: `Under ${line}`, odds: under, handicap: line },
  ],
});

test('NBA and NHL city-ticker spellings resolve to one club identity', () => {
  assert.equal(normalizeClubIdentity('CHA Hornets'), normalizeClubIdentity('Charlotte Hornets'));
  assert.equal(normalizeClubIdentity('MIL Bucks'), normalizeClubIdentity('Milwaukee Bucks'));
  assert.equal(normalizeClubIdentity('SA Spurs'), normalizeClubIdentity('San Antonio Spurs'));
  assert.equal(normalizeClubIdentity('VGK Golden Knights'), normalizeClubIdentity('Vegas Golden Knights'));
  assert.equal(normalizeClubIdentity('TBL Lightning'), normalizeClubIdentity('Tampa Bay Lightning'));
  assert.notEqual(normalizeClubIdentity('CHA Hornets'), normalizeClubIdentity('Milwaukee Bucks'));
});

test('an overtime-inclusive winner is its own period, never regulation full time', () => {
  const ctx = { homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', sport: 'Basketball' };
  const sides = [{ name: 'Boston Celtics', odds: 1.95 }, { name: 'Miami Heat', odds: 2.15 }];
  const ot = resolveContract({ key: 'MONEYLINE', name: 'Winner (Including Overtime)', selections: sides }, ctx);
  const plOt = resolveContract({ key: 'MONEYLINE', name: 'Zwycięzca (z dogrywką)', selections: sides }, ctx);
  const reg = resolveContract({ key: 'MONEYLINE', name: 'Winner (regular time)', selections: sides }, ctx);
  const plReg = resolveContract({ key: 'MONEYLINE', name: 'Zwycięzca (bez dogrywki)', selections: sides }, ctx);
  assert.equal(ot?.period, 'fulltime_ot');
  assert.equal(plOt?.period, 'fulltime_ot');
  assert.notEqual(reg?.period, 'fulltime_ot');
  assert.notEqual(plReg?.period, 'fulltime_ot');
});

test('an overtime winner and a regulation winner never pair into a surebet', () => {
  const base = { sport: 'Basketball', league: 'NBA', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat' };
  const grouped = groupByEvent([
    ev('betano', [{ key: 'MONEYLINE', name: 'Winner (Including Overtime)', selections: [
      { name: 'Boston Celtics', odds: 2.4 }, { name: 'Miami Heat', odds: 1.6 }] }], base),
    ev('unibet', [{ key: 'MONEYLINE', name: 'Winner (regular time)', selections: [
      { name: 'Boston Celtics', odds: 1.6 }, { name: 'Miami Heat', odds: 2.4 }] }], base),
  ]);
  assert.equal(findArbitrage(grouped, { minMarginPercent: 0 }).length, 0);

  const controlGrouped = groupByEvent([
    ev('betano', [{ key: 'MONEYLINE', name: 'Winner (Including Overtime)', selections: [
      { name: 'Boston Celtics', odds: 2.4 }, { name: 'Miami Heat', odds: 1.6 }] }], base),
    ev('unibet', [{ key: 'MONEYLINE', name: 'Winner (Including Overtime)', selections: [
      { name: 'Boston Celtics', odds: 1.6 }, { name: 'Miami Heat', odds: 2.4 }] }], base),
  ]);
  assert.equal(findArbitrage(controlGrouped, { minMarginPercent: 0 }).length, 1);
});

test('clubs whose names start with digits route by team name across MATCH_ODDS and ASIAN_HANDICAP', () => {
  const ctx = { homeTeam: '1899 Hoffenheim', awayTeam: '1. FC Köln', sport: 'Football' };
  const ml = resolveContract({
    key: 'MONEYLINE',
    name: 'Winner',
    selections: [{ name: '1899 Hoffenheim', odds: 2.2 }, { name: '1. FC Köln', odds: 1.75 }],
  }, ctx);
  assert.ok(ml);
  assert.equal(canonicalOutcomeFor('1899 Hoffenheim', ml, ctx), 'home');
  assert.equal(canonicalOutcomeFor('1. FC Köln', ml, ctx), 'away');

  const ah = resolveContract({
    key: 'ASIAN_HANDICAP',
    name: 'Asian Handicap',
    line: -0.5,
    selections: [
      { name: '1899 Hoffenheim (-0.5)', odds: 2.05, handicap: -0.5 },
      { name: '1. FC Köln (+0.5)', odds: 1.85, handicap: 0.5 },
    ],
  }, ctx);
  assert.equal(ah?.family, 'ASIAN_HANDICAP');
  assert.equal(canonicalOutcomeFor('1899 Hoffenheim (-0.5)', ah, ctx), 'home');
  assert.equal(canonicalOutcomeFor('1. FC Köln (+0.5)', ah, ctx), 'away');
});

test('a 2-way whole-number handicap never misclassifies as MATCH_ODDS', () => {
  const ctx = { homeTeam: 'Lakers', awayTeam: 'Warriors', sport: 'Basketball' };
  const spread = resolveContract({
    key: 'SPREAD_CUSTOM',
    name: 'Point Handicap',
    selections: [
      { name: 'Lakers -4', odds: 1.91, handicap: -4 },
      { name: 'Warriors +4', odds: 1.91, handicap: 4 },
    ],
  }, ctx);
  assert.notEqual(spread?.family, 'MATCH_ODDS');
});

test('+EV pairs a provider-opaque 1X2 with named keys, and one clone cluster casts one vote', () => {
  const grouped = groupByEvent([
    ev('betano', [oneXTwo('MR12', 2.45, 3.3, 3.0)]),
    ev('unibet', [oneXTwo('MATCH_ODDS', 2.0, 3.4, 3.8)]),
    ev('favbet', [oneXTwo('1X2', 2.0, 3.4, 3.8)]),
    ev('magnumbet', [oneXTwo('1X2', 1.6, 3.9, 5.5)]),
    ev('winboss', [oneXTwo('1X2', 1.6, 3.9, 5.5)]),
    ev('cashpot', [oneXTwo('1X2', 1.6, 3.9, 5.5)]),
  ]);
  const rows = findPositiveEV(grouped, { minEvPercent: 3 });
  const betanoHome = rows.find((r) => r.sourceId === 'betano' && r.selection === '1');
  assert.ok(betanoHome, 'Betano MR12 must reach the same bucket as MATCH_ODDS and 1X2');
  // Votes: unibet (0.5), favbet (0.5), exalogic cluster as ONE (0.625) -> median = 0.5
  assert.equal(betanoHome.consensusProbability, 0.5);
});

test('+EV ignores empty exchange ladders and applies Power Devigging on heavy-favorite/longshot lines', () => {
  // 1. Empty exchange ladder (inverse sum 1.79 > 1.25 ceiling)
  const emptyLadder = groupByEvent([
    ev('betfair', [total('OVER_UNDER_0_5', 0.5, 1.08, 1.15)]),
    ev('magnumbet', [total('OVER_UNDER_0_5', 0.5, 1.05, 6.6)]),
  ]);
  assert.deepEqual(
    findPositiveEV(emptyLadder, { minEvPercent: 2, devig: true }).filter((r) => r.selection === 'Under 0.5'),
    [],
  );

  // 2. Favorite-longshot bias: retail 1.01 / 14.0 vs exchange 1.01 / 50.0.
  // Naive proportional devigging gave Under 0.5 a 6.73% probability (+236% EV).
  // Power devigging recognizes almost all vig sits on the 14.0 longshot (~1.57% fair -> 50.0 is NOT +EV).
  const longshotBias = groupByEvent([
    ev('gameworld', [total('OVER_UNDER_0_5', 0.5, 1.01, 14.0)]),
    ev('betfair', [total('OVER_UNDER_0_5', 0.5, 1.01, 50.0)]),
  ]);
  assert.deepEqual(
    findPositiveEV(longshotBias, { minEvPercent: 2, devig: true }).filter((r) => r.selection === 'Under 0.5'),
    [],
  );

  // 3. Control: genuine +EV on a balanced total still surfaces cleanly.
  const control = groupByEvent([
    ev('betano', [total('OVER_UNDER_2_5', 2.5, 1.91, 1.91)]),
    ev('unibet', [total('OVER_UNDER_2_5', 2.5, 1.91, 1.91)]),
    ev('favbet', [total('OVER_UNDER_2_5', 2.5, 2.15, 1.72)]),
  ]);
  const controlRows = findPositiveEV(control, { minEvPercent: 2, devig: true });
  assert.ok(controlRows.some((r) => r.sourceId === 'favbet' && r.selection === 'Over 2.5'));
});

test('findLowHold ignores degraded 2-of-3 Double Chance markets while keeping real thin-hold markets', () => {
  const grouped = groupByEvent([
    ev('fortuna', [{
      key: 'ufo:mtyp:00-01',
      name: 'Double Chance',
      selections: [{ name: '1X', odds: 1.95 }, { name: '12', odds: 1.98 }],
    }]),
    ev('betano', [total('OVER_UNDER_2_5', 2.5, 1.97, 1.97)]),
  ]);
  const lows = findLowHold(grouped, { maxHoldPercent: 4 });
  assert.equal(lows.length, 1);
  assert.equal(lows[0].sourceId, 'betano');
});

test('a middle is published once per independent feed pair, not once per clone brand', () => {
  const grouped = groupByEvent([
    ev('betano', [total('OVER_UNDER_2_5', 2.5, 2.3, 1.65)]),
    ev('magnumbet', [total('OVER_UNDER_3_5', 3.5, 3.3, 1.95)]),
    ev('winboss', [total('OVER_UNDER_3_5', 3.5, 3.3, 1.95)]),
    ev('cashpot', [total('OVER_UNDER_3_5', 3.5, 3.3, 1.95)]),
  ]);
  const middles = findMiddles(grouped, { maxMiddleRiskPercent: 100, minMiddleRoiPercent: 0 });
  const overUnder = middles.filter((m) => m.legs.some((l) => l.sourceId === 'betano'));
  assert.equal(overUnder.length, 1);
});

test('verification rejects shared feeds, rejects subject drift, handles null confirmationScan, and confirms middles', () => {
  const eventKey = 'football|2026-11-12T19:00:00.000Z|ac milan|inter milan';
  const shared = verifySignal({
    type: 'arb',
    eventKey,
    marketKey: 'OVER_UNDER_2_5',
    legs: [
      { sourceId: 'magnumbet', selection: 'Over 2.5', odds: 2.1 },
      { sourceId: 'winboss', selection: 'Under 2.5', odds: 2.05 },
    ],
  }, null, { index: new Map() });
  assert.equal(shared.status, 'rejected');
  assert.equal(shared.reason, 'legs share upstream feed');

  const key = (mKey, sel) => `${eventKey}::${mKey}::prematch::${sel.toLowerCase()}`;
  const index = new Map([
    [key('OVER_UNDER_2_5', 'Over 2.5'), [{ sourceId: 'betano', handicap: null, odds: 2.1, subject: 'goals', team: 'match' }]],
    [key('OVER_UNDER_2_5', 'Under 2.5'), [{ sourceId: 'unibet', handicap: null, odds: 2.05, subject: 'corners', team: 'match' }]],
  ]);
  const target = {
    type: 'arb',
    eventKey,
    marketKey: 'OVER_UNDER_2_5',
    family: 'OVER_UNDER',
    period: 'fulltime',
    line: '2.5',
    subject: 'goals',
    legs: [
      { sourceId: 'betano', selection: 'Over 2.5', odds: 2.1 },
      { sourceId: 'unibet', selection: 'Under 2.5', odds: 2.05 },
    ],
  };
  const drifted = verifySignal(target, null, { index });
  assert.equal(drifted.status, 'rejected');
  assert.equal(drifted.reason, 'unibet leg re-quoted from corners-subject, not goals-subject');

  // Control with null confirmationScan: confirms cleanly and returns rounded allocation
  index.set(key('OVER_UNDER_2_5', 'Under 2.5'), [{ sourceId: 'unibet', handicap: null, odds: 2.05, subject: 'goals', team: 'match' }]);
  const clean = verifySignal(target, null, { index });
  assert.equal(clean.status, 'confirmed');
  assert.ok(clean.allocation?.guaranteedProfit > 0);

  // Middle verification (speculative and arb-middle)
  const middleIndex = new Map([
    [key('OVER_UNDER_2_5', 'Over 2.5'), [{ sourceId: 'betano', handicap: 2.5, odds: 2.15, subject: 'goals', team: 'match' }]],
    [key('OVER_UNDER_3_5', 'Under 3.5'), [{ sourceId: 'unibet', handicap: 3.5, odds: 2.05, subject: 'goals', team: 'match' }]],
  ]);
  const arbMiddle = verifySignal({
    type: 'middle',
    arb: true,
    marginPercent: 3.5,
    eventKey,
    marketKey: 'OVER_UNDER_2_5',
    family: 'OVER_UNDER',
    period: 'fulltime',
    subject: 'goals',
    legs: [
      { sourceId: 'betano', marketKey: 'OVER_UNDER_2_5', selection: 'Over 2.5', handicap: 2.5, odds: 2.15 },
      { sourceId: 'unibet', marketKey: 'OVER_UNDER_3_5', selection: 'Under 3.5', handicap: 3.5, odds: 2.05 },
    ],
  }, null, { index: middleIndex });
  assert.equal(arbMiddle.status, 'confirmed');
  assert.ok(arbMiddle.allocation?.guaranteedProfit > 0);
});

test('a Betfair capture with Unknown league pairs at exact kickoff but never across 3h drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-betfair-'));
  try {
    await mkdir(join(dir, 'workspace'), { recursive: true });
    const capturedAt = new Date().toISOString();
    const kickoff = new Date(Date.now() + 7200_000).toISOString();
    const laterKickoff = new Date(Date.now() + 7200_000 + 3 * 3600_000).toISOString();
    const snapshot = (sourceId, events) => JSON.stringify({
      sourceId, runId: 'run-1', capturedAt, sourceUrl: `https://${sourceId}.example/`, transport: 'http', events,
    });
    await writeFile(join(dir, 'workspace', 'betfair_events.json'), snapshot('betfair', [
      {
        sport: 'Football', homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoff,
        eventKey: eventIdentityKey({ sport: 'Football', kickoff, homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
        markets: [oneXTwo('MATCH_ODDS', 2.2, 3.5, 3.6)],
      },
      {
        sport: 'Football', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', kickoff: laterKickoff,
        eventKey: eventIdentityKey({ sport: 'Football', kickoff: laterKickoff, homeTeam: 'Real Madrid', awayTeam: 'Barcelona' }),
        markets: [oneXTwo('MATCH_ODDS', 2.1, 3.6, 3.4)],
      },
    ]));
    await writeFile(join(dir, 'workspace', 'betano_events.json'), snapshot('betano', [
      {
        sport: 'Football', league: 'Premier League', homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoff,
        eventKey: eventIdentityKey({ sport: 'Football', kickoff, homeTeam: 'Arsenal', awayTeam: 'Chelsea' }),
        markets: [oneXTwo('1X2', 2.05, 3.4, 3.5)],
      },
      {
        sport: 'Football', league: 'La Liga', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', kickoff,
        eventKey: eventIdentityKey({ sport: 'Football', kickoff, homeTeam: 'Real Madrid', awayTeam: 'Barcelona' }),
        markets: [oneXTwo('1X2', 2.0, 3.5, 3.5)],
      },
    ]));
    const ws = await loadWorkspace(dir);
    const groups = [...groupByEvent(ws.events).values()];
    const arsenalGroup = groups.find((g) => g.some((e) => e.homeTeam === 'Arsenal') && g.length === 2);
    assert.ok(arsenalGroup, 'exact-kickoff Betfair Unknown league must pair with Premier League');
    const madridMultiBook = groups.find((g) => g.some((e) => e.homeTeam === 'Real Madrid') && g.length === 2);
    assert.equal(madridMultiBook, undefined, '3h kickoff drift must not pair when league is Unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scrapers preserve subject, sport, competition, and overtime settlement periods', () => {
  const futureEpochSec = Math.floor(Date.now() / 1000) + 7200;
  const futureIso = new Date(futureEpochSec * 1000).toISOString();

  // 1. Favbet: Corners/Cards O/U isolated from Goals O/U, plus Cu prelungiri -> fulltime_ot
  const favbet = new FavbetScraper();
  const favEvents = favbet.extractEvents({
    markets: [
      {
        event: {
          event_id: 901,
          sport_id: 1,
          event_dt: futureEpochSec,
          tournament_name: 'Serie A',
          event_status_type: 'notstarted',
          participants: [
            { participant_number: 1, participant_name: 'AC Milan' },
            { participant_number: 2, participant_name: 'Inter' },
          ],
        },
        markets: [
          {
            market_id: 1,
            market_template_id: 1,
            market_name: '1X2',
            market_suspend: false,
            result_type_name: 'Timp Regulamentar',
            outcomes: [
              { outcome_id: 11, outcome_tag: '1', outcome_coef: 2.1 },
              { outcome_id: 12, outcome_tag: 'X', outcome_coef: 3.3 },
              { outcome_id: 13, outcome_tag: '2', outcome_coef: 3.5 },
            ],
          },
          {
            market_id: 2,
            market_template_id: 999,
            market_name: 'Cornere Peste/Sub 9.5',
            market_suspend: false,
            result_type_name: 'Timp Regulamentar',
            outcomes: [
              { outcome_id: 21, outcome_name: 'Peste 9.5', outcome_param: '9.5', outcome_coef: 1.85 },
              { outcome_id: 22, outcome_name: 'Sub 9.5', outcome_param: '9.5', outcome_coef: 1.95 },
            ],
          },
          {
            market_id: 3,
            market_template_id: 998,
            market_name: 'Cartonașe Peste/Sub 4.5',
            market_suspend: false,
            result_type_name: 'Timp Regulamentar',
            outcomes: [
              { outcome_id: 31, outcome_name: 'Peste 4.5', outcome_param: '4.5', outcome_coef: 1.9 },
              { outcome_id: 32, outcome_name: 'Sub 4.5', outcome_param: '4.5', outcome_coef: 1.9 },
            ],
          },
        ],
      },
      {
        event: {
          event_id: 902,
          sport_id: 2,
          sport_name: 'Basketball',
          event_dt: futureEpochSec,
          tournament_name: 'NBA',
          event_status_type: 'notstarted',
          participants: [
            { participant_number: 1, participant_name: 'Boston Celtics' },
            { participant_number: 2, participant_name: 'Miami Heat' },
          ],
        },
        markets: [
          {
            market_id: 4,
            market_template_id: 206,
            market_name: 'Câștigător meci',
            market_suspend: false,
            result_type_name: 'Cu prelungiri',
            outcomes: [
              { outcome_id: 41, outcome_tag: '1', outcome_coef: 1.65 },
              { outcome_id: 42, outcome_tag: '2', outcome_coef: 2.25 },
            ],
          },
        ],
      },
    ],
  });
  const favSoccer = favEvents.find((e) => e.id === '901');
  assert.ok(favSoccer.markets.some((m) => m.key === 'CORNERS_OVER_UNDER_9_5' && m.subject === 'corners'));
  assert.ok(favSoccer.markets.some((m) => m.key === 'CARDS_OVER_UNDER_4_5' && m.subject === 'cards'));
  const favBball = favEvents.find((e) => e.id === '902');
  assert.equal(favBball?.markets[0]?.period, 'fulltime_ot');

  // 2. TotalBet PL: extracts Tennis via ev.path[0].name AND 2-way Zwycięzca market
  const totalbet = new TotalBetPlScraper();
  const tbEvents = totalbet.extractEvents([
    {
      uuid: 'tb-tennis-1',
      start_at: futureIso,
      path: [{ name: 'Tenis' }, { name: 'ATP' }],
      tournament: { name: 'ATP Rome' },
      participants: [{ name: 'Jannik Sinner' }, { name: 'Carlos Alcaraz' }],
      markets: [
        {
          name: 'Zwycięzca meczu',
          game_type: 'twoway',
          outcomes: [
            { name: 'Jannik Sinner', sort: 1, odds: 1.85 },
            { name: 'Carlos Alcaraz', sort: 2, odds: 1.98 },
          ],
        },
      ],
    },
  ]);
  assert.equal(tbEvents.length, 1);
  assert.equal(tbEvents[0].sport, 'tennis');
  assert.equal(tbEvents[0].markets[0].key, 'MATCH_ODDS');

  // 3. Betfair: propagates competition name from search attachments onto normalized events
  const betfair = new BetfairScraper();
  const bfNorm = betfair.normalize({
    search: {
      results: [{ eventId: '33001', competitionId: '12204313', marketId: '1.234' }],
      attachments: { competitions: { '12204313': { name: 'SuperLiga' } } },
    },
    byMarket: {
      eventTypes: [
        {
          eventTypeId: 1,
          eventNodes: [
            {
              eventId: 33001,
              event: { eventName: 'FCSB v Dinamo', openDate: futureIso },
              marketNodes: [],
            },
          ],
        },
      ],
    },
  });
  assert.equal(bfNorm[0]?.competition, 'SuperLiga');

  // 4. LVBET & Betfan: stamp fulltime_ot on overtime-inclusive Basketball winners
  const lvbet = new LvbetScraper({ sport: 'all' });
  const lvEvents = lvbet.extractEvents([
    {
      match_id: 'lv-1',
      date: futureIso,
      sport: 'basketball',
      home: 'Lakers',
      away: 'Celtics',
      markets: [
        {
          markets_class_id: 7113,
          name: 'Money Line (Including Overtime)',
          selections: [
            { order: 0, name: 'Lakers', rate: { decimal: 1.9 } },
            { order: 1, name: 'Celtics', rate: { decimal: 1.92 } },
          ],
        },
      ],
    },
  ]);
  assert.equal(lvEvents[0]?.markets[0]?.period, 'fulltime_ot');

  const betfan = new BetfanScraper({ sport: 'all' });
  const bfPlEvents = betfan.extractEvents([
    {
      id: 'bfpl-1',
      start: futureEpochSec * 1000,
      type: 1,
      category1Name: 'Basketball',
      participants: [{ name: 'Lakers' }, { name: 'Celtics' }],
      games: [
        {
          type: 202,
          name: 'Zwycięzca (z dogrywką)',
          outcomes: [
            { name: 'Lakers', odds: 1.9 },
            { name: 'Celtics', odds: 1.92 },
          ],
        },
      ],
    },
  ]);
  assert.equal(bfPlEvents[0]?.markets[0]?.period, 'fulltime_ot');
});
