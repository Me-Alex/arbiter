// Betvictor (betvictor) test suite.
// Verifies placeholder behavior and contract invariants.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Betvictor from '../src/scrapers/betvictor.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

// Load config entry for betvictor
const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'betvictor');

test('betvictor: the declared contract matches config', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'betvictor.mjs'],
    'betvictor config must declare the exact contract this stub implements',
  );
});

test('betvictor: the dispatcher routes the job when enabled', () => {
  const scraper = instantiate('betvictor', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'betvictor');
});

test('betvictor: fetchRaw returns empty data object', async (t) => {
  const scraper = new Betvictor();
  const raw = await scraper.fetchRaw();
  assert.deepEqual(raw, { data: {} }, 'placeholder fetchRaw should return empty data envelope');
});

test('betvictor: normalize passes through raw data', () => {
  const scraper = new Betvictor();
  const raw = { data: {} };
  const norm = scraper.normalize(raw);
  assert.deepEqual(norm, raw, 'placeholder normalize should be identity');
});

test('betvictor: extractEvents returns empty array', () => {
  const scraper = new Betvictor();
  const events = scraper.extractEvents({});
  assert.deepEqual(events, [], 'placeholder extractEvents should return empty array');
});
