/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Superbet from '../src/scrapers/superbet.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { runScraperBatch } from '../src/scraper-service.mjs';
import { resolveContract, bucketKeyForContract, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/superbet-public.json', import.meta.url), 'utf8'));
const config = { id: 'superbet', enabled: true, engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' };
function payload() {
  const events = structuredClone(fixture.events);
  for (const event of events) event.fixture.utc_date = new Date(Date.now() + 3600000).toISOString();
  return { events };
}
function fakeFetch(raw, calls = []) {
  return async (url, options) => {
    options.signal.throwIfAborted();
    calls.push(url);
    return Response.json(url.endsWith('/struct') ? fixture.structure : raw);
  };
}
async function directory(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'arbiter-superbet-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('configured adapter fetches real-shape feed, caps events and writes complete provenance', async (t) => {
  const dataDir = await directory(t);
  const calls = [];
  const scraper = instantiate('superbet', { jobConfig: config, dataDir, runId: 'offline', maxEvents: 1, fetchImpl: fakeFetch(payload(), calls) });
  const result = await scraper.run();
  assert.equal(result.valid, true);
  assert.equal(result.events, 1);
  assert.equal(calls.length, 2);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, '/v3/ro-RO/events');
  assert.equal(url.searchParams.get('index'), 'active-prematch');
  assert.match(url.searchParams.get('startDate'), /T\d{2}:00:00.000Z$/);
  const snapshot = JSON.parse(await fs.readFile(result.outputs[0], 'utf8'));
  assert.equal(snapshot.runId, 'offline');
  assert.equal(snapshot.sourceUrl, calls[0]);
  assert.equal(snapshot.transport, 'bookmaker-public-json');
  assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
  assert.equal(snapshot.dataStatus, 'fresh');
  assert.deepEqual(snapshot.events[0].markets[0].selections.map((s) => s.name), ['1', 'X', '2']);
  assert.equal(snapshot.events[0].league, fixture.structure.data.tournaments[0].localNames['ro-RO']);
});

test('fetch/normalize rejects bad schema, HTML and HTTP blocks without fallback', async (t) => {
  for (const response of [Response.json({ data: {} }), new Response('<html>blocked</html>'), new Response('blocked', { status: 403 })]) {
    const scraper = new Superbet({ dataDir: await directory(t), fetchImpl: async () => response });
    const result = await scraper.run();
    assert.equal(result.valid, false);
    assert.deepEqual(result.outputs, []);
    assert.match(result.error.message, /missing events|non-JSON|HTTP 403/);
  }
});

test('rejects incomplete, inactive, invalid odds and suspended outcomes', async () => {
  const mutations = [
    (e) => { e.markets[0].odds = []; },                      // no outcomes at all
    (e) => { for (const o of e.markets[0].odds) o.status = 0; },    // all suspended
    (e) => { for (const o of e.markets[0].odds) o.display = false; }, // all hidden
    (e) => { for (const o of e.markets[0].odds) o.price = 1; },     // all price too low
    (e) => { for (const o of e.markets[0].odds) o.price = Infinity; }, // all infinite
    (e) => { for (const o of e.markets[0].odds) o.metadata.offer_state_id = 0; }, // all inactive
  ];
  for (const mutate of mutations) {
    const raw = payload();
    raw.events = raw.events.slice(0, 1);
    mutate(raw.events[0]);
    const scraper = new Superbet({ fetchImpl: fakeFetch(raw) });
    assert.deepEqual(scraper.extractEvents(scraper.normalize(await scraper.fetchRaw())), []);
  }
});

test('zero cap and pre-abort never fetch', async () => {
  const fetchImpl = () => assert.fail('unexpected network request');
  const zero = new Superbet({ maxEvents: 0, fetchImpl });
  assert.deepEqual(await zero.fetchRaw(), { events: [] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new Superbet({ fetchImpl }).fetchRaw({ signal: controller.signal }), { name: 'AbortError' });
});

test('inflight abort and timeout stop fetch without publishing', async (t) => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const scraper = new Superbet({ dataDir: await directory(t), timeoutMs: 30, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (cancel) controller.abort();
    }) });
    const result = await scraper.run({ signal: controller.signal });
    assert.equal(result.valid, false);
    assert.equal(result.status === 'cancelled', cancel);
    assert.deepEqual(result.outputs, []);
  }
});

