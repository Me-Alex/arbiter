// Integration-style test for the event-link feature.
// Verifies that per-event sourceUrl flows correctly through the engine to the
// event-detail-modal, covering every bookmaker that emits browseable URLs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFn } from './helpers/extract-fn.mjs';

const ROOT = join(import.meta.dirname, '..');

// Shared denylist from src/shared/event-url.mjs
import { isEventUrl } from '../src/shared/event-url.mjs';

const modalSrc = readFileSync(join(ROOT, 'public/js/pages/event-detail-modal.js'), 'utf8');

// Extract functions — the shared helper. See test/helpers/extract-fn.mjs.
// ── Denylist correctness ────────────────────────────────────────────────

describe('isEventUrl denylist', () => {
  const browseable = [
    'https://www.maxbet.ro/ro/pariuri-sportive/eveniment/10413685',
    'https://ro.betano.com/cote/toronto-fc-nashville-sc/87691502/',
    'https://superbet.ro/pariuri-sportive/eveniment/12065411',
    'https://sport.netbet.ro/fotbal/1-30711781',
    'https://excelbet.ro/sport/eveniment/74095670',
    'https://efortuna.ro/pariuri-online/fotbal/meci/test/12345',
    'https://www.favbet.ro/ro/sports/event/fotbal/12345/',
    'https://winner.ro/pariuri-sportive/eveniment/12345',
    'https://stanleybet.ro/eveniment/12345',
    'https://www.admiral.ro/ro/sport/eveniment/12345',
    'https://magnumbet.ro/sport/eveniment/12345',
    'https://lasvegas.ro/sport/eveniment/12345',
    'https://winboss.ro/sport/eveniment/12345',
  ];
  for (const url of browseable) {
    it(`accepts ${new URL(url).hostname}`, () => {
      assert.equal(isEventUrl(url), true, `should be browseable: ${url}`);
    });
  }

  const notBrowseable = [
    'https://sports-sm-distribution-api.de-2.nsoftcdn.com/api/v1/events?companyUuid=abc',
    'https://production-superbet-offer-ro.freetls.fastly.net/v3/ro-RO/events',
    'https://api.sportify.bet/api/content/inventory-events?sport=fotbal',
    'https://exalogic.excelbet.ro/XSportDatastore/getPalinsestoDelGiorno',
    'https://api.efortuna.ro/offer/bff/graphql',
    'https://gambling-solutions.ro/some/path',
    'ftp://example.com/event/123',
    '',
    null,
  ];
  for (const url of notBrowseable) {
    it(`rejects ${String(url).slice(0, 60)}`, () => {
      assert.equal(isEventUrl(url), false, `should be rejected: ${url}`);
    });
  }
});

// ── Engine: eventUrl flows through arb legs ─────────────────────────────

describe('engine eventUrl propagation', () => {
  it('arb legs carry per-event sourceUrl', async () => {
    const { findArbitrage } = await import('../src/scanner/engine.mjs');
    const grouped = new Map();
    grouped.set('test|evt|home|away', [
      {
        sourceId: 'maxbet', sport: 'football', league: 'L',
        kickoff: '2030-01-01T18:00:00.000Z', homeTeam: 'Home', awayTeam: 'Away',
        eventKey: 'test|evt|home|away',
        sourceUrl: 'https://www.maxbet.ro/ro/pariuri-sportive/eveniment/100',
        markets: [{ key: 'MATCH_ODDS', name: 'Match Odds', selections: [
          { name: '1', odds: 2.5, group: 'Main' }, { name: 'X', odds: 3.0 }, { name: '2', odds: 2.6 },
        ]}],
      },
      {
        sourceId: 'betano', sport: 'football', league: 'L',
        kickoff: '2030-01-01T18:00:00.000Z', homeTeam: 'Home', awayTeam: 'Away',
        eventKey: 'test|evt|home|away',
        sourceUrl: 'https://ro.betano.com/cote/home-away/200/',
        markets: [{ key: 'MATCH_ODDS', name: 'Match Odds', selections: [
          { name: '1', odds: 1.3, group: 'Main' }, { name: 'X', odds: 4.5 }, { name: '2', odds: 5.0 },
        ]}],
      },
    ]);

    const arbs = findArbitrage(grouped, { minRoiPercent: 0 });
    assert.ok(arbs.length >= 1, 'expected an arb');
    for (const a of arbs) {
      for (const l of a.legs) {
        assert.ok(l.eventUrl, `leg ${l.sourceId} must have eventUrl`);
        assert.ok(isEventUrl(l.eventUrl), `leg ${l.sourceId} eventUrl must be browseable`);
      }
    }
  });

  it('middle legs carry per-event sourceUrl', async () => {
    const { findMiddles } = await import('../src/scanner/engine.mjs');
    const grouped = new Map();
    grouped.set('test|evt|home|away', [
      {
        sourceId: 'maxbet', sport: 'football', league: 'L',
        kickoff: '2030-01-01T18:00:00.000Z', homeTeam: 'Home', awayTeam: 'Away',
        eventKey: 'test|evt|home|away',
        sourceUrl: 'https://www.maxbet.ro/ro/pariuri-sportive/eveniment/100',
        markets: [{ key: 'OVER_UNDER_2_5', name: 'O/U 2.5', selections: [
          { name: 'Over', odds: 1.8, handicap: 2.5 }, { name: 'Under', odds: 2.0, handicap: 2.5 },
        ]}],
      },
      {
        sourceId: 'betano', sport: 'football', league: 'L',
        kickoff: '2030-01-01T18:00:00.000Z', homeTeam: 'Home', awayTeam: 'Away',
        eventKey: 'test|evt|home|away',
        sourceUrl: 'https://ro.betano.com/cote/home-away/200/',
        markets: [{ key: 'OVER_UNDER_3_5', name: 'O/U 3.5', selections: [
          { name: 'Over', odds: 2.2, handicap: 3.5 }, { name: 'Under', odds: 1.7, handicap: 3.5 },
        ]}],
      },
    ]);

    const middles = findMiddles(grouped, { maxMiddleRiskPercent: 100, minMiddleRoiPercent: 0 });
    for (const m of middles) {
      for (const l of m.legs) {
        assert.ok(l.eventUrl, `middle leg ${l.sourceId} must have eventUrl`);
      }
    }
  });
});

