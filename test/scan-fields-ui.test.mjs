// The scanner page has to read the fields the scan actually publishes.
//
// Three of them were not. `verificationSummary` was computed on every run and
// rendered nowhere, so the rejected and expired opportunities — which are
// dropped from every table — had no count at all. "Last updated" asked for
// `scan.scannedAt`, a field no scan has ever written, and silently fell through
// to `scanStartedAt`, labelling the age of the data with the moment the pass
// began reading it. And the in-play price window was the literal "90s" in a
// translation string, asserting a backend constant the page had no way to see,
// while `options.liveMaxAgeMs` sat unread in the same payload.
//
// The real i18n dictionary is loaded into the page context rather than a
// key-returning stub, because a stub that echoes key names would make the
// `{seconds}` substitution — the thing under test — untestable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
const i18nSource = read('public/js/i18n.js');
const scannerHtml = read('public/admin/scanner.html');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The i18n module on its own, so both dictionaries can be read back. */
function i18nContext(lang) {
  const store = { 'arbiter.lang': lang };
  const context = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
    console,
  };
  context.window = context;
  vm.runInNewContext(i18nSource, context);
  return context.arbiterI18n;
}

const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return 'false'; },
  querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
});

/** The whole page script, with the real dictionary mounted. */
function page({ lang = 'en' } = {}) {
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
  const context = {
    document: { getElementById: get, querySelector: select, querySelectorAll: () => [], addEventListener() {} },
    escapeHtml,
    console,
    createDropdown() {},
    arbiterSse: { connect() {} },
    arbiterApi: { async get() { return { profiles: [], sports: [] }; }, async post() { return BASE_SCAN; } },
  };
  context.window = { arbiterConnectionStatus: null, arbiterApp: { mount() {} } };
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
  }));
  // i18n.js assigned onto the shared `window`; the page reads bare globals.
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(scannerSource, context);
  return { context, get, select };
}

const BASE_SCAN = {
  dataHealth: { status: 'fresh', actionableSourceCount: 2 },
  sources: [], eventCount: 4, options: { liveMaxAgeMs: 90000 },
  opportunities: [], middles: [], positiveEv: [], lowHold: [],
};

const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const STARTED_AT = '2026-10-01T09:58:00.000Z'; // deliberately two minutes earlier

test('"last updated" shows when the data was captured, not when the pass began', () => {
  const { context, get } = page();
  context.render({ ...BASE_SCAN, scrapedAt: CAPTURED_AT, scanStartedAt: STARTED_AT });

  // Two minutes apart on purpose: with `scan.scannedAt` — a field nothing
  // publishes — the expression fell through to scanStartedAt and this read the
  // moment the scan started, which is an answer about the run and not about
  // the data.
  assert.equal(
    get('scan-updated').textContent,
    new Date(CAPTURED_AT).toLocaleString(),
    'the header must report the capture time',
  );
  assert.notEqual(
    get('scan-updated').textContent,
    new Date(STARTED_AT).toLocaleString(),
    'and must not quietly fall back to the start of the pass',
  );
});

test('a scan with no capture time still renders, without inventing one', () => {
  // The empty scan used to be published without any timestamp at all, so this
  // is the shape the page has to survive — it must degrade, not print NaN.
  const { context, get } = page();
  context.render(BASE_SCAN);
  assert.equal(get('scan-updated').textContent, '—');
});

test('the verification counters are on screen, all four of them', () => {
  const { context, get } = page();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  context.render({
    ...BASE_SCAN,
    verificationSummary: { confirmed: 7, rejected: 19, expired: 4, unconfirmed: 2, at: CAPTURED_AT },
  });

  const text = get('verification-mix').textContent;
  // Rejected and expired rows never reach the tables, so these four numbers
  // are the only place the cost of the pass is visible at all. The expected
  // line is built from the dictionary so the assertion is about the four
  // counts landing in the right places, not about English capitalisation.
  const expected = [['confirmed', 7], ['rejected', 19], ['expired', 4], ['unverified', 2]];
  assert.equal(
    text,
    expected.map(([label, value]) => `${t(label)} ${value}`).join(' · '),
    'all four counters, in order, each with its own number',
  );
  // 19 rejected against 7 confirmed: the rejected count is not folded into the
  // confirmed one, which is the entire reason for rendering it separately.
  assert.ok(!text.includes(`${t('confirmed')} 19`), 'a rejected row is never reported as a confirmed one');
});

