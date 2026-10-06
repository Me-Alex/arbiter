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
import { codeOnly } from './helpers/code-only.mjs';

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
  // `dict` lives inside the module IIFE and never reaches the context object, so
  // the test gets at it by adding it to the object the IIFE does export. A copy
  // in memory only — the file on disk is untouched.
  //
  // It has to reach the dictionaries rather than `t()`, because `t` resolves
  // `(dict[lang] && dict[lang][key]) || (dict.en[key]) || key`: it falls back to
  // English and then to the key itself, so a label that exists only in Romanian
  // still renders as a sentence in the English context. That is how a mutant
  // deleting the English label outright survived a `t(key) !== key` check.
  const EXPORT = 'window.arbiterI18n = { t, setLang, apply,';
  const exposed = i18nSource.replace(EXPORT, 'window.arbiterI18n = { dict, t, setLang, apply,');
  assert.notEqual(exposed, i18nSource, 'the i18n export line moved; the dictionary is no longer reachable and this test would pass on a missing label again');
  vm.runInNewContext(exposed, context);
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

test('an arbitrage that only exists on paper is marked as such', () => {
  // The engine refuses any allocation with an inverse sum of 1 or more, so a
  // published arbitrage has a positive theoretical edge. It can still lose money
  // once the stake split is rounded to cents, and when it does the row reads
  // +0.00% margin next to -0.01 profit with nothing connecting them. The same flag
  // is already disclosed on the event-detail panel, so this is the one surface
  // that lists arbitrages and did not carry it. Measured on the real allocator,
  // it fires 40 of 200 allocations over the thin tail of the inverse sum at a
  // 1000 bankroll, so this is a row a trader sees, not a theoretical one.
  const { context, select } = page();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);
  const rows = () => select('#arb-table tbody').innerHTML;

  const arb = (roundingRisk) => ({
    homeTeam: 'Home', awayTeam: 'Away', marketKey: 'MATCH_ODDS', legs: [{ sourceId: 'alpha' }],
    marginPercent: 0, totalStake: 1000, guaranteedProfit: roundingRisk ? -0.01 : 12.5,
    roundingRisk,
  });

  context.render({ ...BASE_SCAN, opportunities: [arb(true)] });
  const risky = rows();
  assert.ok(risky.includes(escapeHtml(t('roundingRisk'))), `the marker is missing from the row: ${risky}`);
  assert.ok(risky.includes(escapeHtml(t('roundingRiskHint'))), 'and it has to say what it means, not just name itself');
  assert.ok(risky.includes('chip yellow'), 'and it is styled with a class the stylesheet actually defines');

  // A scan published before the field existed carries no flag at all. The row
  // must render exactly as it did, rather than showing a badge nobody set.
  context.render({ ...BASE_SCAN, opportunities: [{ ...arb(false) }] });
  assert.ok(!rows().includes(escapeHtml(t('roundingRisk'))), 'a false flag draws nothing');
  context.render({ ...BASE_SCAN, opportunities: [{ ...arb(undefined), roundingRisk: undefined }] });
  assert.ok(!rows().includes(escapeHtml(t('roundingRisk'))), 'and a missing flag draws nothing either');
});

test('the marker reuses the keys the event-detail panel already discloses with', () => {
  // An earlier draft added its own `roundingRisk` and `roundingRiskTooltip`
  // here. That is a duplicate key in an object literal, which is not a syntax
  // error: the later entry wins, the first is dead text that reads like a real
  // translation, and test/i18n-dictionary.test.mjs caught the pair. The fix was
  // to use the two keys event-detail-modal.js:415 already renders this with, so
  // the same disclosure reads the same in both languages on both surfaces.
  const modal = read('public/js/pages/event-detail-modal.js');
  assert.match(modal, /t\('roundingRisk'\)/, 'the event-detail panel no longer names the flag');
  assert.match(modal, /t\('roundingRiskHint'\)/);

  const ro = i18nContext('ro').dict.ro;
  const en = i18nContext('en').dict.en;
  for (const key of ['roundingRisk', 'roundingRiskHint']) {
    for (const [lang, dict] of [['ro', ro], ['en', en]]) {
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${lang}.${key} is missing from the dictionary`);
      assert.notEqual(dict[key], key, `${lang}.${key} echoes its own key`);
    }
  }
  assert.notEqual(ro.roundingRiskHint, en.roundingRiskHint, 'the Romanian hint is the English one verbatim');
  assert.notEqual(ro.roundingRisk, en.roundingRisk, 'and so is the label');

  // Nothing invented a key for this row alone. The chip has no string of its
  // own, which is what makes the two surfaces agree by construction.
  const scanner = codeOnly(scannerSource);
  assert.ok(!/roundingRisk(?!Hint)\w*\s*:/.test(scanner), 'the page defines a translation key instead of reading one');
});
