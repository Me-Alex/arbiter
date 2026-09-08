// Deterministic end-to-end: collectCardLegs -> renderEventDetail({"events":[]}, {target}) -> fallback.
// The REAL module source is evaluated once (its IIFE registers
// window.__EDM_exports), so renderEventDetail keeps its real closure deps
// (buildFallbackFromLegs, helpers, race token). The decoupled opts.target lets
// us render without init()/DOM. No function is re-implemented here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');

const gl = globalThis;
gl.BOOK_PALETTE = { default: { color: '#fff', bg: '#333', border: '#555' } };
gl.paletteFor = () => gl.BOOK_PALETTE.default;
gl.fmtStake = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
gl.fmtOdds = (n) => Number(n || 0).toFixed(2);
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
gl.arbiterI18n = { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă', loadingOdds: 'Se încarcă cotele...', noOddsFound: 'Nu s-au găsit cote', offlineFallback: 'Snapshot-urile live lipsesc — afișăm cotele din această oportunitate.' }[k] || k) };
gl.window = { arbiterFormat: null };

// ---- Evaluate the REAL module once, exposing its exports ----
// The module source is embedded via a normal-quoted string (JSON.stringify) so
// its backticks/${} don't collide with any template literal.
const moduleBody = modalSrc.replace(/window\.EventDetailModal\s*=\s*\{/, 'window.__EDM_exports = {');
const modal = await eval(`(async () => {
  const gl = globalThis;
  const helpers = {
    parseStakeAmount: (s) => { if (!s || typeof s !== 'string') return null; const digits = s.match(/([\\d,]+(?:\\.\\d+)?)/); if (!digits) return null; const n = Number(digits[1].replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
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
  // init() wires the module's internal helpers; with a no-op document the
  // dialog refs stay null, which is fine since renderEventDetail uses opts.target.
  window.__EDM_exports.init(helpers);
  return window.__EDM_exports;
})()`);

const { collectCardLegs, renderEventDetail } = modal;

// ---- Minimal fake element (supports innerHTML/className as a real node) ----
function fakeEl(tag, children = {}) {
  const node = {
    tagName: tag,
    innerHTML: '',
    className: '',
    dataset: children.dataset || {},
    _text: '',
    _bySelector: children.bySelector || {},
    _legs: children.legs || [],
    querySelector(sel) { return this._bySelector[sel] || null; },
    querySelectorAll(sel) { return this._legs; },
  };
  // textContent assignment clears innerHTML (real-DOM semantics).
  Object.defineProperty(node, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this.innerHTML = ''; },
  });
  return node;
}

function makeCard() {
  const chipMarket = { textContent: 'O/U 2.5' };
  const mkLeg = (labels) => ({ querySelector: (s) => labels[s] || null });
  const leg1 = mkLeg({ '.book': { textContent: 'maxbet' }, '.stake': { textContent: 'Miză 500' }, '.pick': { textContent: 'Over' }, '.odds': { textContent: '11.00' }, '.profit': { textContent: '+2,805 RON' } });
  const leg2 = mkLeg({ '.book': { textContent: 'betano' }, '.stake': { textContent: 'Miză 500' }, '.pick': { textContent: 'Under' }, '.odds': { textContent: '2.22' }, '.profit': { textContent: '+2,805 RON' } });
  return fakeEl('article', { bySelector: { '.chip-market': chipMarket }, legs: [leg1, leg2] });
}

const card = makeCard();

// ---- Snapshot the card legs via the REAL collectCardLegs ----
const legsSnapshot = collectCardLegs(card);
if (!legsSnapshot) throw new Error('collectCardLegs returned null for a card with legs');

// ---- Call the REAL renderEventDetail with the API's empty response into an explicit target ----
const shimBody = fakeEl('div');
renderEventDetail({ events: [] }, { fallbackLegs: legsSnapshot, target: shimBody });

// ---- Assert ----
const assert = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ':', msg); if (!cond) process.exitCode = 1; };

const bodyHtml = shimBody.innerHTML;
assert(bodyHtml !== 'Se încarcă cotele...', 'body is NOT stuck on Loading');
assert(bodyHtml.includes('<h4>O/U 2.5</h4>'), 'body has concrete market heading O/U 2.5');
assert(bodyHtml.includes('maxbet') && bodyHtml.includes('betano'), 'body has bookmakers');
assert(bodyHtml.includes('11.00') && bodyHtml.includes('2.22'), 'body has odds');
assert(bodyHtml.includes('Miză 500'), 'body has stakes');
assert(bodyHtml.includes('Over') && bodyHtml.includes('Under'), 'body has picks');
assert(bodyHtml.includes('dialog-note'), 'fallback path renders the offline note');
assert(!bodyHtml.includes('Piețe'), 'body has no generic markets heading');
assert(shimBody.className === 'dialog-body', 'target element got the dialog-body class');

console.log('\n--- rendered body (first 400 chars) ---');
console.log(bodyHtml.slice(0, 400));
console.log('\nAll render path checks complete.');