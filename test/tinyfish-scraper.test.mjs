import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TinyfishScraper from '../src/scrapers/tinyfish-scraper.mjs';
import { TINYFISH_BOOKS, getBookConfig } from '../src/tinyfish/books.mjs';

test('TinyfishScraper is registered for every book in books.mjs', () => {
  for (const [id, cfg] of Object.entries(TINYFISH_BOOKS)) {
    assert.equal(getBookConfig(id).baseUrl, cfg.baseUrl);
  }
});

test('TinyfishScraper.normalize maps the two-phase payload to RawEvents', () => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const scraper = new TinyfishScraper({ dataDir, bookConfig: TINYFISH_BOOKS.superbet });
  const raw = {
    events: [{
      sourceUrl: 'https://superbet.ro/cote/fotbal/fcsb-vs-cfr-12345',
      homeTeam: 'FCSB',
      awayTeam: 'CFR Cluj',
      league: 'Liga 1',
      sport: 'Football',
      live: true,
      kickoff: '2026-01-15T18:00:00+03:00',
      markets: [
        {
          key: 'MATCH_ODDS',
          name: 'Final',
          selections: [
            { name: 'FCSB', odds: 1.85 },
            { name: 'Egalitate', odds: 3.40 },
            { name: 'CFR Cluj', odds: 4.20 },
          ],
        },
        {
          key: 'OVER_UNDER_25',
          name: 'Total goluri Peste/Sub 2.5',
          selections: [
            { name: 'Peste 2.5', odds: 1.95, handicap: 2.5 },
            { name: 'Sub 2.5', odds: 1.90, handicap: 2.5 },
          ],
        },
      ],
    }],
    discovery: { count: 1, runId: 'r1' },
    extraction: { ok: 1, failed: 0, runs: [] },
  };
  const raws = scraper.normalize(raw);
  assert.equal(raws.length, 1);
  assert.equal(raws[0].homeTeam, 'FCSB');
  assert.equal(raws[0].kickoff, '2026-01-15T15:00:00.000Z');
  assert.equal(raws[0].live, true);
  assert.equal(raws[0].marketGroups.length, 2);
});

test('TinyfishScraper.extractEvents produces NormalizedEvents with canonical names', () => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const scraper = new TinyfishScraper({ dataDir, bookConfig: TINYFISH_BOOKS.superbet });
  const raw = {
    events: [{
      sourceUrl: 'https://superbet.ro/cote/fotbal/fcsb-vs-cfr-12345',
      homeTeam: 'FCSB', awayTeam: 'CFR Cluj',
      league: 'Liga 1', sport: 'Football',
      kickoff: '2026-01-15T18:00:00+03:00',
      markets: [{
        key: 'MATCH_ODDS',
        name: 'Final',
        selections: [
          { name: 'FCSB', odds: 1.85 },
          { name: 'Egalitate', odds: 3.40 },
          { name: 'CFR Cluj', odds: 4.20 },
        ],
      }],
    }],
    discovery: { count: 1, runId: 'r1' },
    extraction: { ok: 1, failed: 0, runs: [] },
  };
  const events = scraper.extractEvents(scraper.normalize(raw));
  assert.equal(events.length, 1);
  const selections = events[0].markets[0].selections;
  assert.equal(selections[0].name, 'FCSB');
  assert.equal(selections[1].name, 'Draw');
  assert.equal(selections[2].name, 'CFR Cluj');
  assert.ok(events[0].eventKey.includes('fcsb'));
  assert.ok(events[0].eventKey.includes('cfr'));
});

test('TinyfishScraper uses a stable key for live events without kickoff', () => {
  const scraper = new TinyfishScraper({ bookConfig: TINYFISH_BOOKS.superbet });
  const events = scraper.extractEvents(scraper.normalize({
    events: [{
      sourceUrl: 'https://example.test/a-vs-b',
      homeTeam: 'A',
      awayTeam: 'B',
      league: 'Live League',
      sport: 'Football',
      live: true,
      kickoff: null,
      markets: [{
        key: 'MATCH_ODDS',
        selections: [{ name: 'A', odds: 2 }, { name: 'B', odds: 2 }],
      }],
    }],
  }));
  assert.match(events[0].eventKey, /\|live\|a\|b$/);
});

test('TinyfishScraper drops markets whose selections have invalid odds', () => {
  // extractEvents itself doesn't drop bad selections — ScraperBase.validate
  // does that during run(). Confirm both markets appear here, then run()
  // should reject the bad-odds event.
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const scraper = new TinyfishScraper({ dataDir, bookConfig: TINYFISH_BOOKS.superbet });
  const raw = {
    events: [{
      sourceUrl: 'https://x', homeTeam: 'A', awayTeam: 'B',
      league: 'L', sport: 'Football', kickoff: '2030-01-01T00:00:00Z',
      markets: [
        { key: 'BAD', selections: [{ name: 'A', odds: 0.5 }, { name: 'B', odds: 1.85 }] },
        { key: 'OK', selections: [{ name: 'X', odds: 2.0 }, { name: 'Y', odds: 3.0 }] },
      ],
    }],
  };
  const events = scraper.extractEvents(scraper.normalize(raw));
  // extractEvents filters out the bad market itself (odds <= 1 invalid).
  assert.equal(events.length, 1);
  assert.equal(events[0].markets.length, 1);
  assert.equal(events[0].markets[0].key, 'OK');
});

test('TinyfishScraper.run is dry-run safe and writes to workspace', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tf-'));
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const dryRunPayload = {
    events: [{
      sourceUrl: 'https://x', homeTeam: 'A', awayTeam: 'B',
      league: 'L', sport: 'Football', kickoff: '2030-01-01T00:00:00Z',
      markets: [{ key: 'MATCH_ODDS', selections: [{ name: 'A', odds: 1.85 }, { name: 'B', odds: 4.20 }, { name: 'Draw', odds: 3.40 }] }],
    }],
    discovery: { count: 1, runId: 'r1' },
    extraction: { ok: 1, failed: 0, runs: [] },
  };
  const scraper = new TinyfishScraper({ dataDir, dryRun: true, dryRunPayload, bookConfig: TINYFISH_BOOKS.superbet });
  const env = await scraper.run();
  assert.equal(env.valid, true);
  assert.equal(env.events, 1);
  await rm(dataDir, { recursive: true });
});

test('TinyfishScraper.run is dry-run safe with empty payload', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tf-'));
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const scraper = new TinyfishScraper({ dataDir, dryRun: true, bookConfig: TINYFISH_BOOKS.superbet });
  const env = await scraper.run();
  assert.equal(env.valid, true);
  assert.equal(env.events, 0);
  await rm(dataDir, { recursive: true });
});

test('TinyfishScraper reports failure when every discovered event extraction fails', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tf-'));
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const payload = {
    events: [],
    discovery: { count: 5, runId: 'r1' },
    extraction: { ok: 0, failed: 5, runs: [] },
  };
  const scraper = new TinyfishScraper({ dataDir, dryRun: true, dryRunPayload: payload, bookConfig: TINYFISH_BOOKS.superbet });
  const env = await scraper.run();
  assert.equal(env.valid, false);
  assert.equal(env.status, 'failed');
  assert.match(env.error.message, /every discovered event extraction failed/);
  await rm(dataDir, { recursive: true });
});
