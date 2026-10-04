import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFn } from './helpers/extract-fn.mjs';

const dashSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/dashboard.js'), 'utf8');
const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');

const gl = globalThis;
gl.BOOK_PALETTE = [{ color: '#fff', bg: '#333', border: '#555' }];
gl.paletteFor = () => gl.BOOK_PALETTE[0];
gl.fmtStake = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
gl.fmtOdds = (n) => Number(n || 0).toFixed(2);
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
gl.arbiterI18n = { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă' }[k] || k) };

const helpers = {
  parseStakeAmount: (s) => { if (!s || typeof s !== 'string') return null; const digits = s.match(/([\d,]+(?:\.\d+)?)/); if (!digits) return null; const n = Number(digits[1].replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
  paletteFor: gl.paletteFor,
  fmtStake: gl.fmtStake,
  fmtOdds: gl.fmtOdds,
  escapeHtml: gl.escapeHtml,
  arbiterI18n: gl.arbiterI18n,
};

// The modal's functions reference the module-local `helpers` DI object. Wrap
// each extracted function so it closes over a `helpers` object built from the
// real parseStakeAmount source (dashboard.js) and the global shims.
//
// `isEventUrl` and the denylist it closes over come along for the same reason:
// `buildFallbackFromLegs` asks the predicate before it renders a leg link, so an
// extraction that left it out failed with a ReferenceError instead of testing
// anything. Both are taken from the modal's own source rather than from
// src/shared/event-url.mjs on purpose — that file declares itself the single
// source of truth, and the modal keeps a copy, so injecting the shared one would
// let the two drift with this file silently agreeing with itself.
// A plain `throw`, not the local `assert` below: this runs during module setup,
// long before that helper exists, and an extraction that silently yielded an
// empty slice would hand the wrapper a predicate with no denylist — every URL
// passing it, which is the answer this file would then report as a finding.
const patternsFrom = modalSrc.indexOf('const API_URL_PATTERNS = [');
if (patternsFrom === -1) throw new Error('the modal no longer declares API_URL_PATTERNS');
const patternsTo = modalSrc.indexOf('];', patternsFrom);
if (patternsTo === -1) throw new Error('API_URL_PATTERNS is declared but never closed');
const patternsSrc = modalSrc.slice(patternsFrom, patternsTo + 2);
const wrapWithHelpers = (fnSrc) => `(function() {
  ${patternsSrc}
  ${extractFn('isEventUrl', modalSrc)}
  const helpers = {
    parseStakeAmount: ${extractFn('parseStakeAmount', dashSrc)},
    paletteFor: (id) => globalThis.paletteFor(id),
    fmtStake: (n) => globalThis.fmtStake(n),
    fmtOdds: (n) => globalThis.fmtOdds(n),
    escapeHtml: (s) => globalThis.escapeHtml(s),
    arbiterI18n: globalThis.arbiterI18n,
  };
  return (${fnSrc});
})()`;

const parseStakeAmount = eval('(' + extractFn('parseStakeAmount', dashSrc) + ')');
const collectCardLegs = eval(wrapWithHelpers(extractFn('collectCardLegs', modalSrc)));
const buildFallbackFromLegs = eval(wrapWithHelpers(extractFn('buildFallbackFromLegs', modalSrc)));

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
            const txt = cls === 'odds' ? textOf('odds') : textOf(cls);
            return txt !== null ? { textContent: txt } : null;
          },
        };
      });
    },
  };
}

const legsHtml = [
  '<div class="leg"><span class="book">maxbet</span><span class="stake">Miză 500</span><span class="pick">Over</span><span class="odds">11.00</span><span class="profit">+2,805 RON</span></div>',
  '<div class="leg"><span class="book">betano</span><span class="stake">Miză 500</span><span class="pick">Under</span><span class="odds">2.22</span><span class="profit">+2,805 RON</span></div>',
];
const snap = collectCardLegs(fakeCard(legsHtml, 'O/U 2.5'));
const assert = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ':', msg); if (!cond) process.exitCode = 1; };

assert(snap && Array.isArray(snap.legs) && snap.legs.length === 2, 'snapshot shape { legs, marketLabel }');
assert(snap.marketLabel === 'O/U 2.5', 'snapshot.marketLabel captured');
assert(snap.legs[0].stakeAmount === 500 && snap.legs[0].odds === 11, 'leg parsing numeric');

const { sections } = buildFallbackFromLegs(snap);
const html = sections.join('');
assert(html.includes('<h4>O/U 2.5</h4>'), 'heading is market label O/U 2.5');
assert(!html.includes('<h4>Piețe</h4>'), 'heading NOT generic');
assert((html.match(/Miz\u0103 500/g) || []).length === 2, 'stake exactly twice, no dup');
assert(html.includes('11.00') && html.includes('2.22'), 'odds rendered');
assert(html.includes('>Over<') && html.includes('>Under<'), 'picks rendered');
assert(html.includes('+2,805 RON'), 'profit rendered');
assert(html.includes('maxbet') && html.includes('betano'), 'bookmaker names rendered');

// Back-compat bare array
const { sections: s2 } = buildFallbackFromLegs([{ book: 'x', stakeLabel: 'Miză ???', stakeAmount: null, pick: 'P', odds: null, profit: '' }]);
const h2 = s2.join('');
assert(h2.includes('Miză ???'), 'back-compat bare array works');
assert(h2.includes('—') , 'null odds em dash');
assert(h2.includes('<h4>Piețe</h4>'), 'bare array falls back to generic market heading');

assert(buildFallbackFromLegs([]).sections.length === 0, 'empty snapshot -> no sections');
assert(buildFallbackFromLegs(null).sections.length === 0, 'null snapshot -> no sections');
assert(collectCardLegs(null) === null, 'null card -> null');
assert(collectCardLegs({ querySelector: () => null, querySelectorAll: () => [] }) === null, 'card with no legs -> null');

console.log('\nAll checks complete.');
