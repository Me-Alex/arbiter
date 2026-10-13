import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import BetfairScraper, {
  parseEventTeams,
  BETFAIR_SPORT_EVENT_TYPE_IDS,
  BETFAIR_EVENT_TYPE_ID_TO_SPORT,
} from '../src/scrapers/betfair.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { resolveContract, roundedArbitrageAllocation, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import ScraperBase from '../src/scrapers/base.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/betfair-exchange.json', import.meta.url), 'utf8')
);

const config = JSON.parse(
  readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8')
);

test('BetfairScraper: instantiates with expected defaults and ScraperBase contract', () => {
  const scraper = new BetfairScraper({});
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'betfair');
  assert.equal(scraper.name, 'Betfair');
  assert.deepEqual(scraper.sourceIds, ['betfair']);
  assert.equal(scraper.engine, 'betfair-exchange-api');
  assert.equal(scraper.transport, 'betfair-exchange-readonly-json');
  assert.equal(scraper.timeoutMs, 30_000);
  assert.equal(scraper.sourceUrl, 'https://www.betfair.ro/exchange');
  assert.ok(Array.isArray(scraper.sports));
  assert.ok(scraper.sports.includes('football'));
  assert.ok(scraper.sports.includes('tennis'));
  assert.ok(scraper.sports.includes('basketball'));
});

test('BetfairScraper: dispatcher routing and contract drift enforcement', () => {
  const jobConfig = config.jobs.find((j) => j.id === 'betfair');
  assert.ok(jobConfig, 'betfair must be in config/scrapers.json');
  assert.equal(jobConfig.enabled, true);
  assert.equal(jobConfig.validationStatus, 'validated');

  const instance = instantiate('betfair', { jobConfig });
  assert.ok(instance instanceof BetfairScraper);

  for (const field of ['engine', 'transport', 'script']) {
    assert.throws(
      () => instantiate('betfair', { jobConfig: { ...jobConfig, [field]: 'drifted' } }),
      { code: 'ESCRAPERCONFIG' },
      `betfair must reject ${field} drift`
    );
  }

  assert.throws(
    () => instantiate('betfair', { jobConfig: { ...jobConfig, enabled: false } }),
    { code: 'ESCRAPERCONFIG' }
  );
});

test('parseEventTeams: handles European v/vs and US @ formats', () => {
  assert.deepEqual(parseEventTeams('Man.Utd v Tottenham'), {
    homeTeam: 'Man.Utd',
    awayTeam: 'Tottenham',
  });
  assert.deepEqual(parseEventTeams('FCSB vs Otelul Galati'), {
    homeTeam: 'FCSB',
    awayTeam: 'Otelul Galati',
  });
  assert.deepEqual(parseEventTeams('Miami Ohio @ Massachusetts'), {
    homeTeam: 'Massachusetts',
    awayTeam: 'Miami Ohio',
  });
  assert.equal(parseEventTeams(''), null);
  assert.equal(parseEventTeams(null), null);
  assert.equal(parseEventTeams('SingleTeamName'), null);
});

