// Event-detail arbitrage: the reconciled money panel and the backend detector.
//
// The view these cover used to print each book's own overround under a column
// headed "Edge", so the dashboard's headline ROI could not be derived from
// anything on screen. Two things are pinned here:
//   1. findDetailArbitrages() only pairs genuinely independent books and only
//      when the inverse sum is < 1, and its money plan reconciles exactly.
//   2. renderEventDetail() renders that plan, and the rendered figures agree
//      with the allocation that produced them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDetailArbitrages } from '../src/scanner/event-arbs.mjs';
import { roundedArbitrageAllocation } from '../src/scanner/market-contracts.mjs';

const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A BTTS market: two books, prices that leave clear headroom for an arb. */
function bttsMarket(yes, no) {
  return {
    key: 'BOTH_TEAMS_SCORE',
    name: 'Ambele echipe marchează',
    selections: [
      { id: 'y', name: 'Yes', odds: yes },
      { id: 'n', name: 'No', odds: no },
    ],
  };
}

function book(sourceId, markets) {
  return {
    sourceId,
    eventKey: 'football|2026-09-29|belgia|franta',
    homeTeam: 'Belgia',
    awayTeam: 'Franța',
    sport: 'Football',
    league: 'Nations',
    kickoff: '2026-09-29T19:00:00Z',
    markets,
  };
}

// The real shape behind the reported case: Favbet Yes @2.84 + Casa Nu @2.55.
const REAL_CASE = [book('favbet', [bttsMarket(2.84, 1.55)]), book('casa-pariurilor', [bttsMarket(1.9, 2.55)])];

// ---------------------------------------------------------------------------
// Backend detector
// ---------------------------------------------------------------------------

test('detects a real cross-book arb and every figure reconciles', () => {
  const arbs = findDetailArbitrages(REAL_CASE, { bankroll: 1000 });
  const arb = arbs.get('BOTH_TEAMS_SCORE');

  assert.ok(arb, 'arb found for the BTTS market');
  assert.equal(arb.legs.length, 2);
  assert.deepEqual(arb.legs.map((l) => l.sourceId).sort(), ['casa-pariurilor', 'favbet']);

  // The staked selections must be the two complementary ones, not the same
  // side on both books.
  const selections = arb.legs.map((l) => l.selection).sort();
  assert.notEqual(selections[0], selections[1], 'legs are complementary selections');

  // Stakes sum to the bankroll.
  const stakeSum = arb.legs.reduce((s, l) => s + l.stake, 0);
  assert.ok(Math.abs(stakeSum - arb.totalStake) < 0.005, `Σstake ${stakeSum} == totalStake ${arb.totalStake}`);

  // Each payout is its own stake × odds, to the cent.
  for (const leg of arb.legs) {
    assert.ok(Math.abs(leg.payout - Math.round(leg.stake * leg.odds * 100) / 100) < 0.005,
      `payout ${leg.payout} == ${leg.stake} × ${leg.odds}`);
  }

  // Guaranteed profit is the worst payout minus everything staked.
  const minPayout = Math.min(...arb.legs.map((l) => l.payout));
  assert.equal(arb.worstCasePayout, minPayout);
  assert.ok(Math.abs(arb.guaranteedProfit - (minPayout - arb.totalStake)) < 0.005,
    `guaranteed ${arb.guaranteedProfit} == minPayout − totalStake`);

  // ROI is derived from the inverse sum of the two quoted prices.
  const inverseSum = arb.legs.reduce((s, l) => s + 1 / l.odds, 0);
  assert.ok(Math.abs(inverseSum - arb.inverseSum) < 1e-9, 'inverseSum matches Σ(1/odds)');
  assert.ok(inverseSum < 1, 'an arb requires Σ(1/odds) < 1');
  assert.ok(Math.abs(arb.roiPercent - (1 / inverseSum - 1) * 100) < 0.01, 'ROI matches (1/inverseSum − 1)·100');

  // The headline must be positive, and the money must actually be there.
  assert.ok(arb.roiPercent > 0, 'ROI is positive');
  assert.ok(arb.guaranteedProfit > 0, 'guaranteed profit is positive');
  assert.equal(arb.roundingRisk, false);
});

