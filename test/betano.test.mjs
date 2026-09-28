import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import Betano from '../src/scrapers/betano.mjs';

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
