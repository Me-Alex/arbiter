/**
 * Integration-style test for the extraction phase. Doesn't shell out to
 * TinyFish — instead it tests the normalizeExtraction helper by patching
 * the client module via dynamic import.
 *
 * Run with: node --test test/tinyfish-extract.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TinyfishScraper from '../src/scrapers/tinyfish-scraper.mjs';
import { TINYFISH_BOOKS } from '../src/tinyfish/books.mjs';
import { canonicalSelectionName } from '../src/tinyfish/normalize.mjs';
import { canonicalMarketKey } from '../src/tinyfish/extract.mjs';

test('canonicalMarketKey preserves structured TinyFish keys', () => {
  assert.equal(canonicalMarketKey('match_odds'), 'MATCH_ODDS');
  assert.equal(canonicalMarketKey('MATCH_ODDS_ADVANTAGE'), 'MATCH_ODDS_ADVANTAGE');
  assert.equal(canonicalMarketKey('over_under_25'), 'OVER_UNDER_25');
});

test('extraction phase normalizes a real-shape TinyFish payload end-to-end', () => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const scraper = new TinyfishScraper({ dataDir, bookConfig: TINYFISH_BOOKS.superbet });
  const raw = {
    events: [
      {
        sourceUrl: 'https://superbet.ro/cote/fotbal/cagliari-vs-inter-1',
        homeTeam: 'Cagliari',
        awayTeam: 'Inter Milano',
        league: 'Serie A',
        sport: 'Football',
        kickoff: '2026-08-30T14:45:00+03:00',
        markets: [
          {
            key: 'MATCH_ODDS',
            name: 'Final - Super Cota',
            selections: [
              { name: 'Cagliari', odds: 7.7, handicap: null },
              { name: 'Egalitate', odds: 5.0, handicap: null },
              { name: 'Inter Milano', odds: 1.43, handicap: null },
            ],
          },
          {
            key: 'MATCH_ODDS_ADVANTAGE',
            name: 'Final (Super Avantaj)',
            selections: [
              { name: 'Cagliari', odds: 7.4, handicap: null },
              { name: 'Egalitate', odds: 4.85, handicap: null },
              { name: 'Inter Milano', odds: 1.42, handicap: null },
            ],
          },
        ],
      },
      {
        sourceUrl: 'https://superbet.ro/cote/fotbal/fcsb-vs-cfr-2',
        homeTeam: 'FCSB',
        awayTeam: 'CFR Cluj',
        league: 'Liga 1',
        sport: 'Football',
        kickoff: '2026-08-30T18:00:00+03:00',
        markets: [
          {
            key: 'MATCH_ODDS',
            name: 'Final',
            selections: [
              { name: 'FCSB', odds: 1.85, handicap: null },
              { name: 'Egalitate', odds: 3.40, handicap: null },
              { name: 'CFR Cluj', odds: 4.20, handicap: null },
            ],
          },
        ],
      },
    ],
    discovery: { count: 2, runId: 'r1' },
    extraction: { ok: 2, failed: 0, runs: [] },
  };

  const events = scraper.extractEvents(scraper.normalize(raw));
  assert.equal(events.length, 2);
  const cagliari = events[0];
  assert.equal(cagliari.homeTeam, 'Cagliari');
  assert.equal(cagliari.markets.length, 2);
  const selections = cagliari.markets[0].selections;
  assert.equal(selections[0].name, 'Cagliari');
  assert.equal(selections[1].name, 'Draw'); // Egalitate → Draw
  assert.equal(selections[2].name, 'Inter Milano');

  // eventKey includes both teams and the normalized kickoff
  assert.ok(cagliari.eventKey.includes('cagliari'));
  assert.ok(cagliari.eventKey.includes('inter'));
  // kickoff is in UTC ISO
  assert.match(cagliari.kickoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('two books on the same event cross-match in the engine', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tf-int-'));
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  // Two books quote the same match. Combined inverse sum < 1 → arbitrage.
  // Book A: 2.50 / 4.50 / 5.00  →  inv 0.4 + 0.222 + 0.2  = 0.822
  // Book B: 2.10 / 4.00 / 4.50  →  inv 0.476 + 0.25 + 0.222 = 0.948
  // Use Book A home and Book B draw/away so the opportunity is truly cross-book.
  const writeWorkspace = async (sourceId, odds) => {
    const ev = {
      sourceId,
      eventKey: ['football', 'serie a', '2030-01-01T00:00:00.000Z', 'cagliari', 'inter'].join('|'),
      sport: 'Football', league: 'Serie A',
      kickoff: '2030-01-01T00:00:00.000Z',
      homeTeam: 'Cagliari', awayTeam: 'Inter',
      markets: [{ key: 'MATCH_ODDS', name: 'M', selections: [
        { name: 'Cagliari', odds: odds.home },
        { name: 'Draw', odds: odds.draw },
        { name: 'Inter', odds: odds.away },
      ] }],
    };
    // loadWorkspace drops any snapshot that is not FRESH *and* carries full
    // provenance (runId + sourceUrl + transport) — see scanner.mjs. Without
    // those fields the events never reach the engine, so the fixture must
    // declare them to exercise the cross-book matching path.
    await writeFile(join(dataDir, 'workspace', `${sourceId}_events.json`), JSON.stringify({
      schemaVersion: 2,
      sourceId,
      runId: 'offline-tf',
      sourceUrl: `https://example.test/${sourceId}`,
      transport: 'test-fixture-json',
      capturedAt: new Date().toISOString(),
      dataStatus: 'fresh',
      events: [ev],
    }));
  };
  await writeWorkspace('a', { home: 2.50, draw: 4.20, away: 4.60 });
  await writeWorkspace('b', { home: 2.10, draw: 4.50, away: 5.00 });

  const { scanWorkspace } = await import('../src/scanner/scanner.mjs');
  const scan = await scanWorkspace({ dataDir });
  assert.ok(scan.opportunities.length >= 1, 'expected at least one arb');
  const opp = scan.opportunities[0];
  assert.equal(opp.legs.length, 3);
  const home = opp.legs.find((l) => l.selection === 'Cagliari');
  const draw = opp.legs.find((l) => l.selection === 'Draw');
  const away = opp.legs.find((l) => l.selection === 'Inter');
  assert.equal(home.odds, 2.50);
  assert.equal(draw.odds, 4.50);
  assert.equal(away.odds, 5.00);
  assert.ok(opp.roiPercent > 0);
  await rm(dataDir, { recursive: true });
});