test('BetfairScraper: parses real captured exchange events with full market coverage', () => {
  const scraper = new BetfairScraper({ observedAt: fixture.provenance.capturedAt });
  const raw = scraper.normalize(fixture.raw);
  assert.ok(Array.isArray(raw));
  assert.ok(raw.length > 0);

  const events = scraper.validate(scraper.extractEvents(raw));
  assert.ok(events.length > 0);

  const seenMarkets = new Set();
  const seenSports = new Set();

  for (const event of events) {
    assert.equal(event.sourceId, 'betfair');
    assert.ok(event.sourceUrl.startsWith('https://www.betfair.ro/exchange'));
    assert.equal(event.eventKey, eventIdentityKey(event));
    assert.ok(event.providerEventKey.startsWith('betfair|'));
    assert.equal(event.live, false);
    assert.ok(event.markets.length > 0);
    seenSports.add(event.sport);

    for (const market of event.markets) {
      seenMarkets.add(market.key);
      const contract = resolveContract(market);
      assert.ok(contract, `market ${market.key} (${market.name}) must resolve to a valid engine contract`);

      assert.ok(market.selections.length >= 2);
      for (const sel of market.selections) {
        assert.ok(Number.isFinite(sel.odds));
        assert.ok(sel.odds > 1);
        assert.equal(sel.isExchange, true);
        if (sel.layOdds !== undefined) {
          assert.ok(Number.isFinite(sel.layOdds));
          assert.ok(sel.layOdds > 1);
        }
        if (sel.liquidity !== undefined) {
          assert.ok(Number.isFinite(sel.liquidity));
        }
      }
    }
  }

  // Full coverage checks
  assert.ok(seenSports.has('football'), 'must cover football');
  assert.ok(seenMarkets.has('1X2') || seenMarkets.has('MATCH_ODDS'), 'must cover match odds');
  assert.ok([...seenMarkets].some((k) => k.startsWith('OVER_UNDER')), 'must cover totals');
  assert.ok(seenMarkets.has('BTTS'), 'must cover both teams to score');
});

test('BetfairScraper: normalizes raw validation failures cleanly', () => {
  const scraper = new BetfairScraper({});
  assert.throws(() => scraper.normalize(null), /raw payload missing/);
  assert.throws(() => scraper.normalize('not-an-object'), /raw payload missing/);
  assert.throws(() => scraper.normalize({ byMarket: { faultcode: 'ERE-0001', faultstring: 'TOO_MUCH_DATA' } }), /upstream error/);
  assert.throws(() => scraper.normalize({ byMarket: {} }), /expected eventTypes array/);
});

test('BetfairScraper: caps maxEvents via options and environment variable', (t) => {
  const old = process.env.ARBITER_MAX_EVENTS_PER_BOOK;
  t.after(() => {
    if (old === undefined) delete process.env.ARBITER_MAX_EVENTS_PER_BOOK;
    else process.env.ARBITER_MAX_EVENTS_PER_BOOK = old;
  });

  const scraperDefault = new BetfairScraper({ maxEvents: 2 });
  const raw = scraperDefault.normalize(fixture.raw);
  const events = scraperDefault.extractEvents(raw);
  assert.equal(events.length, 2);

  process.env.ARBITER_MAX_EVENTS_PER_BOOK = '3';
  const scraperEnv = new BetfairScraper({});
  const eventsEnv = scraperEnv.extractEvents(raw);
  assert.equal(eventsEnv.length, 3);
});

test('BetfairScraper: fetchRaw handles upstream fetch calls and error states', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('search')) {
      return new globalThis.Response(JSON.stringify(fixture.raw.search), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('bymarket')) {
      return new globalThis.Response(JSON.stringify(fixture.raw.byMarket), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new globalThis.Response('Not found', { status: 404 });
  };

  const scraper = new BetfairScraper({ fetchImpl: mockFetch, batchSize: 50 });
  const raw = await scraper.fetchRaw();
  assert.ok(raw.search);
  assert.ok(raw.byMarket);
  assert.ok(calls.length >= 2);

  // Test HTTP failure
  const failingFetch = async () => new globalThis.Response('Internal Server Error', { status: 500 });
  const scraperFailing = new BetfairScraper({ fetchImpl: failingFetch });
  await assert.rejects(() => scraperFailing.fetchRaw(), /search facet returned HTTP 500/);
});

test('BetfairScraper: _serializable reports full multi-sport market coverage', () => {
  const scraper = new BetfairScraper({});
  const raw = scraper.normalize(fixture.raw);
  const events = scraper.validate(scraper.extractEvents(raw));
  const serialized = scraper._serializable(events, fixture.raw);

  assert.equal(serialized.sourceUrl, 'https://www.betfair.ro/exchange');
  assert.equal(serialized.transport, 'betfair-exchange-readonly-json');
  assert.equal(serialized.coverage.sport, 'multi-sport');
  assert.equal(serialized.coverage.allMarkets, true);
  assert.ok(serialized.coverage.market.includes('fulltime-1x2'));
  assert.ok(serialized.coverage.market.includes('totals'));
  assert.ok(serialized.coverage.market.includes('btts'));
});

