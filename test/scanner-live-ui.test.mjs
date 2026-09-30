import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * The scanner page's in-play handling.
 *
 * The engine can publish a `live` flag that nothing renders, and it can accept an
 * `includeLive` request that no control ever sends. Both happened here: the
 * preview posted `includeLive: false` unconditionally, so a run that collected
 * in-play prices showed none of them, and no table distinguished a price that
 * expires in 90 seconds from one that does not. Neither is catchable from the
 * engine tests, so the page is loaded into a bare `vm` context with a fake DOM
 * and driven the way a user drives it.
 */

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('public/js/pages/scanner.js');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The AI page, loaded whole. It renders one card per confirmed opportunity, so
 * it is the last surface where a live price could be shown next to a pre-match
 * one with nothing to tell them apart.
 */
function aiPage() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
    return nodes.get(id);
  };
  const context = {
    document: { getElementById: get },
    window: { arbiterConnectionStatus: null },
    escapeHtml,
    arbiterApp: { mount() {} },
    arbiterI18n: { lang: 'en', t: key => key },
    arbiterApi: { async get() { return { dataHealth: {}, opportunities: [] }; } },
    arbiterSse: { connect() {} },
  };
  vm.runInNewContext(read('public/js/pages/ai.js'), context);
  return { context, get };
}

/** The badge on its own: it is the one piece of live logic with no DOM around it. */
function badge() {
  const context = { escapeHtml, arbiterI18n: { lang: 'en', t: key => key } };
  vm.createContext(context);
  const start = source.indexOf('function liveBadge(');
  vm.runInContext(source.slice(start, source.indexOf('async function init()', start)), context);
  return context.liveBadge;
}

/**
 * The whole page script, wired to a DOM small enough to stay honest.
 *
 * `querySelector` results are cached per selector, because that is the only way
 * to read back the markup the page wrote: `render` fills table bodies it looks
 * up by selector, and a stub that answered a fresh node each time would let a
 * completely broken renderer pass.
 */
function page({ liveChecked = false, post = EMPTY_SCAN } = {}) {
  const node = () => ({
    textContent: '', innerHTML: '', className: '', value: '', hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute() { return 'false'; },
    querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
  });
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
  let posted = null;
  const context = {
    document: { getElementById: get, querySelector: select, querySelectorAll: () => [], addEventListener() {} },
    window: { arbiterConnectionStatus: null, arbiterApp: { mount() {} } },
    escapeHtml,
    console,
    createDropdown() {},
    arbiterSse: { connect() {} },
    arbiterI18n: { lang: 'en', t: key => key },
    arbiterApi: {
      async get() { return { profiles: [], sports: [] }; },
      async post(url, body) { posted = body; return post; },
    },
  };
  vm.runInNewContext(source, context);
  get('inc-live').checked = liveChecked;
  return { context, get, select, posted: () => posted };
}

const EMPTY_SCAN = {
  dataHealth: { status: 'empty', actionableSourceCount: 0 },
  sources: [], eventCount: 0, opportunities: [], middles: [], positiveEv: [], lowHold: [],
};

const SCAN = {
  dataHealth: { status: 'fresh', actionableSourceCount: 2 },
  sources: [], scanStartedAt: '2026-10-01T10:00:00.000Z', eventCount: 4,
  opportunities: [
    { sport: 'Football', homeTeam: 'A', awayTeam: 'B', marketKey: 'MATCH_ODDS', roiPercent: 4, legs: [], live: true },
    { sport: 'Football', homeTeam: 'C', awayTeam: 'D', marketKey: 'MATCH_ODDS', roiPercent: 3, legs: [], live: false },
  ],
  middles: [
    { sport: 'Football', homeTeam: 'E', awayTeam: 'F', marketKey: 'TOTAL', roiPercent: 30, riskPercent: 2, legs: [], live: true },
  ],
  positiveEv: [
    { sport: 'Football', eventKey: 'football|liga|2026-10-01|G|H|1', marketKey: 'TOTAL', selection: 'Over', sourceId: 'unibet', odds: 3, evPercent: 12, legs: [{}], live: true },
    { sport: 'Football', eventKey: 'football|liga|2026-10-01|I|J|2', marketKey: 'TOTAL', selection: 'Under', sourceId: 'unibet', odds: 3, evPercent: 11, legs: [{}], live: false },
  ],
  lowHold: [],
};

test('the badge reads the signal flag, never the clock', () => {
  const t = key => key;
  assert.match(badge()(t, { live: true }), /chip red live-badge/, 'a live signal is badged');
  // A pre-match price whose kickoff has passed is stale, not running. The badge
  // takes the signal's own flag and nothing else, so it cannot drift onto one.
  assert.equal(badge()(t, { live: false, kickoff: '2020-01-01T00:00:00Z' }), '');
  assert.equal(badge()(t, { live: 'true' }), '', 'the string is not the boolean');
  assert.equal(badge()(t, {}), '');
  assert.equal(badge()(t, null), '');
});

test('the preview asks for in-play prices only when the box is ticked', async () => {
  const off = page({ liveChecked: false });
  await off.context.previewScan();
  assert.equal(off.posted().includeLive, false, 'an unticked box asks for a pre-match preview');

  const on = page({ liveChecked: true });
  await on.context.previewScan();
  assert.equal(on.posted().includeLive, true, 'and a ticked one asks for the in-play prices it collected');
  // The flag is a request for in-play prices, not a sweep of finished matches.
  assert.equal(on.posted().includePast, false);
});

