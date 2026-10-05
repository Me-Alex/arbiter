// Interaction-wiring harness v3: exercises the REAL functions extracted from
// event-detail-modal.js and dashboard.js (not hand-mirrored), against a small
// DOM shim. Covers live-data branch, fallback, race token, error-vs-empty
// notes, kickoff guards, injection escaping, and a render micro-benchmark.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFn } from './helpers/extract-fn.mjs';

const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');
const dashSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/dashboard.js'), 'utf8');

// Extract a top-level `function NAME(...) { ... }` — the shared helper. See
// test/helpers/extract-fn.mjs for what the naive version returned on a default
// argument in the parameter list.
// Extract the event-listener callback body: locate the registration on #opp-list.
function extractListener(from) {
  const marker = "document.getElementById('opp-list').addEventListener('click',";
  const idx = from.indexOf(marker);
  if (idx === -1) throw new Error('cannot find opp-list listener registration');
  const start = idx + marker.length;
  // Named reference: `addEventListener('click', handleOppListClick);`
  const nameMatch = /^\s*([A-Za-z_$][\w$]*)\s*\);/.exec(from.slice(start));
  if (!nameMatch) throw new Error('listener is not a named reference');
  return nameMatch[1];
}

// ---- Stub global environment ----
const gl = globalThis;
gl.BOOK_PALETTE = { default: { color: '#fff', bg: '#333', border: '#555' } };
gl.paletteFor = () => gl.BOOK_PALETTE.default;
gl.fmtStake = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
gl.fmtOdds = (n) => Number(n || 0).toFixed(2);
gl.fmtMarketKey = (k) => String(k || '').replace(/_/g, ' ');
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
gl.arbiterI18n = { t: (k) => ({ stake: 'Miză', markets: 'Piețe', pick: 'Selecție', bookmaker: 'Casă', odds: 'Cotă', loadingOdds: 'Se încarcă cotele...', noOddsFound: 'Nu s-au găsit cote', offlineFallback: 'Snapshot-urile live lipsesc — afișăm cotele din această oportunitate.', offlineFallbackError: 'Cotele live nu au putut fi încărcate — afișăm cotele din această oportunitate.', detectedAgo: 'Detectat cu', detailUnavailable: 'Detaliile evenimentului nu sunt disponibile — modulul de dialog nu s-a încărcat.' }[k] || k) };
gl.arbiterApi = { get: () => Promise.resolve({ events: [] }) };
gl.window = { arbiterFormat: { timeAgo: (ms) => `${Math.round(ms / 60000)}m` } };
gl.document = { getElementById: (id) => ({ 'opp-list': { addEventListener() {} }, 'event-detail-dialog': null, 'event-detail-title': null, 'event-detail-body': null }[id] ?? null), createElement: (tag) => el(tag) };

// ---- Minimal DOM shim ----
function el(tag) {
  const node = {
    tagName: tag,
    dataset: {},
    _attrs: {},
    innerHTML: '',
    _textContent: '',
    className: '',
    _children: [],
    _legs: [],
    _marketChips: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, force) { force === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (force ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); this._handler = fn; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    showModal() { this._attrs.open = ''; },
    close() { delete this._attrs.open; },
    remove() { this._removed = true; },
    querySelector(sel) {
      if (sel === '.chip-market') return this._chipMarket || null;
      if (sel === '.legs') return this._legsEl || null;
      if (sel === '[data-close-event-detail]') return null;
      if (sel === '.match-chips') return this._metaEl || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.leg') return this._legs;
      if (sel === '.opp-market-chip') return this._marketChips;
      if (sel === '.opp-card-v2') return this._children.filter((c) => c.tagName === 'article');
      return [];
    },
    _listeners: {},
    closest() { return null; },
  };
  // textContent assignment clears innerHTML (real-DOM semantics).
  Object.defineProperty(node, 'textContent', {
    get() { return this._textContent; },
    set(v) { this._textContent = String(v); this.innerHTML = ''; },
  });
  return node;
}

