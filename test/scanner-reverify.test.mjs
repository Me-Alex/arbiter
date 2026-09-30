// The scanner page's "Re-verify" control.
//
// `POST /api/verify` is a complete, working endpoint: it re-reads the books
// for the legs in the published scan, writes the verdicts back into it and
// retires confirmations whose event has settled. It also had no way to be
// reached — verification only ever ran as step 2 of a full scrape, so a
// confirmation on screen could be hours old, and an arbitrage whose event has
// since started is no longer an arbitrage. A trader had no way to ask "is this
// still true?" without paying for a whole new scrape.
//
// The wiring has two things easy to get wrong, and both are checked here:
// the route answers with verdict counters rather than with a scan, so the page
// has to re-read `/api/scan` instead of rendering the response; and the route's
// 400 (ENOSCAN) is a state the trader can act on, not a fault to report as a
// raw error string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
const i18nSource = read('public/js/i18n.js');
const scannerHtml = read('public/admin/scanner.html');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function i18nInto(context, lang) {
  vm.runInNewContext(i18nSource, context);
  context.arbiterI18n = context.window.arbiterI18n;
}

/**
 * The page with its two buttons and a recorded API.
 *
 * `postResult` / `postError` decide what the verify call does, and `getCalls`
 * records the order of the requests — which is the part that matters here,
 * since rendering the verify response instead of re-reading the scan would
 * still produce a plausible-looking table.
 */
function page({ lang = 'en', verify = {}, postError = null, verifyGate = null } = {}) {
  const byId = new Map();
  const bySelector = new Map();
  const calls = [];
  const toasts = [];
  const node = (id) => ({
    id, textContent: '', innerHTML: '', className: '', value: '', checked: false, disabled: false, dataset: {},
    handlers: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    setAttribute() {}, getAttribute() { return 'false'; },
    querySelector() { return null; }, querySelectorAll() { return []; }, nextElementSibling: null,
  });
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node(id));
    return byId.get(id);
  };
  const select = (sel) => {
    if (!bySelector.has(sel)) bySelector.set(sel, node(sel));
    return bySelector.get(sel);
  };

  const context = {
    document: {
      getElementById: get, querySelector: select, querySelectorAll: () => [], addEventListener() {},
    },
    escapeHtml,
    console,
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
    createDropdown() {},
    arbiterSse: { connect() {} },
    showToast: (message, type) => { toasts.push({ message, type }); },
  };
  context.window = { arbiterApp: { mount() {} }, showToast: context.showToast };
  i18nInto(context, lang);
  context.arbiterApi = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url === '/api/profiles') return { profiles: [] };
      if (url === '/api/sports') return { sports: [] };
      return { dataHealth: { status: 'fresh', actionableSourceCount: 1 }, options: { liveMaxAgeMs: 90000 }, eventCount: 0, opportunities: [], middles: [], positiveEv: [] };
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (url !== '/api/verify') return {};
      // The verify pass re-reads every book; the gate is how a test holds it
      // open long enough to observe the button's state mid-flight.
      if (verifyGate) await verifyGate;
      if (postError) throw postError;
      return { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0, ...verify };
    },
  };
  vm.runInNewContext(scannerSource, context);
  // i18n.apply() runs on DOMContentLoaded and fills every [data-i18n] node.
  // The page captures the reverify label to put it back afterwards, so the
  // button has to start with the translated text or "the label comes back"
  // would pass against an empty string.
  get('reverify').textContent = context.arbiterI18n.t('reverify');
  get('rescan').textContent = context.arbiterI18n.t('rescan');
  return { context, get, calls, toasts, t: context.arbiterI18n.t.bind(context.arbiterI18n) };
}

const click = (get, id) => Promise.all((get(id).handlers.click || []).map((fn) => fn()));

test('the page has a re-verify control and it reaches the route', async () => {
  assert.match(scannerHtml, /id="reverify"/, 'the control exists in the markup');
  assert.match(scannerHtml, /id="reverify"[^>]*data-i18n="reverify"/, 'and is translated, not hardcoded');

  const { get, calls } = page();
  await click(get, 'reverify');
  const verify = calls.filter((c) => c.url === '/api/verify');
  assert.equal(verify.length, 1, 'exactly one verification call per press');
  assert.equal(verify[0].method, 'POST');
});

