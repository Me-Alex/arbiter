import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import Cashpot from '../src/scrapers/cashpot.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'cashpot');
const CAPTURE = JSON.parse(readFileSync(new URL('../data/endpoints/captures/cashpot-odds-2026-10-12.json', import.meta.url), 'utf8'));

test('cashpot: contract and configuration in scrapers.json', () => {
  assert.equal(JOB.enabled, true);
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.engine, 'exalogic-xsport');
  assert.equal(JOB.transport, 'exalogic-xsport-public-json');
  assert.equal(JOB.script, 'cashpot.mjs');
  assert.deepEqual(JOB.sourceIds, ['cashpot']);
});

test('cashpot: instantiates with expected identity and Exalogic parameters', () => {
  const scraper = instantiate('cashpot');
  assert.ok(scraper instanceof Cashpot);
  assert.equal(scraper.id, 'cashpot');
  assert.equal(scraper.name, 'Cashpot');
  assert.deepEqual(scraper.sourceIds, ['cashpot']);
  assert.equal(scraper.systemCode, 'CASHPOT');
  assert.equal(scraper.apiBase, 'https://exalogic.cashpot.ro/XSportDatastore');
});

test('cashpot: parses real live capture fixture accurately', () => {
  const scraper = new Cashpot({ maxEvents: 100 });
  const rawEvents = scraper.normalize(CAPTURE);
  assert.ok(Array.isArray(rawEvents));
  assert.ok(rawEvents.length > 50, `expected >50 events, got ${rawEvents.length}`);

  const events = scraper.extractEvents(rawEvents);
  assert.ok(events.length > 50, `expected >50 parsed events, got ${events.length}`);

  for (const ev of events) {
    assert.equal(ev.sourceId, 'cashpot');
    assert.equal(ev.sport, 'football');
    assert.ok(ev.id);
    assert.ok(ev.homeTeam);
    assert.ok(ev.awayTeam);
    assert.ok(Array.isArray(ev.markets));
    assert.ok(ev.markets.length > 0);
  }
});

test('cashpot: verifies exact odds parity on live-verified matches', () => {
  const scraper = new Cashpot({ maxEvents: 200 });
  const events = scraper.extractEvents(scraper.normalize(CAPTURE));

  // Find Dukla Prague vs FC Banik Ostrava B
  const dukla = events.find((e) => e.homeTeam.includes('Dukla') && e.awayTeam.includes('Banik'));
  assert.ok(dukla, 'Dukla Prague match must exist');
  const dukla1x2 = dukla.markets.find((m) => m.key === '1x2' || m.name === 'FINAL');
  assert.ok(dukla1x2, '1X2 market must exist for Dukla');
  const sel1 = dukla1x2.selections.find((s) => s.name === '1');
  const selX = dukla1x2.selections.find((s) => s.name === 'X');
  const sel2 = dukla1x2.selections.find((s) => s.name === '2');
  assert.equal(sel1.odds, 1.84, 'home odds 1.84');
  assert.equal(selX.odds, 3.60, 'draw odds 3.60');
  assert.equal(sel2.odds, 3.85, 'away odds 3.85');

  // Find Canada vs Danemarca
  const canada = events.find((e) => e.homeTeam.includes('Canada') && e.awayTeam.includes('Danemarca'));
  assert.ok(canada, 'Canada match must exist');
  const can1x2 = canada.markets.find((m) => m.key === '1x2' || m.name === 'FINAL');
  assert.ok(can1x2);
  const c1 = can1x2.selections.find((s) => s.name === '1');
  const cX = can1x2.selections.find((s) => s.name === 'X');
  const c2 = can1x2.selections.find((s) => s.name === '2');
  assert.equal(c1.odds, 1.85, 'home odds 1.85');
  assert.equal(cX.odds, 3.35, 'draw odds 3.35');
  assert.equal(c2.odds, 4.20, 'away odds 4.20');
});