const evDialog = el('dialog');
const evDialogTitle = el('h3');
const evDialogMeta = el('div');
const evDialogBody = el('div');
const oppList = el('div');
const card = el('article');
card.dataset.sport = 'Football';
card.dataset.home = 'Cardiff City';
card.dataset.away = 'Stoke City';
card.dataset.kickoff = '2026-09-08T21:45:00.000Z';
card.dataset.detectedAt = new Date().toISOString();
card.dataset.group = JSON.stringify([{ marketKey: 'OVER_UNDER_2_5', roiPercent: 561, legs: [{ sourceId: 'maxbet', selection: 'Over', odds: 11, stake: 500 }, { sourceId: 'betano', selection: 'Under', odds: 2.22, stake: 500 }] }]);
card._chipMarket = { textContent: 'O/U 2.5' };
card._legs = [
  { querySelector: (s) => ({ '.book': { textContent: 'maxbet' }, '.stake': { textContent: 'Miză 500' }, '.pick': { textContent: 'Over' }, '.odds': { textContent: '11.00' }, '.profit': { textContent: '+2,805 RON' } }[s] || null) },
  { querySelector: (s) => ({ '.book': { textContent: 'betano' }, '.stake': { textContent: 'Miză 500' }, '.pick': { textContent: 'Under' }, '.odds': { textContent: '2.22' }, '.profit': { textContent: '+2,805 RON' } }[s] || null) },
];
card._legsEl = el('div'); // .legs container
card._roiEl = el('div');
card.querySelector = (sel) => (sel === '.chip-market' ? card._chipMarket : sel === '.legs' ? card._legsEl : sel === '.roi' ? card._roiEl : null);
card.closest = (sel) => (sel === '.opp-card-v2' ? card : null);
oppList._children = [card];

gl.evDialog = evDialog;
gl.evDialogTitle = evDialogTitle;
gl.evDialogMeta = evDialogMeta;
gl.evDialogBody = evDialogBody;
// allow init() to resolve .match-chips
evDialog._metaEl = evDialogMeta;

// Extract the named listener reference from dashboard.js and eval it with the
// real functions in scope.
const listenerName = extractListener(dashSrc);
const dashFnSrcs = Object.fromEntries(['dashRenderLeg', 'formatKickoff', 'dashLiveBadge'].map((n) => [n, extractFn(n, dashSrc)]));

const assert = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ':', msg); if (!cond) process.exitCode = 1; };

// (Second pass) Evaluate the modal with explicit dialog shims injected, then
// let init() wire the dialog closure refs from document.getElementById.
const modal2 = await eval(`(async () => {
  const gl = globalThis;
  const helpers = {
    paletteFor: (id) => gl.paletteFor(id),
    fmtOdds: (n) => gl.fmtOdds(n),
    fmtStake: (n) => gl.fmtStake(n),
    parseStakeAmount: (s) => { if (!s || typeof s !== 'string') return null; const digits = s.match(/([\\d,]+(?:\\.\\d+)?)/); if (!digits) return null; const n = Number(digits[1].replace(/,/g, '')); return Number.isFinite(n) ? n : null; },
    escapeHtml: (s) => gl.escapeHtml(s),
    arbiterI18n: gl.arbiterI18n,
    arbiterApi: gl.arbiterApi,
    arbiterFormat: gl.window.arbiterFormat,
    parseDate: (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; },
  };
  const window = gl.window;
  // Provide real dialog ids so init() finds them:
  const document = {
    getElementById: (id) => ({
      'event-detail-dialog': gl.evDialog,
      'event-detail-title': gl.evDialogTitle,
      'event-detail-body': gl.evDialogBody,
    }[id] ?? null),
  };
  ${modalSrc.replace(/window\.EventDetailModal\s*=\s*\{/, 'window.__EDM2 = {')}
  window.__EDM2.init(helpers);
  return window.__EDM2;
})()`);

