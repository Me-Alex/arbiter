import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmiralBetPlScraper from '../src/scrapers/admiralbet-pl.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

// Load config and fixtures
const scrapersConfig = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config/scrapers.json'), 'utf-8')
);
const eventsFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test/fixtures/admiralbet-pl-events.json'), 'utf-8')
);

// Test that the job is correctly registered in config/scrapers.json
test('admiralbet-pl: config entry matches expectations', () => {
  const jobConfig = scrapersConfig.jobs.find((j) => j.id === 'admiralbet-pl');
  assert.ok(jobConfig, 'admiralbet-pl entry exists');
  assert.equal(jobConfig.enabled, true);
  assert.equal(jobConfig.engine, 'admiralbet-ws');
  assert.equal(jobConfig.transport, 'admiralbet-ws');
  assert.equal(jobConfig.script, 'admiralbet-pl.mjs');
});

// Test that the scraper can be instantiated via the registry
test('admiralbet-pl: registry instantiation works', () => {
  const jobConfig = scrapersConfig.jobs.find((j) => j.id === 'admiralbet-pl');
  const scraper = instantiate('admiralbet-pl', { jobConfig });
  assert.ok(scraper instanceof AdmiralBetPlScraper);
  assert.equal(scraper.id, 'admiralbet-pl');
  assert.equal(scraper.name, 'AdmiralBet Poland');
});

// Test extraction logic using fixture data (mocking WebSocket calls)
test('admiralbet-pl: extracts events with MATCH_ODDS and BTTS markets correctly', async () => {
  const scraper = new AdmiralBetPlScraper();
  // Stub _wsRequest to return appropriate fixture data based on expected type
  scraper._wsRequest = async (url, msg, expectedType, opts) => {
    if (expectedType && expectedType.toUpperCase() === 'R_PREMATCH_HIERARCHY') {
      // Minimal hierarchy stub – not used further
      return { type: expectedType };
    }
    if (expectedType && expectedType.toUpperCase() === 'R-EVENTS') {
      // Return the events payload fixture
      return eventsFixture;
    }
    throw new Error(`Unexpected expectedType ${expectedType}`);
  };

  const raw = await scraper.fetchRaw();
  const rawEvents = scraper.normalize(raw);
  const events = scraper.extractEvents(rawEvents);
  assert.ok(Array.isArray(events), 'extractEvents returns array');
  assert.ok(events.length > 0, 'at least one event extracted');

  const ev = events[0];
  // Basic event shape checks
  assert.equal(ev.sourceId, 'admiralbet-pl');
  assert.equal(ev.sport, 'Football');
  assert.ok(ev.league && typeof ev.league === 'string');
  assert.ok(ev.homeTeam && typeof ev.homeTeam === 'string');
  assert.ok(ev.awayTeam && typeof ev.awayTeam === 'string');
  assert.ok(ev.kickoff && typeof ev.kickoff === 'string');

  // MATCH_ODDS market
  const matchOdds = ev.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(matchOdds, 'MATCH_ODDS market present');
  assert.equal(matchOdds.selections.length, 3, 'MATCH_ODDS has three selections');
  const homeSel = matchOdds.selections.find((s) => s.name === ev.homeTeam);
  const awaySel = matchOdds.selections.find((s) => s.name === ev.awayTeam);
  const drawSel = matchOdds.selections.find((s) => /draw|remis|x/i.test(s.name));
  assert.ok(homeSel, 'home selection found');
  assert.ok(awaySel, 'away selection found');
  assert.ok(drawSel, 'draw selection found');

  // BTTS market
  const btts = ev.markets.find((m) => m.key === 'BOTH_TEAMS_TO_SCORE');
  assert.ok(btts, 'BTTS market present');
  assert.equal(btts.selections.length, 2, 'BTTS has Yes/No selections');
  const yesSel = btts.selections.find((s) => /^yes$/i.test(s.name));
  const noSel = btts.selections.find((s) => /^no$/i.test(s.name));
  assert.ok(yesSel, 'BTTS Yes selection present');
  assert.ok(noSel, 'BTTS No selection present');

  // All markets should be marked as non‑live
  for (const m of ev.markets) {
    assert.equal(m.live, false, `market ${m.key} should have live:false`);
  }
});

test('admiralbet-pl: extracts Totals, Double Chance and 2-way Match Winner resolving to canonical contracts', () => {
  const scraper = new AdmiralBetPlScraper();
  const rawFixture = [
    {
      id: 'mock-admiral-1',
      event: {
        fixture: {
          startTime: '2026-11-10T19:00:00Z',
          sportNodeId: 'koszykowka',
          path: { competitionName: 'NBA', sportPath: 'koszykowka/usa' },
          competitors: [
            { homeAway: 'HOME', name: { name: 'Boston Celtics' } },
            { homeAway: 'AWAY', name: { name: 'LA Lakers' } },
          ],
          markets: [
            {
              marketType: '10',
              name: { name: 'Match Winner' },
              selections: [
                { id: 'sel-1', typeId: 1, name: { name: 'Boston Celtics' }, segments: { DEFAULT: { price: '1.45' } } },
                { id: 'sel-2', typeId: 2, name: { name: 'LA Lakers' }, segments: { DEFAULT: { price: '2.80' } } },
              ],
            },
            {
              marketType: '56',
              name: { name: 'Total Points' },
              specifierValues: { total: '224.5' },
              selections: [
                { id: 'sel-3', typeId: 12, name: { name: 'Over 224.5' }, segments: { DEFAULT: { price: '1.90' } } },
                { id: 'sel-4', typeId: 13, name: { name: 'Under 224.5' }, segments: { DEFAULT: { price: '1.90' } } },
              ],
            },
            {
              marketType: '11',
              name: { name: 'Double Chance' },
              selections: [
                { id: 'sel-5', typeId: 9, name: { name: '1X' }, segments: { DEFAULT: { price: '1.20' } } },
                { id: 'sel-6', typeId: 10, name: { name: '12' }, segments: { DEFAULT: { price: '1.30' } } },
                { id: 'sel-7', typeId: 11, name: { name: 'X2' }, segments: { DEFAULT: { price: '1.80' } } },
              ],
            },
          ],
        },
      },
    },
  ];

  const events = scraper.extractEvents(rawFixture);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.sport, 'Basketball');

  const winner = ev.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(winner, 'Match Winner market must exist');
  assert.equal(winner.period, 'fulltime_ot');

  const totals = ev.markets.find((m) => m.key === 'TOTAL_POINTS');
  assert.ok(totals, 'TOTAL_POINTS market must exist');
  assert.equal(totals.line, 224.5);
  assert.equal(totals.subject, 'points');

  const dc = ev.markets.find((m) => m.key === 'DOUBLE_CHANCE');
  assert.ok(dc, 'Double Chance market must exist');
});
