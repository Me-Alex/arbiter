import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import Betano from '../src/scrapers/betano.mjs';
import { resolveContract, canonicalOutcomeFor, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

/**
 * Betano reaches its feed through a browser: it navigates, lets the app mount,
 * then issues its own requests from inside the page. That makes every failure
 * a swallowed one unless it is counted — and all 36 could fail while the run
 * reported success with zero events, which is the same shape as the other
 * silent-zero defects this project has had.
 *
 * These assertions pin the two properties that matter: a total failure is a
 * failed run, and it names what came back rather than counting.
 */

/** A page that answers `page.evaluate` with whatever the test supplies. */
function pageReturning(payloadFor) {
  return {
    async goto() {},
    async waitForTimeout() {},
    async title() { return 'Pariuri'; },
    async addInitScript() {},
    async evaluate(_fn, sportId) { return payloadFor(sportId); },
    async context() { return { cookies: () => [] }; },
  };
}

/** A page whose in-page requests all fail the given way. */
function failingPage(kind) {
  return {
    async goto() {},
    async waitForTimeout() {},
    async title() { return 'Pariuri'; },
    async addInitScript() {},
    async evaluate() {
      if (kind === 'status') return { __status: 403 };
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    },
    async context() { return { cookies: () => [] }; },
  };
}

/**
 * Run the adapter with a stubbed browser, returning the envelope.
 *
 * The `dataDir` is mandatory and temporary. `ScraperBase` defaults it to
 * `<cwd>/data` and `run()` promotes the result to
 * `data/workspace/betano_events.json`, so a test that omits it writes its
 * fixture straight over the real Betano snapshot. That is not hypothetical:
 * the "a real payload still produces events" fixture below — event 111,
 * FCSB v Dinamo, 2.10/3.30/3.20 — replaced 235 genuinely scraped events in the
 * production workspace, and the next scan happily reported one synthetic match
 * as live Betano data. A test that can overwrite the data it is meant to be
 * checking is worse than no test.
 */
async function runWith(page, opts = {}) {
  const dataDir = './data-test-betano-' + Math.random().toString(36).slice(2);
  await fs.mkdir(`${dataDir}/workspace`, { recursive: true });
  try {
    const scraper = new Betano({ timeoutMs: 20_000, dataDir, ...opts });
    // The adapter also reads the context for cookies after collecting.
    const ctx = { cookies: async () => [] };
    page.context = async () => ctx;
    scraper.pageFactory = async () => page;
    return await scraper.run();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('a session that returned no events is a failed run, not an empty one', async () => {
  // The guard used to be `if (!top?.events || typeof top.events !== 'object')`,
  // and `typeof {} === 'object'` — so a well-formed empty body passed it and
  // the run reported `status: ok, events: 0`.
  const result = await runWith(pageReturning(() => ({ data: { topEventsV2: {} } })));
  assert.equal(result.status, 'failed', 'zero events from every sport is a failure');
  assert.equal(result.valid, false);
  assert.equal(result.events, 0);
});

test('a total failure names what actually came back', async () => {
  const refused = await runWith(failingPage('status'));
  assert.match(refused.error.message, /403/, `the status reaches the message: ${refused.error.message}`);

  const reset = await runWith(failingPage('throw'));
  assert.match(reset.error.message, /ECONNRESET/, `the network code reaches the message: ${reset.error.message}`);
});

test('a real payload still produces events', async () => {
  const result = await runWith(pageReturning(() => ({
    data: {
      topEventsV2: {
        eventIdList: [111],
        events: {
          111: {
            id: 111,
            // The shape the adapter actually reads: participants[] and
            // startTime, not a nested `event` object.
            participants: [{ shortName: 'FCSB' }, { shortName: 'Dinamo' }],
            startTime: new Date(Date.now() + 3600_000).toISOString(),
            leagueId: 5,
            sportId: 'FOOT',
            // Markets live in a separate map and reference selections by id,
            // which is what the adapter walks — not an inline betOffers array.
            marketIdList: [9],
          },
        },
        leagues: { 5: { name: 'Liga 1' } },
        markets: {
          9: { id: 9, name: 'Match Odds', type: 'MATCH_ODDS', selectionIdList: ['s1', 's2', 's3'] },
        },
        selections: {
          s1: { id: 's1', shortName: '1', price: 2.10 },
          s2: { id: 's2', shortName: 'X', price: 3.30 },
          s3: { id: 's3', shortName: '2', price: 3.20 },
        },
      },
    },
  })));
  assert.equal(result.status, 'ok', `a real payload still works: ${result.error?.message ?? ''}`);
  assert.ok(result.events > 0, 'events are extracted');
});

/**
 * The two betano handicap shapes that resolve a contract and then price no leg.
 *
 * They are grouped here because they are the same defect seen from two ends: a
 * handicap leg reached the engine with nothing that says WHICH side it is, so
 * canonicalOutcomeFor returned null and the market contributed a bucket that no
 * other book could ever be matched against. "Resolves" was true, "prices" was
 * false, and only measuring the second one found it.
 *
 * The shapes, both measured on the 2026-09-29 production capture:
 *   FHOT "Handicap"           "-8.5" / "+8.5"      — bare spread, no side token
 *   TGHC "Total Game-uri ..."  "Khachanov +2.5"    — player name, TRAILING line
 *
 * Everything below drives extractEvents on a payload built in the feed's own
 * topEventsV2 shape and then calls the resolver the way engine.mjs does, so a
 * green run means the engine's real path works, not a re-derivation of it.
 */

/** One event carrying `markets` (type → [selection names]) through the adapter. */
function extract({ sportId = 'FOOT', home = 'FCSB', away = 'Dinamo', markets }) {
  const top = {
    events: {
      1: {
        id: 1,
        participants: [{ shortName: home }, { shortName: away }],
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        leagueId: 5,
        sportId,
        // The event lists numeric market ids; each market carries its own `type`,
        // which is the provider key the resolver routes on. Both are needed.
        marketIdList: Object.entries(markets).map((_, i) => String(i + 1)),
      },
    },
    leagues: { 5: { name: 'Liga 1' } },
    markets: {},
    selections: {},
    eventIdList: [1],
  };
  Object.entries(markets).forEach(([type, names], i) => {
    const id = String(i + 1);
    top.markets[id] = { id, name: type, type, selectionIdList: names.map((_, j) => `${id}-${j}`) };
    names.forEach((name, j) => {
      top.selections[`${id}-${j}`] = { id: `${id}-${j}`, shortName: name, price: 2 + j * 0.1, handicap: 3 };
    });
  });
  const out = new Betano({ windowHours: 24 }).extractEvents(top);
  assert.equal(out.length, 1, 'the fixture must reach extractEvents');
  return out[0];
}

/** Resolve and route exactly as engine.mjs:120-171 does. */
function route(ev, market) {
  const contract = resolveContract(market);
  if (!contract) return { contract: null, sides: null };
  const sides = market.selections.map((s) => canonicalOutcomeFor(s.name, contract, {
    homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
  }));
  return { contract, sides };
}

test('FHOT: a bare signed spread is assigned sides by sign, not by position', () => {
  const ev = extract({ markets: { FHOT: ['-8.5', '+8.5'] } });
  const market = ev.markets.find((m) => m.key === 'FHOT');
  assert.deepEqual(market.selections.map((s) => s.name), ['1 (-8.5)', '2 (+8.5)'],
    'the sign becomes the side token; the provider label survives on providerName');
  assert.deepEqual(market.selections.map((s) => s.providerName), ['-8.5', '+8.5']);
  const { contract, sides } = route(ev, market);
  assert.equal(contract.family, 'ASIAN_HANDICAP');
  assert.equal(contract.lineKey, '-8.5/8.5');
  assert.deepEqual(sides, ['home', 'away']);
  // Each leg carries its OWN line, not the provider's `handicap` type flag (3).
  // findMiddles pairs any two legs whose handicaps differ without checking they
  // are the same side, so one shared value would report a middle between this
  // market's own two sides.
  assert.deepEqual(market.selections.map((s) => s.handicap), ['-8.5', '+8.5']);
});

test('FHOT: the reversed leg order collapses onto the same contract', () => {
  // Measured: FHOT listed the negative leg first on 29 markets and the positive
  // leg first on 15. Ordering the lineKey by position would have split one
  // handicap across two buckets, so two books publishing opposite orders would
  // never pair — and neither would a book's own mirrored markets.
  const ev = extract({ markets: { FHOT: ['+8.5', '-8.5'] } });
  const market = ev.markets.find((m) => m.key === 'FHOT');
  assert.deepEqual(market.selections.map((s) => s.name), ['2 (+8.5)', '1 (-8.5)']);
  const { contract, sides } = route(ev, market);
  assert.equal(contract.lineKey, '-8.5/8.5', 'same lineKey as the negative-first order');
  assert.deepEqual(sides, ['away', 'home']);
});

test('TGHC: a trailing line does not stop the player name from matching', () => {
  const ev = extract({
    sportId: 'TENN', home: 'Karen Khachanov', away: 'Felix Auger Aliassime',
    markets: { TGHC: ['Karen Khachanov +2.5', 'Felix Auger Aliassime -2.5'] },
  });
  const market = ev.markets.find((m) => m.key === 'TGHC');
  // The provider publishes the line AFTER the name, so stripping only a leading
  // line left "karen khachanov +2.5" to be compared with "karen khachanov".
  const { contract, sides } = route(ev, market);
  assert.equal(contract.family, 'ASIAN_HANDICAP');
  assert.deepEqual(sides, ['home', 'away'], 'both tennis legs must reach a side');
});

test('a spread that is not two opposite-signed bare legs is left alone', () => {
  // Nothing here is provable as an exhaustive handicap, so nothing may be
  // invented: a whole line pushes, two legs of one sign is not a spread, and a
  // named leg is already labelled. resolveContract withholds all three, which
  // is the correct outcome — an unpriceable market, never a mislabelled one.
  const whole = extract({ markets: { FHOT: ['-8', '+8'] } });
  const wholeMarket = whole.markets.find((m) => m.key === 'FHOT');
  assert.deepEqual(wholeMarket.selections.map((s) => s.name), ['-8', '+8'], 'passed through untouched');
  assert.equal(resolveContract(wholeMarket), null, 'a whole line pushes, so it is not a contract');

  const sameSign = extract({ markets: { FHOT: ['-8.5', '-4.5'] } });
  const sameMarket = sameSign.markets.find((m) => m.key === 'FHOT');
  assert.deepEqual(sameMarket.selections.map((s) => s.name), ['-8.5', '-4.5'], 'passed through untouched');

  const named = extract({ markets: { FHOT: ['FCSB -8.5', 'Dinamo +8.5'] } });
  const namedMarket = named.markets.find((m) => m.key === 'FHOT');
  assert.deepEqual(namedMarket.selections.map((s) => s.name), ['FCSB -8.5', 'Dinamo +8.5'], 'passed through untouched');
  const namedRoute = route(named, namedMarket);
  assert.equal(namedRoute.contract.family, 'ASIAN_HANDICAP');
  assert.deepEqual(namedRoute.sides, ['home', 'away'], 'named legs already route from the team match');
});

test('Basketball points totals: correctly tagged with subject points and resolves OVER_UNDER contract', () => {
  const ev = extract({
    sportId: 'BASK',
    home: 'Los Angeles Lakers',
    away: 'Boston Celtics',
    markets: {
      FTPO: ['Peste 224.5', 'Sub 224.5'],
    },
  });
  assert.equal(ev.sport, 'Basketball');
  const market = ev.markets.find((m) => m.key === 'FTPO');
  assert.ok(market, 'FTPO market extracted');
  assert.equal(market.subject, 'points', 'assigned points subject for Basketball');

  const { contract, sides } = route(ev, market);
  assert.ok(contract, 'resolves to contract');
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '224.5');
  assert.equal(contract.subject, 'points');
  assert.deepEqual(sides, ['over', 'under']);
});

test('Tennis games totals: correctly tagged with subject games and resolves OVER_UNDER contract', () => {
  const ev = extract({
    sportId: 'TENN',
    home: 'Carlos Alcaraz',
    away: 'Jannik Sinner',
    markets: {
      TGOT: ['Peste 22.5', 'Sub 22.5'],
    },
  });
  assert.equal(ev.sport, 'Tennis');
  const market = ev.markets.find((m) => m.key === 'TGOT');
  assert.ok(market, 'TGOT market extracted');
  assert.equal(market.subject, 'games', 'assigned games subject for Tennis');

  const { contract, sides } = route(ev, market);
  assert.ok(contract, 'resolves to contract');
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '22.5');
  assert.equal(contract.subject, 'games');
  assert.deepEqual(sides, ['over', 'under']);
});

test('Tennis 2-way match winner H2HT resolves to MATCH_ODDS', () => {
  const ev = extract({
    sportId: 'TENN',
    home: 'Carlos Alcaraz',
    away: 'Jannik Sinner',
    markets: {
      H2HT: ['Carlos Alcaraz', 'Jannik Sinner'],
    },
  });
  const market = ev.markets.find((m) => m.key === 'H2HT');
  assert.ok(market, 'H2HT market extracted');
  const { contract, sides } = route(ev, market);
  assert.ok(contract);
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.deepEqual(contract.outcomes, ['home', 'away']);
  assert.deepEqual(sides, ['home', 'away']);
});

test('In-play live filtering: live events are filtered out when includeLive is false, kept and marked when true', () => {
  const top = {
    events: {
      1: {
        id: 1,
        participants: [{ shortName: 'FCSB' }, { shortName: 'Dinamo' }],
        startTime: new Date().toISOString(),
        leagueId: 5,
        sportId: 'FOOT',
        isLive: true,
        marketIdList: ['1'],
      },
    },
    leagues: { 5: { name: 'Liga 1' } },
    markets: { 1: { id: '1', name: 'MRES', type: 'MRES', selectionIdList: ['s1', 's2', 's3'] } },
    selections: {
      s1: { id: 's1', shortName: '1', price: 2.10 },
      s2: { id: 's2', shortName: 'X', price: 3.30 },
      s3: { id: 's3', shortName: '2', price: 3.20 },
    },
    eventIdList: [1],
  };

  const prematchScraper = new Betano({ includeLive: false });
  const prematchEvents = prematchScraper.extractEvents(top);
  assert.equal(prematchEvents.length, 0, 'live event excluded when includeLive is false');

  const liveScraper = new Betano({ includeLive: true });
  const liveEvents = liveScraper.extractEvents(top);
  assert.equal(liveEvents.length, 1, 'live event included when includeLive is true');
  assert.equal(liveEvents[0].live, true);
  assert.equal(liveEvents[0].isLive, true);
  assert.equal(liveEvents[0].markets[0].live, true);
});

test('Betano period markets: OUH1 first-half goals and multi-sport sub-windows isolate from full-time', () => {
  const top = {
    events: {
      10: {
        id: 10,
        participants: [{ shortName: 'Arsenal' }, { shortName: 'Chelsea' }],
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        leagueId: 101,
        sportId: 'FOOT',
        marketIdList: ['m1', 'm2'],
      },
      20: {
        id: 20,
        participants: [{ shortName: 'Lakers' }, { shortName: 'Warriors' }],
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        leagueId: 102,
        sportId: 'BASK',
        marketIdList: ['m3', 'm4'],
      },
    },
    leagues: {
      101: { name: 'Premier League' },
      102: { name: 'NBA' },
    },
    markets: {
      m1: { id: 'm1', name: 'Total goluri', type: 'HCTG', selectionIdList: ['s1-o', 's1-u'] },
      m2: { id: 'm2', name: 'Goluri prima repriza Peste/Sub', type: 'OUH1', selectionIdList: ['s2-o', 's2-u'] },
      m3: { id: 'm3', name: 'Total puncte', type: 'FTPO', selectionIdList: ['s3-o', 's3-u'] },
      m4: { id: 'm4', name: 'Sfertul 1 - Total puncte', type: 'Q1PO', selectionIdList: ['s4-o', 's4-u'] },
    },
    selections: {
      's1-o': { id: 's1-o', shortName: 'Peste 2.5', price: 1.85, handicap: 2.5 },
      's1-u': { id: 's1-u', shortName: 'Sub 2.5', price: 1.95, handicap: 2.5 },
      's2-o': { id: 's2-o', shortName: 'Peste 0.5', price: 1.45, handicap: 0.5 },
      's2-u': { id: 's2-u', shortName: 'Sub 0.5', price: 2.65, handicap: 0.5 },
      's3-o': { id: 's3-o', shortName: 'Peste 220.5', price: 1.90, handicap: 220.5 },
      's3-u': { id: 's3-u', shortName: 'Sub 220.5', price: 1.90, handicap: 220.5 },
      's4-o': { id: 's4-o', shortName: 'Peste 54.5', price: 1.85, handicap: 54.5 },
      's4-u': { id: 's4-u', shortName: 'Sub 54.5', price: 1.95, handicap: 54.5 },
    },
    eventIdList: [10, 20],
  };

  const scraper = new Betano();
  const events = scraper.extractEvents(top);
  assert.equal(events.length, 2);

  const football = events.find((e) => e.sport === 'Football');
  const ftGoals = football.markets.find((m) => m.key === 'HCTG');
  assert.equal(ftGoals.period, 'fulltime');
  assert.equal(ftGoals.subject, 'goals');
  const ftGoalsContract = resolveContract(ftGoals);
  assert.equal(ftGoalsContract.family, 'OVER_UNDER');
  assert.equal(ftGoalsContract.period, 'fulltime');
  assert.equal(ftGoalsContract.lineKey, '2.5');

  const h1Goals = football.markets.find((m) => m.key === 'OUH1');
  assert.equal(h1Goals.period, 'half1');
  assert.equal(h1Goals.subject, 'goals');
  const h1GoalsContract = resolveContract(h1Goals);
  assert.equal(h1GoalsContract.family, 'OVER_UNDER');
  assert.equal(h1GoalsContract.period, 'half1');
  assert.equal(h1GoalsContract.lineKey, '0.5');

  const ftBucket = bucketKeyForContract(football.eventKey, ftGoalsContract);
  const h1Bucket = bucketKeyForContract(football.eventKey, h1GoalsContract);
  assert.notEqual(ftBucket, h1Bucket);
  assert.ok(ftBucket.includes('::fulltime::'));
  assert.ok(h1Bucket.includes('::half1::'));

  const basketball = events.find((e) => e.sport === 'Basketball');
  const q1Points = basketball.markets.find((m) => m.name === 'Sfertul 1 - Total puncte');
  assert.equal(q1Points.period, 'q1');
  assert.equal(q1Points.subject, 'points');
  const q1PointsContract = resolveContract(q1Points);
  assert.equal(q1PointsContract.family, 'OVER_UNDER');
  assert.equal(q1PointsContract.period, 'q1');
  assert.equal(q1PointsContract.subject, 'points');
  assert.equal(q1PointsContract.lineKey, '54.5');

  const ftPoints = basketball.markets.find((m) => m.name === 'Total puncte');
  const ftPointsContract = resolveContract(ftPoints);
  const ftPointsBucket = bucketKeyForContract(basketball.eventKey, ftPointsContract);
  const q1PointsBucket = bucketKeyForContract(basketball.eventKey, q1PointsContract);
  assert.notEqual(ftPointsBucket, q1PointsBucket);
  assert.ok(q1PointsBucket.includes('::q1::'));
  assert.ok(ftPointsBucket.includes('::fulltime::'));
});

test('Betano sub-window derivative markets: OUH2, MRH1, MRH2, BTH1, DCH1, DNH1 isolation and deduplication', () => {
  const top = {
    events: {
      100: {
        id: 100,
        participants: [{ shortName: 'Real Madrid' }, { shortName: 'Barcelona' }],
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        leagueId: 201,
        sportId: 'FOOT',
        marketIdList: ['m-ft', 'm-h1-ou', 'm-h2-ou', 'm-ft-1x2', 'm-h1-1x2', 'm-h2-1x2', 'm-ft-btts', 'm-h1-btts', 'm-ft-dc', 'm-h1-dc', 'm-ft-dnb', 'm-h1-dnb', 'm-dup'],
      },
    },
    leagues: {
      201: { name: 'La Liga' },
    },
    markets: {
      'm-ft': { id: 'm-ft', name: 'Total goluri Peste/Sub', type: 'HCTG', selectionIdList: ['s-ft-o', 's-ft-u'] },
      'm-h1-ou': { id: 'm-h1-ou', name: 'Goluri prima repriză Peste/Sub', type: 'OUH1', selectionIdList: ['s-h1-o', 's-h1-u'] },
      'm-h2-ou': { id: 'm-h2-ou', name: 'Goluri a doua repriză Peste/Sub', type: 'OUH2', selectionIdList: ['s-h2-o', 's-h2-u'] },
      'm-ft-1x2': { id: 'm-ft-1x2', name: 'Rezultat final', type: 'MRES', selectionIdList: ['s-1', 's-x', 's-2'] },
      'm-h1-1x2': { id: 'm-h1-1x2', name: 'Rezultat prima repriză', type: 'MRH1', selectionIdList: ['s-h1-1', 's-h1-x', 's-h1-2'] },
      'm-h2-1x2': { id: 'm-h2-1x2', name: 'Rezultat a doua repriză', type: 'MRH2', selectionIdList: ['s-h2-1', 's-h2-x', 's-h2-2'] },
      'm-ft-btts': { id: 'm-ft-btts', name: 'Ambele echipe înscriu', type: 'BTSC', selectionIdList: ['s-btts-y', 's-btts-n'] },
      'm-h1-btts': { id: 'm-h1-btts', name: 'Ambele echipe înscriu prima repriză', type: 'BTH1', selectionIdList: ['s-bth1-y', 's-bth1-n'] },
      'm-ft-dc': { id: 'm-ft-dc', name: 'Șansă dublă', type: 'DBLC', selectionIdList: ['s-dc-1x', 's-dc-12', 's-dc-x2'] },
      'm-h1-dc': { id: 'm-h1-dc', name: 'Șansă dublă prima repriză', type: 'DCH1', selectionIdList: ['s-dch1-1x', 's-dch1-12', 's-dch1-x2'] },
      'm-ft-dnb': { id: 'm-ft-dnb', name: 'Niciun pariu pe egal', type: 'DNOB', selectionIdList: ['s-dnb-1', 's-dnb-2'] },
      'm-h1-dnb': { id: 'm-h1-dnb', name: 'Pariu fără egal prima repriză', type: 'DNH1', selectionIdList: ['s-dnh1-1', 's-dnh1-2'] },
      'm-dup': { id: 'm-dup', name: 'Goluri prima repriză Peste/Sub', type: 'OUH1', selectionIdList: ['s-h1-o', 's-h1-u'] },
    },
    selections: {
      's-ft-o': { id: 's-ft-o', shortName: 'Peste 2.5', price: 1.85, handicap: 2.5 },
      's-ft-u': { id: 's-ft-u', shortName: 'Sub 2.5', price: 1.95, handicap: 2.5 },
      's-h1-o': { id: 's-h1-o', shortName: 'Peste 1.5', price: 2.10, handicap: 1.5 },
      's-h1-u': { id: 's-h1-u', shortName: 'Sub 1.5', price: 1.70, handicap: 1.5 },
      's-h2-o': { id: 's-h2-o', shortName: 'Peste 1.5', price: 1.95, handicap: 1.5 },
      's-h2-u': { id: 's-h2-u', shortName: 'Sub 1.5', price: 1.85, handicap: 1.5 },
      's-1': { id: 's-1', shortName: '1', price: 2.20 },
      's-x': { id: 's-x', shortName: 'X', price: 3.40 },
      's-2': { id: 's-2', shortName: '2', price: 3.10 },
      's-h1-1': { id: 's-h1-1', shortName: '1', price: 2.70 },
      's-h1-x': { id: 's-h1-x', shortName: 'X', price: 2.20 },
      's-h1-2': { id: 's-h1-2', shortName: '2', price: 3.60 },
      's-h2-1': { id: 's-h2-1', shortName: '1', price: 2.50 },
      's-h2-x': { id: 's-h2-x', shortName: 'X', price: 2.40 },
      's-h2-2': { id: 's-h2-2', shortName: '2', price: 3.30 },
      's-btts-y': { id: 's-btts-y', shortName: 'Da', price: 1.75 },
      's-btts-n': { id: 's-btts-n', shortName: 'Nu', price: 2.05 },
      's-bth1-y': { id: 's-bth1-y', shortName: 'Da', price: 3.80 },
      's-bth1-n': { id: 's-bth1-n', shortName: 'Nu', price: 1.25 },
      's-dc-1x': { id: 's-dc-1x', shortName: '1X', price: 1.35 },
      's-dc-12': { id: 's-dc-12', shortName: '12', price: 1.30 },
      's-dc-x2': { id: 's-dc-x2', shortName: 'X2', price: 1.65 },
      's-dch1-1x': { id: 's-dch1-1x', shortName: '1X', price: 1.25 },
      's-dch1-12': { id: 's-dch1-12', shortName: '12', price: 1.60 },
      's-dch1-x2': { id: 's-dch1-x2', shortName: 'X2', price: 1.45 },
      's-dnb-1': { id: 's-dnb-1', shortName: '1', price: 1.60 },
      's-dnb-2': { id: 's-dnb-2', shortName: '2', price: 2.25 },
      's-dnh1-1': { id: 's-dnh1-1', shortName: '1', price: 1.70 },
      's-dnh1-2': { id: 's-dnh1-2', shortName: '2', price: 2.10 },
    },
    eventIdList: [100],
  };

  const scraper = new Betano();
  const events = scraper.extractEvents(top);
  assert.equal(events.length, 1);
  const ev = events[0];

  // 1. Deduplication: m-dup was identical to m-h1-ou, so markets length should be 12, not 13
  assert.equal(ev.markets.length, 12, 'duplicate feed market m-dup was deduplicated');

  // 2. Totals isolation across fulltime, half1, half2
  const ftOu = ev.markets.find((m) => m.key === 'HCTG');
  const h1Ou = ev.markets.find((m) => m.key === 'OUH1');
  const h2Ou = ev.markets.find((m) => m.key === 'OUH2');
  assert.equal(ftOu.period, 'fulltime');
  assert.equal(h1Ou.period, 'half1');
  assert.equal(h2Ou.period, 'half2');
  const ftOuContract = resolveContract(ftOu);
  const h1OuContract = resolveContract(h1Ou);
  const h2OuContract = resolveContract(h2Ou);
  assert.equal(ftOuContract.period, 'fulltime');
  assert.equal(h1OuContract.period, 'half1');
  assert.equal(h2OuContract.period, 'half2');
  const ftOuBucket = bucketKeyForContract(ev.eventKey, ftOuContract);
  const h1OuBucket = bucketKeyForContract(ev.eventKey, h1OuContract);
  const h2OuBucket = bucketKeyForContract(ev.eventKey, h2OuContract);
  assert.notEqual(ftOuBucket, h1OuBucket);
  assert.notEqual(h1OuBucket, h2OuBucket);
  assert.notEqual(ftOuBucket, h2OuBucket);
  assert.ok(ftOuBucket.includes('::fulltime::'));
  assert.ok(h1OuBucket.includes('::half1::'));
  assert.ok(h2OuBucket.includes('::half2::'));

  // 3. 1X2 Match odds isolation across fulltime, half1, half2
  const ft1x2 = ev.markets.find((m) => m.key === 'MRES');
  const h11x2 = ev.markets.find((m) => m.key === 'MRH1');
  const h21x2 = ev.markets.find((m) => m.key === 'MRH2');
  assert.equal(ft1x2.period, 'fulltime');
  assert.equal(h11x2.period, 'half1');
  assert.equal(h21x2.period, 'half2');
  const ft1x2Contract = resolveContract(ft1x2);
  const h11x2Contract = resolveContract(h11x2);
  const h21x2Contract = resolveContract(h21x2);
  assert.equal(ft1x2Contract.family, 'MATCH_ODDS');
  assert.equal(h11x2Contract.family, 'MATCH_ODDS');
  assert.equal(h21x2Contract.family, 'MATCH_ODDS');
  const ft1x2Bucket = bucketKeyForContract(ev.eventKey, ft1x2Contract);
  const h11x2Bucket = bucketKeyForContract(ev.eventKey, h11x2Contract);
  const h21x2Bucket = bucketKeyForContract(ev.eventKey, h21x2Contract);
  assert.notEqual(ft1x2Bucket, h11x2Bucket);
  assert.notEqual(h11x2Bucket, h21x2Bucket);
  assert.notEqual(ft1x2Bucket, h21x2Bucket);

  // 4. BTTS isolation across fulltime and half1
  const ftBtts = ev.markets.find((m) => m.key === 'BTSC');
  const h1Btts = ev.markets.find((m) => m.key === 'BTH1');
  assert.equal(ftBtts.period, 'fulltime');
  assert.equal(h1Btts.period, 'half1');
  const ftBttsContract = resolveContract(ftBtts);
  const h1BttsContract = resolveContract(h1Btts);
  assert.equal(ftBttsContract.family, 'BTTS');
  assert.equal(h1BttsContract.family, 'BTTS');
  const ftBttsBucket = bucketKeyForContract(ev.eventKey, ftBttsContract);
  const h1BttsBucket = bucketKeyForContract(ev.eventKey, h1BttsContract);
  assert.notEqual(ftBttsBucket, h1BttsBucket);
  assert.ok(ftBttsBucket.includes('::fulltime::'));
  assert.ok(h1BttsBucket.includes('::half1::'));

  // 5. Double Chance isolation across fulltime and half1
  const ftDc = ev.markets.find((m) => m.key === 'DBLC');
  const h1Dc = ev.markets.find((m) => m.key === 'DCH1');
  assert.equal(ftDc.period, 'fulltime');
  assert.equal(h1Dc.period, 'half1');
  const ftDcContract = resolveContract(ftDc);
  const h1DcContract = resolveContract(h1Dc);
  assert.equal(ftDcContract.family, 'DOUBLE_CHANCE');
  assert.equal(h1DcContract.family, 'DOUBLE_CHANCE');
  const ftDcBucket = bucketKeyForContract(ev.eventKey, ftDcContract);
  const h1DcBucket = bucketKeyForContract(ev.eventKey, h1DcContract);
  assert.notEqual(ftDcBucket, h1DcBucket);

  // 6. Draw No Bet isolation across fulltime and half1
  const ftDnb = ev.markets.find((m) => m.key === 'DNOB');
  const h1Dnb = ev.markets.find((m) => m.key === 'DNH1');
  assert.equal(ftDnb.period, 'fulltime');
  assert.equal(h1Dnb.period, 'half1');
  const ftDnbContract = resolveContract(ftDnb);
  const h1DnbContract = resolveContract(h1Dnb);
  assert.equal(ftDnbContract.family, 'DRAW_NO_BET');
  assert.equal(h1DnbContract.family, 'DRAW_NO_BET');
  const ftDnbBucket = bucketKeyForContract(ev.eventKey, ftDnbContract);
  const h1DnbBucket = bucketKeyForContract(ev.eventKey, h1DnbContract);
  assert.notEqual(ftDnbBucket, h1DnbBucket);
});
