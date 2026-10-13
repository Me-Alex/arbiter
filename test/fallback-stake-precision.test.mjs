// The offline fallback view must show the same stake the live view shows.
//
// `collectCardLegs` scrapes a rendered card back into an object and
// `buildFallbackFromLegs` renders it again when /api/event-detail fails. That
// round trip is the only place a stake is re-formatted from a value that was
// already correct, and it used fmtStake (whole units) while `renderArbPanel`
// used fmtMoney (cents kept). At a 2,500 bankroll on the published 3-leg
// arbitrage that made the offline card read 1,721 + 432 + 348 = 2,501 under a
// stated 2,500 — the same reconciliation failure the card itself had, moved one
// layer downstream.
//
// Unlike event-detail-fallback.test.mjs, this harness supplies the REAL
// fmtMoney from public/js/format.js. Without it the modal's
// `helpers.fmtMoney || helpers.fmtStake` guard quietly degrades to fmtStake and
// the file would pass against the broken code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFn } from './helpers/extract-fn.mjs';
import { patternsSrc, fnSrc as predicateSrc } from './helpers/event-url-gate.mjs';

const dashSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/dashboard.js'), 'utf8');
const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');
const fmtSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/format.js'), 'utf8');

const gl = globalThis;
gl.BOOK_PALETTE = [{ color: '#fff', bg: '#333', border: '#555' }];
gl.paletteFor = () => gl.BOOK_PALETTE[0];
gl.fmtOdds = (n) => Number(n || 0).toFixed(2);
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
gl.arbiterI18n = { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă' }[k] || k) };

// Both money formatters, straight out of the production source.
gl.fmtStake = eval(`(${extractFn('fmtStake', fmtSrc)})`);
gl.fmtMoney = eval(`(${extractFn('fmtMoney', fmtSrc)})`);

const wrapWithHelpers = (fnSrc) => `(function() {
  ${patternsSrc}
  ${predicateSrc}
  const helpers = {
    parseStakeAmount: ${extractFn('parseStakeAmount', dashSrc)},
    paletteFor: (id) => globalThis.paletteFor(id),
    fmtStake: (n) => globalThis.fmtStake(n),
    fmtMoney: (n) => globalThis.fmtMoney(n),
    fmtOdds: (n) => globalThis.fmtOdds(n),
    escapeHtml: (s) => globalThis.escapeHtml(s),
    arbiterI18n: globalThis.arbiterI18n,
  };
  return (${fnSrc});
})()`;

const collectCardLegs = eval(wrapWithHelpers(extractFn('collectCardLegs', modalSrc)));
const buildFallbackFromLegs = eval(wrapWithHelpers(extractFn('buildFallbackFromLegs', modalSrc)));

const assert = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ':', msg); if (!cond) process.exitCode = 1; };

// `fakeCard` mirrors event-detail-fallback.test.mjs: a minimal element whose
// querySelector returns an object carrying textContent for one class.
function fakeCard(legsHtml, marketLabel) {
  return {
    querySelector: (s) => (s === '.chip-market' ? { textContent: marketLabel } : null),
    querySelectorAll: (sel) => {
      if (sel !== '.leg') return [];
      return legsHtml.map((h) => {
        const textOf = (cls) => {
          const m = h.match(new RegExp(`class="${cls}"[^>]*>([^<]*)<`));
          return m ? m[1] : '';
        };
        return {
          querySelector: (s) => {
            const cls = s.slice(1);
            const txt = textOf(cls);
            return txt !== '' ? { textContent: txt } : null;
          },
        };
      });
    },
  };
}

// The stakes arbitrage.js legRow() writes for the published 3-leg arbitrage at a
// 2,500 bankroll (data/latest-scan.json, opportunities[0], published total
// 1,000 -> scale 2.5), after the residual is folded into the largest leg.
const BANKROLL = 2500;
const CARD = [
  { book: 'baumbet', stake: '1,720.80', pick: 'Over', odds: '2.05' },
  { book: 'excelbet', stake: '431.55', pick: 'Over', odds: '4.68' },
  { book: 'excelbet', stake: '347.65', pick: 'Under', odds: '5.72' },
];
const legsHtml = CARD.map((l) => `<div class="leg"><span class="book">${l.book}</span><span class="stake">${l.stake}</span><span class="pick">${l.pick}</span><span class="odds">${l.odds}</span><span class="profit">+36 RON</span></div>`);

const snap = collectCardLegs(fakeCard(legsHtml, 'O/U 2.5'));
assert(!!snap && snap.legs.length === 3, 'scrapes all three legs off the card');
assert(snap.legs[0].stakeAmount === 1720.8, `stakeAmount keeps cents (${snap.legs[0].stakeAmount})`);

const html = buildFallbackFromLegs(snap).sections.join('');

// Pull the stake numbers back out of the rendered markup, keeping the printed
// text so precision can be asserted on what the user actually sees.
const printed = [...html.matchAll(/Miză ([\d,]+(?:\.\d+)?)/g)].map((m) => m[1]);
const shown = printed.map((s) => Number(s.replace(/,/g, '')));
assert(printed.length === 3, `three stakes rendered (got ${printed.length})`);
assert(
  printed.every((s) => /^\d[\d,]*\.\d{2}$/.test(s)),
  `every leg is printed at cent precision (got ${JSON.stringify(printed)})`,
);

const sum = Math.round(shown.reduce((a, b) => a + b, 0) * 100) / 100;
assert(sum === BANKROLL, `legs sum to the stated bankroll (${sum.toLocaleString('en-US', { minimumFractionDigits: 2 })} vs ${BANKROLL.toFixed(2)})`);

// The live view and the offline view must not disagree about the same card.
assert(gl.fmtMoney(snap.legs[0].stakeAmount) === gl.fmtStake(snap.legs[0].stakeAmount)
  ? 'probe value is whole-unit (test would not detect the bug)'
  : 'probe value genuinely exercises the cent/whole-unit difference', 'sanity');

for (const l of snap.legs) {
  assert(html.includes(`Miză ${gl.fmtMoney(l.stakeAmount)}`), `offline view matches live view for ${l.book} (${gl.fmtMoney(l.stakeAmount)})`);
}

// The guard must still work when a caller supplies no fmtMoney (older harnesses).
const noMoney = eval(`(() => {
  ${patternsSrc}
  ${predicateSrc}
  const helpers = {
    parseStakeAmount: ${extractFn('parseStakeAmount', dashSrc)},
    paletteFor: (id) => globalThis.paletteFor(id),
    fmtStake: (n) => globalThis.fmtStake(n),
    fmtOdds: (n) => globalThis.fmtOdds(n),
    escapeHtml: (s) => globalThis.escapeHtml(s),
    arbiterI18n: globalThis.arbiterI18n,
  };
  return (${extractFn('buildFallbackFromLegs', modalSrc)});
})()`);
assert(noMoney(snap).sections.join('').length > 0, 'renders without fmtMoney rather than throwing');
assert(!noMoney(snap).sections.join('').includes('undefined'), 'no fmtMoney guard does not print undefined');

// A stake the card could not express still falls back to the raw label.
const nullStake = buildFallbackFromLegs([{ book: 'x', stakeLabel: 'Miză ???', stakeAmount: null, pick: 'P', odds: null, profit: '' }]).sections.join('');
assert(nullStake.includes('Miză ???'), 'null stakeAmount still falls back to stakeLabel');

console.log('\nAll checks complete.');