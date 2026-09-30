/**
 * published-scan-flag.test.mjs — can the page tell "never ran" from "ran and found nothing"?
 *
 * The backend could answer this and the route threw the answer away.
 * `readPublishedScan` returns `{scan, published}` — scan-service.mjs spells out
 * why the second part cannot be recovered from the scan — and `GET /api/scan`
 * called `readLatestScan`, which keeps `.scan` and drops the flag.
 *
 * What that cost on screen is specific, and this file pins each part of it:
 *
 *   1. The served fallback is a full `emptyScan()`, which mints a `scrapedAt`
 *      of now. The scanner's "Last updated" field therefore showed the moment
 *      the page was opened as the age of a scan that had never happened.
 *   2. The AI page's "no published scan" panel was gated on `health.status`,
 *      which is never falsy for a served scan, so it could not render — and the
 *      run label fell through to "manual preview" on an install that had never
 *      scraped.
 *   3. The scanner's empty box said "no fresh data", a verdict on stale odds,
 *      when in fact there had never been any odds at all.
 *
 * The flag is served flat (`{...scan, published}`) rather than wrapped in an
 * envelope. Four pages read `scan.opportunities` directly; an envelope would
 * hand every one of them `undefined`, which renders as 0 — the very lie the
 * flag exists to stop. The route test below asserts the flatness so that
 * decision is not silently reversible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { emptyScan, readPublishedScan } from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
const aiSource = read('public/js/pages/ai.js');
const i18nSource = read('public/js/i18n.js');
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- backend: the flag answers the question the scan cannot ---------------

test('readPublishedScan separates "never published" from "published but empty"', async () => {
  const never = mkdtempSync(join(tmpdir(), 'arbiter-never-'));
  const ran = mkdtempSync(join(tmpdir(), 'arbiter-ran-'));
  try {
    const a = await readPublishedScan(never);
    assert.equal(a.published, false, 'no latest-scan.json means nothing has been published');

    // Exactly what scrape-orchestrator.mjs persists when a run completes with
    // nothing above the threshold: an emptyScan with the run's id.
    writeFileSync(join(ran, 'latest-scan.json'), JSON.stringify(emptyScan({ scrapeRunId: 'markets-1' })), 'utf8');
    const b = await readPublishedScan(ran);
    assert.equal(b.published, true, 'an empty scan on disk is still a published scan');

    // The control that makes the first assertion mean something: the two
    // findings are identical, so only the flag separates the states.
    assert.deepEqual(a.scan.opportunities, b.scan.opportunities, 'the findings really are the same');
    assert.notEqual(a.published, b.published, 'and the flag is what tells them apart');
  } finally {
    rmSync(never, { recursive: true, force: true });
    rmSync(ran, { recursive: true, force: true });
  }
});

// ---- the route, over HTTP, against both disk states -----------------------

function serverFor(dataDir) {
  const route = buildRouter({
    dataDir,
    publicDir: dataDir,
    configPath: 'unused',
    profilesPath: 'unused',
    rateLimiter: new RateLimiter({ capacity: 200, refillPerSec: 200 }),
    logger: () => {},
    // The real service, not a stub. A stub that always answered
    // `{published: true}` would make this test a restatement of its own
    // fixture — the thing under test is the route calling the service and
    // passing the flag on, and that needs the service to actually read a disk.
    scanService,
    orchestrator: { scrapeState: { status: 'idle', jobs: [] }, async launch() { return {}; }, async cancel() { return {}; } },
    scheduler: { async status() { return {}; }, async enable() {}, async disable() {} },
    tracker: { async loadAlerts() { return { preferences: {} }; }, async saveAlerts(p) { return p; } },
    broadcaster: { add() {}, stop() {} },
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      route(req, res, url).catch((err) => { res.statusCode = 500; res.end(String(err)); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function getScan(server) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/scan`, { headers: { Host: '127.0.0.1' } });
  const body = await res.text();
  assert.equal(res.status, 200, `GET /api/scan answered ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

test('GET /api/scan publishes the flag, flat, in both disk states', async () => {
  const never = mkdtempSync(join(tmpdir(), 'arbiter-never-'));
  const ran = mkdtempSync(join(tmpdir(), 'arbiter-ran-'));
  const servers = [];
  try {
    writeFileSync(join(ran, 'latest-scan.json'), JSON.stringify(emptyScan({ scrapeRunId: 'markets-1' })), 'utf8');
    servers.push(await serverFor(never), await serverFor(ran));

    const a = await getScan(servers[0]);
    const b = await getScan(servers[1]);

    assert.equal(a.published, false, 'nothing published -> published:false');
    assert.equal(b.published, true, 'a scan on disk -> published:true');
    assert.equal(typeof a.published, 'boolean', 'the flag is a boolean, not a truthy scan');

    // Flatness. An envelope would answer `{scan:{...}, published}` and every
    // page reading `body.opportunities` would render 0 on every run.
    for (const [name, body] of [['never', a], ['ran', b]]) {
      assert.ok(Array.isArray(body.opportunities), `${name}: opportunities is not at the top level`);
      assert.ok(Array.isArray(body.sources), `${name}: sources is not at the top level`);
      assert.ok(body.dataHealth && typeof body.dataHealth.status === 'string', `${name}: dataHealth is not at the top level`);
    }
  } finally {
    for (const s of servers) s.close();
    rmSync(never, { recursive: true, force: true });
    rmSync(ran, { recursive: true, force: true });
  }
});

// ---- the pages ------------------------------------------------------------

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

/** The served fallback, as the route builds it when nothing is published. */
const NEVER = { ...emptyScan(), published: false };
/** A published scan that found nothing. */
const EMPTY = { ...emptyScan({ scrapeRunId: 'markets-1' }), published: true };