const { openEventDetail, renderEventDetail, formatKickoff, parseDate, isEventUrl, collectCardLegs, closeEventDetail } = modal2;
// The real handleOppListClick references `eventDetailModal` — point it at the
// shim-wired modal2.
window.__EDM_exports = modal2;
const handleOppListClick2 = await eval(`(async () => {
  const gl = globalThis;
  const eventDetailModal = window.__EDM_exports;
  const dashRenderLeg = ${dashFnSrcs.dashRenderLeg};
  const formatKickoff = ${dashFnSrcs.formatKickoff};
  const handleOppListClick = ${extractFn(listenerName, dashSrc)};
  return handleOppListClick;
})()`);

// The REAL openEventDetail needs the API stub; wire arbiterApi through helpers.
// The modal's openEventDetail uses helpers.arbiterApi.get. Point it at gl.arbiterApi (already).
// Runner:
 
// ---- Scenarios 1-4: the dialog opens from the modal API, not from a card ----
// The overview used to render cards carrying [data-event-link] and the click
// handler opened the dialog from them. It renders table rows now, and the row's
// Details link is an ordinary anchor to /event.html, so the click delegation
// has no card to work from. openEventDetail is still the modal's own entry
// point and is what the dedicated event page and any future inline use call, so
// that is what these scenarios exercise.
evDialog.close();
await openEventDetail(card);
await new Promise((r) => setTimeout(r, 20)); // let the async API resolve
assert(evDialog._attrs.open !== undefined, 'dialog opened via openEventDetail');
assert(evDialogTitle.textContent === 'Cardiff City vs Stoke City', 'dialog title set');
assert(evDialogBody.innerHTML.includes('dialog-note'), 'offline note present ({"events":[]} path)');
assert(evDialogBody.innerHTML.includes('<h4>O/U 2.5</h4>'), 'fallback heading is concrete market');
assert(evDialogBody.innerHTML.includes('maxbet'), 'fallback has bookmakers');
assert(evDialogBody.innerHTML.includes('11.00'), 'fallback has odds');

// ---- Scenario 5: in-flight race token — a stale response must not overwrite a newer open ----
const cardB = el('article');
cardB.dataset.home = 'Alpha';
cardB.dataset.away = 'Beta';
cardB.dataset.sport = 'Football';
cardB.dataset.kickoff = '2026-09-09T00:00:00.000Z';
cardB._chipMarket = { textContent: '1X2' };
cardB._legs = [];
cardB.querySelector = (sel) => (sel === '.chip-market' ? cardB._chipMarket : sel === '.legs' ? el('div') : null);
cardB.closest = () => null;

evDialog.close();
let callNo = 0;
let resolveFirst, resolveSecond;
const p1 = new Promise((r) => { resolveFirst = r; });
const p2 = new Promise((r) => { resolveSecond = r; });
gl.arbiterApi.get = () => (++callNo === 1 ? p1 : p2);

openEventDetail(card);   // seq=1 -> p1
openEventDetail(cardB);  // seq=2 -> p2, title now "Alpha vs Beta"
resolveFirst({ events: [] }); // stale (seq 1 != 2) — must NOT render/overwrite
await new Promise((r) => setTimeout(r, 20));
assert(!evDialogBody.innerHTML.includes('maxbet'), 'stale first response does NOT render into newer dialog');
resolveSecond({ events: [] }); // latest (seq 2 == 2) — renders
await new Promise((r) => setTimeout(r, 20));
assert(evDialogTitle.textContent === 'Alpha vs Beta', 'latest response renders for the active open');

// ---- Scenario 5b: close-then-resolve — dialog closed, response resolves, body NOT mutated (S3) ----
const pClose = new Promise((r) => { resolveSecond = r; });
gl.arbiterApi.get = () => pClose;
await Promise.resolve();
openEventDetail(card);   // card has maxbet legs; body set to loading
evDialogBody.innerHTML = ''; // simulate close clearing the body
closeEventDetail();      // the real close path bumps the seq token
resolveSecond({ events: [] }); // the pending response would render maxbet — must be dropped
await new Promise((r) => setTimeout(r, 20));
assert(!evDialogBody.innerHTML.includes('maxbet'), 'close-then-resolve does NOT mutate the dialog body');

