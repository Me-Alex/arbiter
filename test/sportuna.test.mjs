/**
 * Sportuna (sportuna) — European sportsbook on Altenar SB2 platform.
 *
 * Verifies candidate promotion lifecycle, declared contracts, dispatcher routing,
 * live fixture normalization, and market extraction across 1X2, totals, and BTTS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import { FEED_GROUPS } from '../src/scanner/feed-groups.mjs';

const scrapersConfig = JSON.parse(
  readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8')
);
const JOB = scrapersConfig.jobs.find((entry) => entry.id === 'sportuna');

const endpointsRegistry = JSON.parse(
  readFileSync(new URL('../data/endpoints/endpoints.json', import.meta.url), 'utf8')
);
const REGISTRY_RECORD = endpointsRegistry.books?.sportuna;

const competitionFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sportuna-competition.json', import.meta.url), 'utf8')
);

// ── Contract & Registry Configuration ─────────────────────────────────────────

test('sportuna: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('sportuna: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['altenar-tenancy', 'altenar-sb2-widget-json', 'altenar-sites.mjs'],
    'a promoted job must declare the exact contract this adapter implements'
  );
});

test('sportuna: the dispatcher routes the job when it is promoted', () => {
  const scraper = instantiate('sportuna', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the platform matcher must route the job');
  assert.equal(scraper.sourceIds[0], 'sportuna');
  assert.equal(scraper.id, 'sportuna');
});

test('sportuna: registered and promoted in config/scrapers.json', () => {
  assert.ok(JOB, 'sportuna must exist in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'sportuna must be enabled');
  assert.equal(JOB.validationStatus, 'validated', 'sportuna must be validated');
  assert.equal(JOB.feedStatus, 'verified', 'sportuna must be verified');
  assert.equal(JOB.platform, 'altenar-sb2');
});

test('sportuna: endpoints registry consistency', () => {
  assert.ok(REGISTRY_RECORD, 'sportuna must exist in data/endpoints/endpoints.json');
  assert.equal(REGISTRY_RECORD.feedStatus, 'verified', 'endpoints feedStatus must be verified');
  assert.equal(REGISTRY_RECORD.platform, 'altenar-sb2');
  assert.equal(REGISTRY_RECORD.scraped, true, 'scraped flag must be true');
  assert.equal(REGISTRY_RECORD.job?.enabled, true, 'registry job must be enabled');
  assert.ok(Array.isArray(REGISTRY_RECORD.captureFiles) && REGISTRY_RECORD.captureFiles.length > 0);
});

test('sportuna: grouped with altenar-tenancy platform peers in feed-groups', () => {
  const altenarGroup = FEED_GROUPS.find((g) => g.id === 'altenar-tenancy');
  assert.ok(altenarGroup, 'altenar-tenancy group must exist');
  assert.ok(altenarGroup.members.includes('sportuna'), 'sportuna must be an altenar-tenancy group member');
});

// ── Normalization & Market Extraction ─────────────────────────────────────────

test('sportuna: normalizes and extracts events from real capture fixture', () => {
  const scraper = instantiate('sportuna', { jobConfig: { ...JOB, enabled: true } });
  scraper.from = Date.parse('2026-10-15T00:00:00Z');
  scraper.to = scraper.from + 86400000 * 30;
  scraper.observedAt = new Date().toISOString();

  const normalized = scraper.normalize(competitionFixture);
  assert.ok(Array.isArray(normalized), 'normalize returns an array of events');
  assert.ok(normalized.length > 0, 'must have normalized events');

  const events = scraper.extractEvents(normalized);
  assert.ok(events.length > 0, 'must extract at least one valid match event');

  const first = events[0];
  assert.equal(first.sourceId, 'sportuna');
  assert.match(first.sourceUrl, /integration=sportuna/);
  assert.ok(first.homeTeam, 'event carries home team');
  assert.ok(first.awayTeam, 'event carries away team');
  assert.ok(first.kickoff, 'event carries kickoff ISO string');
  assert.ok(first.league, 'event carries league');

  // Verify 1X2 market
  const m1x2 = first.markets.find((m) => m.key === '1x2');
  assert.ok(m1x2, 'event carries 1x2 market');
  assert.equal(m1x2.period, 'fulltime');
  const selNames = m1x2.selections.map((s) => s.name).sort();
  assert.deepEqual(selNames, ['1', '2', 'X'], '1x2 carries complete 1X2 selections');
  for (const sel of m1x2.selections) {
    assert.ok(Number.isFinite(sel.odds) && sel.odds > 1, `selection ${sel.name} has valid odds > 1`);
  }

  // Verify additional markets (Total goals and BTTS)
  const mTotal = first.markets.find((m) => m.key === 'TOTAL_GOALS');
  assert.ok(mTotal, 'event carries TOTAL_GOALS market');
  assert.equal(mTotal.selections.length, 2, 'totals has 2 selections');

  const mBtts = first.markets.find((m) => m.key === 'BTTS');
  assert.ok(mBtts, 'event carries BTTS market');
  assert.equal(mBtts.selections.length, 2, 'BTTS has 2 selections');
});

test('sportuna: respects maxEvents limit', () => {
  const scraper = instantiate('sportuna', {
    jobConfig: { ...JOB, enabled: true },
    maxEvents: 2,
  });
  scraper.from = Date.parse('2026-10-15T00:00:00Z');
  scraper.to = scraper.from + 86400000 * 30;
  scraper.observedAt = new Date().toISOString();

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);
  assert.ok(events.length <= 2, `events length (${events.length}) must not exceed maxEvents 2`);
});

test('sportuna: filters out past events when includePast is false', () => {
  const scraper = instantiate('sportuna', {
    jobConfig: { ...JOB, enabled: true },
    includePast: false,
  });
  // Set window far into future so all fixture events are treated as past
  scraper.from = Date.parse('2030-01-01T00:00:00Z');
  scraper.to = scraper.from + 86400000;
  scraper.observedAt = new Date().toISOString();

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);
  assert.equal(events.length, 0, 'all past events must be excluded');
});