// ── Modal fallback renders links from leg.eventUrl ──────────────────────

// `buildFallbackFromLegs` asks `isEventUrl` before it renders a leg link, so an
// extraction that left the predicate out failed with a ReferenceError instead of
// testing anything. The gate comes out of the modal's own source rather than
// being passed in from the import above: that import is what the denylist
// describe block pins, while the modal keeps its own copy of the denylist, and
// handing this the shared one would let the two drift with these tests agreeing
// with each other.
const gateFrom = modalSrc.indexOf('const API_URL_PATTERNS = [');
if (gateFrom === -1) throw new Error('event-detail-modal.js no longer declares API_URL_PATTERNS');
const gateTo = modalSrc.indexOf('];', gateFrom);
if (gateTo === -1) throw new Error('API_URL_PATTERNS is declared but never closed');
const GATE_SRC = modalSrc.slice(gateFrom, gateTo + 2);

const makeHelpers = () => ({
  paletteFor: () => ({ color: '#fff', bg: '#333', border: '#555' }),
  fmtStake: (n) => String(n || 0),
  fmtOdds: (n) => String(n || 0),
  escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  parseStakeAmount: (s) => { if (!s || typeof s !== 'string') return null; const digits = s.match(/([\d,]+(?:\.\d+)?)/); if (!digits) return null; const n = Number(digits[1].replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
  arbiterI18n: { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă', noBookmakersSelected: 'Niciuna' }[k] || k) },
});

const loadFallback = () => new Function('helpers',
  `${GATE_SRC}\n${extractFn('isEventUrl', modalSrc)}\n${extractFn('buildFallbackFromLegs', modalSrc)}\nreturn buildFallbackFromLegs;`)(makeHelpers());

describe('event-detail-modal fallback rendering', () => {
  it('buildFallbackFromLegs includes link icons when eventUrl present', () => {
    const buildFallbackFromLegs = loadFallback();

    const snap = {
      marketLabel: 'O/U 2.5',
      legs: [
        { book: 'maxbet', odds: 10.0, pick: 'Over', stakeAmount: 500, profit: '+2,513 RON', eventUrl: 'https://www.maxbet.ro/ro/pariuri-sportive/eveniment/10413685' },
        { book: 'betano', odds: 2.05, pick: 'Under', stakeAmount: 500, profit: '+2,513 RON', eventUrl: 'https://ro.betano.com/cote/al-nassr-abha/87691502/' },
      ],
    };
    const { sections } = buildFallbackFromLegs(snap);
    assert.ok(sections.length > 0, 'should produce fallback sections');
    const html = sections.join('');
    assert.ok(html.includes('https://www.maxbet.ro/ro/pariuri-sportive/eveniment/10413685'), 'maxbet link present');
    assert.ok(html.includes('https://ro.betano.com/cote/al-nassr-abha/87691502/'), 'betano link present');
    assert.ok(html.includes('book-link'), 'link icon markup present');
  });

  it('buildFallbackFromLegs omits link when eventUrl absent', () => {
    const buildFallbackFromLegs = loadFallback();
    const snap = { marketLabel: 'Test', legs: [{ book: 'm', odds: 2, pick: 'X', stakeAmount: 100, profit: '+50 RON', eventUrl: null }] };
    const { sections } = buildFallbackFromLegs(snap);
    assert.ok(!sections.join('').includes('book-link'), 'no link icon when no eventUrl');
  });

  // The absence above proves nothing on its own: a URL that is simply missing and
  // a URL that is present but is the feed endpoint the capture was pulled from
  // both have to end in no link icon. Only the second one is the regression — of
  // the adapters that publish a URL at all, most publish the endpoint, so a
  // truthiness check renders a link icon that opens JSON.
  it('buildFallbackFromLegs omits the link for an API URL that is present', () => {
    const buildFallbackFromLegs = loadFallback();
    const apiUrl = 'https://www.favbet.ro/service/lineout/getAllEvents';
    const withIt = { marketLabel: 'Test', legs: [{ book: 'favbet', odds: 2, pick: 'X', stakeAmount: 100, profit: '+50 RON', eventUrl: apiUrl }] };
    assert.ok(withIt.legs[0].eventUrl, 'the leg really does carry a URL — the gate has to be what drops it');
    const html = buildFallbackFromLegs(withIt).sections.join('');
    assert.ok(!html.includes('book-link'), 'the feed endpoint is present and still gets no link icon');
    assert.ok(!html.includes(apiUrl), 'and it is not in the markup at all');
    // Both directions, or the assertion above cannot say which way the gate
    // fails. The same function, the same leg, a browseable URL: the icon returns.
    const browseable = 'https://www.favbet.ro/ro/sports/event/fotbal/12345/';
    const ok = buildFallbackFromLegs({ ...withIt, legs: [{ ...withIt.legs[0], eventUrl: browseable }] }).sections.join('');
    assert.ok(ok.includes('book-link'), 'a browseable URL still gets its link icon');
  });
});