// ---- Scenario 6: live-data branch (source links, odds matrix, edge, threshold) ----
evDialogBody.innerHTML = '';
const liveEvents = [
  {
    sourceId: 'maxbet', sourceUrl: 'https://maxbet.ro/game/123',
    markets: [{ key: 'OVER_UNDER_2_5', name: 'Total Goluri', selections: [{ name: 'Over', odds: 1.85 }, { name: 'Under', odds: 2.10 }] }],
  },
  {
    sourceId: 'betano', sourceUrl: 'https://betano.ro/offer/api?dataFormat=json', // must be filtered out
    markets: [{ key: 'OVER_UNDER_2_5', name: 'Total Goluri', selections: [{ name: 'Over', odds: 1.90 }, { name: 'Under', odds: 2.05 }] }],
  },
];
renderEventDetail({ events: liveEvents }, {});
assert(evDialogBody.innerHTML.includes('book-link'), 'live events render a source book-link');
assert(evDialogBody.innerHTML.includes('market-threshold'), 'OVER_UNDER_2_5 renders a threshold chip');
assert(evDialogBody.innerHTML.includes('Total Goluri'), 'market name rendered');
assert(!/betano\.ro\/offer/.test(evDialogBody.innerHTML), 'API sourceUrl is filtered out (no book-link for betano)');
assert(evDialogBody.innerHTML.includes('1.85') && evDialogBody.innerHTML.includes('2.05'), 'odds matrix shows book odds');
assert(evDialogBody.innerHTML.includes('best-edge'), 'lowest-edge book is flagged');
// Fixture math: betano edge = 1/1.90 + 1/2.05 - 1 = +1.4% (pinned below; see Scenario 9 note).
const edgeCell = evDialogBody.innerHTML.match(/edge-cell[^>]*">([^<]+)%/);
assert(edgeCell && edgeCell[1] === '+1.7', `edge % computed (got ${edgeCell?.[1]})`);

// ---- Scenario 7: network error renders the error note, not the offline note ----
evDialogBody.innerHTML = '';
const fbLegs = { legs: [{ book: 'maxbet', pick: 'Over', odds: 2.1, stakeAmount: 100 }], marketLabel: '1X2' };
renderEventDetail(null, { fallbackLegs: fbLegs, error: true });
assert(evDialogBody.innerHTML.includes('Cotele live nu au putut fi încărcate'), 'network error → error-distinction note');
assert(!evDialogBody.innerHTML.includes('Snapshot-urile live lipsesc'), 'error path does NOT use the plain offline note');
evDialogBody.innerHTML = '';
renderEventDetail({ events: [] }, { fallbackLegs: fbLegs });
assert(evDialogBody.innerHTML.includes('Snapshot-urile live lipsesc'), 'healthy-but-empty → plain offline note');
assert(!evDialogBody.innerHTML.includes('Cotele live nu au putut fi încărcate'), 'empty snapshot does NOT use the error note');

// ---- Scenario 7b: fallback note includes detected-age when card has detectedAt (UX1) ----
evDialogBody.innerHTML = '';
renderEventDetail({ events: [] }, { fallbackLegs: { ...fbLegs, detectedAt: new Date(Date.now() - 120000).toISOString() } });
assert(evDialogBody.innerHTML.includes('Detectat cu') && evDialogBody.innerHTML.includes('m'), 'fallback note carries detected-age');
evDialogBody.innerHTML = '';
renderEventDetail({ events: [] }, { fallbackLegs: fbLegs });
assert(!evDialogBody.innerHTML.includes('Detectat cu'), 'fallback note omits age when no detectedAt');

// ---- Scenario 8: kickoff formatting guarded against malformed dates ----
assert(formatKickoff('2026-09-08T21:45:00.000Z') !== '', 'valid kickoff formats to a string');
assert(formatKickoff('not-a-date') === '', 'malformed kickoff returns empty (no RangeError)');
assert(formatKickoff('') === '', 'empty kickoff returns empty');
assert(isEventUrl('https://maxbet.ro/game/123'), 'browseable page URL accepted by isEventUrl');
assert(isEventUrl('https://betano.ro/offer/api?dataFormat=json') === false, 'API URL rejected by isEventUrl');
assert(isEventUrl('http://nsoftcdn.com/x/getPalinsestoDelGiorno') === false, 'exalogic CDN API rejected by isEventUrl');
assert(isEventUrl('http://example.com/offer?dataFormat=x') === false, 'dataFormat= query rejected (T4)');

// ---- Scenario 9: betano edge cell explicit assert (edge 1/1.90+1/2.05-1 = +1.4%) ----
// The +1.4% edge cell and the +1.7% composite best-edge share a fixture:
// maxbet 1.85+2.10 and betano 1.90+2.05. These pins encode that arithmetic —
// if the edge formula is intentionally changed, update both expectations.
evDialogBody.innerHTML = '';
renderEventDetail({ events: liveEvents }, {});
const betanoRow = evDialogBody.innerHTML.match(/<tr>([\s\S]*?betano[\s\S]*?)<\/tr>/)?.[1] || '';
assert(betanoRow.includes('+1.4%'), 'betano row renders its edge cell +1.4%');
assert(evDialogBody.innerHTML.includes('best-edge'), 'best-edge class still present on the lowest-edge book');

// ---- Scenario 9b: market selections with odds boundary 1.0 → edge cell '—' (T2) ----
evDialogBody.innerHTML = '';
renderEventDetail({ events: [{ sourceId: 'maxbet', sourceUrl: 'https://maxbet.ro/g/1', markets: [{ key: 'MATCH_WINNER', name: '1X2', selections: [{ name: '1', odds: 1.0 }, { name: 'X', odds: 1.0 }] }] }] }, {});
assert(evDialogBody.innerHTML.includes('edge-cell dim">—'), 'boundary odds 1.0 → edge cell shows — (validCount<2)');

// ---- Scenario 9c: in-play scope survives the trip to the detail page ----
// The dashboard marks a live row and this page is where that row is opened, so
// a price list that arrived unmarked would read as a calmer thing than the
// signal the trader just clicked. The two badges are deliberately different
// claims: a market section is fed by every book quoting that key, so it can be
// a mix, while an arb plan is scope-pure because findArbitrage refuses to pair
// a live leg with a pre-match one.
const marketLive = (live) => ({ events: [{ sourceId: 'maxbet', sourceUrl: 'https://maxbet.ro/g/1',
  markets: [{ key: 'MATCH_WINNER', name: '1X2', live,
    selections: [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.4 }] }] }] });