const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, type: 'text',
  dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, setAttribute() {}, getAttribute() { return 'false'; },
  querySelector() { return null; }, querySelectorAll: () => [], nextElementSibling: null,
});

/** The SSE handler starts a refresh without returning it, so awaiting it waits
 *  for nothing. One turn of the event loop is what actually lets render() run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Loads scanner.js and returns its elements plus a way to re-render. */
function scannerPage(scan) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node());
    return byId.get(id);
  };
  const handlers = [];
  const context = {
    document: { getElementById: get, querySelector: () => node(), querySelectorAll: () => [], addEventListener() {} },
    escapeHtml,
    console: { warn() {}, log() {} },
    createDropdown() {},
    arbiterSse: { connect: (h) => handlers.push(h) },
    arbiterApi: {
      async get(path) {
        if (path === '/api/scan') return scan;
        if (path === '/api/profiles') return { profiles: [] };
        if (path === '/api/sports') return { sports: [] };
        if (path === '/api/alerts') return { schemaVersion: 1, published: true, scan: {}, preferences: {}, alerts: { arbitrages: [], middles: [] }, counts: { arbitrages: 0, middles: 0 } };
        return {};
      },
      async post() { return {}; },
    },
  };
  context.window = { arbiterConnectionStatus: null, arbiterApp: { mount() {} }, showToast() {} };
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: () => null, setItem() {} },
  }));
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(scannerSource, context);
  return { get, handlers };
}

test('the scanner does not date a scan that has never been published', async () => {
  const { get, handlers } = scannerPage(NEVER);
  // The page's own refresh path, not a direct call into a private function.
  for (const h of handlers) { h('scan-update'); await settle(); }

  const updated = get('scan-updated').textContent;
  assert.notEqual(updated, '—', 'the field is blank rather than dated');
  assert.ok(!/\d{1,2}:\d{2}/.test(updated), `"Last updated" shows a clock time for a scan that never ran: ${updated}`);
  assert.equal(updated, 'niciodată rulat', 'and it says so in the default language');
});

test('the scanner still dates a real scan', async () => {
  const { get, handlers } = scannerPage({ ...EMPTY, scrapedAt: '2026-10-01T10:00:00.000Z' });
  for (const h of handlers) { h('scan-update'); await settle(); }
  const updated = get('scan-updated').textContent;
  assert.ok(/\d{1,2}:\d{2}/.test(updated), `a published scan is no longer dated: ${updated}`);
});

