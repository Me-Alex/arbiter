import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import { FEED_GROUPS } from '../src/scanner/feed-groups.mjs';

const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const job = config.jobs.find((entry) => entry.id === 'slotv');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/altenar-bet99.json', import.meta.url), 'utf8'));

test('slotv: promoted Altenar contract and registry state', () => {
  assert.equal(job.enabled, true);
  assert.equal(job.validationStatus, 'validated');
  assert.equal(job.feedStatus, 'verified');
  assert.deepEqual([job.engine, job.transport, job.script], ['altenar-tenancy', 'altenar-sb2-widget-json', 'altenar-sites.mjs']);
  assert.ok(FEED_GROUPS.find((group) => group.id === 'altenar-tenancy').members.includes('slotv'));
});

test('slotv: extracts parser-compatible fixture events', () => {
  const scraper = instantiate('slotv', { jobConfig: { ...job, enabled: true } });
  scraper.from = Date.parse('2026-09-21T00:00:00Z');
  scraper.to = scraper.from + 30 * 86400000;
  const events = scraper.extractEvents(scraper.normalize(fixture));
  assert.ok(events.length > 0);
  assert.equal(events[0].sourceId, 'slotv');
  assert.ok(events[0].markets.some((market) => market.key === '1x2'));
});
