/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import TotalBet from '../src/scrapers/totalbet.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = config.jobs.find((j) => j.id === 'totalbet');
const capture = JSON.parse(readFileSync(new URL('../data/endpoints/captures/totalbet-odds-2026-10-12.json', import.meta.url), 'utf8'));

function setup(opts = {}) {
  const scraper = instantiate('totalbet', { ...opts, jobConfig: JOB });
  scraper.from = Date.parse(capture.provenance.capturedAt) - 3600000;
  scraper.to = scraper.from + 168 * 3600000;
  scraper.observedAt = capture.provenance.capturedAt;
  scraper.sourceUrl = capture.provenance.sourceUrl;
  return scraper;
}

test('totalbet: job configuration declares verified oddin-platform public contract', () => {
  assert.ok(JOB, 'totalbet must have a job in config/scrapers.json');
  assert.equal(JOB.enabled, true, 'totalbet is a validated and enabled job');
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.feedStatus, 'verified');
  assert.equal(JOB.platform, 'oddin-platform');
  assert.equal(JOB.engine, 'oddin-platform');
  assert.equal(JOB.transport, 'oddin-public-sports-json');
  assert.equal(JOB.script, 'totalbet.mjs');
});

test('totalbet: dispatcher routes to TotalBet scraper instance with sourceId totalbet', () => {
  const scraper = setup();
  assert.ok(scraper instanceof TotalBet);
  assert.ok(scraper instanceof ScraperBase);
  assert.equal(scraper.id, 'totalbet');
  assert.deepEqual(scraper.sourceIds, ['totalbet']);
});

