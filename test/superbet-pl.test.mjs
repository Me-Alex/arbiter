import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import SuperbetPlScraper from '../src/scrapers/superbet-pl.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { resolveContract, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

const publicFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/superbet-pl-public.json'), 'utf-8'),
);
const structFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/superbet-pl-struct.json'), 'utf-8'),
);
const detailFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/superbet-pl-detail.json'), 'utf-8'),
);
const scrapersConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config/scrapers.json'), 'utf-8'),
);

test('superbet-pl: instantiates through registry and verifies configuration', () => {
  const jobConfig = scrapersConfig.jobs.find((j) => j.id === 'superbet-pl');
  assert.ok(jobConfig, 'superbet-pl job exists in config/scrapers.json');
  assert.equal(jobConfig.enabled, true);
  assert.equal(jobConfig.engine, 'public-offer-v3');
  assert.equal(jobConfig.transport, 'bookmaker-public-json');
  assert.equal(jobConfig.script, 'superbet-pl.mjs');

  const scraper = instantiate('superbet-pl', { jobConfig });
  assert.ok(scraper instanceof SuperbetPlScraper);
  assert.equal(scraper.id, 'superbet-pl');
  assert.equal(scraper.name, 'Superbet Poland');
  assert.deepEqual(scraper.sourceIds, ['superbet-pl']);
  assert.equal(scraper.host, 'https://production-superbet-offer-pl.freetls.fastly.net');
  assert.equal(scraper.locale, 'pl-PL');
});

test('superbet-pl: extracts index events with Polish localized market names and 1X2 odds', async () => {
  const scraper = new SuperbetPlScraper({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/v3/pl-PL/events')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => publicFixture,
        };
      }
      if (u.includes('/v2/pl-PL/struct')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => structFixture,
        };
      }
      throw new Error(`Unexpected URL in mock: ${u}`);
    },
    includePast: true,
  });

  const raw = await scraper.fetchRaw();
  assert.ok(Array.isArray(raw.events));
  const events = scraper.extractEvents(raw.events);
  assert.ok(events.length > 0, 'Extracted at least one event');

  // Verify Coventry City event if present in fixture
  const coventry = events.find((e) => e.homeTeam?.includes('Coventry') && e.awayTeam?.includes('Newcastle'));
  if (coventry) {
    assert.equal(coventry.sport, 'Football');
    assert.ok(coventry.markets.length >= 1);
    const m1x2 = coventry.markets.find((m) => m.name === 'Mecz' || m.key === '547');
    assert.ok(m1x2, 'Coventry match carries Mecz / 1X2 market');
    assert.equal(m1x2.selections.length, 3);
    const sel1 = m1x2.selections.find((s) => s.name === '1');
    const selX = m1x2.selections.find((s) => s.name === 'X');
    const sel2 = m1x2.selections.find((s) => s.name === '2');
    assert.ok(sel1 && selX && sel2, 'Contains 1, X, 2 selections');
    assert.equal(sel1.odds, 3.2);
    assert.equal(selX.odds, 3.55);
    assert.equal(sel2.odds, 2.1);

    // Resolve contract
    const contract = resolveContract(m1x2);
    assert.ok(contract, 'Mecz resolves to contract');
    assert.equal(contract.family, 'MATCH_ODDS');
    assert.equal(contract.period, 'fulltime');
    assert.deepEqual(contract.outcomes, ['home', 'draw', 'away']);
  }
});

test('superbet-pl: enriches detail markets (totals, BTTS, first half, handicap) and resolves contracts', async () => {
  const scraper = new SuperbetPlScraper({
    fullMarkets: true,
    detailLimit: 50,
    includePast: true,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/v3/pl-PL/events')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => publicFixture,
        };
      }
      if (u.includes('/v2/pl-PL/struct')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => structFixture,
        };
      }
      if (u.includes('/v2/pl-PL/events/')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'application/json']]),
          json: async () => detailFixture,
        };
      }
      throw new Error(`Unexpected URL in mock: ${u}`);
    },
  });

  const raw = await scraper.fetchRaw();
  const events = scraper.extractEvents(raw.events);
  const coventry = events.find((e) => e.id === '14025567' || (e.homeTeam?.includes('Coventry') && e.awayTeam?.includes('Newcastle')));
  assert.ok(coventry, 'Coventry event found with enriched markets');

  // Verify Total Goals (Liczba goli - 200734)
  const totalsMarkets = coventry.markets.filter((m) => m.name === 'Liczba goli');
  assert.ok(totalsMarkets.length >= 1, 'Extracted Liczba goli detail markets');
  for (const m of totalsMarkets) {
    const contract = resolveContract(m);
    assert.ok(contract, `Contract resolved for total goals ${m.name}`);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'fulltime');
    for (const sel of m.selections) {
      const outcome = canonicalOutcomeFor(sel.name, contract);
      assert.ok(outcome === 'over' || outcome === 'under', `Selection ${sel.name} canonicalizes to over/under`);
    }
  }

  // Verify BTTS (Obie drużyny strzelą - 539)
  const bttsMarket = coventry.markets.find((m) => m.name === 'Obie drużyny strzelą');
  assert.ok(bttsMarket, 'Extracted Obie drużyny strzelą (BTTS) detail market');
  const bttsContract = resolveContract(bttsMarket);
  assert.ok(bttsContract, 'Contract resolved for BTTS');
  assert.equal(bttsContract.family, 'BTTS');
  assert.equal(bttsContract.period, 'fulltime');
  for (const sel of bttsMarket.selections) {
    const outcome = canonicalOutcomeFor(sel.name, bttsContract);
    assert.ok(outcome === 'yes' || outcome === 'no', `Selection ${sel.name} canonicalizes to yes/no`);
  }

  // Verify 1st Half Total Goals (1.połowa - liczba goli - 200735)
  const half1Totals = coventry.markets.filter((m) => m.name === '1.połowa - liczba goli');
  assert.ok(half1Totals.length >= 1, 'Extracted 1.połowa - liczba goli detail markets');
  for (const m of half1Totals) {
    const contract = resolveContract(m);
    assert.ok(contract, `Contract resolved for half1 totals ${m.name}`);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half1');
  }

  // Verify Handicap (Handicap - 200736)
  const handicapMarkets = coventry.markets.filter((m) => m.name === 'Handicap');
  assert.ok(handicapMarkets.length >= 1, 'Extracted Handicap detail markets');
  for (const m of handicapMarkets) {
    const contract = resolveContract(m);
    assert.ok(contract, `Contract resolved for handicap ${m.name}`);
    assert.equal(contract.family, 'ASIAN_HANDICAP');
    assert.equal(contract.period, 'fulltime');
  }
});
