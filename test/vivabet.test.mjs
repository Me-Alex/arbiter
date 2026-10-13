/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Vivabet from '../src/scrapers/vivabet.mjs';
import Egt from '../src/scrapers/egt.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { FEED_GROUPS } from '../src/scanner/feed-groups.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = config.jobs.find((j) => j.id === 'vivabet');
const capture = JSON.parse(readFileSync(new URL('../data/endpoints/captures/vivabet-odds-2026-10-12.json', import.meta.url), 'utf8'));

function setup(opts = {}) {
  const scraper = instantiate('vivabet', { ...opts, jobConfig: JOB });
  scraper.from = Date.parse(capture.provenance.capturedAt) - 3600000;
  scraper.to = scraper.from + 168 * 3600000;
  scraper.observedAt = capture.provenance.capturedAt;
  scraper.sourceUrl = capture.provenance.sourceUrl;
  return scraper;
}

test('vivabet: job configuration declares verified egt-digital public contract', () => {
  assert.ok(JOB, 'vivabet must have a job in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'vivabet is a validated and enabled job');
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.feedStatus, 'verified');
  assert.equal(JOB.platform, 'egt-digital');
  assert.equal(JOB.engine, 'egt-public-sports-api');
  assert.equal(JOB.transport, 'egt-public-sports-json');
  assert.equal(JOB.script, 'vivabet.mjs');
});

test('vivabet: dispatcher routes to Vivabet scraper instance with sourceId vivabet', () => {
  const scraper = setup();
  assert.ok(scraper instanceof Vivabet);
  assert.ok(scraper instanceof Egt);
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'vivabet');
  assert.deepEqual(scraper.sourceIds, ['vivabet']);
});

test('vivabet: captured wire rows preserve prices, identity and provenance', () => {
  const scraper = setup();
  const raw = scraper.normalize(capture.raw);
  const events = scraper.validate(scraper.extractEvents(raw));
  assert.ok(events.length > 0, 'captured events must be cleanly extracted');

  for (const event of events) {
    assert.equal(event.sourceId, 'vivabet');
    assert.ok(event.sourceUrl.startsWith('https://'));
    assert.equal(event.eventKey, eventIdentityKey(event));
    assert.ok(event.runId);
    assert.equal(event.observedAt, capture.provenance.capturedAt);
    assert.equal(event.live, false);

    const market = event.markets.find((m) => m.key === '1x2');
    assert.ok(market, 'must have full-time 1X2 market');
    assert.equal(market.period, 'fulltime');
    assert.deepEqual(market.selections.map((s) => s.name).sort(), ['1', '2', 'X']);
    for (const sel of market.selections) {
      assert.ok(Number.isFinite(sel.odds) && sel.odds > 1, `odds must be valid: ${sel.odds}`);
    }
  }
});

test('vivabet: verified on-screen odds match upstream normalized API container', () => {
  const scraper = setup();
  const raw = scraper.normalize(capture.raw);
  const events = scraper.extractEvents(raw);

  // FC Arges vs CFR Cluj
  const arges = events.find((e) => e.homeTeam.includes('Arges') || e.awayTeam.includes('Cluj'));
  assert.ok(arges, 'FC Arges vs CFR Cluj event must be present');
  const arges1X2 = arges.markets.find((m) => m.key === '1x2');
  assert.ok(arges1X2, '1X2 market must exist for Arges match');
  const sel1 = arges1X2.selections.find((s) => s.name === '1');
  const selX = arges1X2.selections.find((s) => s.name === 'X');
  const sel2 = arges1X2.selections.find((s) => s.name === '2');
  assert.equal(sel1.odds, 2.77, '1 odds must be 2.77');
  assert.equal(selX.odds, 3.25, 'X odds must be 3.25');
  assert.equal(sel2.odds, 2.9, '2 odds must be 2.90');
});

test('vivabet: is grouped with egt-digital platform peers in feed-groups', () => {
  const group = FEED_GROUPS.find((g) => g.id === 'egt-digital');
  assert.ok(group, 'egt-digital feed group must exist');
  assert.ok(group.members.includes('vivabet'), 'vivabet must be a member of egt-digital');
  assert.ok(group.members.includes('prowin'));
  assert.ok(group.members.includes('ultrabet'));
  assert.ok(group.members.includes('vipbet'));
});
