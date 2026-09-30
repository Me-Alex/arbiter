/**
 * alert-ui.test.mjs — the scanner page's half of the alert system.
 *
 * The recurring defect in this codebase has been a control that renders and a
 * backend that answers nobody, or a translation key that does not exist in the
 * language being read. Both are invisible to a test that only calls the engine.
 * So this file checks three separate links: the ids the script reaches for are
 * in the markup, every key it asks for is in both dictionaries, and the flow
 * through the page's own functions actually calls the routes it claims to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
const alertsSource = read('public/js/alerts.js');
const i18nSource = read('public/js/i18n.js');
const scannerHtml = read('public/admin/scanner.html');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Both dictionaries, so a key added to one and not the other is visible. */
function dictionaries() {
  const out = {};
  for (const lang of ['ro', 'en']) {
    const store = { 'arbiter.lang': lang };
    const context = {
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
      console,
    };
    context.window = context;
    vm.runInNewContext(i18nSource, context);
    out[lang] = context.arbiterI18n;
  }
  return out;
}

/** Ids the page reaches for, read out of the source rather than hand-listed. */
const IDS = [...scannerSource.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1]);

/**
 * The declared input type of each id, read out of the markup.
 *
 * A fake element that reports `type: 'text'` for a checkbox makes the page's
 * `el.type === 'checkbox'` branch untestable in a way that hides real
 * behaviour — and a hand-maintained id list is the same hand-written copy of
 * the markup that this whole audit keeps finding out of date. The harness
 * reads the real thing instead.
 */
const INPUT_TYPES = new Map();
for (const [, attrs, id] of scannerHtml.matchAll(/<input\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  INPUT_TYPES.set(id, /\btype="([^"]+)"/.exec(attrs)?.[1] ?? 'text');
}

const node = (id = '') => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false,
  type: INPUT_TYPES.get(id) || 'text',
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return 'false'; },
  querySelector() { return null; }, querySelectorAll: () => [], nextElementSibling: null,
});

const ALERT_PAYLOAD = {
  schemaVersion: 1,
  published: true,
  scan: { id: 'scan-1', scrapedAt: '2026-10-01T10:00:00.000Z', eventCount: 4 },
  preferences: {
    minRoiPercent: 1, minMiddleRoiPercent: 25, includeLive: false,
    channels: { desktop: true, sound: false },
    quietHours: { from: '23:00', to: '07:00', enabled: false },
    cooldownSeconds: 60,
  },
  alerts: {
    arbitrages: [{
      key: 'fotbal::1x2::arb', type: 'arb', eventKey: 'fotbal::1x2', marketKey: '1x2',
      sport: 'fotbal', league: 'Superliga', homeTeam: 'FCSB', awayTeam: 'Dinamo',
      live: false, roiPercent: 4, totalStake: 100, guaranteedProfit: 4, riskPercent: 0,
      sourceIds: ['betano', 'fortuna'], verified: 'confirmed',
    }],
    middles: [],
  },
  counts: { arbitrages: 1, middles: 0 },
  truncated: { arbitrages: 0, middles: 0 },
  thresholds: { minRoiPercent: 1, minMiddleRoiPercent: 25, includeLive: false },
  quietNow: false,
  evaluatedAt: '2026-10-01T10:00:00.000Z',
};