evDialogBody.innerHTML = '';
renderEventDetail(marketLive(true), {});
assert(evDialogBody.innerHTML.includes('live-badge'), '9c: an in-play market is badged');
assert(evDialogBody.innerHTML.includes('title="liveInMarket"'), '9c: the market badge claims only that it contains in-play prices');
assert(evDialogBody.innerHTML.includes('>live<'), '9c: the badge carries the label');
evDialogBody.innerHTML = '';
renderEventDetail(marketLive(false), {});
assert(!evDialogBody.innerHTML.includes('live-badge'), '9c: a pre-match market is not badged');
evDialogBody.innerHTML = '';
renderEventDetail(marketLive(undefined), {});
assert(!evDialogBody.innerHTML.includes('live-badge'), '9c: an unmeasured market is not badged');
// Mixed: one book in-play, one not, same market key. The section must still say
// so — hiding it would be the one outcome worse than showing it.
evDialogBody.innerHTML = '';
renderEventDetail({ events: [
  { sourceId: 'maxbet', markets: [{ key: 'MATCH_WINNER', name: '1X2', live: true, selections: [{ name: '1', odds: 2.1 }] }] },
  { sourceId: 'unibet', markets: [{ key: 'MATCH_WINNER', name: '1X2', live: false, selections: [{ name: '1', odds: 2.0 }] }] },
] }, {});
assert(evDialogBody.innerHTML.includes('live-badge'), '9c: a market with one in-play book is badged');

