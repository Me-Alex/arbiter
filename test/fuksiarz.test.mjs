import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import FuksiarzScraper from '../src/scrapers/fuksiarz.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

const categoriesFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/fuksiarz-categories.json'), 'utf-8'),
);
const eventsFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/fuksiarz-events.json'), 'utf-8'),
);
const scrapersConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config/scrapers.json'), 'utf-8'),
);

test('fuksiarz: instantiates through registry and verifies configuration', () => {
  const jobConfig = scrapersConfig.jobs.find((j) => j.id === 'fuksiarz');
  assert.ok(jobConfig, 'fuksiarz job exists in config/scrapers.json');
  assert.equal(jobConfig.enabled, true);
  assert.equal(jobConfig.engine, 'fuksiarz-rest-v1');
  assert.equal(jobConfig.transport, 'fuksiarz-public-json');
  assert.equal(jobConfig.script, 'fuksiarz.mjs');

  const scraper = instantiate('fuksiarz', { jobConfig });
  assert.ok(scraper instanceof FuksiarzScraper);
  assert.equal(scraper.id, 'fuksiarz');
  assert.equal(scraper.name, 'Fuksiarz Poland');
  assert.deepEqual(scraper.sourceIds, ['fuksiarz']);
});

test('fuksiarz: extracts events and markets from fixture with correct 1X2, BTTS, and totals lines', () => {
  const scraper = new FuksiarzScraper({ includePast: true, maxEvents: 100 });
  const rawEvents = scraper.normalize(eventsFixture);
  assert.equal(rawEvents.length, 30);

  const events = scraper.extractEvents(rawEvents);
  assert.ok(events.length > 0, 'Extracted events from fixture');

  // Verify Everton vs Chelsea
  const match = events.find((e) => e.homeTeam === 'Everton' && e.awayTeam === 'Chelsea');
  assert.ok(match, 'Found Everton vs Chelsea');
  assert.equal(match.sport, 'football');
  assert.ok(match.kickoff);

  // 1X2 check: Everton: 3 | X: 3.65 | Chelsea: 2.15
  const m1x2 = match.markets.find((m) => m.key === '1x2');
  assert.ok(m1x2, '1X2 market found');
  assert.equal(m1x2.selections.length, 3);
  const s1 = m1x2.selections.find((s) => s.name === '1');
  const sX = m1x2.selections.find((s) => s.name === 'X');
  const s2 = m1x2.selections.find((s) => s.name === '2');
  assert.equal(s1.odds, 3);
  assert.equal(sX.odds, 3.65);
  assert.equal(s2.odds, 2.15);

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

test('fuksiarz: mock fetchRaw successfully fetches categories and batches events', async () => {
  const scraper = new FuksiarzScraper({
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