/** The page, with recording stubs for both API routes. */
function page({ lang = 'en', alerts = ALERT_PAYLOAD, alertsError = null, postResult = null } = {}) {
  const byId = new Map();
  const bySelector = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node(id));
    return byId.get(id);
  };
  const select = (selector) => {
    if (!bySelector.has(selector)) bySelector.set(selector, node());
    return bySelector.get(selector);
  };
  const calls = { get: [], post: [], toasts: [] };
  const context = {
    document: { getElementById: get, querySelector: select, querySelectorAll: () => [], addEventListener() {} },
    escapeHtml,
    console: { warn() {}, log() {} },
    createDropdown() {},
    arbiterSse: { connect() {} },
    arbiterApi: {
      async get(path) {
        calls.get.push(path);
        if (path === '/api/alerts') {
          if (alertsError) throw alertsError;
          return alerts;
        }
        if (path === '/api/profiles') return { profiles: [] };
        if (path === '/api/sports') return { sports: [] };
        return { dataHealth: { status: 'fresh', actionableSourceCount: 1 }, sources: [], eventCount: 0, options: {}, opportunities: [], middles: [], positiveEv: [] };
      },
      async post(path, body) {
        calls.post.push({ path, body });
        if (path === '/api/alerts') return postResult || alerts;
        return { opportunities: [], middles: [], positiveEv: [] };
      },
    },
  };
  context.window = {
    arbiterConnectionStatus: null,
    arbiterApp: { mount() {} },
    showToast: (message, type) => calls.toasts.push({ message, type }),
  };
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
  }));
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(alertsSource, context);
  context.window.arbiterAlerts = context.arbiterAlerts;
  vm.runInNewContext(scannerSource, context);
  return { context, get, select, calls };
}

// ---- the markup ------------------------------------------------------------