test('Betfair Exchange: order book liquidity and depth compute executable fill volumes', () => {
  const legs = [
    {
      sourceId: 'betfair',
      selection: '1',
      odds: 2.10,
      liquidity: 120.00,
      isExchange: true,
      depth: {
        back: [{ price: 2.10, size: 120.00 }, { price: 2.08, size: 450.00 }],
        lay: [{ price: 2.12, size: 200.00 }]
      }
    },
    {
      sourceId: 'superbet',
      selection: 'X2',
      odds: 2.05,
    }
  ];

  // Bankroll 1000: Betfair desired stake is ~493.98, but available liquidity is 120.00
  const allocation = roundedArbitrageAllocation(legs, 1000);
  assert.ok(allocation);
  assert.equal(allocation.isLiquidityConstrained, true);
  assert.ok(allocation.maxExecutableBankroll < 1000);
  const bfLeg = allocation.legs.find((l) => l.sourceId === 'betfair');
  assert.equal(bfLeg.fillVolume, 120.00);
  assert.ok(bfLeg.fillRate < 1.0);
  assert.ok(bfLeg.depth.back.length >= 2);

  // Bankroll 200: Betfair desired stake is ~98.80, which is fully within 120.00 liquidity
  const smallAlloc = roundedArbitrageAllocation(legs, 200);
  assert.ok(smallAlloc);
  assert.equal(smallAlloc.isLiquidityConstrained, false);
  const bfSmall = smallAlloc.legs.find((l) => l.sourceId === 'betfair');
  assert.equal(bfSmall.fillVolume, bfSmall.stake);
  assert.equal(bfSmall.fillRate, 1.0);
});

test('BetfairScraper: exports sports taxonomy mapping constants', () => {
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.football, 1);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.tennis, 2);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.basketball, 7522);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS['ice-hockey'], 7524);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.handball, 468328);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.volleyball, 998917);
  assert.equal(BETFAIR_SPORT_EVENT_TYPE_IDS.darts, 3503);

  assert.equal(BETFAIR_EVENT_TYPE_ID_TO_SPORT[1], 'football');
  assert.equal(BETFAIR_EVENT_TYPE_ID_TO_SPORT[2], 'tennis');
  assert.equal(BETFAIR_EVENT_TYPE_ID_TO_SPORT[7522], 'basketball');
  assert.equal(BETFAIR_EVENT_TYPE_ID_TO_SPORT[7524], 'ice-hockey');
  assert.equal(BETFAIR_EVENT_TYPE_ID_TO_SPORT[468328], 'handball');
});

test('BetfairScraper: constructor sets sports array for sport all and single sport', () => {
  const allScraper = new BetfairScraper({ sport: 'all' });
  assert.ok(allScraper.sports.length > 5);
  assert.ok(allScraper.sports.includes('football'));
  assert.ok(allScraper.sports.includes('tennis'));
  assert.ok(allScraper.sports.includes('basketball'));
  assert.ok(allScraper.sports.includes('ice-hockey'));

  const singleScraper = new BetfairScraper({ sport: 'basketball' });
  assert.deepEqual(singleScraper.sports, ['basketball']);
});

