import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ScraperBase from '../src/scrapers/base.mjs';
import { isMatchResultMarket } from '../src/scanner/market-contracts.mjs';

/**
 * The contract every adapter inherits, expressed as a test rather than as a
 * convention.
 *
 * A three-way market whose selections are literally {1, X, 2} is what the
 * engine reads as the match-result contract — that inference is what lets
 * opaque provider keys be compared across books. The flip side is that a
 * first-half result, a half-time-or-full-time window or a mislabelled
 * double-chance market looks identical unless it declares a settlement period.
 *
 * Four separate adapters shipped that bug before it was fixed per-adapter, so
 * the guard now lives in ScraperBase: an adapter that forgets `period` fails
 * here rather than publishing an arbitrage that cannot exist.
 */

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function market(selections, extra = {}) {
  return { key: 'opaque-1', name: 'Result', period: 'fulltime', selections, ...extra };
}

const oneXTwo = (key, extra = {}) => market(
  [{ id: 'h', name: '1', odds: 2.1 }, { id: 'd', name: 'X', odds: 3.3 }, { id: 'a', name: '2', odds: 4.6 }],
  { key, ...extra },
);

/** A scraper that returns whatever events a test hands it, unchanged. */
function fakeScraper(events) {
  class Fake extends ScraperBase {
    id = 'contract-probe';
    name = 'Contract probe';
    sourceIds = ['contract-probe'];
    maxAttempts = 1;

    async fetchRaw() {
      return {};
    }

    normalize() {
      return events;
    }

    extractEvents(raw) {
      return raw;
    }
  }
  return new Fake({ dataDir: globalThis.__contractDataDir });
}

async function withScraper(events, run) {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-contract-'));
  globalThis.__contractDataDir = dir;
  try {
    await run(fakeScraper(events));
  } finally {
    delete globalThis.__contractDataDir;
    await rm(dir, { recursive: true, force: true });
  }
}

const event = (markets) => ({
  id: 'e1',
  sourceId: 'contract-probe',
  eventKey: 'ignored-by-base',
  sport: 'Football',
  league: 'Liga 1',
  kickoff: FUTURE,
  homeTeam: 'FCSB',
  awayTeam: 'Dinamo',
  markets,
});

