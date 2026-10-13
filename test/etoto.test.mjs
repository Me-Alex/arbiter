import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import EtotoScraper from '../src/scrapers/etoto.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

const categoriesFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/etoto-categories.json'), 'utf-8'),
);
const eventsFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/etoto-events.json'), 'utf-8'),
);
const scrapersConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config/scrapers.json'), 'utf-8'),
);

test('etoto: instantiates through registry and verifies configuration', () => {
  const jobConfig = scrapersConfig.jobs.find((j) => j.id === 'etoto');
  assert.ok(jobConfig, 'etoto job exists in config/scrapers.json');
  assert.equal(jobConfig.enabled, true);
  assert.equal(jobConfig.engine, 'etoto-rest-v1');
  assert.equal(jobConfig.transport, 'etoto-public-json');
  assert.equal(jobConfig.script, 'etoto.mjs');

  const scraper = instantiate('etoto', { jobConfig });
  assert.ok(scraper instanceof EtotoScraper);
  assert.equal(scraper.id, 'etoto');
  assert.equal(scraper.name, 'ETOTO Poland');
  assert.deepEqual(scraper.sourceIds, ['etoto']);
});

test('etoto: extracts events and markets from fixture with correct 1X2, BTTS, and totals lines', () => {
  const scraper = new EtotoScraper({ includePast: true, maxEvents: 100 });
  const rawEvents = scraper.normalize(eventsFixture);
  assert.equal(rawEvents.length, 29);

  const events = scraper.extractEvents(rawEvents);
  assert.ok(events.length > 0, 'Extracted events from fixture');

  // Verify match with 1X2, BTTS, and Totals
  const match = events.find((e) => e.homeTeam === 'Wieczysta Kraków' && e.awayTeam === 'Raków Częstochowa');
  assert.ok(match, 'Found Wieczysta Kraków vs Raków Częstochowa');
  assert.equal(match.sport, 'football');
  assert.ok(match.kickoff);

  // 1X2 check
  const m1x2 = match.markets.find((m) => m.key === '1x2');
  assert.ok(m1x2, '1X2 market found');
  assert.equal(m1x2.selections.length, 3);
  const s1 = m1x2.selections.find((s) => s.name === '1');
  const sX = m1x2.selections.find((s) => s.name === 'X');
  const s2 = m1x2.selections.find((s) => s.name === '2');
  assert.ok(s1 && s1.odds > 1);
  assert.ok(sX && sX.odds > 1);
  assert.ok(s2 && s2.odds > 1);

  // BTTS check
  const btts = match.markets.find((m) => m.key === 'btts');
  assert.ok(btts, 'BTTS market found');
  const yes = btts.selections.find((s) => s.name === 'Yes');
  const no = btts.selections.find((s) => s.name === 'No');
  assert.ok(yes && yes.odds > 1);
  assert.ok(no && no.odds > 1);

  // Totals check
  const totals25 = match.markets.find((m) => m.key === 'total:2.5');
  assert.ok(totals25, 'Total 2.5 market found');
  assert.equal(totals25.line, 2.5);
  const over25 = totals25.selections.find((s) => s.name.includes('Over'));
  const under25 = totals25.selections.find((s) => s.name.includes('Under'));
  assert.ok(over25 && over25.odds > 1);
  assert.ok(under25 && under25.odds > 1);
});

test('etoto: mock fetchRaw successfully fetches categories and batches events', async () => {
  const scraper = new EtotoScraper({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/categories/multi/')) {
        return new globalThis.Response(JSON.stringify(eventsFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/categories')) {
        return new globalThis.Response(JSON.stringify(categoriesFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected mock URL: ${u}`);
    },
    includePast: true,
  });

  const raw = await scraper.fetchRaw();
  assert.ok(Array.isArray(raw.events));
  assert.ok(raw.events.length > 0);
  const events = scraper.extractEvents(raw.events);
  assert.ok(events.length > 0);
});
