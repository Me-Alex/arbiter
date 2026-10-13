/**
 * PariuriPlus (pariuriplus) test suite.
 *
 * Verifies candidate routing, contract invariants, and parser behavior against
 * real capture fixture data (data/endpoints/captures/pariuriplus-odds-2026-10-11.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Pariuriplus from '../src/scrapers/pariuriplus.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'pariuriplus');

const fixture = JSON.parse(
  readFileSync(new URL('../data/endpoints/captures/pariuriplus-odds-2026-10-11.json', import.meta.url), 'utf8')
);

test('pariuriplus: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('pariuriplus: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'pariuriplus.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('pariuriplus: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('pariuriplus', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'pariuriplus');
  assert.ok(scraper instanceof ScraperBase);
  assert.ok(scraper instanceof Pariuriplus);
});

test('pariuriplus: normalize extracts events from fixture envelope and raw shapes', () => {
  const scraper = new Pariuriplus();

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

test('pariuriplus: normalize fails closed on invalid or error payloads', () => {
  const scraper = new Pariuriplus();
  assert.throws(() => scraper.normalize(null), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize('not-an-object'), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({}), { name: 'ValidationError' });
  assert.throws(() => scraper.normalize({ faultcode: 'ERR', faultstring: 'Upstream fault' }), { name: 'UpstreamError' });
  assert.throws(() => scraper.normalize({ status: 'error', error: 'Blocked by Cloudflare' }), { name: 'UpstreamError' });
});

test('pariuriplus: extractEvents collects pre-match football with complete 1X2 markets', () => {
  const scraper = new Pariuriplus({
    // generous window so all future test dates are admitted
    windowHours: 24 * 30,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  // Out of 9 events in fixture:
  // - 5 are valid future football matches
  // - 1 is live (CFR Cluj - Craiova) -> dropped
  // - 1 is tennis (Sinner - Alcaraz) -> dropped
  // - 1 is incomplete (suspended Draw on Rapid - Hermannstadt) -> dropped
  // - 1 is in the past (Steaua - U Cluj) -> dropped
  assert.equal(events.length, 5, 'only the 5 valid future football events survive');

  const [e1, e2, e3, e4, e5] = events;

  // Verify first match: Corvinul 1921 Hunedoara vs Voluntari
  assert.equal(e1.id, '40882761');
  assert.equal(e1.sourceId, 'pariuriplus');
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
    { name: '1', odds: 2.15 },
    { name: 'X', odds: 3.20 },
    { name: '2', odds: 3.55 },
  ]);

  // Verify third match: FC Botoșani vs UTA Arad
  assert.equal(e3.homeTeam, 'FC Botoșani');
  assert.equal(e3.awayTeam, 'UTA Arad');
  assert.deepEqual(e3.markets[0].selections, [
    { name: '1', odds: 2.50 },
    { name: 'X', odds: 3.00 },
    { name: '2', odds: 2.95 },
  ]);

  // Verify fourth match: Arsenal vs Leeds United
  assert.equal(e4.homeTeam, 'Arsenal');
  assert.equal(e4.awayTeam, 'Leeds United');
  assert.deepEqual(e4.markets[0].selections, [
    { name: '1', odds: 1.35 },
    { name: 'X', odds: 5.20 },
    { name: '2', odds: 8.50 },
  ]);

  // Verify fifth match: Chelsea vs Bournemouth (numeric epoch ms timestamp)
  assert.equal(e5.homeTeam, 'Chelsea');
  assert.equal(e5.awayTeam, 'Bournemouth');
  assert.equal(e5.kickoff, new Date(1792245600000).toISOString());
  assert.deepEqual(e5.markets[0].selections, [
    { name: '1', odds: 1.55 },
    { name: 'X', odds: 4.10 },
    { name: '2', odds: 5.80 },
  ]);
});

test('pariuriplus: extractEvents admits live events when includeLive is true', () => {
  const scraper = new Pariuriplus({
    windowHours: 24 * 30,
    includeLive: true,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  const liveEvent = events.find((e) => e.homeTeam === 'CFR Cluj');
  assert.ok(liveEvent, 'live event admitted when includeLive is true');
  assert.equal(liveEvent.live, true);
  assert.equal(liveEvent.isLive, true);
  assert.equal(liveEvent.markets[0].live, true);
  assert.deepEqual(liveEvent.markets[0].selections, [
    { name: '1', odds: 2.10 },
    { name: 'X', odds: 3.40 },
    { name: '2', odds: 3.30 },
  ]);
});

test('pariuriplus: extractEvents admits past matches when includePast is true', () => {
  const scraper = new Pariuriplus({
    windowHours: 24 * 365,
    includePast: true,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);

  const pastEvent = events.find((e) => e.homeTeam === 'Steaua');
  assert.ok(pastEvent, 'past event admitted when includePast is true');
  assert.equal(pastEvent.awayTeam, 'U Cluj');
});

test('pariuriplus: malformed kickoff drops single row without throwing', () => {
  const scraper = new Pariuriplus();
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

test('pariuriplus: maxEvents bounds extracted events', () => {
  const scraper = new Pariuriplus({
    windowHours: 24 * 30,
    maxEvents: 2,
  });

  const rawEvents = scraper.normalize(fixture);
  const events = scraper.extractEvents(rawEvents);
  assert.equal(events.length, 2);
});

test('pariuriplus: also extracts standard Digitain matchBets format', () => {
  const scraper = new Pariuriplus({ windowHours: 24 * 30 });
  const digitainMbEvent = {
    idMatch: 8881234,
    team1Name: 'Inter Milano',
    team2Name: 'AC Milan',
    sportName: 'Fotbal',
    matchDateTime: '2026-10-25T19:45:00Z',
    tournamentName: 'Serie A',
    matchBets: [
      {
        mbDisplayName: 'Rezultat final',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 2.10, mboActive: true },
          { mboDisplayName: 'X', mboOddValue: 3.40, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 3.50, mboActive: true },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([digitainMbEvent]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Inter Milano');
  assert.equal(events[0].awayTeam, 'AC Milan');
  assert.deepEqual(events[0].markets[0].selections, [
    { name: '1', odds: 2.10 },
    { name: 'X', odds: 3.40 },
    { name: '2', odds: 3.50 },
  ]);
});

test('pariuriplus: fetchRaw handles errors and bounds payload safely', async () => {
  // 1. Timeout / abort
  const abortScraper = new Pariuriplus({
    fetchImpl: () => Promise.reject({ name: 'AbortError' }),
  });
  await assert.rejects(abortScraper.fetchRaw(), { name: 'TimeoutError' });

  // 2. HTTP 403 Forbidden / Cloudflare challenge
  const error403Scraper = new Pariuriplus({
    fetchImpl: () => Promise.resolve({
      ok: false,
      status: 403,
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(error403Scraper.fetchRaw(), { name: 'UpstreamError' });

  // 3. Non-JSON response
  const htmlScraper = new Pariuriplus({
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
  const successScraper = new Pariuriplus({
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

test('pariuriplus: extracts sub-window period markets from Digitain event.S with deterministic bucket keys', () => {
  const scraper = new Pariuriplus({ windowHours: 24 * 30 });
  const cardStakesEvent = {
    EId: 8891001,
    HT: 'Universitatea Craiova',
    AT: 'CFR Cluj',
    SN: 'Fotbal',
    CN: 'Romania. Superliga',
    D: '2026-10-25T18:00:00Z',
    S: [
      // Full-time 1X2 (GId: 1)
      { GId: 1, GN: 'Rezultat final', TeamSide: 1, F: 2.25, SS: false },
      { GId: 1, GN: 'Rezultat final', TeamSide: 0, F: 3.10, SS: false },
      { GId: 1, GN: 'Rezultat final', TeamSide: 2, F: 3.20, SS: false },
      // Half 1 1X2 (GId: 201)
      { GId: 201, GN: 'Rezultat Repriza 1', TeamSide: 1, F: 2.80, SS: false },
      { GId: 201, GN: 'Rezultat Repriza 1', TeamSide: 0, F: 2.00, SS: false },
      { GId: 201, GN: 'Rezultat Repriza 1', TeamSide: 2, F: 3.75, SS: false },
    ],
  };

  const [event] = scraper.extractEvents([cardStakesEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 2);

  const [ftMarket, htMarket] = event.markets;
  assert.equal(ftMarket.key, '1X2');
  assert.equal(ftMarket.period, 'fulltime');
  assert.deepEqual(ftMarket.selections.map((s) => s.odds), [2.25, 3.10, 3.20]);

  assert.equal(htMarket.key, '1X2');
  assert.equal(htMarket.period, 'half1');
  assert.deepEqual(htMarket.selections.map((s) => s.odds), [2.80, 2.00, 3.75]);

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

test('pariuriplus: extracts sub-window period markets from Digitain matchBets with deterministic bucket keys', () => {
  const scraper = new Pariuriplus({ windowHours: 24 * 30 });
  const digitainMbEvent = {
    idMatch: 8891002,
    team1Name: 'Arsenal',
    team2Name: 'Chelsea',
    sportName: 'Fotbal',
    matchDateTime: '2026-10-25T17:30:00Z',
    tournamentName: 'Premier League',
    matchBets: [
      {
        mbDisplayName: 'Rezultat final',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 1.95, mboActive: true },
          { mboDisplayName: 'X', mboOddValue: 3.50, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 3.80, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Rezultat Repriza 1',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 2.50, mboActive: true },
          { mboDisplayName: 'X', mboOddValue: 2.15, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 4.10, mboActive: true },
        ],
      },
      {
        mbDisplayName: 'Rezultat Repriza 2',
        mbActive: true,
        mbOutcomes: [
          { mboDisplayName: '1', mboOddValue: 2.30, mboActive: true },
          { mboDisplayName: 'X', mboOddValue: 2.35, mboActive: true },
          { mboDisplayName: '2', mboOddValue: 3.90, mboActive: true },
        ],
      },
    ],
  };

  const [event] = scraper.extractEvents([digitainMbEvent]);
  assert.ok(event);
  assert.equal(event.markets.length, 3);

  const [ft, h1, h2] = event.markets;
  assert.equal(ft.period, 'fulltime');
  assert.equal(h1.period, 'half1');
  assert.equal(h2.period, 'half2');

  const ftContract = resolveContract(ft);
  const h1Contract = resolveContract(h1);
  const h2Contract = resolveContract(h2);

  assert.equal(ftContract.period, 'fulltime');
  assert.equal(h1Contract.period, 'half1');
  assert.equal(h2Contract.period, 'half2');

  const ftBucket = bucketKeyForContract(event.eventKey, ftContract);
  const h1Bucket = bucketKeyForContract(event.eventKey, h1Contract);
  const h2Bucket = bucketKeyForContract(event.eventKey, h2Contract);

  assert.match(ftBucket, /::fulltime::/);
  assert.match(h1Bucket, /::half1::/);
  assert.match(h2Bucket, /::half2::/);

  assert.notEqual(ftBucket, h1Bucket);
  assert.notEqual(ftBucket, h2Bucket);
  assert.notEqual(h1Bucket, h2Bucket);
});