test('batch forwards cap through fetch/normalize and logs unsupported routing', async (t) => {
  const dataDir = await directory(t);
  t.mock.method(globalThis, 'fetch', fakeFetch(payload()));
  // 'probe-book' declares an engine/transport no adapter implements, so the
  // registry must reject it as an unsupported source instead of silently
  // falling back to some other scraper.
  const configPath = join(dataDir, 'scrapers.json');
  await fs.writeFile(configPath, JSON.stringify({
    jobs: [
      { ...config, sourceIds: ['superbet'] },
      { id: 'probe-book', enabled: true, engine: 'probe-engine', transport: 'probe-transport', script: 'probe.mjs', sourceIds: [] },
    ],
  }));
  const { jobs } = await runScraperBatch({ dataDir, configPath, books: ['superbet', 'probe-book'], maxEvents: 1 });
  assert.equal(jobs[0].events, 1);
  assert.equal(jobs[1].valid, false);
  assert.match(jobs[1].error.message, /unsupported source/);
  assert.throws(() => instantiate('superbet', { jobConfig: { ...config, engine: 'wrong' } }), { code: 'ESCRAPERCONFIG' });
});

test('superbet multi-sport: basketball 2-way winner and multi-line points totals resolve cleanly', () => {
  const basketballEvent = {
    event_id: 99001,
    fixture: {
      sport_id: 4,
      event_name: 'Boston Celtics·LA Lakers',
      utc_date: new Date(Date.now() + 3600000).toISOString(),
      tournament_id: 501,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'NOT_STARTED' },
    markets: [
      {
        id: 2,
        name: 'Câștigător meci',
        odds: [
          {
            uuid: 'bball-w1',
            price: 1.65,
            status: 1,
            display: true,
            metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'line-win' },
          },
          {
            uuid: 'bball-w2',
            price: 2.30,
            status: 1,
            display: true,
            metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'line-win' },
          },
        ],
      },
      {
        id: 552,
        name: 'Total puncte',
        odds: [
          {
            uuid: 'bball-o218',
            price: 1.90,
            status: 1,
            display: true,
            metadata: { name: 'Peste 218.5', offer_state_id: 1, market_line_uuid: 'line-218' },
          },
          {
            uuid: 'bball-u218',
            price: 1.90,
            status: 1,
            display: true,
            metadata: { name: 'Sub 218.5', offer_state_id: 1, market_line_uuid: 'line-218' },
          },
          {
            uuid: 'bball-o220',
            price: 2.10,
            status: 1,
            display: true,
            metadata: { name: 'Peste 220.5', offer_state_id: 1, market_line_uuid: 'line-220' },
          },
          {
            uuid: 'bball-u220',
            price: 1.75,
            status: 1,
            display: true,
            metadata: { name: 'Sub 220.5', offer_state_id: 1, market_line_uuid: 'line-220' },
          },
        ],
      },
    ],
  };

  const scraper = new Superbet({ sport: 'basketball' });
  const [event] = scraper.extractEvents(scraper.normalize({ events: [basketballEvent] }));
  assert.ok(event, 'basketball event extracted');
  assert.equal(event.sport, 'Basketball');
  assert.equal(event.homeTeam, 'Boston Celtics');
  assert.equal(event.awayTeam, 'LA Lakers');

  const winnerMarket = event.markets.find((m) => m.key === '2');
  assert.ok(winnerMarket, 'match winner market found');
  const winnerContract = resolveContract(winnerMarket);
  assert.equal(winnerContract.family, 'MATCH_ODDS');
  assert.deepEqual(winnerContract.outcomes, ['home', 'away']);

  const totalsMarkets = event.markets.filter((m) => m.key === '552');
  assert.equal(totalsMarkets.length, 2, 'both line 218.5 and 220.5 are extracted');
  for (const tm of totalsMarkets) {
    assert.equal(tm.subject, 'points');
    const c = resolveContract(tm);
    assert.equal(c.family, 'OVER_UNDER');
    assert.equal(c.subject, 'points');
    assert.ok(c.lineKey === '218.5' || c.lineKey === '220.5');
  }
});

