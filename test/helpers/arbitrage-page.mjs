/**
 * The arbitrage console as the browser drives it: the script runs, fetches
 * resolve, `render` draws, and the sidebar controls re-render through the
 * page's own listener stack.
 *
 * Modelled on test/helpers/scanner-page.mjs and deliberately kept to the same
 * shape — one harness per page, shared by every test that needs to drive that
 * page, rather than a per-test copy of the vm context that drifts from the
 * first one and starts passing on a page the other is failing.
 *
 * Why this harness exists at all: the bankroll control was decorative. A
 * `replan()` sat fully written and fully documented in the page while nothing
 * called it, so typing a working stake changed one label in the masthead and
 * nothing an operator would actually place. The defect was invisible to every
 * test in the tree, because every one of them either read the source or called
 * a render function directly. Only dispatching the real `input` event finds it.
 *
 * Two globals are set the way test/scan-fields-census.test.mjs sets them:
 *
 *   arbiterFormat: null   — the console formats through locals precisely so it
 *                           can be read with the shared formatter absent. If it
 *                           ever reaches for window.arbiterFormat at load time,
 *                           this harness fails to construct instead of the page
 *                           failing quietly in a browser where it does exist.
 *   arbiterI18n            — the real public/js/i18n.js, not a stub dictionary,
 *                           because a page can read a key that exists and still
 *                           render it wrong.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { codeOnly } from './code-only.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const pageSource = read('public/js/pages/arbitrage.js');
const pageHtml = read('public/admin/arbitrage.html');
const i18nSource = read('public/js/i18n.js');

export const escapeHtml = (v) => String(v ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Every id the page ships markup for, read out of the markup rather than
 * listed here.
 *
 * The page asks the document for seventeen elements and the markup answers all
 * seventeen — but that was measured, not designed. A control that exists in the
 * script and not in the page is a control that throws on load, and the failure
 * mode is the worst kind: an exception in an IIFE stops every listener after
 * it from ever being attached, so the half of the page below the missing node
 * is simply dead with nothing in the console to point at it.
 */
export const DECLARED_IDS = new Set(
  [...codeOnly(pageHtml, false).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
);

/** The ids the page reaches for, read out of the source rather than pinned. */
export const REQUESTED_IDS = [...new Set(
  [...pageSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
)];

/**
 * The segmented signal buttons, as the markup ships them: one node per
 * `data-signal`, so a test can click "Arbs" the way the operator does instead
 * of assigning to state that only exists inside the closure.
 */
export const SIGNALS = [...codeOnly(pageHtml, false)
  .matchAll(/<button\b[^>]*\bdata-signal="([^"]+)"/g)].map((m) => m[1]);

export const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
  offsetWidth: 0,
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
  fire(type) { for (const fn of this._listeners[type] || []) fn({ target: this }); },
  setAttribute(name, value) { this[`attr:${name}`] = value; },
  getAttribute(name) { return `attr:${name}` in this ? this[`attr:${name}`] : null; },
  querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
});

export const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A `/api/scan` answer with one opportunity and one middle in it, built from the
 * values a real driven scan published: a three-way 1x2 arbitrage (baumbet /
 * excelbet / excelbet) and a two-way TOTAL_GOALS middle (favbet / admiral).
 *
 * The three-leg case is not decoration. Two of the three real opportunities
 * carry three legs, and a Dutch split across three books is where the page's
 * "the legs still sum to the total on the same card" promise is easiest to
 * break — two legs have one rounding residual between them, three have two.
 */
export const OPPORTUNITY = {
  type: 'arb',
  sport: 'Football',
  league: 'Superliga',
  kickoff: '2026-10-09T17:00:00.000Z',
  homeTeam: 'FCSB',
  awayTeam: 'Craiova',
  marketKey: '1x2',
  marginPercent: 0.12,
  totalStake: 1000,
  worstCasePayout: 1001.2,
  guaranteedProfit: 1.2,
  inverseSum: 0.9987769017090979,
  legs: [
    { sourceId: 'baumbet', selection: '1', outcome: 'home', odds: 1.4546, stake: 688.32 },
    { sourceId: 'excelbet', selection: 'X', outcome: 'draw', odds: 5.8, stake: 172.62 },
    { sourceId: 'excelbet', selection: '2', outcome: 'away', odds: 7.2, stake: 139.06 },
  ],
};

