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
import { codeOnly } from './helpers/code-only.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
// Comments blanked, so a field named in prose is not counted as read. The helper
// is the tree's shared one for exactly this, and this file's census is the
// reason it exists.
const scannerCode = codeOnly(scannerSource, true);
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
  // The two stamps are deliberately hours apart. An old scan re-evaluated
  // against freshly saved preferences is the ordinary case, not an exotic one,
  // and a fixture where they coincide makes every assertion about which one the
  // page dates the list by pass regardless of the answer.
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
  evaluatedAt: '2026-10-01T14:05:00.000Z',
};

/**
 * The note the page should print for a payload scanned at `when`.
 *
 * The page's substitution list lives here rather than being copied into each
 * test. Two tests built their expected string as `t('alertsSinceScan').replace(
 * '{when}', …)` — a hand-copy that did not know about `{count}`, so adding the
 * event count made both of them expect a literal `{count}` in the interface and
 * fail against a page that was right. One builder is the fix; three hand-copies
 * would have been the bug waiting for the next placeholder.
 */
const sinceScanNote = (alerts = ALERT_PAYLOAD, when = alerts.scan.scrapedAt) => {
  return dictionaries().en.t('alertsSinceScan')
    .replace('{when}', new Date(when).toLocaleString())
    .replace('{count}', Number(alerts.scan.eventCount || 0).toLocaleString());
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
    assert.ok(i18n.t('alertsSinceScan').includes('{count}'), `alertsSinceScan/${lang} has no {count}`);
  }
  // ...and the bare noun the table uses is a separate key, so shortening one
  // cannot silently break the other.
  assert.notEqual(langs.en.t('alertStake'), langs.en.t('alertStakeValue'));
});

// ---- the payload's own fields ----------------------------------------------

/**
 * Every field `GET /api/alerts` publishes, read off the builders rather than off
 * a list written here.
 *
 * The payload is assembled in three places — the route's own four literals, the
 * normalised preferences, and the spread of `evaluateAlerts` — so the first two
 * are *run* (they are pure, and this file already imports nothing from src/ but
 * that is the point: a hand-written key list is a copy that stops being true
 * quietly) and the route's literals are read out of the router's source. The
 * comparison against ALERT_PAYLOAD below is the control that says the fixture in
 * this file still holds the real shape.
 */
const routerCode = read('src/router.mjs');
const alertEngine = await import('../src/alert-engine.mjs');

/** `scan: { id: …, scrapedAt: …, eventCount: … }` as the route writes it. */
const SCAN_REFERENCE = /scan:\s*\{([^}]*)\}/.exec(routerCode)?.[1] || '';
const SCAN_FIELDS = [...SCAN_REFERENCE.matchAll(/(\w+):/g)].map((m) => m[1]).sort();