test('the scanner names the two empty states differently', async () => {
  const langs = dictionaries();

  const never = scannerPage(NEVER);
  for (const h of never.handlers) { h('scan-update'); await settle(); }
  const neverBox = never.get('scan-empty').innerHTML;
  assert.ok(!neverBox.includes('hidden'), 'the box is shown');
  assert.ok(!neverBox.includes('proaspete'), '"no fresh data" is a verdict on stale odds, and there are no odds yet');

  const ran = scannerPage(EMPTY);
  for (const h of ran.handlers) { h('scan-update'); await settle(); }
  const ranBox = ran.get('scan-empty').innerHTML;
  assert.ok(!ranBox.includes('hidden'), 'the box is shown');
  assert.notEqual(neverBox, ranBox, 'the two empty states render the same thing, so the flag changes nothing');

  for (const key of ['noPublishedScan', 'noFreshData', 'neverRan']) {
    for (const lang of ['ro', 'en']) {
      assert.notEqual(langs[lang].t(key), key, `${key} is missing from the ${lang} dictionary`);
    }
  }
});

function aiPage(scan) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, node());
    return byId.get(id);
  };
  const context = {
    document: { getElementById: get, querySelector: () => node(), addEventListener() {} },
    escapeHtml,
    console: { warn() {}, log() {} },
    arbiterApp: { mount() {} },
    arbiterSse: { connect() {} },
    // `fail` makes the read throw, which is the third state this page has to
    // survive: a backend that is up but unreachable is not a published scan and
    // not a hand-run preview either.
    arbiterApi: { async get() { if (scan === FAIL) throw new Error('network down'); return scan; } },
  };
  context.window = { arbiterApp: { mount() {} }, arbiterConnectionStatus: null };
  vm.runInNewContext(i18nSource, Object.assign(context, {
    localStorage: { getItem: () => null, setItem() {} },
  }));
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(aiSource, context);
  return { get, settle: () => new Promise((r) => setTimeout(r, 0)) };
}
const FAIL = Symbol('unreachable');

test('the AI page can render the state it previously had no way to reach', async () => {
  // Compared against the dictionary rather than against a word: the Romanian
  // label is "previzualizare", so a search for "preview" matches nothing in the
  // default language and the assertion passes whatever the page renders.
  const dicts = dictionaries();
  const t = dicts.ro.t.bind(dicts.ro);

  const never = aiPage(NEVER);
  await never.settle();
  const html = never.get('scan-health').innerHTML;
  assert.ok(html.includes(t('noPublishedScan')), 'the never-ran panel is not rendered at all');
  assert.ok(!html.includes(t('manualPreview')), 'a scan that never ran is called a manual preview');
  assert.ok(!html.includes('undefined'), 'the fallback renders a literal "undefined" as the status');
  // Telling the trader nothing has run without offering to run one leaves them
  // with a fact and no next step.
  assert.ok(html.includes('/admin/scrape.html'), 'the never-ran panel offers no way to start a scrape');

  const ran = aiPage(EMPTY);
  await ran.settle();
  const ranHtml = ran.get('scan-health').innerHTML;
  assert.notEqual(html, ranHtml, 'both states render the same panel, so the flag changes nothing');
  assert.ok(ranHtml.includes(t('fromPublishedScan')), 'a published scan no longer renders the published-scan panel');
});

test('the AI page still calls a hand-run scan a preview', async () => {
  const dicts = dictionaries();
  const page = aiPage({ ...EMPTY, scrapeRunId: null });
  await page.settle();
  assert.ok(page.get('scan-health').innerHTML.includes(dicts.ro.t('manualPreview')), 'the manual-preview label is gone');
});

test('a failed read is not mistaken for a published scan', async () => {
  const dicts = dictionaries();
  const page = aiPage(FAIL);
  await page.settle();
  const html = page.get('scan-health').innerHTML;
  assert.ok(!html.includes('undefined'), `an unreachable backend renders "undefined" as the status: ${html.slice(0, 120)}`);
  assert.ok(!html.includes(dicts.ro.t('fromPublishedScan')), 'an unreachable backend claims a published scan is on screen');
});
