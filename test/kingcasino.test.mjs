/**
 * King Casino (kingcasino) test suite.
 *
 * Verifies candidate routing, contract invariants, and parser behavior against
 * real capture fixture data (data/endpoints/captures/kingcasino-odds-2026-10-11.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Kingcasino from '../src/scrapers/kingcasino.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'kingcasino');

const fixture = JSON.parse(
  readFileSync(new URL('../data/endpoints/captures/kingcasino-odds-2026-10-11.json', import.meta.url), 'utf8')
);

test('kingcasino: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('kingcasino: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'kingcasino.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('kingcasino: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('kingcasino', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'kingcasino');
  assert.ok(scraper instanceof ScraperBase);
  assert.ok(scraper instanceof Kingcasino);
});

test('kingcasino: normalize extracts events from fixture envelope and raw shapes', () => {
  const scraper = new Kingcasino();

  // Fixture envelope { provenance, raw: [...] }
  const fromEnvelope = scraper.normalize(fixture);
  assert.ok(Array.isArray(fromEnvelope));
  assert.equal(fromEnvelope.length, 9);

  // Direct array
  const fromArray = scraper.normalize(fixture.raw);
  assert.ok(Array.isArray(fromArray));
  assert.equal(fromArray.length, 9);

  // Wrapped under data { data: [...] }
  const fromData = scraper.normalize({ data: fixture.raw });
  assert.ok(Array.isArray(fromData));
  assert.equal(fromData.length, 9);

  // Wrapped under data.events { data: { events: [...] } }
  const fromDataEvents = scraper.normalize({ data: { events: fixture.raw } });
  assert.ok(Array.isArray(fromDataEvents));
  assert.equal(fromDataEvents.length, 9);
});

test('kingcasino: normalize fails closed on invalid or error payloads', () => {
  const scraper = new Kingcasino();
  assert.throws(() => scraper.normalize(null), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize('not-an-object'), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({}), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({ faultcode: 'ERR', faultstring: 'Upstream fault' }), { name: 'UpstreamError' });
  assert.throws(() => scraper.normalize({ status: 'error', error: 'Blocked by Cloudflare' }), { name: 'UpstreamError' });
});

test('kingcasino: extractEvents collects pre-match football with complete 1X2 markets', () => {
  const scraper = new Kingcasino({
    // generous window so all future test dates are admitted
    windowHours: 24 * 30,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  // Out of 9 events in fixture:
  // - 5 are valid future football matches
  // - 1 is live (Oțelul - Petrolul) -> dropped
  // - 1 is tennis (Alcaraz - Djokovic) -> dropped
  // - 1 is incomplete (suspended Draw on Hermannstadt - Poli Iași) -> dropped
  // - 1 is in the past (UTA Arad - Sepsi) -> dropped
  assert.equal(events.length, 5, 'only the 5 valid future football events survive');

  const [e1, e2, e3, e4, e5] = events;

  // Verify first match: FCSB vs Rapid București
  assert.equal(e1.id, '40981101');
  assert.equal(e1.sourceId, 'kingcasino');
  assert.equal(e1.sport, 'football');
  assert.equal(e1.homeTeam, 'FCSB');
  assert.equal(e1.awayTeam, 'Rapid București');
  assert.equal(e1.league, 'Romania. Superliga');
  assert.equal(e1.kickoff, '2026-10-18T18:00:00.000Z');
  assert.equal(e1.live, false);
  assert.equal(e1.eventKey, eventIdentityKey(e1));
  assert.equal(e1.markets.length, 1);
  assert.equal(e1.markets[0].key, '1X2');
  assert.deepEqual(e1.markets[0].selections, [
    { name: '1', odds: 2.10 },
    { name: 'X', odds: 3.35 },
    { name: '2', odds: 3.45 },
  ]);

  // Verify second match: Universitatea Craiova vs CFR Cluj
  assert.equal(e2.homeTeam, 'Universitatea Craiova');
  assert.equal(e2.awayTeam, 'CFR Cluj');
  assert.deepEqual(e2.markets[0].selections, [
    { name: '1', odds: 2.65 },
    { name: 'X', odds: 3.10 },
    { name: '2', odds: 2.80 },
  ]);

  // Verify third match: Dinamo București vs Farul Constanța
  assert.equal(e3.homeTeam, 'Dinamo București');
  assert.equal(e3.awayTeam, 'Farul Constanța');
  assert.deepEqual(e3.markets[0].selections, [
    { name: '1', odds: 2.40 },
    { name: 'X', odds: 3.25 },
    { name: '2', odds: 2.95 },
  ]);

  // Verify fourth match: Real Madrid vs Barcelona
  assert.equal(e4.homeTeam, 'Real Madrid');
  assert.equal(e4.awayTeam, 'Barcelona');
  assert.equal(e4.league, 'Spain. LaLiga');
  assert.deepEqual(e4.markets[0].selections, [
    { name: '1', odds: 2.05 },
    { name: 'X', odds: 3.75 },
    { name: '2', odds: 3.30 },
  ]);

  // Verify fifth match: Liverpool vs Manchester City (numeric epoch ms timestamp)
  assert.equal(e5.homeTeam, 'Liverpool');
  assert.equal(e5.awayTeam, 'Manchester City');
  assert.equal(e5.kickoff, new Date(1792332000000).toISOString());
  assert.deepEqual(e5.markets[0].selections, [
    { name: '1', odds: 2.35 },
    { name: 'X', odds: 3.50 },
    { name: '2', odds: 2.90 },
  ]);
});

test('kingcasino: extractEvents admits live events when includeLive is true', () => {
  const scraper = new Kingcasino({
    windowHours: 24 * 30,
    includeLive: true,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  const liveEvent = events.find((e) => e.homeTeam === 'Oțelul Galați');
  assert.ok(liveEvent, 'live event admitted when includeLive is true');
  assert.equal(liveEvent.live, true);
  assert.equal(liveEvent.markets[0].live, true, 'market must be marked live');
  assert.deepEqual(liveEvent.markets[0].selections, [
    { name: '1', odds: 2.40 },
    { name: 'X', odds: 3.00 },
    { name: '2', odds: 3.10 },
  ]);
});

test('kingcasino: extracts 2-way moneyline for Tennis and Basketball', () => {
  const scraper = new Kingcasino({
    sport: 'tennis',
    windowHours: 24 * 30,
  });

  const tennisMbEvent = {
    idMatch: 8881236,
    team1Name: 'Jannik Sinner',
    team2Name: 'Carlos Alcaraz',
    sportName: 'Tenis',
    matchDateTime: '2026-10-25T17:30:00Z',
    tournamentName: 'ATP Paris',
    matchBets: [
      {
        mbDisplayName: 'Castigator meci',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.85, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 1.95, mboActive: true },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([tennisMbEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'tennis');
  assert.equal(events[0].markets[0].key, 'MATCH_ODDS');
  assert.deepEqual(events[0].markets[0].selections, [
    { name: '1', odds: 1.85 },
    { name: '2', odds: 1.95 },
  ]);
});

test('kingcasino: extractEvents admits past matches when includePast is true', () => {
  const scraper = new Kingcasino({
    windowHours: 24 * 365,
    includePast: true,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  const pastEvent = events.find((e) => e.homeTeam === 'UTA Arad');
  assert.ok(pastEvent, 'past event admitted when includePast is true');
  assert.equal(pastEvent.awayTeam, 'Sepsi OSK');
});

test('kingcasino: malformed kickoff drops single row without throwing', () => {
  const scraper = new Kingcasino();
  const badEvent = {
    EId: 99999999,
    HT: 'Valid Home',
    AT: 'Valid Away',
    SN: 'Fotbal',
    D: 'not-a-date',
    S: [
      { N: '1', F: 2.0, GId: 1, TeamSide: 1 },
      { N: 'X', F: 3.0, GId: 1, TeamSide: 0 },
      { N: '2', F: 4.0, GId: 1, TeamSide: 2 },
    ],
  };

  const events = scraper.extractEvents([badEvent]);
  assert.equal(events.length, 0);
});

test('kingcasino: maxEvents bounds extracted events', () => {
  const scraper = new Kingcasino({
    windowHours: 24 * 30,
    maxEvents: 2,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);
  assert.equal(events.length, 2);
});

test('kingcasino: also extracts standard Digitain matchBets format', () => {
  const scraper = new Kingcasino({ windowHours: 24 * 30 });
  const digitainMbEvent = {
    idMatch: 8881235,
    team1Name: 'Bayern Munchen',
    team2Name: 'Borussia Dortmund',
    sportName: 'Fotbal',
    matchDateTime: '2026-10-25T17:30:00Z',
    tournamentName: 'Bundesliga',
    matchBets: [
      {
        mbDisplayName: 'Rezultat final',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.65, mboActive: true },
          { mboDisplayName: 'X', mboOddValue: 4.20, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 4.80, mboActive: true },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([digitainMbEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Bayern Munchen');
  assert.equal(events[0].awayTeam, 'Borussia Dortmund');
  assert.deepEqual(events[0].markets[0].selections, [
    { name: '1', odds: 1.65 },
    { name: 'X', odds: 4.20 },
    { name: '2', odds: 4.80 },
  ]);
});

test('kingcasino: fetchRaw handles errors and bounds payload safely', async () => {
  // 1. Timeout / abort
  const abortScraper = new Kingcasino({
    fetchImpl: () => Promise.reject({ name: 'AbortError' }),
  });
  await assert.rejects(abortScraper.fetchRaw(), { name: 'TimeoutError' });

  // 2. HTTP 403 Forbidden / Cloudflare challenge
  const error403Scraper = new Kingcasino({
    fetchImpl: () => Promise.resolve({
      ok: false,
      status: 403,
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(error403Scraper.fetchRaw(), { name: 'UpstreamError' });

  // 3. Non-JSON response
  const htmlScraper = new Kingcasino({
    fetchImpl: () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(htmlScraper.fetchRaw(), { name: 'ValidationError' });

  // 4. Successful JSON response
  const bytes = Buffer.from(JSON.stringify([{ test: 1 }]));
  let readDone = false;
  const successScraper = new Kingcasino({
    fetchImpl: () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body: {
        getReader() {
          return {
            read: async () => {
              if (readDone) return { done: true, value: undefined };
              readDone = true;
              return { done: false, value: bytes };
            },
            cancel: async () => {},
          };
        },
      },
    }),
  });
  const res = await successScraper.fetchRaw();
  assert.deepEqual(res, [{ test: 1 }]);
});

test('kingcasino: extracts sub-window period markets from Digitain event.S with deterministic bucket keys', () => {
  const scraper = new Kingcasino({ windowHours: 24 * 30 });
  const cardStakesEvent = {
    EId: 9001234,
    HT: 'FCSB',
    AT: 'Dinamo București',
    SN: 'Fotbal',
    CN: 'Romania. Superliga',
    D: '2026-10-25T18:00:00Z',
    S: [
      // Full-time 1X2 (GId: 1)
      { GId: 1, GN: 'Castigator meci', TeamSide: 1, F: 2.10, SS: false },
      { GId: 1, GN: 'Castigator meci', TeamSide: 0, F: 3.30, SS: false },
      { GId: 1, GN: 'Castigator meci', TeamSide: 2, F: 3.40, SS: false },
      // Half 1 1X2 (GId: 101)
      { GId: 101, GN: 'Rezultat Repriza 1', TeamSide: 1, F: 2.65, SS: false },
      { GId: 101, GN: 'Rezultat Repriza 1', TeamSide: 0, F: 2.05, SS: false },
      { GId: 101, GN: 'Rezultat Repriza 1', TeamSide: 2, F: 3.90, SS: false },
    ],
  };

  const [event] = scraper.extractEvents([cardStakesEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 2);

  const [ftMarket, htMarket] = event.markets;
  assert.equal(ftMarket.key, '1X2');
  assert.equal(ftMarket.period, 'fulltime');
  assert.deepEqual(ftMarket.selections.map((s) => s.odds), [2.10, 3.30, 3.40]);

  assert.equal(htMarket.key, '1X2');
  assert.equal(htMarket.period, 'half1');
  assert.deepEqual(htMarket.selections.map((s) => s.odds), [2.65, 2.05, 3.90]);

  // Bucket key isolation
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

test('kingcasino: extracts sub-window period markets from Digitain matchBets with deterministic bucket keys', () => {
  const scraper = new Kingcasino({ sport: 'tennis', windowHours: 24 * 30 });
  const tennisMbEvent = {
    idMatch: 9005678,
    team1Name: 'Jannik Sinner',
    team2Name: 'Carlos Alcaraz',
    sportName: 'Tenis',
    matchDateTime: '2026-10-25T17:30:00Z',
    tournamentName: 'ATP Paris',
    matchBets: [
      {
        mbDisplayName: 'Castigator meci',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.85, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 1.95, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Castigator Set 1',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.80, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 2.00, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Castigator Set 2',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.82, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 1.98, mboActive: true },
        ],
      },
    ],
  };

  const [event] = scraper.extractEvents([tennisMbEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 3);

  const [matchWinner, set1Winner, set2Winner] = event.markets;
  assert.equal(matchWinner.period, 'fulltime');
  assert.equal(set1Winner.period, 'set1');
  assert.equal(set2Winner.period, 'set2');

  const mwContract = resolveContract(matchWinner);
  const s1Contract = resolveContract(set1Winner);
  const s2Contract = resolveContract(set2Winner);

  assert.equal(mwContract.period, 'fulltime');
  assert.equal(s1Contract.period, 'set1');
  assert.equal(s2Contract.period, 'set2');

  const mwBucket = bucketKeyForContract(event.eventKey, mwContract);
  const s1Bucket = bucketKeyForContract(event.eventKey, s1Contract);
  const s2Bucket = bucketKeyForContract(event.eventKey, s2Contract);

  assert.match(mwBucket, /::fulltime::/);
  assert.match(s1Bucket, /::set1::/);
  assert.match(s2Bucket, /::set2::/);

  assert.notEqual(mwBucket, s1Bucket);
  assert.notEqual(mwBucket, s2Bucket);
  assert.notEqual(s1Bucket, s2Bucket);
});