test('it verifies everything published rather than a chosen subset', async () => {
  // The route reads `body.targets` and falls back to every opportunity in the
  // published scan. Sending an empty object is what asks for that; sending a
  // stale target list from the page would verify rows that may since be gone.
  const { get, calls } = page();
  await click(get, 'reverify');
  const body = calls.find((c) => c.url === '/api/verify').body;
  // Spread into a host-realm object: the page's body was created inside the vm
  // context, so a strict deepEqual would compare prototypes and fail on
  // sameness of structure.
  assert.deepEqual({ ...body }, {});
  assert.equal(body.targets, undefined, 'no target list is sent');
});

test('the scan is re-read after verifying, not rendered from the response', async () => {
  // `POST /api/verify` rewrites latest-scan.json and answers with the verdict
  // counters. Rendering that response would draw an empty table, because it has
  // no opportunities in it — a plausible-looking page that is quietly wrong.
  const { get, calls } = page({ verify: { confirmed: 4, rejected: 9 } });
  await click(get, 'reverify');

  const scanRead = calls.findIndex((c) => c.method === 'GET' && c.url === '/api/scan');
  const verifyCall = calls.findIndex((c) => c.url === '/api/verify');
  assert.ok(scanRead > verifyCall, 'the published scan is fetched after the verification, not before it');
});

test('the outcome is reported as the four verdict counts', async () => {
  const { get, toasts, t } = page({ verify: { confirmed: 3, rejected: 11, expired: 2, unconfirmed: 5 } });
  await click(get, 'reverify');

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'success');
  for (const [label, n] of [['confirmed', 3], ['rejected', 11], ['expired', 2], ['unverified', 5]]) {
    assert.ok(toasts[0].message.includes(`${t(label)} ${n}`), `${label} ${n} is reported, got: ${toasts[0].message}`);
  }
});

test('"no published scan" is reported as a state, not as an error string', async () => {
  // The route answers 400 ENOSCAN when there is nothing to verify. That is the
  // common case on a fresh install and after a failed run, and it is something
  // the trader can act on — so it gets its own message instead of the raw
  // transport text, which is what the generic failure path would show.
  const err = Object.assign(new Error('no latest-scan.json'), { status: 400, code: 'ENOSCAN' });
  const { get, toasts, t } = page({ postError: err });
  await click(get, 'reverify');

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'warning');
  assert.equal(toasts[0].message, t('reverifyNoScan'));
  assert.ok(!toasts[0].message.includes('latest-scan.json'), 'the raw route text is not what the trader reads');
});

test('any other failure is reported with its own message', async () => {
  const err = Object.assign(new Error('verification pass failed'), { status: 500 });
  const { get, toasts } = page({ postError: err });
  await click(get, 'reverify');
  assert.equal(toasts[0].type, 'warning');
  assert.equal(toasts[0].message, 'verification pass failed');
});

test('the button is busy while the pass runs and free afterwards', async () => {
  // The verify pass re-reads every book for the legs in the scan. It is not
  // fast, and the label has to say so — a button that keeps its idle caption
  // through a ten-second pass reads as "nothing happened".
  const { get } = page();
  const button = get('reverify');
  const seen = [];
  // A second listener, which the harness keeps alongside the page's own.
  button.addEventListener('click', () => { seen.push({ disabled: button.disabled, label: button.textContent }); });

  await click(get, 'reverify');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].disabled, true, 'the button is disabled while the pass runs');
  assert.equal(seen[0].label, 'Verifying…', 'and says what it is doing');
  assert.equal(button.disabled, false, 'it is released once the pass is done');
  assert.equal(button.textContent, 'Re-verify', 'and its label comes back');
});

test('a second press while the pass is in flight is ignored', async () => {
  // Two verification passes writing latest-scan.json would interleave: the
  // second re-reads a file the first is still replacing. The guard is the
  // button's own disabled state, so what is checked is that the handler
  // honours it rather than relying on the browser to withhold the click.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { get, calls } = page({ verifyGate: gate });

  const inFlight = click(get, 'reverify');
  await new Promise((r) => setImmediate(r));
  assert.equal(get('reverify').disabled, true, 'the first press is still under way');

  await click(get, 'reverify');
  release();
  await inFlight;

  assert.equal(calls.filter((c) => c.url === '/api/verify').length, 1, 'only one pass was started');
  assert.equal(get('reverify').disabled, false, 'and the button is free again afterwards');
});

test('the control is labelled in both languages', () => {
  for (const lang of ['ro', 'en']) {
    const context = { document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] }, localStorage: { getItem: () => lang, setItem() {} }, console };
    context.window = context;
    i18nInto(context, lang);
    assert.notEqual(context.arbiterI18n.t('reverify'), 'reverify', `${lang}.reverify is translated`);
  }
});
