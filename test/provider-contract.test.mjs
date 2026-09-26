import test from 'node:test';
import assert from 'node:assert/strict';

import MaxBet from '../src/scrapers/maxbet.mjs';
import Admiral from '../src/scrapers/admiral.mjs';
import StanleyBet from '../src/scrapers/stanleybet.mjs';
import Unibet from '../src/scrapers/unibet.mjs';

/**
 * The four ProviderContract adapters are the legacy parsing path: they share
 * one fetch helper and one set of parsers, and no configured job routes to
 * them (config/scrapers.json points every NSoft book at nsoft.mjs instead).
 *
 * They have no real-response fixture and cannot get one. All four endpoints
 * are retired — checked 2026-09-26:
 *
 *   maxbet      https://www.maxbet.ro/api/sports                       404
 *   admiral     https://www.admiral.ro/feeds/prematch.json             301 → SPA
 *               https://www.admiralbet.ro/feeds/prematch.json          200 HTML
 *   stanleybet  https://www.stanleybet.ro/feeds/events                 200 HTML
 *   unibet      https://www.unibet.ro/api/kambi/offer/v1/betoffer/...  404
 *
 * The saved captures in data/endpoints-all/ agree: the "admiral" capture
 * already records NSoft URLs, which is what the current adapter uses. These
 * classes appear never to have been the live path.
 *
 * So these tests do not claim a real payload. They pin the two things that
 * actually broke while the classes sat unused:
 *
 *   1. the constructor assigns what fetchRaw and parse read — a sibling that
 *      skipped an assignment once requested `undefined/getPalinsestoDelGiorno`,
 *      which is exactly how winboss and las-vegas failed silently;
 *   2. the parsers still shape events the way the engine expects, so a future
 *      re-enable of a restored endpoint is not starting from a broken base.
 */

const CLASSES = [
  { name: 'maxbet', Cls: MaxBet, base: 'https://www.maxbet.ro' },
  { name: 'admiral', Cls: Admiral, base: 'https://www.admiral.ro' },
  { name: 'stanleybet', Cls: StanleyBet, base: 'https://www.stanleybet.ro' },
  { name: 'unibet', Cls: Unibet, base: 'https://www.unibet.ro' },
];