/** Dot paths down to the leaves, because a census of `counts` alone is not one. */
function leafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix];
  if (Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

const PUBLISHED = [
  ...leafPaths(alertEngine.evaluateAlerts({}, {})),
  ...leafPaths(alertEngine.normalizeAlertPreferences({})).map((p) => `preferences.${p}`),
  ...SCAN_FIELDS.map((f) => `scan.${f}`),
  'schemaVersion',
  'published',
].sort();

/**
 * Published by the route, read by no page, with the reason it is allowed.
 *
 * Every reason names a measurement, and the measurement is re-checked by the
 * controls at the foot of this file rather than left as prose.
 */
const UNREAD_BY_DESIGN = {
  schemaVersion: [
    'A version marker. Measured across the whole tree: six builders write one',
    '(src/router.mjs:294, src/alert-engine.mjs, src/tracker-service.mjs,',
    'src/scanner/scanner.mjs, src/scanner/market-catalog.mjs, src/scrapers/base.mjs) and',
    'no page reads any of them. Three of the sibling documents have a test that',
    'pins their value — test/router.test.mjs:492, test/tracker-service.test.mjs:274,',
    'test/endpoints-registry.test.mjs:24 — and this one does not, so the marker here',
    'is carried and checked by nothing. It is exempt as a marker, not as a value:',
    'ALERT_SCHEMA is asserted below so the number cannot drift without the file',
    'noticing.',
  ].join(' '),
  'scan.id': [
    'The other two thirds of the run reference. Measured: the page reads',
    '`scrapedAt` and `eventCount` off this object and never `id`, and no page',
    'fetches GET /api/scrape-run to follow a run id — the one consumer of that',
    'route is the scrape page\'s own run table, which reads the document it asks',
    'for. The id is the join key between this payload and the raw run file, and',
    'the reference was published to say which run a list came from, which the',
    'timestamp already answers for a reader.',
  ].join(' '),
  thresholds: [
    'A second copy of three fields `preferences` already carries, with the same',
    'values from the same object: `evaluateAlerts` normalises once into `prefs`',
    '(src/alert-engine.mjs:131) and then publishes `prefs.minRoiPercent`,',
    '`prefs.minMiddleRoiPercent` and `prefs.includeLive` again under this name',
    '(:152-156), while the route publishes the same normalised object as',
    '`preferences` (src/router.mjs:292). The page fills its form from',
    '`payload.preferences` and shows nothing from `thresholds`, so the duplicate',
    'is a second name for one number and the two can never disagree — which is',
    'the only argument for keeping it that it can never be the wrong one.',
  ].join(' '),
  evaluatedAt: [
    'The moment the list was computed, and the route recomputes on every call',
    '(`...evaluateAlerts(scan, preferences)` inside readAlertPayload,',
    'src/router.mjs:300), so its value is the moment the request arrived. A page',
    'rendering it would display the time the reader pressed refresh. The date the',
    'list is actually good for is `scan.scrapedAt`, which the note already prints',
    '— and the difference between the two is the reason',
    'test "the list is dated by the scan it came from" exists.',
  ].join(' '),
};

/**
 * `const counts = payload.counts`, read again as `counts.arbitrages`.
 *
 * @type {Map<string, string>} local name → the payload path it stands for
 */
const ALIASES = new Map([...scannerCode.matchAll(/const\s+(\w+)\s*=\s*payload\.(\w+)/g)]
  .map((m) => [m[1], `payload.${m[2]}`]));

/**
 * Whether the page reaches `path`, and the two shapes it uses to reach a field
 * two steps down.
 *
 * `const counts = payload.counts` and then `counts.arbitrages` is a read of
 * `payload.counts.arbitrages` through a local name, and
 * `((payload.truncated || {}).arbitrages || 0)` dereferences straight off the
 * fallback. Neither contains the literal dotted path, and the first version of
 * this census reported five unread fields that the page renders two lines above
 * the table — an instrument that fails on what it was built to find is worse
 * than one that has no opinion.
 *
 * Both forms are resolved, and nothing else is. A leaf name merely appearing
 * somewhere in the file is deliberately NOT counted as a read: that would
 * approve any field whose name occurs once, and the census could then never fail
 * on the thing it exists to catch. The window cannot cross a `;`, so a match
 * stays inside one statement.
 */
const isRead = (path) => {
  if (path.startsWith('preferences.')) {
    return scannerCode.includes(`prefs.${path.slice('preferences.'.length)}`);
  }
  if (scannerCode.includes(`payload.${path}`)) return true;
  const [head, ...rest] = path.split('.');
  const tail = rest.join('.');
  for (const [name, base] of ALIASES) {
    if (base === `payload.${head}` && scannerCode.includes(`${name}.${tail}`)) return true;
  }
  return new RegExp(`payload\\.${head}\\b[^;]{0,60}?\\.${tail}\\b`).test(scannerCode);
};

test('every field the alerts route publishes is read by the page, or has a measured reason', () => {
  // A key covers itself and everything under it, so `thresholds` covers its three
  // leaves without a list that says the same thing three times.
  const exempt = (path) => {
    const parts = path.split('.');
    return parts.some((_, i) => parts.slice(0, i + 1).join('.') in UNREAD_BY_DESIGN);
  };
  const unread = PUBLISHED.filter((p) => !isRead(p) && !exempt(p));
  assert.deepEqual(unread, [],
    `the page never reads these, and they carry no reason above: ${unread.join(', ')}`);

  // The canary: a field added to any of the three builders fails here rather than
  // becoming one more thing nobody sees.
  assert.deepEqual(Object.keys(ALERT_PAYLOAD).sort(), [...new Set(PUBLISHED.map((p) => p.split('.')[0]))].sort(),
    'the fixture in this file no longer holds the real payload shape');
});

test('no exemption names a field the page reads', () => {
  for (const [field, reason] of Object.entries(UNREAD_BY_DESIGN)) {
    assert.ok(reason.length > 80, `${field} has no recorded reason`);
    // Only the field that is named, not its siblings. `scan.id` is exempt while
    // `scan.scrapedAt` and `scan.eventCount` are read two lines apart, and a
    // check that walked the whole parent would have demanded the exemption be
    // deleted for the sake of two fields the page really does use.
    const covered = PUBLISHED.filter((p) => p === field || p.startsWith(`${field}.`));
    assert.ok(covered.length > 0, `${field} is exempt but the route publishes no such field`);
    assert.ok(!covered.some(isRead),
      `${field} is exempt, but the page reads it — remove the entry and say why in the same commit`);
  }
});

test('the census instruments are the ones they claim to be', () => {
  // A census whose instrument reads nothing passes everything, so the search has
  // to be shown working in both directions.
  assert.ok(PUBLISHED.length === 25, `expected 25 published paths, measured ${PUBLISHED.length}`);
  assert.ok(PUBLISHED.includes('preferences.quietHours.from') && PUBLISHED.includes('truncated.arbitrages'),
    'the walk descends to the leaves instead of stopping at the objects');
  assert.ok(isRead('scan.scrapedAt') && isRead('published'),
    'the search finds the paths the page really dereferences');
  assert.ok(!isRead('scan.runId') && !isRead('counts.nope'),
    'and it does not invent a read for a field nobody publishes');
  // Both resolution forms, shown working. Without these the census could pass by
  // having quietly stopped resolving them.
  assert.ok(ALIASES.get('counts') === 'payload.counts' && isRead('counts.middles'),
    'a field reached through a local name is read');
  assert.ok(isRead('truncated.arbitrages'),
    'and one reached straight off a `|| {}` fallback');
  // Comments are blanked first, so a field named in prose is not counted as read.
  assert.ok(!scannerCode.includes('thresholds'), 'the page never mentions thresholds outside a comment');
  assert.equal(alertEngine.ALERT_SCHEMA, ALERT_PAYLOAD.schemaVersion,
    'the fixture still carries the schema version the engine publishes');
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

test('the counts are drawn against the scan they came from, not on their own', async () => {
  const { context, get } = page();
  await context.refreshAlerts();
  const note = get('alerts-note').textContent;
  // The note dates the list and says how much was scanned. Without the second
  // half a count is unreadable: one arbitrage out of four events and one out of
  // forty thousand are the same sentence.
  assert.ok(note.includes('4'), `the event count is missing from the note: ${note}`);
  assert.ok(/\d{1,2}:\d{2}/.test(note) || note.includes('2026'), `the scan time is missing: ${note}`);

  // A large scan is formatted, not printed raw — the same treatment the count
  // above the table already gets.
  const big = page({ alerts: { ...ALERT_PAYLOAD, scan: { ...ALERT_PAYLOAD.scan, eventCount: 40120 } } });
  await big.context.refreshAlerts();
  assert.ok(big.get('alerts-note').textContent.includes('40,120'),
    `a five-digit event count was not formatted: ${big.get('alerts-note').textContent}`);
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
  assert.equal(plainGet('alerts-note').textContent, sinceScanNote());
});

test('the list is dated by the scan it came from, not by when the server evaluated it', async () => {
  const sinceScan = (when) => sinceScanNote(ALERT_PAYLOAD, when);

  const { context, get } = page();
  await context.refreshAlerts();
  const note = get('alerts-note').textContent;

  // `evaluateAlerts` builds the list out of the scan's own signals, which were
  // captured at `scrapedAt`; `now` reaches only `quietNow` and the stamp itself.
  // Dating the list by the evaluation would claim the odds are as fresh as the
  // evaluation, and a scan re-evaluated an hour later is exactly the case where
  // that claim is false and most tempting.
  assert.equal(note, sinceScan(ALERT_PAYLOAD.scan.scrapedAt), 'the note carries the scan time');
  assert.notEqual(note, sinceScan(ALERT_PAYLOAD.evaluatedAt), 'and never the evaluation time');

  // The control, so the assertion above is a claim about which field the page
  // reads rather than about a constant string: move the scan, and it follows.
  const LATER = '2026-10-01T16:45:00.000Z';
  const rescanned = page({ alerts: { ...ALERT_PAYLOAD, scan: { ...ALERT_PAYLOAD.scan, scrapedAt: LATER } } });
  await rescanned.context.refreshAlerts();
  assert.equal(rescanned.get('alerts-note').textContent, sinceScan(LATER));

  // ...while moving only the evaluation time leaves it exactly where it was.
  const reevaluated = page({ alerts: { ...ALERT_PAYLOAD, evaluatedAt: '2026-10-01T22:00:00.000Z' } });
  await reevaluated.context.refreshAlerts();
  assert.equal(reevaluated.get('alerts-note').textContent, sinceScan(ALERT_PAYLOAD.scan.scrapedAt));
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
