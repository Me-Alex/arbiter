/**
 * The scanner page as the browser drives it: the script runs, `init()` fires
 * on its own, fetches resolve, and `render` draws.
 *
 * Lifted out of test/sport-selection.test.mjs because a second property of the
 * same page needed the harness — test/sport-label.test.mjs. One harness, two
 * tests, rather than a copy of the vm context that could drift from the first
 * one and start passing on a page the other is failing.
 *
 * The `change` dispatch and every render go through the page's own listener
 * stack rather than calling `render` directly — the defects this harness was
 * built for are precisely that listeners or seeds did not exist, and a test
 * calling `render` itself would pass on the page it is failing.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { codeOnly } from './code-only.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');
const scannerHtml = read('public/admin/scanner.html');
const i18nSource = read('public/js/i18n.js');

export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The options the control offers, as the registry serves them. */
export const SPORTS = [
  { id: 'football', name: 'Football' },
  { id: 'tennis', name: 'Tennis' },
];

/**
 * The links as the markup ships them: `?type=`, no sport. Read out of the page
 * rather than typed, so a link added or removed in the markup is exercised by
 * the runtime rewrite instead of being pinned a second time — test/scan-csv
 * already owns the census of which families have a link.
 */
export const SHIPPED = [...codeOnly(scannerHtml, false)
  .matchAll(/<a\b[^>]*\bhref="(\/api\/scan\/export\.csv[^"]*)"/g)].map((m) => m[1]);

export const node = () => ({
  textContent: '', innerHTML: '', className: '', value: '', checked: false, hidden: false,
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

/** The `/api/alerts` answer a page without an alert concern should get. */
const EMPTY_ALERTS = {
  schemaVersion: 1,
  published: true,
  scan: {},
  // Complete, because `fillAlertForm` reads `channels` and `quietHours`
  // as objects: a stub with `preferences: {}` throws inside the page's
  // own catch and leaves the alert form unfilled.
  preferences: {
    minRoiPercent: 1, minMiddleRoiPercent: 1, cooldownSeconds: 300, includeLive: false,
    channels: { desktop: false, sound: false },
    quietHours: { enabled: false, from: '23:00', to: '07:00' },
  },
  alerts: { arbitrages: [], middles: [] },
  counts: { arbitrages: 0, middles: 0 },
};

export function page({ scan = {}, alertsPayload = EMPTY_ALERTS, sports = SPORTS } = {}) {
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
  const anchors = SHIPPED.map((href) => {
    const a = node();
    a.setAttribute('href', href);
    return a;
  });
  const store = {};
  const context = {
    document: {
      getElementById: get,
      querySelector: select,
      // Only the export links are modelled; every other selector the page
      // walks (the flash targets) is empty in a document without layout.
      querySelectorAll: (selector) => (selector.startsWith('a[href*=') ? anchors : []),
      addEventListener() {},
    },
    escapeHtml,
    // A browser global, not an ECMAScript one: `runInNewContext` starts from
    // ECMAScript alone, and the page reads `URLSearchParams` to rewrite its
    // export links. Same injection scrape-page.test.mjs makes.
    URLSearchParams,
    console: { warn() {}, log() {}, error() {} },
    createDropdown() {},
    arbiterSse: { connect() {} },
    arbiterApi: {
      async get(path) {
        if (path === '/api/scan') return scan;
        if (path === '/api/profiles') return { profiles: [] };
        if (path === '/api/sports') return { sports };
        if (path === '/api/alerts') return alertsPayload;
        return {};
      },
      async post() { return {}; },
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
  };
  context.window = { arbiterConnectionStatus: null, arbiterApp: { mount() {} }, showToast() {} };
  vm.runInNewContext(i18nSource, context);
  context.arbiterI18n = context.window.arbiterI18n;
  vm.runInNewContext(scannerSource, context);
  return { context, get, select, anchors };
}