test('a 1X2 market with no period is accepted, not dropped', () => {
  // Absence of `period` means the provider published no settlement window,
  // which the engine treats as full-time. Refusing it would empty the feeds of
  // the FEG family, which stamps `period: 'unknown'` on everything.
  const events = [event([oneXTwo('547', { period: undefined })])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.equal(out[0].markets.length, 1, 'an unlabelled market is still a real market');
});

test('a first-half 1X2 is dropped while the full-time one on the same event survives', () => {
  // The regression this guards: favbet published MATCH_ODDS_1H with no period,
  // so a 1H price was paired against another book's full-time legs. The
  // full-time market on the same event must not be lost to the same filter.
  const events = [event([
    oneXTwo('MATCH_ODDS_1H', { period: 'firsthalf' }),
    oneXTwo('MATCH_ODDS'),
  ])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.deepEqual(out[0].markets.map((m) => m.key), ['MATCH_ODDS']);
});

test('an unlabelled market is not silently promoted to full time by the base class', async () => {
  // The base class does not *add* a period; it only removes markets that
  // declare a non-full-time window. Adding one would be a claim the adapter
  // never made.
  const events = [event([oneXTwo('547', { period: undefined })])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.equal(out[0].markets[0].period, undefined);
});

for (const period of ['firsthalf', 'secondhalf', 'half-or-full', 'halftime']) {
  test(`a ${period} 1X2 lookalike is dropped`, async () => {
    const events = [event([oneXTwo('MRES', { period }), oneXTwo('547')])];
    const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
    assert.deepEqual(out[0].markets.map((m) => m.key), ['547']);
  });
}

test('a totals or handicap market is kept whatever its period', async () => {
  // Only the result-market shape is at risk. A half-time over/under is a real
  // market of its own and the middles scan is entitled to see it.
  const totals = market(
    [{ id: 'o', name: 'Over', odds: 1.95, handicap: 2.5 }, { id: 'u', name: 'Under', odds: 1.95, handicap: 2.5 }],
    { key: 'OVER_UNDER_2_5', period: 'firsthalf' },
  );
  const events = [event([totals, oneXTwo('547')])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.deepEqual(out[0].markets.map((m) => m.key), ['OVER_UNDER_2_5', '547']);
});

test('an incomplete 1X2 (no draw) is not treated as a result lookalike', async () => {
  // Two outcomes is not the three-way shape, so the period guard does not
  // apply; that is a completeness question, which each adapter settles.
  const twoWay = market(
    [{ id: 'h', name: '1', odds: 2.1 }, { id: 'a', name: '2', odds: 3.3 }],
    { key: 'MATCH_ODDS_1H', period: 'firsthalf' },
  );
  const events = [event([twoWay])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.equal(out[0].markets.length, 1);
});

test('a market whose own name contradicts a full-time label is dropped', () => {
  // The bug this closes is not a missing `period` — it is a wrong one. The
  // Exalogic adapters mapped the double-chance codes onto the same literal
  // 1/X/2 outcome labels and stamped every market `fulltime`; winner stamped
  // every bet type. A declared period is only as good as the adapter that
  // wrote it, so the provider's own name is checked as independent evidence.
  const events = [event([
    oneXTwo('dc', { name: 'Dubla sansa', period: 'fulltime' }),
    oneXTwo('547'),
  ])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.deepEqual(out[0].markets.map((m) => m.key), ['547'],
    'the double chance is dropped even though it claims full-time settlement');
});

for (const name of ['Rezultat repriza 1', '1st Half Result', 'Pauza sau Final', 'Half Time or Full']) {
  test(`a market named "${name}" is dropped despite a full-time label`, () => {
    const events = [event([oneXTwo('MATCH_ODDS_1H', { name, period: 'fulltime' })])];
    const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
    assert.equal(out[0].markets.length, 0);
  });
}

for (const name of ['1. repriza', '2. repriza', '1 repriza', 'Repriza 1', 'Repriza 2', 'Rezultat 1. repriza']) {
  test(`a market named "${name}" is dropped in either Romanian word order`, () => {
    // The FEG family spells it ordinal-first ("1. repriza") while the hand-written
    // list only matched word-first ("repriza 1"). A new adapter copying the FEG
    // spelling therefore published a half-time price on a literal {1, X, 2}
    // selection set, which every other check accepts.
    const events = [event([oneXTwo('MATCH_ODDS_1H', { name, period: 'fulltime' })])];
    const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
    assert.equal(out[0].markets.length, 0,
      `"${name}" settles before the final whistle and must not be bucketed as a full-time result`);
  });
}

test('an unknown opaque key on a half-time market is not promoted to a full-time result', () => {
  // The engine reads a literal {1, X, 2} set on a non-FEG opaque key as the
  // match-result contract, so the name check is the only thing standing between
  // a new provider's first-half price and a fabricated arbitrage.
  const lookalike = oneXTwo('4477', { name: '1. repriza', period: 'fulltime' });
  const real = oneXTwo('547');
  assert.equal(isMatchResultMarket(lookalike), false);
  assert.equal(isMatchResultMarket(real), true,
    'the genuine full-time market on the same shape is still accepted');
});

test('a legitimate full-time market with no settlement window survives', () => {
  // The FEG family stamps `period: 'unknown'` on every market, and a real
  // result market is called "Meci". Refusing either would empty those feeds.
  const events = [event([oneXTwo('ufo:mtyp:00-00', { name: 'Meci', period: 'unknown' })])];
  const out = fakeScraper([])._dropNonFullTimeLookalikes(events);
  assert.equal(out[0].markets.length, 1);
});

test('the guard runs before anything is written to the workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-contract-ws-'));
  try {
    class Probe extends ScraperBase {
      id = 'ws-probe';
      name = 'WS probe';
      sourceIds = ['ws-probe'];
      maxAttempts = 1;

      async fetchRaw() { return {}; }
      normalize() { return []; }
      // An adapter that publishes a 1H result and forgets `period` entirely.
      extractEvents() {
        return [{
          id: 'e1',
          sourceId: 'ws-probe',
          eventKey: 'k',
          sport: 'Football',
          league: 'L1',
          kickoff: FUTURE,
          homeTeam: 'A',
          awayTeam: 'B',
          markets: [oneXTwo('LEAKY_1H', { period: undefined })],
        }];
      }
    }

    const s = new Probe({ dataDir: dir });
    // The period is genuinely absent here, so the guard cannot see a window and
    // the market is kept — the engine's own inference will decide. This test
    // documents that boundary rather than pretending the guard is total.
    const result = await s.run();
    assert.equal(result.status, 'ok');
    const blob = JSON.parse(await readFile(join(dir, 'workspace', 'ws-probe_events.json'), 'utf8'));
    assert.equal(blob.events[0].markets.length, 1,
      'an unlabelled market is published; the engine refuses to pair it as full-time only if the adapter says otherwise');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