test('superbet multi-sport: tennis 2-way winner and games totals resolve cleanly', () => {
  const tennisEvent = {
    event_id: 99002,
    fixture: {
      sport_id: 2,
      event_name: 'Alcaraz C.·Sinner J.',
      utc_date: new Date(Date.now() + 3600000).toISOString(),
      tournament_id: 502,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'NOT_STARTED' },
    markets: [
      {
        id: 547,
        name: 'Final',
        odds: [
          {
            uuid: 'ten-w1',
            price: 1.85,
            status: 1,
            display: true,
            metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'line-ten-win' },
          },
          {
            uuid: 'ten-w2',
            price: 1.95,
            status: 1,
            display: true,
            metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'line-ten-win' },
          },
        ],
      },
      {
        id: 550,
        name: 'Total game-uri',
        odds: [
          {
            uuid: 'ten-o22',
            price: 1.80,
            status: 1,
            display: true,
            metadata: { name: 'Peste 22.5', offer_state_id: 1, market_line_uuid: 'line-22' },
          },
          {
            uuid: 'ten-u22',
            price: 2.00,
            status: 1,
            display: true,
            metadata: { name: 'Sub 22.5', offer_state_id: 1, market_line_uuid: 'line-22' },
          },
        ],
      },
    ],
  };

  const scraper = new Superbet({ sport: 'tennis' });
  const [event] = scraper.extractEvents(scraper.normalize({ events: [tennisEvent] }));
  assert.ok(event, 'tennis event extracted');
  assert.equal(event.sport, 'Tennis');
  assert.equal(event.homeTeam, 'Alcaraz C.');
  assert.equal(event.awayTeam, 'Sinner J.');

  const winnerMarket = event.markets.find((m) => m.key === '547');
  assert.ok(winnerMarket, 'tennis winner market found');
  const winnerContract = resolveContract(winnerMarket);
  assert.equal(winnerContract.family, 'MATCH_ODDS');
  assert.deepEqual(winnerContract.outcomes, ['home', 'away']);

  const gamesMarket = event.markets.find((m) => m.key === '550');
  assert.ok(gamesMarket, 'tennis games totals market found');
  assert.equal(gamesMarket.subject, 'games');
  const gamesContract = resolveContract(gamesMarket);
  assert.equal(gamesContract.family, 'OVER_UNDER');
  assert.equal(gamesContract.subject, 'games');
  assert.equal(gamesContract.lineKey, '22.5');
});

test('superbet in-play: includeLive queries active-live and marks markets live', async () => {
  const calls = [];
  const liveEvent = {
    event_id: 99003,
    fixture: {
      sport_id: 1,
      event_name: 'Real Madrid·Barcelona',
      utc_date: new Date(Date.now() - 1800000).toISOString(),
      tournament_id: 503,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'IN_PLAY' },
    markets: [
      {
        id: 547,
        name: 'Final',
        odds: [
          {
            uuid: 'live-1',
            price: 2.20,
            status: 1,
            display: true,
            metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'line-live-1' },
          },
          {
            uuid: 'live-x',
            price: 3.40,
            status: 1,
            display: true,
            metadata: { name: 'X', offer_state_id: 1, market_line_uuid: 'line-live-1' },
          },
          {
            uuid: 'live-2',
            price: 3.10,
            status: 1,
            display: true,
            metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'line-live-1' },
          },
        ],
      },
    ],
  };

  const fakeTransport = async (url) => {
    calls.push(url);
    if (url.endsWith('/struct')) return Response.json({ data: { tournaments: [] } });
    return Response.json({ events: [liveEvent] });
  };

  const scraper = new Superbet({ includeLive: true, fetchImpl: fakeTransport });
  const raw = await scraper.fetchRaw();
  assert.ok(calls.some((u) => u.includes('index=active-live')), 'queried active-live index');

  const [event] = scraper.extractEvents(scraper.normalize(raw));
  assert.ok(event, 'live event extracted');
  assert.equal(event.live, true);
  assert.equal(event.markets[0].live, true);
});

