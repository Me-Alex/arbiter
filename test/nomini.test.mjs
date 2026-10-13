/**
 * Nomini (nomini) — scaffolded on 2026-10-11.
 *
 * Asserts candidate state, declared contracts, platform dispatcher routing,
 * and live fixture normalization with complete 1X2 market validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'nomini');

test('nomini: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('nomini: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['altenar-tenancy', 'altenar-sb2-widget-json', 'altenar-sites.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('nomini: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('nomini', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the platform matcher must route the job');
  assert.equal(scraper.sourceIds[0], 'nomini');
});

test('nomini: normalizes and extracts events from real capture fixture', () => {
  const scraper = instantiate('nomini', { jobConfig: { ...JOB, enabled: true } });
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/altenar-nomini.json', import.meta.url), 'utf8'));
  scraper.from = Date.parse('2026-09-01T00:00:00Z');
  scraper.to = scraper.from + 86400000 * 60;
  scraper.observedAt = new Date().toISOString();

  const normalized = scraper.normalize(fixture);
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0, 'must extract at least one event');
  const first = events[0];
  assert.equal(first.sourceId, 'nomini');
  assert.match(first.sourceUrl, /integration=nomini/);
  assert.ok(first.homeTeam, 'has home team');
  assert.ok(first.awayTeam, 'has away team');

  const m1x2 = first.markets.find((m) => m.key === '1x2');
  assert.ok(m1x2, 'event carries 1x2 market');
  assert.equal(m1x2.period, 'fulltime');
  const selNames = m1x2.selections.map((s) => s.name).sort();
  assert.deepEqual(selNames, ['1', '2', 'X'], '1x2 carries complete 1X2 selections');
  for (const sel of m1x2.selections) {
    assert.ok(Number.isFinite(sel.odds) && sel.odds > 1, 'selection ' + sel.name + ' has valid odds');
  }
});
