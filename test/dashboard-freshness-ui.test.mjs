/**
 * dashboard-freshness-ui.test.mjs — the two claims in the dashboard's
 * data-freshness cell, and whether the page earns them.
 *
 * The cell carries the answer to one question: can I trust this board? It
 * answered wrongly twice.
 *
 * "Last scrape" printed `Math.max` over the per-source `ageMs`, which is the age
 * of the stalest book, not the age of the scan — the number said "Last scrape"
 * and meant "oldest feed". `s.ageMs || 0` also flattened an unknown age to zero,
 * so a board nobody could date read as the most recent possible one.
 *
 * "All fresh" was gated at 80% freshness, so a board of 99 fresh out of 105
 * printed the green all-clear over six stale books.
 *
 * The real i18n dictionary is mounted rather than a key-echoing stub, so the
 * assertions are about which label was chosen and not about English wording.
 * `timeAgo` is injected as a recorder, in the same spirit as the injected
 * translator in `frontend-labels.test.mjs`: the age that reaches it is the
 * decision under test, and a real formatter would only add arithmetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dashboardSource = read('public/js/pages/dashboard.js');
const i18nSource = read('public/js/i18n.js');

const EMDASH = '\u2014';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return 'false'; },
  querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
});

/** The dashboard page, with the real dictionary mounted and `timeAgo` recorded. */
function page({ lang = 'en', scan = BASE } = {}) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node());
    return byId.get(id);
  };
  const state = { scan };
  const context = {
    document: { getElementById: get, querySelector: () => node(), querySelectorAll: () => [], addEventListener() {} },
    escapeHtml,
    console,
    // A fresh vm context starts from bare ECMAScript, so host additions are
    // absent — including timers. `refresh` uses `setTimeout` to clear its
    // counting animation, and without it the whole refresh threw into its own
    // catch block: every cell stayed empty and the first version of this test
    // was measuring a broken mount rather than a claim.
    setTimeout,
    clearTimeout,
    arbiterApp: { mount() {} },
    arbiterSse: { connect() {} },
    arbiterApi: { async get() { return state.scan; }, async post() { return state.scan; } },
  };
  context.window = { arbiterApp: { mount() {} }, arbiterConnectionStatus: null };
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
  }));
  context.arbiterI18n = context.window.arbiterI18n;
  // The age is echoed back inside the string, so an assertion can say which
  // number reached a particular cell. Counting calls instead would not: the
  // source-health rows format their own `ageMs` through the same function, and
  // a source's age is a fact the page is entitled to print.
  context.window.arbiterFormat = { timeAgo: (ms) => `AGE:${ms}` };
  vm.runInNewContext(dashboardSource, context);
  return { context, get, state };
}

/** Run the page over one scan and return the freshness cell. */
async function render(scan, options = {}) {
  const harness = page({ ...options, scan });
  await harness.context.refresh();
  return {
    ...harness,
    time: harness.get('qb-scrape-time'),
    status: harness.get('qb-scrape-status'),
  };
}

const BASE = {
  dataHealth: { status: 'fresh', actionableSourceCount: 2 },
  sources: [], eventCount: 4, scrapedAt: null,
  opportunities: [], middles: [], positiveEv: [], lowHold: [],
};

/** `fresh` fresh sources and `stale` stale ones, the stale ones three days old. */
const sources = (fresh, stale) => [
  ...Array.from({ length: fresh }, (_, i) => ({ id: `fresh-${i}`, dataStatus: 'fresh', ageMs: MINUTE, count: 10 })),
  ...Array.from({ length: stale }, (_, i) => ({ id: `stale-${i}`, dataStatus: 'stale', ageMs: 3 * DAY, count: 10 })),
];

test('the control: the cell reaches the page at all', async () => {
  // Without this, a broken mount would read as "no claim was made" and every
  // assertion below would be comparing an empty string to an empty string.
  const { status, context } = await render({ ...BASE, sources: sources(3, 0) });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.equal(status.textContent, t('allFresh'));
});

test('"last scrape" ages the scan, not the feeds it captured', async () => {
  // The shape the live board has: a scan two days old whose feeds were all a
  // minute old when it ran. A source's `ageMs` is stamped at capture time —
  // `snapshotQuality` measures `now - capturedAt` while the scan is running —
  // so `Math.max` over those ages answers a question about the scan's own
  // moment. The cell announced a last scrape of "1m" for a board two days old.
  const scanAge = 2 * DAY + 17 * HOUR;
  const { time } = await render({
    ...BASE,
    scrapedAt: new Date(Date.now() - scanAge).toISOString(),
    sources: [{ id: 'fresh-0', dataStatus: 'fresh', ageMs: MINUTE, count: 10 }],
  });
  const aged = Number(/^AGE:(\d+)$/.exec(time.textContent)?.[1]);
  assert.ok(Number.isFinite(aged), `the cell must carry an age taken from scrapedAt, got ${JSON.stringify(time.textContent)}`);
  assert.ok(Math.abs(aged - scanAge) < MINUTE, `the cell must age the scan (about ${scanAge} ms), got ${aged} ms`);
  assert.notEqual(aged, MINUTE, 'a feed that was a minute old when the scan ran does not date the scan');
});

test('a scan with no capture time shows no age rather than a substitute', async () => {
  // The sources still carry ages, and those ages are what the cell used to
  // print. They date the feeds, not the scan, so none of them is an answer to
  // "when was the last scrape" — the honest report is that it is not known.
  const { time } = await render({
    ...BASE,
    sources: [{ id: 'dated', dataStatus: 'fresh', ageMs: MINUTE, count: 10 }],
  });
  assert.equal(time.textContent, EMDASH, 'an undated scan shows no age rather than a source age');
});

test('"All fresh" needs every source, not four in five', async () => {
  const { status, context } = await render({ ...BASE, sources: sources(99, 6) });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.notEqual(status.textContent, t('allFresh'), 'six stale books are not "all fresh"');
  assert.equal(status.textContent, t('someStale'));
  assert.equal(status.className, 's yellow', 'and the cell is not the green all-clear');
});

test('a fully fresh board is still allowed to say so', async () => {
  // The control for the test above: a guard that blocks the all-clear
  // unconditionally would pass there and be just as wrong.
  const { status, context } = await render({ ...BASE, sources: sources(105, 0) });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.equal(status.textContent, t('allFresh'));
  assert.equal(status.className, 's green');
});

test('a board that is mostly stale says so, in red', async () => {
  const { status, context } = await render({ ...BASE, sources: sources(2, 8) });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.equal(status.textContent, t('dataStale'));
  assert.equal(status.className, 's red');
});

test('a scan with no sources is no data, and still dates itself', async () => {
  const { status, time, context } = await render({
    ...BASE,
    scrapedAt: new Date(Date.now() - 3 * MINUTE).toISOString(),
    sources: [],
  });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.equal(status.textContent, t('noData'));
  // The age of the scan is a fact about the scan, not about its sources, so an
  // empty scan over a live feed still has one.
  assert.match(time.textContent, /^AGE:\d+$/, 'and the scan still dates itself');
});

test('the Romanian cell makes the same claims', async () => {
  const { status, context } = await render({ ...BASE, sources: sources(99, 6) }, { lang: 'ro' });
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  assert.equal(status.textContent, t('someStale'));
  assert.notEqual(status.textContent, t('allFresh'));
});