test('superbet multi-sport period markets: tennis set winners and set games totals parse correctly', () => {
  const tennisEvent = {
    event_id: 99101,
    fixture: {
      sport_id: 2,
      event_name: 'Djokovic N.·Alcaraz C.',
      utc_date: new Date(Date.now() + 3600000).toISOString(),
      tournament_id: 504,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'NOT_STARTED' },
    markets: [
      {
        id: 547,
        name: 'Final',
        odds: [
          { uuid: 't-w1', price: 1.95, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-win' } },
          { uuid: 't-w2', price: 1.85, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-win' } },
        ],
      },
      {
        id: 548,
        name: 'Setul 1 - Câștigător',
        odds: [
          { uuid: 's1-w1', price: 1.90, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-s1-win' } },
          { uuid: 's1-w2', price: 1.90, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-s1-win' } },
        ],
      },
      {
        id: 549,
        name: 'Setul 1 - Total game-uri',
        odds: [
          { uuid: 's1-o9', price: 1.95, status: 1, display: true, metadata: { name: 'Peste 9.5', offer_state_id: 1, market_line_uuid: 'l-s1-g9' } },
          { uuid: 's1-u9', price: 1.80, status: 1, display: true, metadata: { name: 'Sub 9.5', offer_state_id: 1, market_line_uuid: 'l-s1-g9' } },
        ],
      },
    ],
  };

  const scraper = new Superbet({ sport: 'tennis' });
  const [event] = scraper.extractEvents(scraper.normalize({ events: [tennisEvent] }));
  assert.ok(event);

  const fulltimeWin = event.markets.find((m) => m.name === 'Final');
  assert.equal(fulltimeWin.period, 'fulltime');
  const fulltimeContract = resolveContract(fulltimeWin);
  assert.equal(fulltimeContract.family, 'MATCH_ODDS');
  assert.equal(fulltimeContract.period, 'fulltime');

  const set1Win = event.markets.find((m) => m.name === 'Setul 1 - Câștigător');
  assert.equal(set1Win.period, 'set1');
  const set1WinContract = resolveContract(set1Win);
  assert.equal(set1WinContract.family, 'MATCH_ODDS');
  assert.equal(set1WinContract.period, 'set1');

  const set1Games = event.markets.find((m) => m.name === 'Setul 1 - Total game-uri');
  assert.equal(set1Games.period, 'set1');
  assert.equal(set1Games.subject, 'games');
  const set1GamesContract = resolveContract(set1Games);
  assert.equal(set1GamesContract.family, 'OVER_UNDER');
  assert.equal(set1GamesContract.period, 'set1');
  assert.equal(set1GamesContract.subject, 'games');
  assert.equal(set1GamesContract.lineKey, '9.5');

  const ftBucket = bucketKeyForContract(event.eventKey, fulltimeContract);
  const set1Bucket = bucketKeyForContract(event.eventKey, set1WinContract);
  assert.notEqual(ftBucket, set1Bucket, 'set 1 winner bucket must never collide with full-time match winner');
  assert.ok(set1Bucket.includes('::set1::'), 'set1 bucket contains set1 period');
  assert.ok(ftBucket.includes('::fulltime::'), 'fulltime bucket contains fulltime period');
});

test('superbet multi-sport period markets: basketball quarters and halves parse with distinct buckets', () => {
  const basketballEvent = {
    event_id: 99102,
    fixture: {
      sport_id: 4,
      event_name: 'Real Madrid·Barcelona',
      utc_date: new Date(Date.now() + 3600000).toISOString(),
      tournament_id: 505,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'NOT_STARTED' },
    markets: [
      {
        id: 2,
        name: 'Câștigător meci',
        odds: [
          { uuid: 'b-ft-1', price: 1.75, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-b-ft' } },
          { uuid: 'b-ft-2', price: 2.10, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-b-ft' } },
        ],
      },
      {
        id: 552,
        name: 'Total puncte',
        odds: [
          { uuid: 'b-ft-o165', price: 1.90, status: 1, display: true, metadata: { name: 'Peste 165.5', offer_state_id: 1, market_line_uuid: 'l-b-ft-165' } },
          { uuid: 'b-ft-u165', price: 1.90, status: 1, display: true, metadata: { name: 'Sub 165.5', offer_state_id: 1, market_line_uuid: 'l-b-ft-165' } },
        ],
      },
      {
        id: 601,
        name: 'Sfertul 1 - Câștigător',
        odds: [
          { uuid: 'b-q1-1', price: 1.85, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-b-q1' } },
          { uuid: 'b-q1-2', price: 1.95, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-b-q1' } },
        ],
      },
      {
        id: 602,
        name: 'Sfertul 1 - Total puncte',
        odds: [
          { uuid: 'b-q1-o41', price: 1.85, status: 1, display: true, metadata: { name: 'Peste 41.5', offer_state_id: 1, market_line_uuid: 'l-b-q1-41' } },
          { uuid: 'b-q1-u41', price: 1.95, status: 1, display: true, metadata: { name: 'Sub 41.5', offer_state_id: 1, market_line_uuid: 'l-b-q1-41' } },
        ],
      },
      {
        id: 603,
        name: 'Prima repriză - Total puncte',
        odds: [
          { uuid: 'b-h1-o82', price: 1.90, status: 1, display: true, metadata: { name: 'Peste 82.5', offer_state_id: 1, market_line_uuid: 'l-b-h1-82' } },
          { uuid: 'b-h1-u82', price: 1.90, status: 1, display: true, metadata: { name: 'Sub 82.5', offer_state_id: 1, market_line_uuid: 'l-b-h1-82' } },
        ],
      },
    ],
  };

  const scraper = new Superbet({ sport: 'basketball' });
  const [event] = scraper.extractEvents(scraper.normalize({ events: [basketballEvent] }));
  assert.ok(event);

  const q1Win = event.markets.find((m) => m.name === 'Sfertul 1 - Câștigător');
  assert.equal(q1Win.period, 'q1');
  const q1WinContract = resolveContract(q1Win);
  assert.equal(q1WinContract.family, 'MATCH_ODDS');
  assert.equal(q1WinContract.period, 'q1');

  const q1Totals = event.markets.find((m) => m.name === 'Sfertul 1 - Total puncte');
  assert.equal(q1Totals.period, 'q1');
  assert.equal(q1Totals.subject, 'points');
  const q1TotalsContract = resolveContract(q1Totals);
  assert.equal(q1TotalsContract.family, 'OVER_UNDER');
  assert.equal(q1TotalsContract.period, 'q1');
  assert.equal(q1TotalsContract.subject, 'points');
  assert.equal(q1TotalsContract.lineKey, '41.5');

  const h1Totals = event.markets.find((m) => m.name === 'Prima repriză - Total puncte');
  assert.equal(h1Totals.period, 'half1');
  assert.equal(h1Totals.subject, 'points');
  const h1TotalsContract = resolveContract(h1Totals);
  assert.equal(h1TotalsContract.family, 'OVER_UNDER');
  assert.equal(h1TotalsContract.period, 'half1');
  assert.equal(h1TotalsContract.subject, 'points');
  assert.equal(h1TotalsContract.lineKey, '82.5');

  const ftTotals = event.markets.find((m) => m.name === 'Total puncte');
  const ftTotalsContract = resolveContract(ftTotals);

  const q1Bucket = bucketKeyForContract(event.eventKey, q1TotalsContract);
  const h1Bucket = bucketKeyForContract(event.eventKey, h1TotalsContract);
  const ftBucket = bucketKeyForContract(event.eventKey, ftTotalsContract);

  assert.notEqual(q1Bucket, h1Bucket);
  assert.notEqual(q1Bucket, ftBucket);
  assert.notEqual(h1Bucket, ftBucket);
  assert.ok(q1Bucket.includes('::q1::'));
  assert.ok(h1Bucket.includes('::half1::'));
  assert.ok(ftBucket.includes('::fulltime::'));
});

test('superbet football period markets: 1st half 1X2 and BTTS resolution and bucket isolation', () => {
  const footballEvent = {
    event_id: 99103,
    fixture: {
      sport_id: 5,
      event_name: 'FCSB·CFR Cluj',
      utc_date: new Date(Date.now() + 3600000).toISOString(),
      tournament_id: 506,
      offer_state_status: { 1: 1 },
    },
    inplay_stats_metadata: { status: 'NOT_STARTED' },
    markets: [
      {
        id: 547,
        name: 'Final',
        odds: [
          { uuid: 'f-1', price: 2.10, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-ft' } },
          { uuid: 'f-x', price: 3.25, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1, market_line_uuid: 'l-ft' } },
          { uuid: 'f-2', price: 3.60, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-ft' } },
        ],
      },
      {
        id: 562,
        name: 'Prima repriză - 1X2',
        odds: [
          { uuid: 'h1-1', price: 2.70, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l-h1' } },
          { uuid: 'h1-x', price: 2.05, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1, market_line_uuid: 'l-h1' } },
          { uuid: 'h1-2', price: 4.10, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l-h1' } },
        ],
      },
    ],
  };

  const scraper = new Superbet({ sport: 'football' });
  const [event] = scraper.extractEvents(scraper.normalize({ events: [footballEvent] }));
  assert.ok(event);

  const ftMarket = event.markets.find((m) => m.name === 'Final');
  assert.equal(ftMarket.period, 'fulltime');
  const ftContract = resolveContract(ftMarket);
  assert.equal(ftContract.family, 'MATCH_ODDS');
  assert.equal(ftContract.period, 'fulltime');

  const h1Market = event.markets.find((m) => m.name === 'Prima repriză - 1X2');
  assert.equal(h1Market.period, 'half1');
  const h1Contract = resolveContract(h1Market);
  assert.equal(h1Contract.family, 'MATCH_ODDS');
  assert.equal(h1Contract.period, 'half1');

  const ftBucket = bucketKeyForContract(event.eventKey, ftContract);
  const h1Bucket = bucketKeyForContract(event.eventKey, h1Contract);
  assert.notEqual(ftBucket, h1Bucket, '1st half 1X2 must never bucket with full-time 1X2');
  assert.ok(h1Bucket.includes('::half1::'));
  assert.ok(ftBucket.includes('::fulltime::'));

  // Test BTTS market contract resolution for Superbet
  const bttsMarket = {
    key: 'sb:539:Ambele echipe marchează (GG)',
    name: 'Ambele echipe marchează (GG)',
    period: 'fulltime',
    family: 'BTTS',
    selections: [
      { id: 'btts-da', name: 'Da', odds: 1.85, handicap: null },
      { id: 'btts-nu', name: 'Nu', odds: 1.95, handicap: null },
    ],
  };
  const bttsContract = resolveContract(bttsMarket);
  assert.ok(bttsContract);
  assert.equal(bttsContract.family, 'BTTS');
  assert.equal(bttsContract.period, 'fulltime');
  assert.deepEqual(bttsContract.outcomes, ['yes', 'no']);
  assert.equal(canonicalOutcomeFor('Da', bttsContract), 'yes');
  assert.equal(canonicalOutcomeFor('Nu', bttsContract), 'no');
  const bttsBucket = bucketKeyForContract(event.eventKey, bttsContract);
  assert.ok(bttsBucket.includes('::BTTS::fulltime::_::yes+no::_::_'));
});
