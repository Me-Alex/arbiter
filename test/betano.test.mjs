import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import Betano from '../src/scrapers/betano.mjs';
import { resolveContract, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

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
