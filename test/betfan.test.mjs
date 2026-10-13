import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TextEncoder } from 'node:util';
import Betfan, { BETFAN_SPORT_MAP } from '../src/scrapers/betfan.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../src/shared/errors.mjs';

const scrapersConfig = JSON.parse(
  readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8')
);
const JOB = scrapersConfig.jobs.find((j) => j.id === 'betfan');

const competitionFixture = JSON.parse(
  readFileSync(new URL('./fixtures/betfan-competition.json', import.meta.url), 'utf8')
);
const multisportFixture = JSON.parse(
  readFileSync(new URL('./fixtures/betfan-multisport.json', import.meta.url), 'utf8')
);

// ── Contract & Registry Configuration ─────────────────────────────────────────

test('betfan: registered and promoted in config/scrapers.json', () => {
  assert.ok(JOB, 'betfan must exist in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'promoted job must be enabled');
  assert.equal(JOB.validationStatus, 'validated', 'promoted job must be validated');
  assert.equal(JOB.feedStatus, 'verified', 'promoted job feedStatus must be verified');
  assert.equal(JOB.platform, 'custom');
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['custom-json', 'custom-json', 'betfan.mjs'],
    'contract triple must match implementation',
  );
});

test('betfan: instantiates through registry dispatcher', () => {
  const scraper = instantiate('betfan', { jobConfig: JOB });
  assert.ok(scraper instanceof Betfan);
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'betfan');
  assert.equal(scraper.name, 'BETFAN');
  assert.deepEqual(scraper.sourceIds, ['betfan']);
  assert.equal(scraper.engine, 'custom-json');
  assert.equal(scraper.transport, 'custom-json');
});

// ── Normalization ─────────────────────────────────────────────────────────────

test('betfan: normalize parses events array from payload', () => {
  const scraper = new Betfan();
  const normalized = scraper.normalize(competitionFixture);

  assert.ok(Array.isArray(normalized));
  assert.equal(normalized.length, competitionFixture.events.length);

  for (const item of normalized) {
    assert.ok(item.id);
    assert.ok(Array.isArray(item.games));
  }
});

test('betfan: normalize rejects invalid inputs', () => {
  const scraper = new Betfan();
  assert.throws(() => scraper.normalize(null), ValidationError);
  assert.throws(() => scraper.normalize('not an object'), ValidationError);
  assert.throws(() => scraper.normalize({}), ValidationError);
  assert.throws(() => scraper.normalize({ events: 'not an array' }), ValidationError);
});

// ── Football Event & Market Extraction ────────────────────────────────────────

test('betfan: extracts football events with 1X2, BTTS, and Double Chance markets', () => {
  const scraper = new Betfan({
    includePast: true,
    includeLive: true,
    windowHours: 720,
    maxEvents: 50,
  });

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);

  assert.ok(Array.isArray(events));
  assert.ok(events.length > 0);

  // 1. Verify Komarno - Rużomberk (id: 40524193)
  const komarno = events.find((e) => e.eventId === '40524193');
  assert.ok(komarno, 'Komarno match must be extracted');
  assert.equal(komarno.sport, 'football');
  assert.equal(komarno.homeTeam, 'Komarno');
  assert.equal(komarno.awayTeam, 'Rużomberk');
  assert.equal(komarno.kickoff, '2026-10-17T13:30:00.000Z');
  assert.ok(komarno.eventKey);

  // 1X2 match odds
  const mo = komarno.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(mo, 'MATCH_ODDS market must be extracted');
  assert.equal(mo.selections.length, 3);
  const sel1 = mo.selections.find((s) => s.name === '1');
  const selX = mo.selections.find((s) => s.name === 'X');
  const sel2 = mo.selections.find((s) => s.name === '2');
  assert.ok(sel1 && sel1.odds === 2);
  assert.ok(selX && selX.odds === 3.45);
  assert.ok(sel2 && sel2.odds === 3.05);

  // Double chance
  const dc = komarno.markets.find((m) => m.key === 'DOUBLE_CHANCE');
  assert.ok(dc, 'DOUBLE_CHANCE market must be extracted');
  assert.equal(dc.selections.length, 3);
  assert.ok(dc.selections.every((s) => s.odds > 1));

  // 2. Verify match with BTTS: Notts County vs Nottingham Forest U21
  const notts = events.find((e) => e.homeTeam.includes('Notts County'));
  assert.ok(notts, 'Notts County match must be found');
  const btts = notts.markets.find((m) => m.key === 'BTTS');
  assert.ok(btts, 'BTTS market must be extracted');
  assert.equal(btts.selections.length, 2);
  const yes = btts.selections.find((s) => s.name === 'Yes');
  const no = btts.selections.find((s) => s.name === 'No');
  assert.ok(yes && yes.odds === 1.45);
  assert.ok(no && no.odds === 2.5);
});

// ── Multi-Sport Support ───────────────────────────────────────────────────────

