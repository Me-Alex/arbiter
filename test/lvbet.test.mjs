import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TextEncoder } from 'node:util';
import Lvbet, { LVBET_SPORT_MAP, LVBET_SPORT_NAME_TO_ID } from '../src/scrapers/lvbet.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../src/shared/errors.mjs';

const scrapersConfig = JSON.parse(
  readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8')
);
const JOB = scrapersConfig.jobs.find((j) => j.id === 'lvbet');

const competitionFixture = JSON.parse(
  readFileSync(new URL('./fixtures/lvbet-competition.json', import.meta.url), 'utf8')
);
const multisportFixture = JSON.parse(
  readFileSync(new URL('./fixtures/lvbet-multisport.json', import.meta.url), 'utf8')
);

// ── Contract & Registry Configuration ─────────────────────────────────────────

test('lvbet: registered and promoted in config/scrapers.json', () => {
  assert.ok(JOB, 'lvbet must exist in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'promoted job must be enabled');
  assert.equal(JOB.validationStatus, 'validated', 'promoted job must be validated');
  assert.equal(JOB.feedStatus, 'verified', 'promoted job feedStatus must be verified');
  assert.equal(JOB.platform, 'custom');
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'lvbet.mjs'],
    'contract triple must match implementation',
  );
});

test('lvbet: instantiates through registry dispatcher', () => {
  const scraper = instantiate('lvbet', { jobConfig: JOB });
  assert.ok(scraper instanceof Lvbet);
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'lvbet');
  assert.equal(scraper.name, 'LV BET');
  assert.deepEqual(scraper.sourceIds, ['lvbet']);
  assert.equal(scraper.engine, 'custom-json');
  assert.equal(scraper.transport, 'custom-json');
});

// ── Normalization ─────────────────────────────────────────────────────────────

test('lvbet: normalize parses matches and pairs primary_column_markets', () => {
  const scraper = new Lvbet();
  const normalized = scraper.normalize(competitionFixture);

  assert.ok(Array.isArray(normalized));
  assert.equal(normalized.length, competitionFixture.matches.length);

  for (const item of normalized) {
    assert.ok(item.match_id);
    assert.ok(Array.isArray(item.markets));
  }

  // Check that match bc:31111901 has attached markets
  const vMatch = normalized.find((m) => m.match_id === 'bc:31111901');
  assert.ok(vMatch);
  assert.ok(vMatch.markets.length >= 4);
});

test('lvbet: normalize rejects invalid inputs', () => {
  const scraper = new Lvbet();
  assert.throws(() => scraper.normalize(null), ValidationError);
  assert.throws(() => scraper.normalize('not an object'), ValidationError);
  assert.throws(() => scraper.normalize({}), ValidationError);
  assert.throws(() => scraper.normalize({ matches: 'not an array' }), ValidationError);
});

// ── Football Event & Market Extraction ────────────────────────────────────────

test('lvbet: extracts football events with full 1X2, BTTS, Over/Under, Double Chance and Asian Handicap', () => {
  const scraper = new Lvbet({
    includePast: true,
    includeLive: true,
    windowHours: 720,
    maxEvents: 50,
  });

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);

  assert.ok(Array.isArray(events));
  assert.ok(events.length > 0);

  // Validate Valerenga vs SK Brann (bc:31111901)
  const valerenga = events.find((e) => e.eventId === 'bc:31111901');
  assert.ok(valerenga, 'Valerenga vs SK Brann match must be found');
  assert.equal(valerenga.sport, 'football');
  assert.equal(valerenga.homeTeam, 'Valerenga');
  assert.equal(valerenga.awayTeam, 'SK Brann');
  assert.equal(valerenga.kickoff, '2026-10-18T15:00:00.000Z');
  assert.ok(valerenga.eventKey);

  // 1. MATCH_ODDS (3-way)
  const matchOdds = valerenga.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(matchOdds, 'MATCH_ODDS market must be extracted');
  assert.equal(matchOdds.selections.length, 3);
  const sel1 = matchOdds.selections.find((s) => s.name === '1');
  const selX = matchOdds.selections.find((s) => s.name === 'X');
  const sel2 = matchOdds.selections.find((s) => s.name === '2');
  assert.ok(sel1 && sel1.odds === 2.47);
  assert.ok(selX && selX.odds === 3.75);
  assert.ok(sel2 && sel2.odds === 2.5);

  // 2. OVER_UNDER (Total Goals 3.5)
  const ou = valerenga.markets.find((m) => m.key === 'OVER_UNDER');
  assert.ok(ou, 'OVER_UNDER market must be extracted');
  assert.equal(ou.line, 3.5);
  const overSel = ou.selections.find((s) => s.name === 'Over');
  const underSel = ou.selections.find((s) => s.name === 'Under');
  assert.ok(overSel && overSel.odds === 1.95);
  assert.ok(underSel && underSel.odds === 1.77);

  // 3. ASIAN_HANDICAP (0.0)
  const ah = valerenga.markets.find((m) => m.key === 'ASIAN_HANDICAP');
  assert.ok(ah, 'ASIAN_HANDICAP market must be extracted');
  assert.equal(ah.line, 0);
  assert.equal(ah.selections.length, 2);
  assert.equal(ah.selections[0].odds, 1.85);
  assert.equal(ah.selections[1].odds, 1.85);

  // 4. DOUBLE_CHANCE
  const dc = valerenga.markets.find((m) => m.key === 'DOUBLE_CHANCE');
  assert.ok(dc, 'DOUBLE_CHANCE market must be extracted');
  assert.equal(dc.selections.length, 3);
  assert.ok(dc.selections.every((s) => s.odds > 1));

  // 5. BTTS on matches with class 3151
  const matchesWithBtts = events.filter((e) => e.markets.some((m) => m.key === 'BTTS'));
  assert.ok(matchesWithBtts.length > 0, 'BTTS markets must be extracted on applicable matches');
  const bttsMarket = matchesWithBtts[0].markets.find((m) => m.key === 'BTTS');
  assert.equal(bttsMarket.selections.length, 2);
  assert.ok(bttsMarket.selections.find((s) => s.name === 'Yes'));
  assert.ok(bttsMarket.selections.find((s) => s.name === 'No'));
});

