// Integration-style test for the event-link feature.
// Verifies that per-event sourceUrl flows correctly through the engine to the
// event-detail-modal, covering every bookmaker that emits browseable URLs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..');

// Denylist from event-detail-modal.js
const API_PATTERNS = [
  /nsoftcdn\.com/, /nsoft\.com/, /\/api\//, /\/api2\//,
  /getPalinsestoDelGiorno/, /\?companyUuid=/, /offerTemplate=/, /dataFormat=/,
  /freetls\.fastly\.net/, /efortuna\.ro\/offer/, /sportify\.bet/,
  /gambling-solutions\.ro/, /service\/lineout/,
];

function isBrowseableEventUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  return !API_PATTERNS.some((re) => re.test(url));
}

const modalSrc = readFileSync(join(ROOT, 'public/js/pages/event-detail-modal.js'), 'utf8');

// Extract isEventUrl via brace matching.
function extractFn(name, from = modalSrc) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(from);
  if (!m) throw new Error('cannot find function ' + name);
  const idx = m.index;
  let depth = 0;
  let i = from.indexOf('{', idx);
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return from.slice(idx, i + 1);
}

// Extract isEventUrl + its dependency via brace matching.
function extractConst(name, from = modalSrc) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[`);
  const m = re.exec(from);
  if (!m) throw new Error('cannot find const ' + name);
  let depth = 0;
  let i = from.indexOf('[', m.index);
  if (i === -1) throw new Error('no open bracket for ' + name);
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  // include the semicolon
  return from.slice(m.index, i + 2);
}

const apiPatternsSrc = extractConst('API_URL_PATTERNS', modalSrc);
const isEventUrlSrc = `${apiPatternsSrc}\n${extractFn('isEventUrl', modalSrc)}\nreturn isEventUrl;`;
const isEventUrl = new Function(isEventUrlSrc)();

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
        assert.ok(isBrowseableEventUrl(l.eventUrl), `leg ${l.sourceId} eventUrl must be browseable`);
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

describe('event-detail-modal fallback rendering', () => {
  const makeHelpers = () => ({
    paletteFor: () => ({ color: '#fff', bg: '#333', border: '#555' }),
    fmtStake: (n) => String(n || 0),
    fmtOdds: (n) => String(n || 0),
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    parseStakeAmount: (s) => { if (!s || typeof s !== 'string') return null; const digits = s.match(/([\d,]+(?:\.\d+)?)/); if (!digits) return null; const n = Number(digits[1].replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
    arbiterI18n: { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă', noBookmakersSelected: 'Niciuna' }[k] || k) },
  });

  it('buildFallbackFromLegs includes link icons when eventUrl present', () => {
    const fnSrc = `${extractFn('buildFallbackFromLegs', modalSrc)}\nreturn buildFallbackFromLegs;`;
    const buildFallbackFromLegs = new Function('helpers', fnSrc)(makeHelpers());

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
    const fnSrc = `${extractFn('buildFallbackFromLegs', modalSrc)}\nreturn buildFallbackFromLegs;`;
    const buildFallbackFromLegs = new Function('helpers', fnSrc)(makeHelpers());
    const snap = { marketLabel: 'Test', legs: [{ book: 'm', odds: 2, pick: 'X', stakeAmount: 100, profit: '+50 RON', eventUrl: null }] };
    const { sections } = buildFallbackFromLegs(snap);
    assert.ok(!sections.join('').includes('book-link'), 'no link icon when no eventUrl');
  });
});