test('totalbet: captured wire rows preserve prices, identity and provenance', () => {
  const scraper = setup();
  const raw = scraper.normalize(capture.raw);
  const events = scraper.validate(scraper.extractEvents(raw));
  assert.ok(events.length > 0, 'captured events must be cleanly extracted');

  for (const event of events) {
    assert.equal(event.sourceId, 'totalbet');
    assert.ok(event.sourceUrl.startsWith('https://'));
    assert.equal(event.eventKey, eventIdentityKey(event));
    assert.ok(event.providerEventKey.split('|').includes(event.kickoff));
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

test('totalbet: verified on-screen odds match upstream Oddin API feed', () => {
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
  assert.equal(sel1.odds, 3.01, '1 odds must be 3.01');
  assert.equal(selX.odds, 3.18, 'X odds must be 3.18');
  assert.equal(sel2.odds, 2.6, '2 odds must be 2.60');

  // U.Cluj vs Rapid Bucuresti
  const ucluj = events.find((e) => e.homeTeam.includes('Cluj') && e.awayTeam.includes('Rapid'));
  assert.ok(ucluj, 'U.Cluj vs Rapid Bucuresti event must be present');
  const ucluj1X2 = ucluj.markets.find((m) => m.key === '1x2');
  assert.ok(ucluj1X2, '1X2 market must exist for U.Cluj match');
  const u1 = ucluj1X2.selections.find((s) => s.name === '1');
  const uX = ucluj1X2.selections.find((s) => s.name === 'X');
  const u2 = ucluj1X2.selections.find((s) => s.name === '2');
  assert.equal(u1.odds, 2.82, '1 odds must be 2.82');
  assert.equal(uX.odds, 3.36, 'X odds must be 3.36');
  assert.equal(u2.odds, 2.65, '2 odds must be 2.65');
});

test('totalbet: normalize and extract handles flat homePageEvents shape', () => {
  const scraper = setup();
  const flatFixture = [
    {
      eventName: 'Everton vs. Liverpool',
      // Anchored on the scraper's own window rather than Date.now(): setup()
      // pins from/to to the capture's capturedAt, so a clock-derived kickoff
      // drifts outside a window that closes seven days after the capture. This
      // assertion went red on 2026-10-19 12:42Z for exactly that reason, with
      // no code change behind it.
      eventDate: new Date(scraper.from + 7200000).toISOString(),
      fixtureId: '99887766',
      outcomes: [
        { marketName: 'Final', marketId: '1', name: '1', odds: 4.10 },
        { marketName: 'Final', marketId: '1', name: 'X', odds: 3.65 },
        { marketName: 'Final', marketId: '1', name: '2', odds: 1.85 },
      ],
    },
  ];
  const raw = scraper.normalize(flatFixture);
  const events = scraper.extractEvents(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Everton');
  assert.equal(events[0].awayTeam, 'Liverpool');
  const m = events[0].markets[0];
  assert.equal(m.selections.find((s) => s.name === '1').odds, 4.10);
  assert.equal(m.selections.find((s) => s.name === 'X').odds, 3.65);
  assert.equal(m.selections.find((s) => s.name === '2').odds, 1.85);
});

test('totalbet: extracts Double Chance, merged BTTS, and rich detail fixture markets', () => {
  const scraper = setup();
  const richFixture = [
    {
      eventName: 'Arsenal vs. Chelsea',
      eventDate: new Date(scraper.from + 7200000).toISOString(),
      fixtureId: '77665544',
      markets: [
        {
          marketId: '1',
          marketName: 'Final',
          outcomes: [
            { outcomeId: '1', outcomeName: '1', value: '2.00' },
            { outcomeId: '2', outcomeName: 'X', value: '3.40' },
            { outcomeId: '3', outcomeName: '2', value: '3.60' },
          ],
        },
        {
          marketId: '10',
          marketName: 'Double Chance',
          outcomes: [
            { outcomeId: '9', outcomeName: '1X', value: '1.25' },
            { outcomeId: '10', outcomeName: '12', value: '1.30' },
            { outcomeId: '11', outcomeName: 'X2', value: '1.75' },
          ],
        },
        // Split BTTS market entries
        {
          marketId: '29',
          marketName: 'Da gol nu da gol',
          outcomes: [{ outcomeId: '74', outcomeName: 'GG', value: '1.80' }],
        },
        {
          marketId: '29',
          marketName: 'Da gol nu da gol',
          outcomes: [{ outcomeId: '76', outcomeName: 'NG', value: '1.95' }],
        },
      ],
      detailMarkets: [
        {
          marketId: '11',
          marketName: 'Winner (RF)',
          outcomes: [
            { outcomeId: '4', marketId: '11', outcomeOdd: 1.50 },
            { outcomeId: '5', marketId: '11', outcomeOdd: 2.50 },
          ],
        },
        {
          marketId: 'dm1351',
          marketName: 'Total goluri',
          outcomes: [
            { outcomeId: '12', marketId: '18', specifier: 'total=2.5|', outcomeOdd: 1.85 },
            { outcomeId: '13', marketId: '18', specifier: 'total=2.5|', outcomeOdd: 1.95 },
          ],
        },
        {
          marketId: '166',
          marketName: 'Cornere total',
          outcomes: [
            { outcomeId: '12', marketId: '166', specifier: 'total=9.5|', outcomeOdd: 1.80 },
            { outcomeId: '13', marketId: '166', specifier: 'total=9.5|', outcomeOdd: 2.00 },
          ],
        },
        {
          marketId: '16',
          marketName: 'Handicap asiatic',
          outcomes: [
            { outcomeId: '1714', marketId: '16', specifier: 'hcp=-1.5|', outcomeOdd: 3.50 },
            { outcomeId: '1715', marketId: '16', specifier: 'hcp=-1.5|', outcomeOdd: 1.25 },
          ],
        },
      ],
    },
  ];

  const raw = scraper.normalize(richFixture);
  const events = scraper.extractEvents(raw);
  assert.equal(events.length, 1);
  const ev = events[0];

  const dc = ev.markets.find((m) => m.key === 'DOUBLE_CHANCE');
  assert.ok(dc, 'Double Chance market must exist');
  assert.deepEqual(dc.selections.map((s) => s.name), ['1X', '12', 'X2']);

  const btts = ev.markets.find((m) => m.key === 'BTTS');
  assert.ok(btts, 'Merged BTTS market must exist');
  assert.deepEqual(btts.selections.map((s) => s.name), ['Yes', 'No']);

  const dnb = ev.markets.find((m) => m.key === 'DRAW_NO_BET');
  assert.ok(dnb, 'DRAW_NO_BET market must exist');

  const ou = ev.markets.find((m) => m.key === 'OVER_UNDER' && m.line === 2.5);
  assert.ok(ou, 'OVER_UNDER 2.5 market must exist');

  const cn = ev.markets.find((m) => m.key === 'CNOU' && m.line === 9.5);
  assert.ok(cn, 'Corners Over/Under 9.5 market must exist');

  const ah = ev.markets.find((m) => m.key === 'ASIAN_HANDICAP');
  assert.ok(ah, 'Asian Handicap market must exist');
  assert.equal(ah.line, -1.5);
});
