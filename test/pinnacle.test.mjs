// Pinnacle (pinnacle) test suite.
// Verifies placeholder behavior and contract invariants.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Pinnacle from '../src/scrapers/pinnacle.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

// Load config entry for pinnacle
const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'pinnacle');

test('pinnacle: the declared contract matches config', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'pinnacle.mjs'],
    'pinnacle config must declare the exact contract this stub implements',
  );
});

test('pinnacle: the dispatcher routes the job when enabled', () => {
  const scraper = instantiate('pinnacle', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'pinnacle');
});

test('pinnacle: fetchRaw returns empty data object', async (t) => {
  const scraper = new Pinnacle();
  const raw = await scraper.fetchRaw();
  assert.deepEqual(raw, { data: {} }, 'placeholder fetchRaw should return empty data envelope');
});

test('pinnacle: normalize passes through raw data', () => {
  const scraper = new Pinnacle();
  const raw = { data: {} };
  const norm = scraper.normalize(raw);
  assert.deepEqual(norm, raw, 'placeholder normalize should be identity');
});

test('pinnacle: extractEvents returns empty array', () => {
  const scraper = new Pinnacle();
  const events = scraper.extractEvents({});
  assert.deepEqual(events, [], 'placeholder extractEvents should return empty array');
});
