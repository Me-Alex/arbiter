/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import NSoft, { matchesNSoftConfig } from '../src/scrapers/nsoft.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { FEED_GROUPS } from '../src/scanner/feed-groups.mjs';

const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = config.jobs.find((j) => j.id === 'gameworld');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/nsoft-public.json', import.meta.url), 'utf8'));

test('gameworld: job configuration declares verified nsoft public contract', () => {
  assert.ok(JOB, 'gameworld must have a job in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'gameworld is a validated and enabled job');
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.feedStatus, 'verified');
  assert.equal(JOB.platform, 'nsoft');
  assert.equal(JOB.engine, 'nsoft-public-json');
  assert.equal(JOB.transport, 'nsoft-public-sports-json');
  assert.equal(JOB.script, 'nsoft.mjs');
});

test('gameworld: matchesNSoftConfig matches the configured contract', () => {
  assert.equal(matchesNSoftConfig('gameworld', JOB), true);
});

test('gameworld: instantiate routes to NSoft scraper instance with sourceId gameworld', () => {
  const scraper = instantiate('gameworld', { jobConfig: JOB });
  assert.ok(scraper instanceof NSoft);
  assert.equal(scraper.id, 'gameworld');
  assert.deepEqual(scraper.sourceIds, ['gameworld']);
});

test('gameworld: normalizes compact fixture and extracts complete 1X2 market', () => {
  const scraper = new NSoft('gameworld');
  const normalized = scraper.normalize(structuredClone(fixture));
  for (const e of normalized) {
    e.startsAt = new Date(Date.now() + 3600000).toISOString();
  }
  const events = scraper.extractEvents(normalized);
  assert.ok(events.length > 0, 'must extract at least one event');
  const ft = events[0].markets.find((m) => m.key === '1x2');
  assert.ok(ft, 'must contain full-time 1X2 market');
  assert.deepEqual(ft.selections.map((s) => s.name), ['1', 'X', '2']);
});

test('gameworld: is grouped with admiral, stanleybet, and seven in nsoft-company feed group', () => {
  const group = FEED_GROUPS.find((g) => g.id === 'nsoft-company');
  assert.ok(group, 'nsoft-company feed group must exist');
  assert.ok(group.members.includes('gameworld'), 'gameworld must be a member of nsoft-company');
});