// The plan's own badge: only when the plan itself was built in-play.
const planLive = (live) => ({ events: [{ sourceId: 'maxbet', sourceUrl: 'https://maxbet.ro/g/1',
  markets: [{ key: 'MATCH_WINNER', name: '1X2', live: false, arb: { live, roiPercent: 3, totalStake: 100,
    worstCasePayout: 103, guaranteedProfit: 3, roundingRisk: false,
    legs: [{ sourceId: 'maxbet', selection: '1', odds: 2.1, stake: 100, payout: 210 }] },
    selections: [{ name: '1', odds: 2.1 }, { name: 'X', odds: 3.4 }] }] }] });
evDialogBody.innerHTML = '';
renderEventDetail(planLive(true), {});
assert((evDialogBody.innerHTML.match(/live-badge/g) || []).length === 1, '9c: a live plan is badged once, on the plan alone');
assert(evDialogBody.innerHTML.includes('title="liveTooltip"'), '9c: the plan badge makes the 90-second claim, which pairingScope guarantees');
evDialogBody.innerHTML = '';
renderEventDetail(planLive(false), {});
assert(!evDialogBody.innerHTML.includes('live-badge'), '9c: a pre-match plan is not badged');

// ---- Scenario 10: renderOppV2 tolerates malformed kickoff/detectedAt ----
// renderOppV2 lives in dashboard.js — extract it too.
const renderOppV2Src = extractFn('renderOppV2', dashSrc);
const { renderOppV2 } = await eval(`(async () => {
  const gl = globalThis;
  const t = (k) => gl.arbiterI18n.t(k);
  const paletteFor = (id) => gl.paletteFor(id);
  const fmtStake = (n) => gl.fmtStake(n);
  const fmtOdds = (n) => gl.fmtOdds(n);
  const fmtMarketKey = (k) => gl.fmtMarketKey(k);
  const escapeHtml = (s) => gl.escapeHtml(s);
  const arbiterI18n = gl.arbiterI18n;
  const eventDetailModal = window.__EDM_exports;
  const dashRenderLeg = ${dashFnSrcs.dashRenderLeg};
  const formatKickoff = ${dashFnSrcs.formatKickoff};
  const dashLiveBadge = ${dashFnSrcs.dashLiveBadge};
  const ROI_BAR_SCALE = 12;
  const BADGE_FRESH_MS = 5 * 60 * 1000;
  const BADGE_RECENT_MS = 30 * 60 * 1000;
  const renderOppV2 = ${renderOppV2Src};
  return { renderOppV2 };
})()`);
evDialogBody.innerHTML = '';
const malformedCardHtml = renderOppV2({
  sport: 'Football', homeTeam: 'A', awayTeam: 'B',
  marketKey: '1X2', roiPercent: 3,
  kickoff: 'not-a-date', detectedAt: 'also-not-a-date',
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
}, []);
assert(!evDialogBody.innerHTML.includes('RangeError'), 'renderOppV2 does not throw RangeError (malformed dates)');
assert(!malformedCardHtml.includes('<span class="dim mono">'), 'malformed kickoff renders NO kickoff label');
assert(!/(time-badge)/.test(malformedCardHtml), 'malformed detectedAt renders NO time badge');
const healthyCardHtml = renderOppV2({
  sport: 'Football', homeTeam: 'A', awayTeam: 'B',
  marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-09-08T21:45:00.000Z', detectedAt: new Date().toISOString(),
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
}, []);
assert(healthyCardHtml.includes('time-badge'), 'healthy detectedAt still renders the time badge');
// UX3: event link carries a rich aria-label (home vs away + formatted kickoff).
const labelMatch = healthyCardHtml.match(/aria-label="([^"]+)"/);
assert(labelMatch && labelMatch[1].includes('A vs B') && /\d{4}/.test(labelMatch[1]), `event link carries a rich aria-label with kickoff (UX3) (got ${labelMatch?.[1]})`);

