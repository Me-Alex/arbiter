/**
 * Winmasters (winmasters) test suite.
 *
 * Verifies candidate routing, contract invariants, and parser behavior against
 * real capture fixture data (data/endpoints/captures/winmasters-odds-2026-10-11.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Winmasters, { WINMASTERS_SPORT_ID_MAP, WINMASTERS_SPORT_NAME_TO_ID } from '../src/scrapers/winmasters.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'winmasters');

const fixture = JSON.parse(
  readFileSync(new URL('../data/endpoints/captures/winmasters-odds-2026-10-11.json', import.meta.url), 'utf8')
);

test('winmasters: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('winmasters: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'winmasters.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('winmasters: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('winmasters', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'winmasters');
  assert.ok(scraper instanceof ScraperBase);
  assert.ok(scraper instanceof Winmasters);
});

test('winmasters: normalize extracts events from fixture envelope and raw shapes', () => {
  const scraper = new Winmasters();
  
  // Fixture envelope { provenance, raw: [...] }
  const fromEnvelope = scraper.normalize(fixture);
  assert.ok(Array.isArray(fromEnvelope));
  assert.equal(fromEnvelope.length, 8);

  // Direct array
  const fromArray = scraper.normalize(fixture.raw);
  assert.ok(Array.isArray(fromArray));
  assert.equal(fromArray.length, 8);

  // Wrapped under data { data: [...] }
  const fromData = scraper.normalize({ data: fixture.raw });
  assert.ok(Array.isArray(fromData));
  assert.equal(fromData.length, 8);

  // Wrapped under data.events { data: { events: [...] } }
  const fromDataEvents = scraper.normalize({ data: { events: fixture.raw } });
  assert.ok(Array.isArray(fromDataEvents));
  assert.equal(fromDataEvents.length, 8);
});

test('winmasters: normalize fails closed on invalid or error payloads', () => {
  const scraper = new Winmasters();
  assert.throws(() => scraper.normalize(null), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize('not-an-object'), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({}), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({ faultcode: 'ERR', faultstring: 'Upstream fault' }), { name: 'UpstreamError' });
  assert.throws(() => scraper.normalize({ status: 'error', error: 'Blocked by Cloudflare' }), { name: 'UpstreamError' });
});

test('winmasters: extractEvents collects pre-match football with complete 1X2 markets', () => {
  const scraper = new Winmasters({
    // generous window so all future test dates are admitted
    windowHours: 24 * 30,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  // Out of 8 events in fixture:
  // - 4 are valid future football matches
  // - 1 is live (Real Madrid - Barcelona) -> dropped
  // - 1 is basketball -> dropped
  // - 1 is incomplete (suspended Draw) -> dropped
  // - 1 is in the past (Liverpool - Everton) -> dropped
  assert.equal(events.length, 4, 'only the 4 valid future football events survive');

  const [e1, e2, e3, e4] = events;

  // Verify first match: Corvinul 1921 Hunedoara vs Voluntari
  assert.equal(e1.id, '40882761');
  assert.equal(e1.sourceId, 'winmasters');
  assert.equal(e1.sport, 'football');
  assert.equal(e1.homeTeam, 'Corvinul 1921 Hunedoara');
  assert.equal(e1.awayTeam, 'Voluntari');
  assert.equal(e1.league, 'Romania. Superliga');
  assert.equal(e1.kickoff, '2026-10-15T15:00:00.000Z');
  assert.equal(e1.live, false);
  assert.equal(e1.eventKey, eventIdentityKey(e1));
  assert.equal(e1.markets.length, 1);
  assert.equal(e1.markets[0].key, '1X2');
  assert.deepEqual(e1.markets[0].selections, [
    { name: '1', odds: 3.05 },
    { name: 'X', odds: 2.83 },
    { name: '2', odds: 2.46 },
  ]);

  // Verify second match: Sepsi OSK vs Dinamo București
  assert.equal(e2.homeTeam, 'Sepsi OSK');
  assert.equal(e2.awayTeam, 'Dinamo București');
  assert.deepEqual(e2.markets[0].selections, [
    { name: '1', odds: 2.20 },
    { name: 'X', odds: 3.30 },
    { name: '2', odds: 3.40 },
  ]);

  // Verify third match: Arsenal vs Chelsea (kickoff was epoch numeric)
  assert.equal(e3.homeTeam, 'Arsenal');
  assert.equal(e3.awayTeam, 'Chelsea');
  assert.equal(e3.kickoff, new Date(1792000000000).toISOString());
  assert.deepEqual(e3.markets[0].selections, [
    { name: '1', odds: 1.85 },
    { name: 'X', odds: 3.75 },
    { name: '2', odds: 4.20 },
  ]);

  // Verify fourth match: CFR Cluj vs Universitatea Craiova
  assert.equal(e4.homeTeam, 'CFR Cluj');
  assert.equal(e4.awayTeam, 'Universitatea Craiova');
  assert.deepEqual(e4.markets[0].selections, [
    { name: '1', odds: 2.10 },
    { name: 'X', odds: 3.25 },
    { name: '2', odds: 3.60 },
  ]);
});

test('winmasters: extractEvents admits live events when includeLive is true', () => {
  const scraper = new Winmasters({ includeLive: true, windowHours: 24 * 30 });
  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);
  
  const liveMatch = events.find((e) => e.homeTeam === 'Real Madrid' && e.awayTeam === 'Barcelona');
  assert.ok(liveMatch, 'live match admitted when includeLive is true');
  assert.equal(liveMatch.live, true);
  assert.equal(liveMatch.markets[0].live, true, 'markets stamped with live: true');
});

test('winmasters: extractEvents admits past matches when includePast is true', () => {
  const scraper = new Winmasters({ includePast: true, windowHours: 24 * 30 });
  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);
  
  const pastMatch = events.find((e) => e.homeTeam === 'Liverpool' && e.awayTeam === 'Everton');
  assert.ok(pastMatch, 'past match admitted when includePast is true');
});

test('winmasters: malformed kickoff drops single row without throwing', () => {
  const scraper = new Winmasters({ windowHours: 24 * 30 });
  const badEvent = { ...fixture.raw[0], D: 'invalid-date-string' };
  const goodEvent = { ...fixture.raw[1] };
  const events = scraper.extractEvents([badEvent, goodEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Sepsi OSK');
});

test('winmasters: maxEvents bounds extracted events', () => {
  const scraper = new Winmasters({ maxEvents: 2, windowHours: 24 * 30 });
  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);
  assert.equal(events.length, 2);
});

test('winmasters: also extracts standard Digitain matchBets format', () => {
  const scraper = new Winmasters({ windowHours: 24 * 30 });
  const digitainMatchBetsEvent = {
    idMatch: 99001,
    active: true,
    bettingStatus: true,
    sportName: { 42: 'Fotbal', 2: 'Football' },
    team1Name: { 42: 'FCSB', 2: 'FCSB' },
    team2Name: { 42: 'Rapid București', 2: 'Rapid Bucuresti' },
    matchDateTime: Date.now() + 86400000,
    tournamentName: { 42: 'Romania - Liga 1' },
    matchBets: [
      {
        idBet: 1,
        mbActive: true,
        mbDisplayName: { 42: 'Rezultat final' },
        mbOutcomes: [
          { mboActive: true, mboDisplayName: { 42: '1' }, mboOddValue: 2.05 },
          { mboActive: true, mboDisplayName: { 42: 'X' }, mboOddValue: 3.35 },
          { mboActive: true, mboDisplayName: { 42: '2' }, mboOddValue: 3.60 },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([digitainMatchBetsEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'FCSB');
  assert.equal(events[0].awayTeam, 'Rapid București');
  assert.deepEqual(events[0].markets[0].selections, [
    { name: '1', odds: 2.05 },
    { name: 'X', odds: 3.35 },
    { name: '2', odds: 3.60 },
  ]);
});

test('winmasters: fetchRaw handles errors and bounds payload safely', async () => {
  // Test non-200 HTTP response
  const scraper403 = new Winmasters({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(scraper403.fetchRaw(), { name: 'UpstreamError' });

  // Test non-JSON Content-Type
  const scraperHtml = new Winmasters({
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(scraperHtml.fetchRaw(), { name: 'ValidationError' });

  // Test successful fetch with mock
  const scraperOk = new Winmasters({
    fetchImpl: async () => {
      const jsonStr = JSON.stringify(fixture.raw);
      const bytes = Buffer.from(jsonStr);
      let read = false;
      return {
        ok: true,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (read) return { done: true };
              read = true;
              return { done: false, value: bytes };
            },
            cancel: async () => {},
          }),
        },
      };
    },
  });

  const raw = await scraperOk.fetchRaw();
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 8);
});

test('winmasters: WINMASTERS_SPORT_ID_MAP maps core sports and their IDs symmetrically', () => {
  assert.equal(WINMASTERS_SPORT_ID_MAP[1], 'football');
  assert.equal(WINMASTERS_SPORT_ID_MAP[2], 'basketball');
  assert.equal(WINMASTERS_SPORT_ID_MAP[3], 'tennis');
  assert.equal(WINMASTERS_SPORT_NAME_TO_ID['football'], 1);
  assert.equal(WINMASTERS_SPORT_NAME_TO_ID['basketball'], 2);
  assert.equal(WINMASTERS_SPORT_NAME_TO_ID['tennis'], 3);
});

test('winmasters: extractEvents extracts 2-way basketball moneyline market', () => {
  const scraper = new Winmasters({
    sport: 'basketball',
    windowHours: 24 * 30,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  assert.equal(events.length, 1, 'only basketball event extracted');
  const [bball] = events;
  assert.equal(bball.id, '40888888');
  assert.equal(bball.sport, 'basketball');
  assert.equal(bball.homeTeam, 'U-BT Cluj-Napoca');
  assert.equal(bball.awayTeam, 'CSM Oradea');
  assert.equal(bball.markets.length, 1);
  assert.equal(bball.markets[0].key, 'MATCH_ODDS');
  assert.deepEqual(bball.markets[0].selections, [
    { name: '1', odds: 1.45 },
    { name: '2', odds: 2.75 },
  ]);
});

test('winmasters: extractEvents with sport: all admits both football and basketball', () => {
  const scraper = new Winmasters({
    sport: 'all',
    windowHours: 24 * 30,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  // 4 football + 1 basketball = 5 valid prematch events
  assert.equal(events.length, 5);
  const sports = events.map((e) => e.sport);
  assert.ok(sports.includes('football'));
  assert.ok(sports.includes('basketball'));
});

test('winmasters: 2-way matchBets format extracts correctly for basketball/tennis', () => {
  const scraper = new Winmasters({ sport: 'tennis', windowHours: 24 * 30 });
  const digitainTennisEvent = {
    idMatch: 99002,
    active: true,
    bettingStatus: true,
    SId: 3,
    sportName: { 42: 'Tenis', 2: 'Tennis' },
    team1Name: { 42: 'Jannik Sinner', 2: 'Jannik Sinner' },
    team2Name: { 42: 'Carlos Alcaraz', 2: 'Carlos Alcaraz' },
    matchDateTime: Date.now() + 86400000,
    tournamentName: { 42: 'ATP Masters 1000' },
    matchBets: [
      {
        idBet: 1,
        mbActive: true,
        mbDisplayName: { 42: 'Castigator meci' },
        mbOutcomes: [
          { mboActive: true, mboDisplayName: { 42: '1' }, mboOddValue: 1.72 },
          { mboActive: true, mboDisplayName: { 42: '2' }, mboOddValue: 2.15 },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([digitainTennisEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'tennis');
  assert.equal(events[0].homeTeam, 'Jannik Sinner');
  assert.equal(events[0].awayTeam, 'Carlos Alcaraz');
  assert.equal(events[0].markets[0].key, 'MATCH_ODDS');
  assert.deepEqual(events[0].markets[0].selections, [
    { name: '1', odds: 1.72 },
    { name: '2', odds: 2.15 },
  ]);
});

test('winmasters: extracts sub-window period markets from Digitain event.S with deterministic bucket keys', () => {
  const scraper = new Winmasters({ sport: 'football', windowHours: 24 * 30 });
  const cardStakesEvent = {
    EId: 77881001,
    HT: 'Liverpool',
    AT: 'Manchester City',
    SN: 'Fotbal',
    CN: 'Premier League',
    D: '2026-10-25T18:00:00Z',
    S: [
      // Full-time 1X2 (GId: 1)
      { GId: 1, GN: 'Rezultat final', TeamSide: 1, F: 2.40, SS: false },
      { GId: 1, GN: 'Rezultat final', TeamSide: 0, F: 3.40, SS: false },
      { GId: 1, GN: 'Rezultat final', TeamSide: 2, F: 2.90, SS: false },
      // Half 1 1X2 (GId: 301)
      { GId: 301, GN: 'Rezultat Repriza 1', TeamSide: 1, F: 2.95, SS: false },
      { GId: 301, GN: 'Rezultat Repriza 1', TeamSide: 0, F: 2.10, SS: false },
      { GId: 301, GN: 'Rezultat Repriza 1', TeamSide: 2, F: 3.50, SS: false },
    ],
  };

  const [event] = scraper.extractEvents([cardStakesEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 2);

  const [ftMarket, htMarket] = event.markets;
  assert.equal(ftMarket.key, '1X2');
  assert.equal(ftMarket.period, 'fulltime');
  assert.deepEqual(ftMarket.selections.map((s) => s.odds), [2.40, 3.40, 2.90]);

  assert.equal(htMarket.key, '1X2');
  assert.equal(htMarket.period, 'half1');
  assert.deepEqual(htMarket.selections.map((s) => s.odds), [2.95, 2.10, 3.50]);

  const ftContract = resolveContract(ftMarket);
  const htContract = resolveContract(htMarket);
  assert.equal(ftContract.period, 'fulltime');
  assert.equal(htContract.period, 'half1');

  const ftBucket = bucketKeyForContract(event.eventKey, ftContract);
  const htBucket = bucketKeyForContract(event.eventKey, htContract);
  assert.match(ftBucket, /::fulltime::/);
  assert.match(htBucket, /::half1::/);
  assert.notEqual(ftBucket, htBucket);
});

test('winmasters: extracts sub-window period markets from Digitain matchBets with deterministic bucket keys', () => {
  const scraper = new Winmasters({ sport: 'basketball', windowHours: 24 * 30 });
  const bballMbEvent = {
    idMatch: 77881002,
    team1Name: 'Boston Celtics',
    team2Name: 'Golden State Warriors',
    sportName: 'Baschet',
    matchDateTime: '2026-10-25T19:00:00Z',
    tournamentName: 'NBA',
    matchBets: [
      {
        mbDisplayName: 'Castigator meci',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.65, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 2.25, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Castigator Sfertul 1',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.75, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 2.10, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Castigator Sfertul 2',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.70, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 2.15, mboActive: true },
        ],
      },
    ],
  };

  const [event] = scraper.extractEvents([bballMbEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 3);

  const [matchWinner, q1Winner, q2Winner] = event.markets;
  assert.equal(matchWinner.period, 'fulltime');
  assert.equal(q1Winner.period, 'q1');
  assert.equal(q2Winner.period, 'q2');

  const mwContract = resolveContract(matchWinner);
  const q1Contract = resolveContract(q1Winner);
  const q2Contract = resolveContract(q2Winner);

  assert.equal(mwContract.period, 'fulltime');
  assert.equal(q1Contract.period, 'q1');
  assert.equal(q2Contract.period, 'q2');

  const mwBucket = bucketKeyForContract(event.eventKey, mwContract);
  const q1Bucket = bucketKeyForContract(event.eventKey, q1Contract);
  const q2Bucket = bucketKeyForContract(event.eventKey, q2Contract);

  assert.match(mwBucket, /::fulltime::/);
  assert.match(q1Bucket, /::q1::/);
  assert.match(q2Bucket, /::q2::/);

  assert.notEqual(mwBucket, q1Bucket);
  assert.notEqual(mwBucket, q2Bucket);
  assert.notEqual(q1Bucket, q2Bucket);
});