// ── Multi-Sport Support ───────────────────────────────────────────────────────

test('lvbet: extracts basketball events with 2-way moneyline', () => {
  const scraper = new Lvbet({
    sport: 'basketball',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const raw = {
    matches: multisportFixture.basketball.matches,
    primary_column_markets: multisportFixture.basketball.primary_column_markets,
  };
  const normalized = scraper.normalize(raw);
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'basketball');
  }

  const first = events[0];
  const mo = first.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(mo, 'Basketball event must carry MATCH_ODDS');
  assert.equal(mo.selections.length, 2, 'Basketball moneyline is 2-way');
  assert.ok(mo.selections.every((s) => s.odds > 1));
});

test('lvbet: extracts tennis events with 2-way match winner', () => {
  const scraper = new Lvbet({
    sport: 'tennis',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const raw = {
    matches: multisportFixture.tennis.matches,
    primary_column_markets: multisportFixture.tennis.primary_column_markets,
  };
  const normalized = scraper.normalize(raw);
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'tennis');
  }

  // Find match with active odds (bc:31198549)
  const matchWithOdds = events.find((e) => e.eventId === 'bc:31198549') || events.find((e) => e.markets.some((m) => m.key === 'MATCH_ODDS'));
  assert.ok(matchWithOdds, 'Tennis match with open odds must be found');
  const mo = matchWithOdds.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(mo, 'Tennis match must carry MATCH_ODDS');
  assert.equal(mo.selections.length, 2, 'Tennis match winner is 2-way');
  assert.ok(mo.selections.every((s) => s.odds > 1));
});

test('lvbet: extracts ice hockey events with money line / match result', () => {
  const scraper = new Lvbet({
    sport: 'ice-hockey',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const raw = {
    matches: multisportFixture['ice-hockey'].matches,
    primary_column_markets: multisportFixture['ice-hockey'].primary_column_markets,
  };
  const normalized = scraper.normalize(raw);
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'ice-hockey');
  }

  const first = events[0];
  const mo = first.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(mo, 'Ice Hockey match must carry MATCH_ODDS');
  assert.ok(mo.selections.length === 2 || mo.selections.length === 3, 'Ice hockey market is 2-way (Money Line) or 3-way');
  assert.ok(mo.selections.every((s) => s.odds > 1));
});

// ── Limits, Filtering & Edge Cases ────────────────────────────────────────────

test('lvbet: respects maxEvents limit', () => {
  const scraper = new Lvbet({
    includePast: true,
    includeLive: true,
    windowHours: 720,
    maxEvents: 3,
  });

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);
  assert.equal(events.length, 3);
});