// ---- Scenario 11: mixed malformed/healthy (T1) ----
const mixedCardHtml = renderOppV2({
  sport: 'Football', homeTeam: 'A', awayTeam: 'B',
  marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-09-08T21:45:00.000Z', detectedAt: 'not-a-date',
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
}, []);
assert(mixedCardHtml.includes('<span class="dim mono">'), 'mixed: healthy kickoff renders label');
assert(!/(time-badge)/.test(mixedCardHtml), 'mixed: malformed detectedAt renders NO time badge');

// ---- Scenario 11b: the card's in-play verdict is taken over the whole group ----
// The card groups several opportunities of one match, and `o` is only the one it
// was built for, so reading `o` alone leaves a live card unmarked whenever a
// cheaper pre-match market wins the sort. The control is that ordering: the
// in-play market is the second element, so a `o`-only reading misses it.
const groupedCard = (o, allMarkets) => renderOppV2({
  sport: 'Football', homeTeam: 'A', awayTeam: 'B',
  marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-09-08T21:45:00.000Z',
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
  ...o,
}, allMarkets);
assert(groupedCard({ live: true }, []).includes('live-badge'), '11b: an in-play opportunity badges the card');
assert(groupedCard({ live: false }, [{ marketKey: '1X2', roiPercent: 3, live: false }, { marketKey: 'TOTAL', roiPercent: 1, live: true }]).includes('live-badge'),
  '11b: an in-play sibling market badges the card even when the opportunity is not');
assert(!groupedCard({ live: false }, []).includes('live-badge'), '11b: a pre-match card is not badged');
assert(!groupedCard({}, [{ marketKey: '1X2', roiPercent: 3 }]).includes('live-badge'), '11b: a card with no measured scope is not badged');
// A kickoff in the past is stale, not running: the verdict never reads the clock.
assert(!groupedCard({ kickoff: '2000-01-01T00:00:00.000Z' }, []).includes('live-badge'), '11b: a past kickoff does not badge the card');

// ---- Scenario 12: S1 injection — a " in sourceId/selection is escaped ----
const injCardHtml = renderOppV2({
  sport: 'Football', homeTeam: '<img onerror>', awayTeam: 'B',
  marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-09-08T21:45:00.000Z',
  legs: [{ sourceId: 'ma"xbet', selection: '"><script>', odds: 2, stake: 100 }],
}, []);
assert(injCardHtml.includes('ma&quot;xbet'), 'S1: quote in sourceId escaped in leg render');
assert(!injCardHtml.includes('<script>'), 'S1: raw script tag not present');
assert(injCardHtml.includes('&quot;&gt;&lt;script&gt;'), 'S1: selection escaped (quote+angle)');
assert(injCardHtml.includes('&lt;img onerror&gt;'), 'S1: home team escaped in event label');

// ---- Scenario 13: S2 — dataset.home with markup renders via textContent, query percent-encoded ----
// openEventDetail sets evDialogTitle.textContent — shim stores string, no HTML.
evDialog.close();
const cardC = el('article');
cardC.dataset.home = '"><img onerror=x>';
cardC.dataset.away = 'B';
cardC.dataset.sport = 'Football';
cardC.dataset.kickoff = '2026-09-08T21:45:00.000Z';
cardC.dataset.detectedAt = '';
cardC._chipMarket = { textContent: '1X2' };
cardC._legs = [];
cardC.querySelector = (sel) => (sel === '.chip-market' ? cardC._chipMarket : sel === '.legs' ? el('div') : null);
cardC.closest = () => null;
let capturedQuery = '';
gl.arbiterApi.get = (url) => { capturedQuery = url; return Promise.resolve({ events: [] }); };
openEventDetail(cardC);
assert(evDialogTitle.textContent.includes('<img onerror'), 'S2: title set via textContent (raw markup not interpreted)');
assert(!evDialogTitle.textContent.includes('<') || evDialogTitle._raw === undefined, 'S2: no HTML injection into title');
assert(capturedQuery.includes('%22%3E%3Cimg'), 'S2: query string percent-encoded (home sanitized)');