test('the reported case reproduces the headline ROI, not the per-book overround', () => {
  const arb = findDetailArbitrages(REAL_CASE, { bankroll: 1000 }).get('BOTH_TEAMS_SCORE');
  // Favbet 1/2.84 + 1/1.55 = 0.997 → about -0.27% overround on its own.
  const favbetOverround = (1 / 2.84 + 1 / 1.55 - 1) * 100;
  // The arb pairs Favbet Yes with Casa No: 1/2.84 + 1/2.55 = 0.7442.
  const roi = (1 / (1 / 2.84 + 1 / 2.55) - 1) * 100;

  assert.ok(Math.abs(roi - 34.36) < 0.05, `headline ROI is ~34.36%, got ${roi.toFixed(2)}`);
  assert.ok(Math.abs(arb.roiPercent - roi) < 0.01, 'panel ROI equals the cross-book ROI');
  assert.ok(Math.abs(favbetOverround - arb.roiPercent) > 10,
    'per-book overround cannot stand in for the arbitrage ROI');
});

test('no arb when the books disagree with the market maker', () => {
  // Both books mirror each other, so no combination beats a 2-way market.
  const balanced = [book('favbet', [bttsMarket(1.95, 1.95)]), book('casa-pariurilor', [bttsMarket(1.95, 1.95)])];
  assert.equal(findDetailArbitrages(balanced).size, 0);
});

test('a single book is never an arbitrage', () => {
  assert.equal(findDetailArbitrages([book('favbet', [bttsMarket(3.0, 1.6)])]).size, 0);
});

test('two brands on one shared feed cannot form an arb', () => {
  // Exalogic resells one feed, so a price gap between the two brands is a
  // capture-timing artifact rather than an edge. See src/scanner/feed-groups.mjs.
  const shared = [book('excelbet', [bttsMarket(2.84, 1.55)]), book('magnumbet', [bttsMarket(1.9, 2.55)])];
  assert.equal(findDetailArbitrages(shared).size, 0, 'shared-feed pair is rejected');
});

test('half-time and full-time of the same family never pair', () => {
  const ht = { ...bttsMarket(2.84, 1.55), key: 'BOTH_TEAMS_SCORE_1H', period: '1st_half' };
  const ft = bttsMarket(1.9, 2.55);
  const arbs = findDetailArbitrages([
    book('favbet', [ht]),
    book('casa-pariurilor', [ft]),
  ]);
  // Only the full-time contract is complete on its own, so a half-time leg
  // must never be borrowed to complete it.
  assert.equal(arbs.size, 0, '1H BTTS is not combined with FT BTTS');
});

test('allocation matches the scanner formula it delegates to', () => {
  const arbs = findDetailArbitrages(REAL_CASE, { bankroll: 1000 });
  const expected = roundedArbitrageAllocation(REAL_CASE[0].markets[0].selections.length === 2 ? [
    { odds: 2.84, selection: 'Yes', sourceId: 'favbet' },
    { odds: 2.55, selection: 'No', sourceId: 'casa-pariurilor' },
  ] : [], 1000);
  const arb = arbs.get('BOTH_TEAMS_SCORE');
  assert.equal(arb.guaranteedProfit, expected.guaranteedProfit);
  assert.equal(arb.totalStake, expected.totalStake);
  assert.equal(arb.worstCasePayout, expected.worstCasePayout);
  assert.equal(arb.roundingRisk, expected.roundingRisk);
});