test('every element the page reaches for exists in scanner.html', () => {
  const present = new Set([...scannerHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...new Set(IDS)].filter((id) => !present.has(id));
  // An id the script reaches for but the markup does not have is a `$('x')`
  // that returns null and a null-dereference on the first render — the whole
  // panel, gone, with nothing in the console to say why.
  assert.deepEqual(missing, [], `ids used by scanner.js but absent from the markup: ${missing.join(', ')}`);
});

test('the alert script is loaded, and before the page script that uses it', () => {
  const order = [...scannerHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.includes('/js/alerts.js'), 'alerts.js is not on the page at all');
  const alertsAt = order.indexOf('/js/alerts.js');
  const scannerAt = order.indexOf('/js/pages/scanner.js');
  assert.ok(alertsAt < scannerAt, `alerts.js loads at ${alertsAt}, scanner.js at ${scannerAt}`);
  // ...and after the helpers it leans on.
  for (const dep of ['/js/i18n.js', '/js/pages/common.js', '/js/api.js']) {
    assert.ok(order.indexOf(dep) < alertsAt, `${dep} must load before alerts.js`);
  }
});

test('the alert controls are labelled for both languages, not just the default one', () => {
  const langs = dictionaries();
  const keys = [...new Set([...scannerHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
  const alertControls = [
    'alertsLabel', 'alertMinRoi', 'alertMinMiddleRoi', 'alertCooldown', 'alertQuietFrom',
    'alertQuietTo', 'alertChannels', 'alertDesktop', 'alertSound', 'alertQuietEnabled',
    'alertIncludeLive', 'alertsSave',
  ];
  for (const key of alertControls) {
    assert.ok(keys.includes(key), `${key} is in the page but carries no data-i18n`);
  }
  // The check that matters: a key present in English and missing in Romanian
  // silently falls back to English, which looks fine until someone reads it.
  for (const key of [...keys, ...alertControls]) {
    for (const lang of ['en', 'ro']) {
      const value = langs[lang].t(key);
      assert.notEqual(value, key, `key ${key} is missing from the ${lang} dictionary`);
    }
  }
});

test('the notification templates really carry their placeholders', () => {
  const langs = dictionaries();
  // This is the bug the page would have shipped with: a bare "stake" where the
  // code substitutes a number, so every notification ended in a dangling noun.
  for (const [lang, i18n] of Object.entries(langs)) {
    assert.ok(i18n.t('alertStakeValue').includes('{value}'), `alertStakeValue/${lang} has no {value}`);
    assert.ok(i18n.t('alertArbRoi').includes('{roi}'), `alertArbRoi/${lang} has no {roi}`);
    assert.ok(i18n.t('alertMiddleRoi').includes('{roi}') && i18n.t('alertMiddleRoi').includes('{risk}'), `alertMiddleRoi/${lang}`);
    assert.ok(i18n.t('alertsTruncated').includes('{n}'), `alertsTruncated/${lang} has no {n}`);
    assert.ok(i18n.t('alertsSinceScan').includes('{when}'), `alertsSinceScan/${lang} has no {when}`);
  }
  // ...and the bare noun the table uses is a separate key, so shortening one
  // cannot silently break the other.
  assert.notEqual(langs.en.t('alertStake'), langs.en.t('alertStakeValue'));
});

// ---- the flow --------------------------------------------------------------

test('the page reads the alerts and renders what cleared the thresholds', async () => {
  const { context, get, select, calls } = page();
  await context.refreshAlerts();
  assert.ok(calls.get.includes('/api/alerts'), 'the page never asked for the alerts');
  assert.ok(get('alerts-count').textContent.includes('1'), get('alerts-count').textContent);
  const rows = select('#alerts-table tbody').innerHTML;
  assert.ok(rows.includes('FCSB'), 'the matching signal is on screen');
  assert.ok(rows.includes('betano'), 'with the books to place with');
  assert.ok(rows.includes('confirmed'), 'and its verification verdict');
});

test('the settings form is filled from what the server stored', async () => {
  const { context, get } = page();
  await context.refreshAlerts();
  assert.equal(get('alert-min-roi').value, '1');
  assert.equal(get('alert-mid-roi').value, '25');
  assert.equal(get('alert-cooldown').value, '60');
  assert.equal(get('alert-quiet-from').value, '23:00');
  assert.equal(get('alert-quiet-to').value, '07:00');
  assert.equal(get('alert-desktop').checked, true);
  assert.equal(get('alert-sound').checked, false);
  assert.equal(get('alert-live').checked, false);
  assert.equal(get('alert-quiet-enabled').checked, false);
});

test('a field the user is typing in is not overwritten by a refresh', async () => {
  const { context, get } = page();
  await context.refreshAlerts();
  get('alert-min-roi').value = '7';
  get('alert-min-roi').focus = () => {};
  // A scan-update lands mid-edit. Re-filling the box would throw away what was
  // being typed, with no undo.
  context.document.activeElement = get('alert-min-roi');
  await context.refreshAlerts();
  assert.equal(get('alert-min-roi').value, '7', 'the half-typed value survived');
  // ...while every other field still updates, so the panel is not frozen.
  assert.equal(get('alert-cooldown').value, '60');
  context.document.activeElement = null;
});

test('saving posts the form and renders the answer, without a second request', async () => {
  const posted = {
    ...ALERT_PAYLOAD,
    preferences: { ...ALERT_PAYLOAD.preferences, minRoiPercent: 10, channels: { desktop: true, sound: true } },
  };
  const { context, get, select, calls } = page({ postResult: posted });
  await context.refreshAlerts();
  get('alert-min-roi').value = '10';
  get('alert-sound').checked = true;
  calls.post.length = 0;
  await context.saveAlerts();

  assert.equal(calls.post.length, 1, 'one request, not "save then re-read"');
  const [call] = calls.post;
  assert.equal(call.path, '/api/alerts');
  assert.equal(call.body.preferences.minRoiPercent, '10', 'the raw field value is posted; the server coerces it');
  assert.equal(call.body.preferences.channels.sound, true);
  assert.equal(call.body.preferences.quietHours.from, '23:00');
  // The answer is rendered, so the list is never computed under thresholds the
  // form has just abandoned.
  assert.equal(get('alert-min-roi').value, '10', 'the form adopts what the server actually stored');
  assert.ok(select('#alerts-table tbody').innerHTML.includes('FCSB'));
  assert.ok(calls.toasts.some((t) => t.type === 'success'), 'and the user is told it saved');
});

test('a failed save is reported and the button comes back', async () => {
  const { context, get, calls } = page();
  await context.refreshAlerts();
  context.arbiterApi.post = async () => { throw new Error('rate limit exceeded'); };
  await context.saveAlerts();
  assert.ok(calls.toasts.some((t) => t.type === 'error' && /rate limit/.test(t.message)), JSON.stringify(calls.toasts));
  assert.equal(get('alerts-save').disabled, false, 'a failed save must not leave the control dead');
});

test('an unavailable alerts route says so instead of claiming a quiet market', async () => {
  const { context, get, select } = page({ alertsError: Object.assign(new Error('no route'), { code: 'ENOTFOUND' }) });
  await context.refreshAlerts();
  assert.equal(get('alerts-count').textContent, '—');
  assert.ok(/no route/.test(get('alerts-note').textContent), get('alerts-note').textContent);
  assert.ok(/no route/.test(select('#alerts-table tbody').innerHTML));
});

test('an unpublished scan is never shown as "nothing to report"', async () => {
  const empty = {
    ...ALERT_PAYLOAD,
    published: false,
    alerts: { arbitrages: [], middles: [] },
    counts: { arbitrages: 0, middles: 0 },
  };
  const { context, get, select } = page({ alerts: empty });
  await context.refreshAlerts();
  const langs = dictionaries();
  assert.equal(get('alerts-count').textContent, langs.en.t('alertsNoScan'));
  // The distinction is the whole reason the route sends `published`: an empty
  // list with no explanation is a claim about the market.
  const note = get('alerts-note').textContent;
  assert.notEqual(note, langs.en.t('alertsSinceScan').replace('{when}', new Date(ALERT_PAYLOAD.scan.scrapedAt).toLocaleString()));
  assert.ok(note.length > 0);
  assert.ok(!select('#alerts-table tbody').innerHTML.includes('FCSB'));
});

test('a truncated list says how much it is hiding', async () => {
  const many = { ...ALERT_PAYLOAD, truncated: { arbitrages: 7, middles: 3 } };
  const { context, get } = page({ alerts: many });
  await context.refreshAlerts();
  const langs = dictionaries();
  assert.equal(get('alerts-note').textContent, langs.en.t('alertsTruncated').replace('{n}', '10'));
  // The control: nothing hidden, so nothing claimed.
  const { context: plain, get: plainGet } = page();
  await plain.refreshAlerts();
  assert.equal(plainGet('alerts-note').textContent, langs.en.t('alertsSinceScan').replace('{when}', new Date(ALERT_PAYLOAD.scan.scrapedAt).toLocaleString()));
});

test('quiet hours are stated on screen even though the list still renders', async () => {
  const { context, get, select } = page({ alerts: { ...ALERT_PAYLOAD, quietNow: true } });
  await context.refreshAlerts();
  const langs = dictionaries();
  assert.equal(get('alerts-note').textContent, langs.en.t('alertsQuietNow'));
  assert.ok(select('#alerts-table tbody').innerHTML.includes('FCSB'), 'the list is data, not an interruption');
});

test('the page still renders its alerts when the notification script is absent', async () => {
  const { context, get, select } = page();
  // alerts.js is an extra script on an existing page; a 404 on it must not take
  // the settings form and the list down with it.
  context.window.arbiterAlerts = undefined;
  await context.refreshAlerts();
  assert.ok(get('alerts-count').textContent.includes('1'), 'the counts are still there');
  assert.ok(select('#alerts-table tbody').innerHTML.includes('FCSB'), 'and so is the list');
  assert.equal(get('alert-min-roi').value, '1', 'and the form is still filled from the server');
});

test('a scan-update re-reads the alerts, and a book-by-book scrape update does not', async () => {
  const { context, calls } = page();
  calls.get.length = 0;
  // Capture the handler the page registers, by re-running just its tail with a
  // recording arbiterSse. Forty `scrape-update` events per run, each one
  // re-reading the alerts for a scan that has not been published yet, is forty
  // pointless requests.
  const handlers = [];
  context.arbiterSse = { connect: (fn) => handlers.push(fn) };
  vm.runInNewContext(scannerSource.slice(scannerSource.indexOf('arbiterSse.connect')), context);
  assert.equal(handlers.length, 1, 'the page registers one SSE handler');
  await handlers[0]('scrape-update');
  assert.equal(calls.get.includes('/api/alerts'), false, 'a book finishing is not a new scan');
  assert.ok(calls.get.includes('/api/scan'), 'but the tables do refresh');
  await handlers[0]('scan-update');
  assert.ok(calls.get.includes('/api/alerts'), 'a published scan can change what clears the thresholds');
});