for (const { name, Cls, base } of CLASSES) {
  test(`${name} carries the configuration its fetch reads`, () => {
    const s = new Cls({});
    // Every one of these is read by fetchRaw or fetchJson. A missing value
    // does not throw: it produces a request to a URL built from "undefined",
    // which fails quietly and looks like an empty market.
    assert.equal(typeof s.baseUrl, 'string', `${name}: baseUrl must be set`);
    assert.ok(s.baseUrl.startsWith('http'), `${name}: baseUrl must be an absolute URL`);
    assert.match(s.baseUrl, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: baseUrl should match the configured host`);
    assert.ok(!s.baseUrl.includes('undefined'), `${name}: baseUrl must not contain "undefined"`);
    assert.ok(Number.isFinite(s.timeoutMs) && s.timeoutMs > 0, `${name}: timeoutMs must be a positive number`);
  });
}

test('MaxBet parses a sports/event shape into engine-shaped events', () => {
  const s = new MaxBet({});
  // Built from the shape MaxBet.parse actually reads — HomeName/AwayName with
  // separate HomeOdds/DrawOdds/AwayOdds, or a MarketGroups array. Not a
  // captured payload; see the file header for why one is not available.
  const events = s.parse({
    events: [{
      EventId: 987654,
      HomeName: 'FCSB', AwayName: 'Dinamo',
      MatchTime: '2030-01-01T12:00:00Z',
      SportName: 'Football', LeagueName: 'Liga 1',
      HomeOdds: 2.10, DrawOdds: 3.40, AwayOdds: 3.20,
    }],
  });
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.homeTeam, 'FCSB');
  assert.equal(e.awayTeam, 'Dinamo');
  assert.equal(e.league, 'Liga 1');
  assert.equal(e.id, '987654');

  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  const markets = out[0].markets;
  assert.ok(markets.length > 0, 'a priced market must survive parsing');
  const allOdds = markets.flatMap((m) => m.selections.map((x) => Number(x.odds)));
  assert.ok(allOdds.length >= 3, 'home, draw and away are all published');
  assert.ok(allOdds.every((o) => Number.isFinite(o) && o > 1), 'every selection is priced above 1');
});

test('MaxBet drops sides whose odds are missing or below 1', () => {
  const s = new MaxBet({});
  const events = s.parse({
    events: [{
      EventId: 5, HomeName: 'A', AwayName: 'B', MatchTime: '2030-01-01T12:00:00Z',
      SportName: 'Football', LeagueName: 'L',
      HomeOdds: 0.90, DrawOdds: 3.40, AwayOdds: 'not-a-number',
    }],
  });
  const out = s.extractEvents(events);
  const odds = (out[0]?.markets || []).flatMap((m) => m.selections.map((x) => Number(x.odds)));
  assert.ok(odds.every((o) => Number.isFinite(o) && o > 1),
    'a side priced below 1 or unparseable must not be published');
  assert.ok(!odds.includes(0.9), 'the sub-1 price is dropped rather than published');
});

test('Unibet parses the Kambi offer shape, including its wrapped odds', () => {
  const s = new Unibet({});
  const events = s.parse({
    events: [{
      event: { id: 4242, homeName: 'Rapid', awayName: 'U Craiova', start: '2030-01-01T12:00:00Z' },
      sport: 'Fotbal', leagueName: 'Liga 1',
      betOffers: [{
        betOfferType: { name: 'Match Odds' },
        outcomes: [
          { label: 'Rapid', criterion: { label: 'Rapid' }, odds: { decimal: 1.95 } },
          { label: 'X', criterion: { label: 'X' }, odds: { decimal: 3.60 } },
          { label: 'U Craiova', criterion: { label: 'U Craiova' }, odds: { decimal: 4.20 } },
        ],
      }],
    }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Rapid');

  // Kambi wraps the price: `odds: { decimal: 1.95 }`. Reading that with
  // Number() is NaN, so every selection was filtered out and the event
  // vanished — a Kambi feed that answered perfectly produced nothing.
  const out = s.extractEvents(events);
  assert.equal(out.length, 1, 'a priced Kambi market must survive parsing');
  const odds = (out[0].markets || []).flatMap((m) => m.selections.map((x) => Number(x.odds)));
  assert.deepEqual(odds.sort((a, b) => a - b), [1.95, 3.60, 4.20],
    'the wrapped decimal prices are unwrapped, not dropped');
  assert.equal(out[0].sourceUrl, 'https://www.unibet.ro/sportsbook/#/event/4242');
});

test('a synthesised event id is not turned into a deep link', () => {
  // When the provider omits an id, `parse` synthesises one from the teams and
  // kickoff. Emitting that as a URL produces a link that 404s, so the guard
  // requires a numeric id — the same rule maxbet, stanleybet and unibet share.
  const s = new MaxBet({});
  const events = s.parse({
    events: [{
      HomeName: 'A', AwayName: 'B', MatchTime: '2030-01-01T12:00:00Z',
      SportName: 'Football', LeagueName: 'L',
      HomeOdds: 2, DrawOdds: 3, AwayOdds: 4,
    }],
  });
  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  assert.match(out[0].id, /^a-b-/, 'the provider omitted an id, so one is synthesised');
  assert.equal(out[0].sourceUrl, null, 'a synthesised id must not become a browsable link');
});

/**
 * The legacy classes are kept for a reason, and the reason has to stay true:
 * if a configured job ever starts routing to one of them, it will be talking
 * to a retired endpoint and will report an empty run. That is exactly how the
 * winboss/las-vegas regression looked, and it is invisible in a unit suite.
 */
test('no enabled job routes to a legacy ProviderContract class', async () => {
  const fs = await import('node:fs/promises');
  const { instantiate } = await import('../src/scrapers/index.mjs');
  const cfg = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));

  const legacy = new Set(['maxbet', 'admiral', 'stanleybet', 'unibet']);
  for (const job of cfg.jobs) {
    if (job.enabled === false) continue;
    let scraper;
    try {
      scraper = instantiate(job.id, { jobConfig: job });
    } catch {
      continue; // a job with no implementation yet is not this test's concern
    }
    const cls = scraper?.constructor?.name;
    assert.ok(
      !['MaxBetScraper', 'AdmiralScraper', 'StanleybetScraper', 'UnibetScraper'].includes(cls),
      `${job.id} instantiates ${cls}, a legacy class whose endpoint is retired`,
    );
    assert.ok(!(legacy.has(job.id) && cls && cls.endsWith('Scraper') && /MaxBet|Admiral|Stanley|Unibet/.test(cls)),
      `${job.id} must not reach a legacy adapter`);
  }
});

test('the NSoft tenants route to the NSoft adapter, not the legacy one', async () => {
  const fs = await import('node:fs/promises');
  const { instantiate } = await import('../src/scrapers/index.mjs');
  const cfg = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  for (const id of ['maxbet', 'admiral', 'stanleybet']) {
    const job = cfg.jobs.find((j) => j.id === id);
    if (!job) continue;
    const scraper = instantiate(id, { jobConfig: job });
    assert.equal(
      scraper.constructor.name,
      'NSoftScraper',
      `${id} runs on the NSoft platform; the ProviderContract class is not its path`,
    );
  }
});

/**
 * A class in the DIRECT registry with no job routing to it needs a recorded
 * reason, not just a comment.
 *
 * The decision to keep these four is a judgement: their endpoints are gone,
 * but the parsers are the only written reference for the ProviderContract
 * shape and the Kambi offer format, and an endpoint can come back. A judgement
 * that lives only in a comment stops being true the moment the comment is not
 * read — and nothing would notice, because nothing would fail.
 *
 * So the reason is asserted: every registered scraper either has an enabled
 * job, or a validationReason in the config that says why it does not.
 */
test('every registered scraper is either used or has a recorded reason', async () => {
  const fs = await import('node:fs/promises');
  const { ALL_SCRAPERS } = await import('../src/scrapers/index.mjs');
  const cfg = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  const jobs = cfg.jobs || [];

  const orphans = [];
  for (const id of ALL_SCRAPERS) {
    const job = jobs.find((j) => j.id === id);
    if (job && job.enabled !== false) continue;
    if (job && typeof job.validationReason === 'string' && job.validationReason.trim().length > 20) continue;
    orphans.push(id);
  }

  assert.deepEqual(orphans, [],
    'these scrapers are registered but neither enabled nor explained: ' + orphans.join(', '));
});

test('the four legacy classes each carry the reason they are kept', async () => {
  const fs = await import('node:fs/promises');
  const files = ['maxbet', 'admiral', 'stanleybet', 'unibet'];
  for (const id of files) {
    const src = await fs.readFile(new URL(`../src/scrapers/${id}.mjs`, import.meta.url), 'utf8');
    const header = src.slice(0, 1500);
    assert.match(header, /LEGACY/, `${id} says it is legacy`);
    // A reason, not just a label: either the endpoint's state or the fact
    // that another adapter serves this book.
    assert.ok(
      /retired|endpoint|not the live path|disabled/i.test(header),
      `${id} states why it is not in use`,
    );
  }
});