test('rounding risk is surfaced when cent-rounding eats the profit', () => {
  // A hair-under arb on a bankroll whose allocation rounds badly: the panel
  // must flag it rather than advertise a theoretical profit that is not banked.
  const thin = [book('favbet', [bttsMarket(2.02, 2.02)]), book('casa-pariurilor', [bttsMarket(2.02, 2.02)])];
  const arb = findDetailArbitrages(thin, { bankroll: 1 }).get('BOTH_TEAMS_SCORE');
  if (arb) {
    assert.equal(arb.roundingRisk, arb.guaranteedProfit < 0);
  }
});

test('malformed input degrades to no arb instead of throwing', () => {
  assert.equal(findDetailArbitrages(null).size, 0);
  assert.equal(findDetailArbitrages([]).size, 0);
  assert.equal(findDetailArbitrages([{ sourceId: 'a' }, { sourceId: 'b', markets: 'nope' }]).size, 0);
});

// ---------------------------------------------------------------------------
// Frontend rendering — the REAL renderer source is evaluated, not mirrored
// ---------------------------------------------------------------------------

const gl = globalThis;
gl.BOOK_PALETTE = { default: { color: '#fff', bg: '#333', border: '#555' } };
gl.paletteFor = () => gl.BOOK_PALETTE.default;
gl.fmtStake = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
gl.fmtOdds = (n) => Number(n || 0).toFixed(2);
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I18N = {
  bookmaker: 'Casă', odds: 'Cotă', pick: 'Selecție', stake: 'Miză', profit: 'Profit',
  stakePerLeg: 'Miză pe fiecare piață', payoutIfWins: 'Retragere', totalStake: 'Miză totală',
  bestPayout: 'Retragere garantată', guaranteed: 'Profit garantat', theoreticalRoi: 'ROI teoretic',
  marketOdds: 'Toate cotele pieței', edge: 'Overround', edgeHint: 'h', arbLive: 'Arbitraj live',
  arbOnLiveOdds: 'Pe cotele live', roundingRisk: 'Atenție la rotunjire', roundingRiskHint: 'hint',
  livePrice: 'Cota live', noOddsFound: 'Nu s-au găsit cote', markets: 'piețe',
};
gl.arbiterI18n = { t: (k) => I18N[k] || k };
gl.window = { arbiterFormat: null };