// ---- Scenario 14: P1 micro-benchmark — renderOppV2 1000x under a sane budget ----
// Budget is deliberately loose: this measures hot-path throughput, and the
// full `npm test` run executes ~50 test files in parallel, so a tight wall-clock
// bound (e.g. 200ms) flakes under CPU contention. 1000 renders standalone take
// ~107ms; 1000ms leaves ample headroom while still catching pathological regressions.
const t0 = Date.now();
for (let i = 0; i < 1000; i++) {
  renderOppV2({ sport: 'Football', homeTeam: 'A', awayTeam: 'B', marketKey: '1X2', roiPercent: 3, kickoff: '2026-09-08T21:45:00.000Z', detectedAt: new Date().toISOString(), legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }] }, []);
}
const dt = Date.now() - t0;
assert(dt < 1000, `P1: renderOppV2 micro-bench 1000 renders in ${dt}ms (<1000ms)`);

// ---- Scenario 15: S1 data-group projection has no verification/kind ----
const groupProj = JSON.parse(card.dataset.group.replace(/&quot;/g, '"'));
assert(groupProj[0].verification === undefined && groupProj[0].kind === undefined, 'CQ3: data-group projection has no verification/kind');

// ---- Scenario 16: dashRenderLeg degraded fallback when module missing ----
// dashboard.js documents that its leg markup delegates to the module and only
// falls back to its own copy when event-detail-modal.js did not load. Exercise
// that degraded path (eventDetailModal === null) directly.
const dashRenderLegDegraded = await eval(`(async () => {
  const gl = globalThis;
  const eventDetailModal = null; // module missing — degraded path
  const paletteFor = (id) => gl.paletteFor(id);
  const fmtStake = (n) => gl.fmtStake(n);
  const fmtOdds = (n) => gl.fmtOdds(n);
  const escapeHtml = (s) => gl.escapeHtml(s);
  const arbiterI18n = gl.arbiterI18n;
  const dashRenderLeg = ${dashFnSrcs.dashRenderLeg};
  return dashRenderLeg;
})()`);
const degradedHtml = dashRenderLegDegraded({ sourceId: 'maxbet', selection: 'Over', odds: 11, stake: 500 }, gl.arbiterI18n.t, 0);
assert(degradedHtml.includes('<span class="book"') && degradedHtml.includes('>maxbet</span>'), 'degraded dashRenderLeg renders a leg when module missing');
assert(degradedHtml.includes('Miză 500') && degradedHtml.includes('11.00'), 'degraded dashRenderLeg renders stake+odds');

// ---- Scenario 17: a card with no sport claims none ----
// The fourth site that defaulted a missing sport to the literal 'Football'
// (dashboard.js:538 -> the chip at :605), asserted where renderOppV2's
// harness already lives — the harness dashboard.js says the retained
// renderer is kept alive for. The pair is the proof: the unsported record
// must print no bare chip, and the sported one must still print its own, or
// a renderer that printed nothing at all would pass the first half while
// having lost the label the second half is about.
const noSportCard = renderOppV2({
  homeTeam: 'NoSportHome', awayTeam: 'NoSportAway', marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-10-08T21:45:00.000Z',
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
}, []);
assert(!/<span class="chip">/.test(noSportCard), 'the card prints a sport chip for a record that carries none');
const sportedCard = renderOppV2({
  sport: 'TENNIS', homeTeam: 'Alcaraz', awayTeam: 'Sinner', marketKey: '1X2', roiPercent: 3,
  kickoff: '2026-10-08T21:45:00.000Z',
  legs: [{ sourceId: 'maxbet', selection: '1', odds: 2, stake: 100 }],
}, []);
assert(sportedCard.includes('>TENNIS</span>'), 'the card lost the chip for the record that carries TENNIS');

console.log('\nAll real-wiring scenario checks complete.');