test('BetfairScraper: live in-play filtering respects includeLive flag', () => {
  const rawLive = [
    {
      eventId: '1001',
      event: { eventId: '1001', eventName: 'Arsenal v Chelsea', openDate: '2026-01-01T12:00:00Z' },
      eventTypeId: 1,
      marketNodes: [
        {
          description: { marketType: 'MATCH_ODDS' },
          state: { status: 'OPEN', inplay: true },
          runners: [
            { description: { runnerName: 'Arsenal' }, exchange: { availableToBack: [{ price: 2.10, size: 100 }] } },
            { description: { runnerName: 'The Draw' }, exchange: { availableToBack: [{ price: 3.40, size: 100 }] } },
            { description: { runnerName: 'Chelsea' }, exchange: { availableToBack: [{ price: 3.50, size: 100 }] } },
          ],
        },
      ],
    },
  ];

  const defaultScraper = new BetfairScraper({ includeLive: false });
  assert.equal(defaultScraper.extractEvents(rawLive).length, 0, 'inplay event dropped when includeLive is false');

  const liveScraper = new BetfairScraper({ includeLive: true });
  const liveEvents = liveScraper.extractEvents(rawLive);
  assert.equal(liveEvents.length, 1, 'inplay event admitted when includeLive is true');
  assert.equal(liveEvents[0].live, true);
  assert.equal(liveEvents[0].markets[0].live, true, 'markets tagged with live: true on inplay events');
});

test('BetfairScraper: extracts basketball points totals with subject points', () => {
  const scraper = new BetfairScraper({});
  const rawBasketball = [
    {
      eventId: '2001',
      event: { eventId: '2001', eventName: 'Boston Celtics @ LA Lakers', openDate: '2030-01-01T20:00:00Z' },
      eventTypeId: 7522,
      marketNodes: [
        {
          description: { marketType: 'OVER_UNDER_215_5' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Over 215.5' }, exchange: { availableToBack: [{ price: 1.85, size: 200 }], availableToLay: [{ price: 1.90, size: 100 }] } },
            { description: { runnerName: 'Under 215.5' }, exchange: { availableToBack: [{ price: 1.95, size: 200 }], availableToLay: [{ price: 2.00, size: 100 }] } },
          ],
        },
      ],
    },
  ];

  const events = scraper.extractEvents(rawBasketball);
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'basketball');
  assert.equal(events[0].markets.length, 1);
  const total = events[0].markets[0];
  assert.equal(total.key, 'POINTS_OVER_UNDER_215_5');
  assert.equal(total.subject, 'points');
  assert.equal(total.name, 'Total Points 215.5');

  const contract = resolveContract(total, { sport: 'Basketball' });
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'points');
  assert.equal(contract.lineKey, '215.5');
});

test('BetfairScraper: extracts tennis games totals with subject games', () => {
  const scraper = new BetfairScraper({});
  const rawTennis = [
    {
      eventId: '3001',
      event: { eventId: '3001', eventName: 'Jannik Sinner v Carlos Alcaraz', openDate: '2030-01-01T15:00:00Z' },
      eventTypeId: 2,
      marketNodes: [
        {
          description: { marketType: 'OVER_UNDER_22_5' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Over 22.5' }, exchange: { availableToBack: [{ price: 1.80, size: 200 }] } },
            { description: { runnerName: 'Under 22.5' }, exchange: { availableToBack: [{ price: 2.05, size: 200 }] } },
          ],
        },
      ],
    },
  ];

  const events = scraper.extractEvents(rawTennis);
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'tennis');
  assert.equal(events[0].markets.length, 1);
  const total = events[0].markets[0];
  assert.equal(total.key, 'OVER_UNDER_22_5');
  assert.equal(total.subject, 'games');
  assert.equal(total.name, 'Total Games 22.5');

  const contract = resolveContract(total, { sport: 'Tennis' });
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'games');
  assert.equal(contract.lineKey, '22.5');
});

