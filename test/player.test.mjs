import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import EveryMatrixWampScraper from '../src/scrapers/everymatrix-wamp.mjs';
import PlayerScraper from '../src/scrapers/player.mjs';
import { isFullTimeMarket } from '../src/scanner/market-contracts.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'player');

const FUTURE = Date.parse('2030-01-01T12:00:00Z');

function makeScraper() {
  const s = new PlayerScraper({ dataDir: 'data' });
  s._lastObservedAt = '2026-10-11T00:00:00.000Z';
  s._lastSourceUrl = 'wss://api.player.ro/v2';
  return s;
}

function makeMatch(overrides = {}) {
  return {
    id: 900001,
    startTime: FUTURE,
    homeParticipantName: 'FCSB',
    awayParticipantName: 'Dinamo',
    parentName: 'Liga 1',
    ...overrides,
  };
}

function oneXTwoRecords(s, { homeOdds = 2.15, drawOdds = 3.35, awayOdds = 3.45 } = {}) {
  const type = s.oneXTwoTypeId;
  return [
    { _type: 'MARKET', id: 500, bettingTypeId: type, displayName: 'Final - Timp regulamentar.' },
    { _type: 'OUTCOME', id: 11, typeName: 'Home', paramParticipantName1: 'FCSB' },
    { _type: 'OUTCOME', id: 12, typeName: 'Draw' },
    { _type: 'OUTCOME', id: 13, typeName: 'Away', paramParticipantName1: 'Dinamo' },
    { _type: 'BETTING_OFFER', id: 21, bettingTypeId: type, outcomeId: 11, odds: homeOdds, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 22, bettingTypeId: type, outcomeId: 12, odds: drawOdds, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 23, bettingTypeId: type, outcomeId: 13, odds: awayOdds, isAvailable: true },
  ];
}

test('player: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('player: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['everymatrix-odds-wamp', 'everymatrix-odds-wamp', 'player.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('player: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('player', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'player');
  assert.ok(scraper instanceof EveryMatrixWampScraper);
  assert.ok(scraper instanceof PlayerScraper);
});

test('player: addresses its specific dealer endpoint, realm and operatorId', () => {
  const s = makeScraper();
  assert.equal(s.wsUrl, 'wss://api.player.ro/v2');
  assert.equal(s.realm, 'www.player.ro');
  assert.equal(s.origin, 'https://sports2.player.ro');
  assert.equal(s.operatorId, '2474');
  assert.equal(s.siteBaseUrl, 'https://sports2.player.ro');
  assert.equal(s.sport, 'Football');
  assert.equal(s.sportId, '1');
});

test('player: topic URLs carry the dealer identity and operator 2474', () => {
  const s = makeScraper();
  assert.match(s.tournamentListTopic(), /\/2474\//);
  assert.match(s.tournamentListTopic(), /\/1\//);
  assert.match(s.aggregatorTopic(1234), /tournament-aggregator-groups-overview\/1234/);
  assert.match(s.matchOddsTopic(900001), /900001/);
});

test('player: extractEvents emits a full-time 1X2 with three distinct outcomes and player sourceId', () => {
  const s = makeScraper();
  const [ev] = s.extractEvents([{ match: makeMatch(), records: oneXTwoRecords(s) }]);
  assert.ok(ev, 'a complete regulation-time market yields an event');
  assert.equal(ev.sourceId, 'player');
  assert.equal(ev.sport, 'Football');
  assert.equal(ev.league, 'Liga 1');
  assert.equal(ev.homeTeam, 'FCSB');
  assert.equal(ev.awayTeam, 'Dinamo');
  assert.equal(ev.kickoff, new Date(FUTURE).toISOString());
  assert.equal(ev.markets[0].key, 'MATCH_ODDS');
  assert.equal(isFullTimeMarket(ev.markets[0]), true, 'an absent period is treated as full-time');
  const names = ev.markets[0].selections.map((x) => x.name).sort();
  assert.deepEqual(names, ['1', '2', 'X']);
  for (const sel of ev.markets[0].selections) {
    assert.ok(sel.odds > 1, `odds must be usable, got ${sel.odds}`);
    assert.ok(sel.id, 'each selection keeps its provider id');
  }
});

test('player: extractEvents drops past matches or invalid participants', () => {
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  assert.equal(s.extractEvents([{ match: makeMatch({ startTime: Date.parse('2020-01-01T00:00:00Z') }), records }]).length, 0);
  assert.equal(s.extractEvents([{ match: makeMatch({ homeParticipantName: '' }), records }]).length, 0);
  assert.equal(s.extractEvents([{ match: makeMatch({ awayParticipantName: null }), records }]).length, 0);
});

test('player: extractEvents dedupes the same fixture', () => {
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  const out = s.extractEvents([
    { match: makeMatch(), records },
    { match: makeMatch({ id: 900002 }), records },
  ]);
  assert.equal(out.length, 1, 'same home/away/kickoff is one event');
});