test('four zeroes are not the same claim as no verification pass', () => {
  // A scan that has not been verified reports four zeroes and no `at`; a pass
  // that ran and confirmed nothing reports four zeroes and one. Printing the
  // counters in both cases would assert that a verification happened when none
  // did, which is the one claim this line must not make on its own.
  const { context, get } = page();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);

  context.render({ ...BASE_SCAN, verificationSummary: { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0 } });
  assert.equal(get('verification-mix').textContent, t('notVerifiedYet'));

  context.render({ ...BASE_SCAN, verificationSummary: { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0, at: CAPTURED_AT } });
  const text = get('verification-mix').textContent;
  assert.notEqual(text, t('notVerifiedYet'), 'a pass that ran and confirmed nothing is a different statement');
  assert.ok(text.includes(`${t('confirmed')} 0`), `and it still shows the counters, got: ${text}`);
});

test('a missing verificationSummary does not throw the render', () => {
  // A scan published before the field existed, or a preview that has genuinely
  // not been verified. Same answer as "never verified", not a crash.
  const { context, get } = page();
  context.render(BASE_SCAN);
  assert.equal(typeof get('verification-mix').textContent, 'string');
  assert.ok(get('verification-mix').textContent.length > 0);
});

test('the in-play window is read from the scan, not hardcoded', () => {
  const { context, get } = page();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);

  // 45s, not the 90 the translation string used to claim. A page that hardcoded
  // the number would keep saying 90 after DEFAULT_LIVE_MAX_AGE_MS changed.
  context.render({ ...BASE_SCAN, options: { liveMaxAgeMs: 45000 } });
  const note = get('live-window-note').textContent;
  assert.ok(note.includes('45'), `the window comes from the scan, got: ${note}`);
  assert.ok(!note.includes('90'), `and is not the hardcoded default, got: ${note}`);
  assert.ok(!note.includes('{seconds}'), 'the placeholder was substituted');

  context.render({ ...BASE_SCAN, options: { liveMaxAgeMs: 90000 } });
  assert.ok(get('live-window-note').textContent.includes('90'), 'and it does say 90 when the scan says 90');
  assert.equal(t('livePreviewNote').includes('{seconds}'), true, 'the template still carries its placeholder');
});

test('a scan with no recorded window says so instead of guessing', () => {
  // Publishing 90s here would be the page asserting a number it does not have.
  // The one honest thing to print is that the scan did not record one.
  const { context, get } = page();
  context.render({ ...BASE_SCAN, options: {} });
  const note = get('live-window-note').textContent;
  assert.equal(note, context.arbiterI18n.t('liveWindowUnknown'));
  assert.ok(!/\d/.test(note), 'no invented number');
});

test('the new keys exist in both languages', () => {
  for (const lang of ['ro', 'en']) {
    const { t } = i18nContext(lang);
    for (const key of ['verificationTotals', 'verificationTotalsNote', 'notVerifiedYet', 'liveWindowUnknown', 'livePreviewNote']) {
      assert.notEqual(t(key), key, `${lang}.${key} must be translated, not echoed`);
    }
    assert.ok(t('livePreviewNote').includes('{seconds}'), `${lang}.livePreviewNote must keep its placeholder`);
  }
});

test('the summary strip has a slot for the counters, and the page owns the window note', () => {
  // The markup is half the wiring: a missing id means the page writes into
  // nothing. And the window note must NOT carry data-i18n, or i18n.apply() —
  // which runs on DOMContentLoaded and on every language switch — would
  // overwrite the substituted number with the bare {seconds} template.
  assert.match(scannerHtml, /id="verification-mix"/, 'the counters have an element to render into');
  assert.match(scannerHtml, /id="live-window-note"/);
  const note = scannerHtml.match(/<span[^>]*id="live-window-note"[^>]*>/);
  assert.ok(note, 'the window note exists in the markup');
  assert.ok(!note[0].includes('data-i18n'), 'the page is the only writer of the window note');
});