test('BetfairScraper: extracts sub-window period markets (halves, sets) with bucket key isolation', () => {
  const scraper = new BetfairScraper({});
  const rawSubWindows = [
    {
      eventId: '4001',
      event: { eventId: '4001', eventName: 'Arsenal v Chelsea', openDate: '2030-01-01T17:00:00Z' },
      eventTypeId: 1,
      marketNodes: [
        {
          description: { marketType: 'MATCH_ODDS', marketName: 'Match Odds' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Arsenal' }, exchange: { availableToBack: [{ price: 2.10, size: 500 }] } },
            { description: { runnerName: 'The Draw' }, exchange: { availableToBack: [{ price: 3.40, size: 400 }] } },
            { description: { runnerName: 'Chelsea' }, exchange: { availableToBack: [{ price: 3.50, size: 300 }] } },
          ],
        },
        {
          description: { marketType: 'HALF_TIME', marketName: 'Half Time' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Arsenal' }, exchange: { availableToBack: [{ price: 2.70, size: 300 }] } },
            { description: { runnerName: 'The Draw' }, exchange: { availableToBack: [{ price: 2.15, size: 350 }] } },
            { description: { runnerName: 'Chelsea' }, exchange: { availableToBack: [{ price: 4.10, size: 200 }] } },
          ],
        },
        {
          description: { marketType: 'OVER_UNDER_25', marketName: 'Over/Under 2.5 Goals' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Over 2.5 Goals' }, exchange: { availableToBack: [{ price: 1.85, size: 450 }] } },
            { description: { runnerName: 'Under 2.5 Goals' }, exchange: { availableToBack: [{ price: 2.05, size: 450 }] } },
          ],
        },
        {
          description: { marketType: 'FIRST_HALF_GOALS_15', marketName: 'First Half Goals 1.5' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Over 1.5 Goals' }, exchange: { availableToBack: [{ price: 2.60, size: 200 }] } },
            { description: { runnerName: 'Under 1.5 Goals' }, exchange: { availableToBack: [{ price: 1.55, size: 300 }] } },
          ],
        },
      ],
    },
    {
      eventId: '4002',
      event: { eventId: '4002', eventName: 'Carlos Alcaraz v Novak Djokovic', openDate: '2030-01-01T19:00:00Z' },
      eventTypeId: 2,
      marketNodes: [
        {
          description: { marketType: 'MATCH_ODDS', marketName: 'Match Odds' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Carlos Alcaraz' }, exchange: { availableToBack: [{ price: 1.75, size: 800 }] } },
            { description: { runnerName: 'Novak Djokovic' }, exchange: { availableToBack: [{ price: 2.20, size: 700 }] } },
          ],
        },
        {
          description: { marketType: 'SET_WINNER', marketName: 'Set 1 Winner' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Carlos Alcaraz' }, exchange: { availableToBack: [{ price: 1.80, size: 400 }] } },
            { description: { runnerName: 'Novak Djokovic' }, exchange: { availableToBack: [{ price: 2.10, size: 350 }] } },
          ],
        },
      ],
    },
  ];

  const events = scraper.extractEvents(rawSubWindows);
  assert.equal(events.length, 2);

  // Event 1: Football Arsenal v Chelsea
  const fbEvent = events[0];
  assert.equal(fbEvent.markets.length, 4);

  const ft1x2 = fbEvent.markets.find((m) => m.key === '1X2');
  assert.ok(ft1x2);
  assert.equal(ft1x2.period, 'fulltime');

  const ht1x2 = fbEvent.markets.find((m) => m.key === 'HALF_WINNER');
  assert.ok(ht1x2);
  assert.equal(ht1x2.period, 'half1');

  const ftOu = fbEvent.markets.find((m) => m.key === 'OVER_UNDER_2_5');
  assert.ok(ftOu);
  assert.equal(ftOu.period, 'fulltime');
  assert.equal(ftOu.line, 2.5);

  const htOu = fbEvent.markets.find((m) => m.key === 'OVER_UNDER_1_5_1H');
  assert.ok(htOu);
  assert.equal(htOu.period, 'half1');
  assert.equal(htOu.line, 1.5);

  const ft1x2Contract = resolveContract(ft1x2, { sport: 'Football' });
  const ht1x2Contract = resolveContract(ht1x2, { sport: 'Football' });
  const ftOuContract = resolveContract(ftOu, { sport: 'Football' });
  const htOuContract = resolveContract(htOu, { sport: 'Football' });

  assert.equal(ft1x2Contract.period, 'fulltime');
  assert.equal(ht1x2Contract.period, 'half1');
  assert.equal(ftOuContract.period, 'fulltime');
  assert.equal(htOuContract.period, 'half1');

  const ft1x2Bucket = bucketKeyForContract('evFB', ft1x2Contract);
  const ht1x2Bucket = bucketKeyForContract('evFB', ht1x2Contract);
  const ftOuBucket = bucketKeyForContract('evFB', ftOuContract);
  const htOuBucket = bucketKeyForContract('evFB', htOuContract);

  assert.equal(ft1x2Bucket, 'evFB::MATCH_ODDS::fulltime::_::home+draw+away::_::_');
  assert.equal(ht1x2Bucket, 'evFB::MATCH_ODDS::half1::_::home+draw+away::_::_');
  assert.equal(ftOuBucket, 'evFB::OVER_UNDER::fulltime::2.5::over+under::goals::match');
  assert.equal(htOuBucket, 'evFB::OVER_UNDER::half1::1.5::over+under::goals::match');

  assert.notEqual(ft1x2Bucket, ht1x2Bucket, 'FT 1X2 and HT 1X2 must never bucket together');
  assert.notEqual(ftOuBucket, htOuBucket, 'FT Over/Under and HT Over/Under must never bucket together');

  // Event 2: Tennis Alcaraz v Djokovic
  const tnEvent = events[1];
  assert.equal(tnEvent.markets.length, 2);

  const ftMatchOdds = tnEvent.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(ftMatchOdds);
  assert.equal(ftMatchOdds.period, 'fulltime');

  const set1Winner = tnEvent.markets.find((m) => m.key === 'SET_WINNER');
  assert.ok(set1Winner);
  assert.equal(set1Winner.period, 'set1');

  const ftMatchContract = resolveContract(ftMatchOdds, { sport: 'Tennis' });
  const set1Contract = resolveContract(set1Winner, { sport: 'Tennis' });

  assert.equal(ftMatchContract.period, 'fulltime');
  assert.equal(set1Contract.period, 'set1');

  const ftMatchBucket = bucketKeyForContract('evTN', ftMatchContract);
  const set1Bucket = bucketKeyForContract('evTN', set1Contract);

  assert.equal(ftMatchBucket, 'evTN::MATCH_ODDS::fulltime::_::home+away::_::_');
  assert.equal(set1Bucket, 'evTN::MATCH_ODDS::set1::_::home+away::_::_');
  assert.notEqual(ftMatchBucket, set1Bucket, 'Full-time Match Odds and Set 1 Winner must never bucket together');
});

