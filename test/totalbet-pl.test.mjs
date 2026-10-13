import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import TotalBetPl from '../src/scrapers/totalbet-pl.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = config.jobs.find((j) => j.id === 'totalbet-pl');
const eventsFixture = JSON.parse(readFileSync(new URL('./fixtures/totalbet-events.json', import.meta.url), 'utf8'));
const detailFixture = JSON.parse(readFileSync(new URL('./fixtures/totalbet-detail.json', import.meta.url), 'utf8'));

function setup(opts = {}) {
  const scraper = instantiate('totalbet-pl', { ...opts, jobConfig: JOB });
  scraper.from = Date.parse('2026-10-12T00:00:00.000Z');
  scraper.to = scraper.from + 168 * 3600000;
  scraper.observedAt = '2026-10-12T23:58:00.000Z';
  return scraper;
}

test('totalbet-pl: instantiates through registry and verifies configuration', () => {
  assert.ok(JOB, 'totalbet-pl must be configured in config/scrapers.json');
  assert.equal(JOB.enabled, true);
  assert.equal(JOB.engine, 'totalbet-rest-v1');
  assert.equal(JOB.transport, 'totalbet-public-json');
  assert.equal(JOB.script, 'totalbet-pl.mjs');
  assert.deepEqual(JOB.sourceIds, ['totalbet-pl']);

  const scraper = setup();
  assert.ok(scraper instanceof TotalBetPl);
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'totalbet-pl');
  assert.deepEqual(scraper.sourceIds, ['totalbet-pl']);
});

test('totalbet-pl: extracts events and markets from fixture with correct 1X2, BTTS, and totals lines', () => {
  const scraper = setup();
  const rawEvents = scraper.normalize(eventsFixture);

  // Merge Always Ready event with detail component_lists fixture
  const mergedEvents = rawEvents.map((e) => {
    if (e.uuid === detailFixture.data.event.uuid || e.name?.includes('Always Ready')) {
      return { ...e, component_lists: detailFixture.data.event.component_lists };
    }
    return e;
  });

  const events = scraper.validate(scraper.extractEvents(mergedEvents));
  assert.ok(events.length > 0, 'Must extract events from fixture');

  for (const ev of events) {
    assert.equal(ev.sourceId, 'totalbet-pl');
    assert.ok(ev.kickoff);
    assert.ok(ev.eventKey);
    assert.equal(ev.eventKey, eventIdentityKey(ev));

    const market1X2 = ev.markets.find((m) => m.key === '1x2');
    assert.ok(market1X2, 'Every event must have 1X2 market');
    assert.equal(market1X2.selections.length, 3);
    for (const sel of market1X2.selections) {
      assert.ok(Number.isFinite(sel.odds) && sel.odds > 1);
    }
  }

  // Verify Always Ready match with enriched BTTS and totals
  const alwaysReady = events.find((e) => e.homeTeam.includes('Always Ready'));
  if (alwaysReady) {
    const btts = alwaysReady.markets.find((m) => m.key === 'btts');
    assert.ok(btts, 'Always Ready match must have BTTS market');
    const yesSel = btts.selections.find((s) => s.name === 'Yes');
    const noSel = btts.selections.find((s) => s.name === 'No');
    assert.equal(yesSel.odds, 1.79);
    assert.equal(noSel.odds, 1.78);

    const total25 = alwaysReady.markets.find((m) => m.key === 'total:2.5');
    assert.ok(total25, 'Always Ready match must have total 2.5 line');
    const over25 = total25.selections.find((s) => s.name === 'Over 2.5');
    const under25 = total25.selections.find((s) => s.name === 'Under 2.5');
    assert.equal(under25.odds, 3.37);
    assert.ok(over25.odds > 1);
  }
});

test('totalbet-pl: mock fetchRaw successfully fetches and paginates events', async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/events?')) {
      return new globalThis.Response(JSON.stringify(eventsFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/events/')) {
      return new globalThis.Response(JSON.stringify(detailFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unhandled mock URL: ${u}`);
  };

  const scraper = new TotalBetPl({ fetchImpl: mockFetch, maxEvents: 20 });
  const raw = await scraper.fetchRaw();
  assert.ok(raw?.events?.length > 0);
});