test('the in-play counter and the badge agree with the rows on screen', async () => {
  const { context, get, select } = page({ post: SCAN });
  await context.init();
  context.render(SCAN);

  // One per in-play signal, across all three tables — an in-play middle expires
  // exactly like an in-play arbitrage, so counting only arbitrages would
  // understate the perishable money on screen.
  assert.equal(get('live-count').textContent, '3');
  assert.equal(get('live-count').className, 'text-red');

  const arb = select('#arb-table tbody').innerHTML;
  const mid = select('#mid-table tbody').innerHTML;
  const ev = select('#ev-table tbody').innerHTML;
  assert.equal((arb.match(/live-badge/g) || []).length, 1, 'only the live arbitrage is badged');
  assert.equal((mid.match(/live-badge/g) || []).length, 1, 'and the live middle too');
  assert.equal((ev.match(/live-badge/g) || []).length, 1, 'and the live +EV row');

  // A scan with nothing in play says zero rather than leaving the previous
  // run's number on screen.
  context.render(EMPTY_SCAN);
  assert.equal(get('live-count').textContent, '0');
  assert.equal(get('live-count').className, '');
});

test('the page carries the controls its own code drives', () => {
  // A control that is not on the page cannot be ticked, and a page control with
  // no handler is decoration. Either would leave `includeLive` permanently false
  // while every assertion above still passed.
  const markup = read('public/admin/scanner.html');
  assert.match(markup, /id="inc-live"/);
  assert.match(markup, /data-i18n="includeLive"/);
  assert.match(markup, /id="live-count"/);
  // Every i18n key the page's live strings need, in both languages.
  const i18n = read('public/js/i18n.js');
  for (const key of ['includeLive', 'liveSignals', 'liveSignalsNote', 'liveTooltip', 'livePreviewNote', 'live', 'liveInMarket']) {
    const uses = (i18n.match(new RegExp(`^\\s*${key}:`, 'gm')) || []).length;
    assert.equal(uses, 2, `${key} is translated in both languages`);
  }
});

/**
 * The badge is emitted on several pages, so its rule cannot live in one page's
 * own stylesheet. It sat in scanner.css, which public/index.html does not load,
 * so the dashboard rendered an unstyled span — invisible in the sense that
 * matters, since a trader learns within a day to ignore a mark with no weight.
 *
 * The assertion is reachability, not placement: for each page whose script emits
 * the badge, at least one stylesheet that page actually links must define it.
 */
test('every page that renders the badge also loads the rule for it', () => {
  const stylesheetsOf = html => [...read(html).matchAll(/<link[^>]+href="\/css\/([^"]+)"/g)].map(m => m[1]);
  const emitsBadge = script => read(script).includes('live-badge');
  const pages = [
    { html: 'public/admin/scanner.html', script: 'public/js/pages/scanner.js' },
    { html: 'public/index.html', script: 'public/js/pages/dashboard.js' },
    // The dashboard opens the event-detail dialog from the same page, and
    // /event.html loads the same modal standalone, so both must reach the rule.
    { html: 'public/index.html', script: 'public/js/pages/event-detail-modal.js' },
    { html: 'public/event.html', script: 'public/js/pages/event-detail-modal.js' },
    { html: 'public/admin/ai.html', script: 'public/js/pages/ai.js' },
  ];
  for (const { html, script } of pages.filter(p => emitsBadge(p.script))) {
    const sheets = stylesheetsOf(html);
    assert.ok(sheets.length > 0, `${html} links at least one stylesheet`);
    // A real selector, not a substring: `.live-badge-RENAMED {` contains the
    // text `.live-badge` and would sail past a plain includes(), which is
    // exactly the shape of a rule that stops matching the markup.
    const defines = new RegExp(`(^|[^\\w-])\\.live-badge\\s*\\{`, 'm');
    const styled = sheets.filter(sheet => defines.test(read(`public/css/${sheet}`)));
    assert.ok(styled.length > 0, `${html} renders the badge but loads no stylesheet defining .live-badge (links: ${sheets.join(', ')})`);
  }
});

test('the AI page marks an in-play opportunity and leaves the others alone', () => {
  const { context, get } = aiPage();
  const card = (live) => ({ sport: 'Football', homeTeam: 'A', awayTeam: 'B', marketKey: 'MATCH_ODDS', roiPercent: 3, live,
    verification: { status: 'confirmed' } });
  const render = (opps) => {
    context.renderInsights({ opportunities: opps });
    return get('ai-insights').innerHTML;
  };
  const badges = (html) => (html.match(/live-badge/g) || []).length;

  const mixed = render([card(true), card(false)]);
  assert.equal(badges(mixed), 1, 'only the in-play card is badged');
  assert.match(mixed, /class="chip red live-badge"/);
  assert.match(mixed, /title="liveTooltip"/);

  // The page already filters to verified opportunities, so an unverified card is
  // not rendered at all and must not contribute a badge either.
  const unverified = render([{ ...card(true), verification: { status: 'pending' } }]);
  assert.equal(badges(unverified), 0, 'an unverified card is not rendered at all');

  const prematch = render([card(false)]);
  assert.equal(badges(prematch), 0, 'a pre-match card is not badged');

  const unmeasured = render([{ marketKey: 'MATCH_ODDS', verification: { status: 'confirmed' } }]);
  assert.equal(badges(unmeasured), 0, 'a card with no measured scope is not badged');

  // A kickoff in the past is stale, not running: the verdict never reads it.
  const staleKickoff = render([{ ...card(false), kickoff: '2000-01-01T00:00:00.000Z' }]);
  assert.equal(badges(staleKickoff), 0, 'a past kickoff does not badge the card');
});
