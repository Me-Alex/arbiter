import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import Luck from '../src/scrapers/luck.mjs';
import { resolveContract } from '../src/scanner/market-contracts.mjs';

const CFG = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = CFG.jobs ? CFG.jobs.find((j) => j.id === 'luck') : CFG.find((j) => j.id === 'luck');
const CAPTURE_CONTAINER = JSON.parse(readFileSync(new URL('../data/endpoints/captures/luck-odds-2026-11-07.json', import.meta.url), 'utf8'));
const CAPTURE = typeof CAPTURE_CONTAINER.raw === 'string' ? JSON.parse(CAPTURE_CONTAINER.raw) : CAPTURE_CONTAINER.raw;

test('luck: job configuration in scrapers.json', () => {
  assert.ok(JOB, 'luck job entry must exist in scrapers.json');
  assert.equal(JOB.enabled, true);
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.engine, 'exalogic-xsport');
  assert.equal(JOB.transport, 'exalogic-xsport-public-json');
  assert.equal(JOB.script, 'luck.mjs');
  assert.deepEqual(JOB.sourceIds, ['luck']);
  assert.equal(JOB.platform, 'exalogic-xsport');
});

test('luck: instantiates with expected identity and Exalogic parameters', () => {
  const scraper = instantiate('luck');
  assert.ok(scraper instanceof Luck);
  assert.equal(scraper.id, 'luck');
  assert.equal(scraper.name, 'Luck');
  assert.deepEqual(scraper.sourceIds, ['luck']);
  assert.equal(scraper.systemCode, 'LUCKY');
  assert.equal(scraper.apiBase, 'https://sport.luck.com/XSportDatastore');
  assert.equal(scraper.sourceUrl, 'https://luck.com/sport');
});

test('luck: parses real live REA MCP capture fixture accurately', () => {
  const scraper = new Luck({ maxEvents: 100 });
  const rawEvents = scraper.normalize(CAPTURE);
  assert.ok(Array.isArray(rawEvents));
  assert.ok(rawEvents.length >= 20, `expected >=20 events, got ${rawEvents.length}`);

  const events = scraper.extractEvents(rawEvents);
  assert.ok(events.length >= 20, `expected >=20 parsed events, got ${events.length}`);

  for (const ev of events) {
    assert.equal(ev.sourceId, 'luck');
    assert.equal(ev.sport, 'football');
    assert.ok(ev.id);
    assert.ok(ev.homeTeam);
    assert.ok(ev.awayTeam);
    assert.ok(Array.isArray(ev.markets));
    assert.ok(ev.markets.length > 0);

    for (const m of ev.markets) {
      const contract = resolveContract(m, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, sport: ev.sport });
      assert.ok(contract, `market ${m.key} must resolve to a valid contract`);
    }
  }
});