test('BetfairScraper: extracts second-half sub-window derivatives and resolves runner order alignment', () => {
  const scraper = new BetfairScraper({});
  const rawPayload = [
    {
      eventId: '5001',
      event: { eventId: '5001', eventName: 'Liverpool v Everton', openDate: '2030-01-01T14:00:00Z' },
      eventTypeId: 1,
      marketNodes: [
        {
          description: { marketType: 'MATCH_ODDS', marketName: 'Second Half Winner' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Liverpool' }, exchange: { availableToBack: [{ price: 1.90, size: 400 }] } },
            { description: { runnerName: 'The Draw' }, exchange: { availableToBack: [{ price: 2.60, size: 300 }] } },
            { description: { runnerName: 'Everton' }, exchange: { availableToBack: [{ price: 4.80, size: 150 }] } },
          ],
        },
        {
          description: { marketType: 'SECOND_HALF_GOALS_15', marketName: 'Second Half Goals 1.5' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Over 1.5 Goals' }, exchange: { availableToBack: [{ price: 2.20, size: 250 }] } },
            { description: { runnerName: 'Under 1.5 Goals' }, exchange: { availableToBack: [{ price: 1.70, size: 350 }] } },
          ],
        },
      ],
    },
    {
      eventId: '5002',
      event: { eventId: '5002', eventName: 'Golden State Warriors @ Los Angeles Lakers', openDate: '2030-01-01T22:00:00Z' },
      eventTypeId: 7522,
      marketNodes: [
        {
          // 2-way with inverted runner order (Away team listed first)
          description: { marketType: 'MATCH_ODDS', marketName: '1st Quarter Winner' },
          state: { status: 'OPEN', inplay: false },
          runners: [
            { description: { runnerName: 'Golden State Warriors' }, exchange: { availableToBack: [{ price: 2.30, size: 300 }], availableToLay: [{ price: 2.36, size: 150 }] } },
            { description: { runnerName: 'Los Angeles Lakers' }, exchange: { availableToBack: [{ price: 1.65, size: 500 }], availableToLay: [{ price: 1.70, size: 250 }] } },
          ],
        },
      ],
    },
  ];

  const events = scraper.extractEvents(rawPayload);
  assert.equal(events.length, 2);

  // Event 1: Liverpool v Everton second half derivatives
  const fbEvent = events[0];
  assert.equal(fbEvent.markets.length, 2);

  const half2Winner = fbEvent.markets.find((m) => m.key === 'HALF_WINNER');
  assert.ok(half2Winner);
  assert.equal(half2Winner.period, 'half2');

  const half2Ou = fbEvent.markets.find((m) => m.key === 'OVER_UNDER_1_5');
  assert.ok(half2Ou);
  assert.equal(half2Ou.period, 'half2');

  const h2WinContract = resolveContract(half2Winner, { sport: 'Football', homeTeam: 'Liverpool', awayTeam: 'Everton' });
  const h2OuContract = resolveContract(half2Ou, { sport: 'Football', homeTeam: 'Liverpool', awayTeam: 'Everton' });

  assert.equal(h2WinContract.period, 'half2');
  assert.equal(h2OuContract.period, 'half2');

  const h2WinBucket = bucketKeyForContract('evDerby', h2WinContract);
  const h2OuBucket = bucketKeyForContract('evDerby', h2OuContract);

  assert.equal(h2WinBucket, 'evDerby::MATCH_ODDS::half2::_::home+draw+away::_::_');
  assert.equal(h2OuBucket, 'evDerby::OVER_UNDER::half2::1.5::over+under::goals::match');

  // Event 2: NBA Lakers vs Warriors Q1 winner with runner alignment
  const nbaEvent = events[1];
  assert.equal(nbaEvent.homeTeam, 'Los Angeles Lakers');
  assert.equal(nbaEvent.awayTeam, 'Golden State Warriors');
  assert.equal(nbaEvent.markets.length, 1);

  const q1Winner = nbaEvent.markets[0];
  assert.equal(q1Winner.key, 'QUARTER_WINNER');
  assert.equal(q1Winner.period, 'q1');

  // Verify selections are correctly attributed to home and away teams
  const homeSel = q1Winner.selections.find((s) => s.name === 'Los Angeles Lakers');
  const awaySel = q1Winner.selections.find((s) => s.name === 'Golden State Warriors');
  assert.ok(homeSel);
  assert.ok(awaySel);
  assert.equal(homeSel.odds, 1.65, 'Home odds aligned despite inverted runner list');
  assert.equal(awaySel.odds, 2.30, 'Away odds aligned despite inverted runner list');

  const q1Contract = resolveContract(q1Winner, { sport: 'Basketball', homeTeam: 'Los Angeles Lakers', awayTeam: 'Golden State Warriors' });
  assert.equal(q1Contract.period, 'q1');
  assert.deepEqual(q1Contract.outcomes, ['home', 'away']);

  const q1Bucket = bucketKeyForContract('evNBA', q1Contract);
  assert.equal(q1Bucket, 'evNBA::MATCH_ODDS::q1::_::home+away::_::_');
});