test('lvbet: correctly handles teams_reversed flag', () => {
  const scraper = new Lvbet({
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const sampleMatch = {
    match_id: 'test:reversed:1',
    teams_reversed: true,
    date: '2026-10-18T15:00:00+00:00',
    sports_groups_ids: [1],
    home: ['Team A'],
    away: ['Team B'],
    state: { is_pre: true, is_live: false },
    markets: [],
  };

  const events = scraper.extractEvents([sampleMatch]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Team B', 'Home team must be swapped when teams_reversed is true');
  assert.equal(events[0].awayTeam, 'Team A', 'Away team must be swapped when teams_reversed is true');
});

test('lvbet: filters out past events when includePast is false', () => {
  const scraper = new Lvbet({
    includePast: false,
    includeLive: false,
  });
  scraper.from = Date.parse('2026-10-15T00:00:00Z');
  scraper.to = Date.parse('2026-10-20T00:00:00Z');

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);

  for (const ev of events) {
    const t = Date.parse(ev.kickoff);
    assert.ok(t >= scraper.from, `Event ${ev.kickoff} must be >= ${new Date(scraper.from).toISOString()}`);
  }
});

test('lvbet: filters out live events when includeLive is false', () => {
  const scraper = new Lvbet({
    includePast: true,
    includeLive: false,
    windowHours: 720,
  });

  const mixedMatches = [
    {
      match_id: 'm:pre',
      date: '2026-10-18T15:00:00+00:00',
      sports_groups_ids: [1],
      home: ['Team A'],
      away: ['Team B'],
      state: { is_pre: true, is_live: false },
      markets: [],
    },
    {
      match_id: 'm:live',
      date: '2026-10-18T15:00:00+00:00',
      sports_groups_ids: [1],
      home: ['Team C'],
      away: ['Team D'],
      state: { is_pre: false, is_live: true },
      markets: [],
    },
  ];

  const events = scraper.extractEvents(mixedMatches);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'm:pre');
});

test('lvbet: ignores invalid rates <= 1.0', () => {
  const scraper = new Lvbet({
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const matchWithBadOdds = {
    match_id: 'test:bad:odds',
    date: '2026-10-18T15:00:00+00:00',
    sports_groups_ids: [1],
    home: ['Team A'],
    away: ['Team B'],
    state: { is_pre: true, is_live: false },
    markets: [
      {
        markets_class_id: 2669,
        name: 'Match Result',
        selections: [
          { name: '1', order: 0, rate: { decimal: 1.0 } }, // invalid <= 1
          { name: 'X', order: 1, rate: { decimal: 3.2 } },
          { name: '2', order: 2, rate: { decimal: 2.1 } },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([matchWithBadOdds]);
  assert.equal(events.length, 1);
  assert.equal(events[0].markets.length, 0, 'Market with invalid decimal odds must be rejected');
});

// ── Network & fetchRaw Smoke Tests ────────────────────────────────────────────

test('lvbet: fetchRaw aggregates matches across configured sports', async () => {
  const mockFetch = async (url) => ({
    ok: true,
    headers: { get: () => 'application/json' },
    body: {
      getReader() {
        let readOnce = false;
        const jsonStr = JSON.stringify({
          matches: [{ match_id: 'fetch:1', date: '2026-10-18T15:00:00Z', home: ['H'], away: ['A'], sports_groups_ids: [1] }],
          primary_column_markets: [],
        });
        const encoder = new TextEncoder();
        return {
          async read() {
            if (readOnce) return { done: true, value: undefined };
            readOnce = true;
            return { done: false, value: encoder.encode(jsonStr) };
          },
          releaseLock() {},
          cancel: async () => {},
        };
      },
      cancel: async () => {},
    },
  });

  const scraper = new Lvbet({
    fetchImpl: mockFetch,
    sport: 'football',
  });

  const raw = await scraper.fetchRaw();
  assert.ok(raw.matches.length > 0);
  assert.equal(raw.matches[0].match_id, 'fetch:1');
});

test('lvbet: fetchRaw throws UpstreamError on HTTP failure', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 503,
    body: { cancel: async () => {} },
  });

  const scraper = new Lvbet({ fetchImpl: mockFetch });
  await assert.rejects(() => scraper.fetchRaw(), UpstreamError);
});

test('lvbet: fetchRaw throws ValidationError on non-JSON content-type', async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    body: { cancel: async () => {} },
  });

  const scraper = new Lvbet({ fetchImpl: mockFetch });
  await assert.rejects(() => scraper.fetchRaw(), ValidationError);
});

test('lvbet: sport map consistency', () => {
  assert.equal(LVBET_SPORT_MAP[1], 'football');
  assert.equal(LVBET_SPORT_MAP[3], 'basketball');
  assert.equal(LVBET_SPORT_MAP[4], 'tennis');
  assert.equal(LVBET_SPORT_MAP[2], 'ice-hockey');
  assert.equal(LVBET_SPORT_NAME_TO_ID.football, 1);
  assert.equal(LVBET_SPORT_NAME_TO_ID.basketball, 3);
  assert.equal(LVBET_SPORT_NAME_TO_ID.tennis, 4);
  assert.equal(LVBET_SPORT_NAME_TO_ID['ice-hockey'], 2);
});