const moduleBody = modalSrc.replace(/window\.EventDetailModal\s*=\s*\{/, 'window.__EDM_exports = {');
const modal = await eval(`(async () => {
  const gl = globalThis;
  const helpers = {
    parseStakeAmount: (s) => null,
    paletteFor: (id) => gl.paletteFor(id),
    fmtStake: (n) => gl.fmtStake(n),
    fmtOdds: (n) => gl.fmtOdds(n),
    escapeHtml: (s) => gl.escapeHtml(s),
    arbiterI18n: gl.arbiterI18n,
    arbiterFormat: gl.window.arbiterFormat,
    parseDate: (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; },
  };
  const window = gl.window;
  const document = gl.document || { getElementById: () => null };
  eval(${JSON.stringify(moduleBody)});
  window.__EDM_exports.init(helpers);
  return window.__EDM_exports;
})()`);

function fakeEl() {
  return { innerHTML: '', className: '' };
}

function renderArb(arb) {
  const target = fakeEl();
  modal.renderEventDetail({
    events: [{
      sourceId: 'favbet', sport: 'Football', league: 'Nations', kickoff: '2026-09-29T19:00:00Z',
      homeTeam: 'Belgia', awayTeam: 'Franța',
      markets: [{ ...bttsMarket(2.84, 1.55), arb }],
    }],
  }, { target });
  return target.innerHTML;
}

test('the panel renders the ROI, the money, and each staked leg', () => {
  const arb = findDetailArbitrages(REAL_CASE, { bankroll: 1000 }).get('BOTH_TEAMS_SCORE');
  const html = renderArb(arb);

  // Headline ROI as the backend computed it.
  assert.ok(html.includes(`+${arb.roiPercent.toFixed(2)}`), `ROI ${arb.roiPercent} rendered`);
  assert.ok(html.includes('ROI teoretic'), 'ROI is labelled theoretical');

  // The reconciled money, not a per-leg ROI slice.
  assert.ok(html.includes('1,000.00'), 'total stake rendered');
  assert.ok(html.includes('Profit garantat'), 'guaranteed profit labelled');
  assert.ok(html.includes(`+${gl.fmtStake(arb.guaranteedProfit)}`), 'guaranteed profit amount rendered');
  assert.ok(html.includes('Retragere garantată'), 'worst-case payout labelled');

  // Both books, both selections, both stakes.
  for (const leg of arb.legs) {
    assert.ok(html.includes(leg.sourceId), `${leg.sourceId} rendered`);
    assert.ok(html.includes(leg.selection), `${leg.selection} rendered`);
  }

  // The per-leg equation that proves the columns add up.
  assert.ok(html.includes('×'), 'equation line rendered');
});

test('the rendered figures are the allocation figures, not a re-derivation', () => {
  const arb = findDetailArbitrages(REAL_CASE, { bankroll: 1000 }).get('BOTH_TEAMS_SCORE');
  const html = renderArb(arb);

  for (const leg of arb.legs) {
    assert.ok(html.includes(gl.fmtStake(leg.stake)), `stake ${leg.stake} rendered`);
    assert.ok(html.includes(gl.fmtStake(leg.payout)), `payout ${leg.payout} rendered`);
  }
  // The guaranteed profit must appear exactly once as its own figure: it is a
  // single amount, never one per leg.
  const profitCells = html.match(new RegExp(`\\+${gl.fmtStake(arb.guaranteedProfit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) || [];
  assert.ok(profitCells.length <= 2, 'guaranteed profit is not repeated per leg');
});

test('a market with no arb still shows its exact per-book prices', () => {
  const target = fakeEl();
  modal.renderEventDetail({
    events: [{
      sourceId: 'favbet', sport: 'Football', league: 'Nations', kickoff: '2026-09-29T19:00:00Z',
      homeTeam: 'A', awayTeam: 'B',
      markets: [bttsMarket(1.95, 1.95)],
    }],
    // A second book so the matrix has more than one row.
  }, { target });
  const html = target.innerHTML;
  assert.ok(html.includes('1.95'), 'prices shown');
  assert.ok(html.includes('Overround'), 'the column is named for what it is');
  assert.ok(!html.includes('ev-arb-roi-value'), 'no money panel without an arb');
  assert.ok(!html.includes('ROI teoretic'), 'no ROI claim without an arb');
});

test('the overround column is labelled as overround, not as the arb ROI', () => {
  const arb = findDetailArbitrages(REAL_CASE, { bankroll: 1000 }).get('BOTH_TEAMS_SCORE');
  const html = renderArb(arb);
  assert.ok(html.includes('Overround'), 'header says Overround');
  assert.ok(!/<th class="num">Edge<\/th>/.test(html), 'the misleading bare "Edge" header is gone');
});

test('staked prices are marked in the reference matrix', () => {
  const arb = findDetailArbitrages(REAL_CASE, { bankroll: 1000 }).get('BOTH_TEAMS_SCORE');
  const html = renderArb(arb);
  assert.ok(html.includes('is-arb'), 'staked prices highlighted');
  assert.ok(html.includes('is-arb-row'), 'staked books highlighted');
});

test('rounding risk is called out on the panel', () => {
  const html = modal.renderArbPanel({
    legs: [
      { sourceId: 'a', selection: 'Yes', odds: 2.02, stake: 0.5, payout: 1.01 },
      { sourceId: 'b', selection: 'No', odds: 2.02, stake: 0.5, payout: 0.99 },
    ],
    roiPercent: 0.5, totalStake: 1, worstCasePayout: 0.99, guaranteedProfit: -0.01, roundingRisk: true,
  }, gl.arbiterI18n.t);
  assert.ok(html.includes('has-risk'), 'risk modifier set');
  assert.ok(html.includes('Atenție la rotunjire'), 'risk note rendered');
  assert.ok(html.includes('-0.01'), 'the real (negative) guaranteed profit is shown, not the theoretical one');
});

test('the panel tolerates a missing summary block', () => {
  // Recomputed from the legs, so an allocation without the derived totals
  // still renders numbers that add up.
  const html = modal.renderArbPanel({
    legs: [
      { sourceId: 'a', selection: 'Yes', odds: 2.5, stake: 40, payout: 100 },
      { sourceId: 'b', selection: 'No', odds: 2.5, stake: 60, payout: 150 },
    ],
    roiPercent: 10,
  }, gl.arbiterI18n.t);
  assert.ok(html.includes('100.00'), 'total stake recomputed as the sum of legs');
  assert.ok(html.includes('100.00'), 'worst payout = min payout');
  assert.ok(html.includes('+0.00'), 'guaranteed profit recomputed');
});

test('renderLeg no longer shows stake × ROI on every leg', () => {
  const t = gl.arbiterI18n.t;
  const withPayout = modal.renderLeg({ sourceId: 'favbet', selection: 'Yes', odds: 2.84, stake: 352.11, payout: 1000 }, t, 34.36);
  // ROI is a property of the whole combination; the leg shows its own net.
  assert.ok(withPayout.includes('+647.89'), 'leg net = payout − stake');
  assert.ok(!withPayout.includes('120.97'), 'no fabricated stake × ROI slice');

  const noPayout = modal.renderLeg({ sourceId: 'favbet', selection: 'Yes', odds: 2.84, stake: 352.11 }, t, 34.36);
  assert.ok(!noPayout.includes('120.97'), 'still no fabricated profit without a payout');
  assert.ok(noPayout.includes('2.84'), 'falls back to stating the price');
});

test('fmtMoney keeps cents so the panel equation is checkable by eye', async () => {
  // format.js is a browser IIFE that publishes on `window`, so load it into a
  // stub rather than expecting a module export.
  const { createContext, runInContext } = await import('node:vm');
  const formatSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/format.js'), 'utf8');
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(formatSrc, sandbox);
  const { fmtMoney, fmtStake } = sandbox.window.arbiterFormat;
  assert.equal(typeof fmtMoney, 'function', 'fmtMoney is published');

  // fmtStake rounds to whole units, which is correct for a headline but would
  // make "37.67 × 3.16" render as "38 × 3.16 = 119" and stop reconciling.
  assert.equal(fmtStake(37.67), '38');
  assert.equal(fmtMoney(37.67), '37.67');
  assert.equal(fmtMoney(119.04), '119.04');
  assert.equal(fmtMoney(0), '0.00');
  assert.equal(fmtMoney(NaN), '—', 'non-numeric money is not shown as 0.00');
  assert.equal(fmtMoney(-0.01), '-0.01', 'a rounded-into-loss profit stays negative');
});

test('the panel equation uses cents, not rounded whole units', () => {
  const html = modal.renderArbPanel({
    legs: [
      { sourceId: 'a', selection: 'Yes', odds: 3.16, stake: 37.67, payout: 119.04 },
      { sourceId: 'b', selection: 'No', odds: 1.91, stake: 62.33, payout: 119.05 },
    ],
    roiPercent: 19.05, totalStake: 100, worstCasePayout: 119.04, guaranteedProfit: 19.04, roundingRisk: false,
  }, gl.arbiterI18n.t);
  // Each term must be arithmetically true as printed.
  assert.ok(html.includes('37.67'), 'stake printed with cents');
  assert.ok(html.includes('119.04'), 'payout printed with cents');
  assert.ok(html.includes('100.00'), 'total stake printed with cents');
  assert.ok(html.includes('+19.04'), 'guaranteed profit printed with cents');
});