test('betfan: extracts basketball events with moneyline', () => {
  const scraper = new Betfan({
    sport: 'basketball',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const normalized = scraper.normalize({ events: multisportFixture.basketball });
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'basketball');
  }

  const first = events[0];
  const mo = first.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(mo, 'Basketball match carries MATCH_ODDS');
  assert.ok(mo.selections.length === 2 || mo.selections.length === 3);
  assert.ok(mo.selections.every((s) => s.odds > 1));
});

test('betfan: extracts tennis events with 2-way match winner', () => {
  const scraper = new Betfan({
    sport: 'tennis',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const normalized = scraper.normalize({ events: multisportFixture.tennis });
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'tennis');
  }

  const matchWithOdds = events.find((e) => e.markets.some((m) => m.key === 'MATCH_ODDS'));
  assert.ok(matchWithOdds, 'Tennis match with open MATCH_ODDS must be found');
  const mo = matchWithOdds.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.equal(mo.selections.length, 2, 'Tennis match winner is 2-way');
  assert.ok(mo.selections.every((s) => s.odds > 1));
});

test('betfan: extracts ice hockey events', () => {
  const scraper = new Betfan({
    sport: 'ice-hockey',
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const normalized = scraper.normalize({ events: multisportFixture['ice-hockey'] });
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(ev.sport, 'ice-hockey');
  }
});

// ── Limits, Filtering & Edge Cases ────────────────────────────────────────────

test('betfan: respects maxEvents limit', () => {
  const scraper = new Betfan({
    includePast: true,
    includeLive: true,
    windowHours: 720,
    maxEvents: 3,
  });

  const normalized = scraper.normalize(competitionFixture);
  const events = scraper.extractEvents(normalized);
  assert.equal(events.length, 3);
});

test('betfan: fallback team extraction from event name when participants missing', () => {
  const scraper = new Betfan({
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const sampleMatch = {
    id: 999901,
    name: 'Bayern Munich - Borussia Dortmund',
    start: 1792243800000,
    type: 1,
    category1Id: 1,
    participants: null,
    games: [],
  };

  const events = scraper.extractEvents([sampleMatch]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Bayern Munich');
  assert.equal(events[0].awayTeam, 'Borussia Dortmund');
});

test('betfan: filters out past events when includePast is false', () => {
  const scraper = new Betfan({
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

test('betfan: filters out live events when includeLive is false', () => {
  const scraper = new Betfan({
    includePast: true,
    includeLive: false,
    windowHours: 720,
  });

  const mixedMatches = [
    {
      id: 101,
      start: 1792243800000,
      type: 1, // prematch
      category1Id: 1,
      name: 'Team A - Team B',
      games: [],
    },
    {
      id: 102,
      start: 1792243800000,
      type: 2, // live
      category1Id: 1,
      name: 'Team C - Team D (live)',
      games: [],
    },
  ];

  const events = scraper.extractEvents(mixedMatches);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, '101');
});

test('betfan: ignores invalid rates <= 1.0', () => {
  const scraper = new Betfan({
    includePast: true,
    includeLive: true,
    windowHours: 720,
  });

  const matchWithBadOdds = {
    id: 105,
    start: 1792243800000,
    type: 1,
    category1Id: 1,
    name: 'Team A - Team B',
    games: [
      {
        type: 1,
        name: 'Mecz',
        outcomes: [
          { name: 'Team A', odds: 1.0 }, // invalid <= 1
          { name: 'X', odds: 3.2 },
          { name: 'Team B', odds: 2.1 },
        ],
      },
    ],
  };

  const events = scraper.extractEvents([matchWithBadOdds]);
  assert.equal(events.length, 1);
  assert.equal(events[0].markets.length, 0, 'Market with invalid decimal odds must be rejected');
});

// ── Network & fetchRaw Smoke Tests ────────────────────────────────────────────

test('betfan: fetchRaw fetches and parses event payload', async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    body: {
      getReader() {
        let readOnce = false;
        const jsonStr = JSON.stringify({
          events: [{ id: 8001, start: 1792243800000, name: 'H - A', category1Id: 1 }],
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

  const scraper = new Betfan({ fetchImpl: mockFetch });
  const raw = await scraper.fetchRaw();
  assert.ok(raw.events.length > 0);
  assert.equal(raw.events[0].id, 8001);
});

test('betfan: fetchRaw throws UpstreamError on HTTP failure', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 502,
    body: { cancel: async () => {} },
  });

  const scraper = new Betfan({ fetchImpl: mockFetch });
  await assert.rejects(() => scraper.fetchRaw(), UpstreamError);
});

test('betfan: fetchRaw throws ValidationError on non-JSON content-type', async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    body: { cancel: async () => {} },
  });

  const scraper = new Betfan({ fetchImpl: mockFetch });
  await assert.rejects(() => scraper.fetchRaw(), ValidationError);
});

test('betfan: sport map consistency', () => {
  assert.equal(BETFAN_SPORT_MAP[1], 'football');
  assert.equal(BETFAN_SPORT_MAP[2], 'basketball');
  assert.equal(BETFAN_SPORT_MAP[5], 'tennis');
  assert.equal(BETFAN_SPORT_MAP[4], 'ice-hockey');
});