export const MIDDLE = {
  type: 'middle',
  arb: true,
  sport: 'Football',
  league: 'Superliga',
  kickoff: '2026-10-09T19:30:00.000Z',
  homeTeam: 'Rapid',
  awayTeam: 'Dinamo',
  marketKey: 'TOTAL_GOALS',
  family: 'TOTAL_GOALS',
  line: 1.5,
  roiPercent: 215,
  riskPercent: 20,
  marginPercent: 68.75,
  totalStake: 1000,
  guaranteedProfit: 193.65,
  legs: [
    { sourceId: 'favbet', selection: 'Over 1.5', side: 'over', odds: 1.6, stake: 746.03 },
    { sourceId: 'admiral', selection: 'Sub 2.5', side: 'under', odds: 4.7, stake: 253.97 },
  ],
};

export const SCAN = {
  scrapedAt: '2026-10-08T22:20:37.153Z',
  scanStartedAt: '2026-10-08T22:05:11.000Z',
  eventCount: 11133,
  dataHealth: { status: 'fresh' },
  opportunities: [OPPORTUNITY],
  middles: [MIDDLE],
  positiveEv: [],
  lowHold: [],
  sources: [{ sourceId: 'baumbet' }, { sourceId: 'excelbet' }, { sourceId: 'favbet' }, { sourceId: 'admiral' }],
};

/**
 * Loads the page and returns the handles a test drives it through.
 *
 * `scan` is merged over the default rather than replacing it, so a test can
 * pass one real row from a driven workspace instead of restating the shape of
 * every family — and so a missing family renders as the empty state instead of
 * as a TypeError that would fail the test for the wrong reason.
 */
export function page({ scan = {}, wait = settle } = {}) {
  const store = {};
  const byId = new Map();
  const bySelector = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node());
    return byId.get(id);
  };
  const select = (selector) => {
    if (!bySelector.has(selector)) bySelector.set(selector, node());
    return bySelector.get(selector);
  };
  const signalButtons = SIGNALS.map((signal) => {
    const btn = node();
    btn.dataset.signal = signal;
    btn.setAttribute('aria-pressed', String(signal === 'all'));
    return btn;
  });

  const context = {
    document: {
      getElementById: get,
      querySelector: select,
      querySelectorAll: (selector) => (selector === '.segmented button' ? signalButtons : []),
      addEventListener() {},
    },
    escapeHtml,
    // Browser globals, not ECMAScript ones: runInNewContext starts from
    // ECMAScript alone, and this page reads URLSearchParams (eventLink and the
    // export button), Date (the capture-age line) and setTimeout (the SSE
    // debounce).
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    arbiterApp: { mount() {} },
    arbiterSse: { connect() {} },
    // i18n.js reads the operator's language choice on load, so this is not
    // optional scaffolding: without it the real i18n source throws before the
    // page is ever evaluated, and the failure looks like a broken harness.
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    arbiterApi: {
      async get(path) {
        if (path === '/api/scan') return { ...SCAN, ...scan };
        return {};
      },
      async post() { return {}; },
    },
  };
  context.window = {
    arbiterConnectionStatus: { setDataHealth() {} },
    location: { href: '' },
  };
  // Set to null on purpose, as the field census sets it. See the file header.
  context.arbiterFormat = null;

  vm.runInNewContext(i18nSource, context);
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(pageSource, context);

  return { context, get, select, signalButtons };
}

/**
 * The leg stakes off a rendered card, paired with the odds beside them.
 *
 * Keyed on the odds rather than on any class name. `odds()` formats to exactly
 * two decimals on every leg of every card, so `@1.45 688` is a contract the
 * formatter already makes, while a class list is decoration that a restyle is
 * free to change — and a test that breaks when someone tidies the CSS teaches
 * the next person to restyle the CSS less.
 *
 * The em dash is matched as a stake value rather than skipped. A leg whose
 * stake is null renders `\u2014`, and silently dropping that position would
 * shift every later leg one slot left, so a test summing the returned stakes
 * would add up the wrong books and call it a passing card.
 *
 * @returns {{odds:number, stakeText:string, stake:number|null}[]}
 */
export function cardLegs(el) {
  const text = String(el.innerHTML || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&middot;/g, '.')
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
  const legs = [];
  for (const m of text.matchAll(/@(\d+(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?|\u2014)/g)) {
    const stakeText = m[2];
    legs.push({
      odds: Number(m[1]),
      stakeText,
      stake: stakeText === '\u2014' ? null : Number(stakeText.replace(/,/g, '')),
    });
  }
  return legs;
}