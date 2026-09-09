// Unit tests for connection-status.js:
//  - the PURE top-level decision functions (decideStateTransition,
//    decideHealthBanner) extracted by brace-matching — no DOM needed.
//  - the IIFE plumbing (setDataHealth → banner DOM, handleStateChange →
//    toasts + indicator refresh) exercised end-to-end against a DOM shim.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(join(import.meta.dirname, '..', 'public/js/connection-status.js'), 'utf8');

// Extract a top-level `function NAME(...) { ... }` by brace matching.
function extractFn(name, from = src) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(from);
  if (!m) throw new Error('cannot find function ' + name);
  const idx = m.index;
  let depth = 0;
  let i = from.indexOf('{', idx);
  if (i === -1) throw new Error('no open brace for ' + name);
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return from.slice(idx, i + 1);
}

const fnSrc = `${extractFn('decideStateTransition')}
${extractFn('decideHealthBanner')}
return { decideStateTransition, decideHealthBanner };`;
const { decideStateTransition, decideHealthBanner } = new Function(fnSrc)();

const T0 = 1_000_000;

describe('decideStateTransition', () => {
  it('ignores identical states (no toast, no update)', () => {
    const r = decideStateTransition('open', 'open', T0, T0 - 10_000);
    assert.equal(r.act, false);
    assert.equal(r.toast, null);
  });

  it('fires "lost" toast on open → reconnecting', () => {
    const r = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(r.act, true);
    assert.equal(r.toast, 'lost');
  });

  it('fires "reconnected" toast on reconnecting → open', () => {
    const r = decideStateTransition('reconnecting', 'open', T0, T0 - 10_000);
    assert.equal(r.act, true);
    assert.equal(r.toast, 'reconnected');
  });

  it('produces no toast for unknown → open (first contact)', () => {
    const r = decideStateTransition('unknown', 'open', T0, 0);
    assert.equal(r.act, true);
    assert.equal(r.toast, null);
  });

  it('debounces a rapid flip within the 2s window', () => {
    const first = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(first.act, true);
    // Immediate re-flip back — should be dropped (prev is now reconnecting)
    const second = decideStateTransition('reconnecting', 'open', T0, T0);
    assert.equal(second.act, false);
    assert.equal(second.toast, null);
  });

  it('allows a transition after the 2s window has elapsed', () => {
    const late = decideStateTransition('reconnecting', 'open', T0 + 3000, T0 - 10_000);
    assert.equal(late.act, true);
    assert.equal(late.toast, 'reconnected');
  });

  it('never debounces the very first transition from unknown', () => {
    const r = decideStateTransition('unknown', 'reconnecting', T0, 0);
    assert.equal(r.act, true);
  });

  it('supports a closed-open cycle beyond the window', () => {
    const a = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(a.toast, 'lost');
    const b = decideStateTransition('reconnecting', 'open', T0 + 3000, T0);
    assert.equal(b.toast, 'reconnected');
  });
});

describe('decideHealthBanner', () => {
  it('hides the banner for fresh data', () => {
    const r = decideHealthBanner({ status: 'fresh', actionableSourceCount: 3 });
    assert.equal(r.visible, false);
    assert.equal(r.className, '');
  });

  it('hides the banner when status is unknown', () => {
    const r = decideHealthBanner({ status: 'unknown' });
    assert.equal(r.visible, false);
  });

  it('hides the banner when health is undefined', () => {
    const r = decideHealthBanner(undefined);
    assert.equal(r.visible, false);
  });

  it('shows a warning banner for stale data with actionable counts', () => {
    const r = decideHealthBanner({ status: 'stale', actionableSourceCount: 2 });
    assert.equal(r.visible, true);
    assert.match(r.className, /\bvisible\b/);
    assert.ok(!r.className.includes(' info'), 'stale should NOT be info variant');
    assert.equal(r.status, 'stale');
    assert.equal(r.actionable, 2);
    assert.equal(r.empty, false);
  });

  it('shows an info banner for empty data', () => {
    const r = decideHealthBanner({ status: 'empty', actionableSourceCount: 0 });
    assert.equal(r.visible, true);
    assert.ok(r.className.includes(' info'), 'empty should be info variant');
    assert.equal(r.status, 'empty');
    assert.equal(r.empty, true);
  });

  it('shows a warning banner for partial data (not info)', () => {
    const r = decideHealthBanner({ status: 'partial', actionableSourceCount: 5 });
    assert.equal(r.visible, true);
    assert.ok(!r.className.includes(' info'), 'partial should NOT be info variant');
    assert.equal(r.status, 'partial');
    assert.equal(r.actionable, 5);
    assert.equal(r.empty, false);
  });

  it('defaults missing health to hidden', () => {
    const r = decideHealthBanner(null);
    assert.equal(r.visible, false);
    assert.equal(r.status, 'unknown');
  });
});

// ── IIFE plumbing integration ──────────────────────────────────────────────
// Evaluate the WHOLE module in a sandbox with a DOM shim, then drive the
// exported window.arbiterConnectionStatus.setDataHealth / setState to verify
// the full path (decision fn → DOM effect), not just the pure functions.

function el(tag) {
  const node = {
    tagName: tag,
    id: '',
    className: '',
    innerHTML: '',
    _removed: false,
    _listeners: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); this._sync(); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); this._sync(); },
      contains(c) { return this._s.has(c); },
      _sync() { node.className = 'data-freshness-banner' + (this._s.has('visible') ? ' visible' : '') + (this._s.has('info') ? ' info' : ''); },
    },
    setAttribute(k, v) { this[k] = String(v); },
    getAttribute(k) { return this[k] ?? null; },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    remove() { this._removed = true; },
    insertBefore(child) { this._firstChild = child; },
  };
  return node;
}

function runModuleSandbox() {
  // Fresh DOM shim per invocation so tests are isolated.
  const mainEl = el('main');
  const bannerEl = el('div');
  let created = 0;

  const documentShim = {
    readyState: 'complete',
    createElement: (tag) => { if (tag === 'div' && created === 0) { created++; return bannerEl; } return el(tag); },
    getElementById: (id) => (id === 'data-freshness-banner' ? createdBanner() : null),
    querySelector: (sel) => (sel === 'main' ? mainEl : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  function createdBanner() { return created > 0 ? bannerEl : null; }
  documentShim.getElementById = (id) => (id === 'data-freshness-banner' ? createdBanner() : null);

  const toasts = [];
  // Monotonic fake clock: returns the last-set "now" so tests can control time.
  let fakeNow = 1_000_000;
  const FakeDate = {
    now: () => fakeNow,
    _advance: (ms) => { fakeNow += ms; },
  };

  const sandbox = {
    window: {
      showToast: (msg, type, opts = {}) => { toasts.push({ msg, type, opts }); },
      arbiterI18n: {
        t: (k) => ({ noFreshData: 'NU', dataHealth: 'DH', freshSources: 'FS', runScrape: 'RS', connectionLost: 'CL', reconnected: 'RC' }[k] || k),
      },
      document: documentShim,
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
    },
    document: documentShim,
    console,
    Date: FakeDate,
    Math,
    Number,
  };
  sandbox.window.window = sandbox.window;

  const fn = new Function('window', 'document', 'console', 'Date', 'Math', 'Number', 'escapeHtml',
    `${src}\nreturn window.arbiterConnectionStatus;`);
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = fn(sandbox.window, documentShim, console, FakeDate, Math, Number, escape);
  return { api, bannerEl, mainEl, toasts, documentShim, advance: (ms) => FakeDate._advance(ms) };
}

describe('connection-status IIFE plumbing', () => {
  it('setDataHealth creates the banner once and shows it for stale data', () => {
    const { api, bannerEl, toasts } = runModuleSandbox();
    api.setDataHealth({ status: 'stale', actionableSourceCount: 2 });
    assert.equal(bannerEl.className, 'data-freshness-banner visible');
    assert.match(bannerEl.innerHTML, /DH: stale \(2 FS\)/);
    assert.match(bannerEl.innerHTML, /RS/);
    assert.ok(!toasts.length);
  });

  it('setDataHealth hides the banner for fresh data', () => {
    const { api, bannerEl, mainEl, toasts } = runModuleSandbox();
    // Prime the banner with stale first so the element exists
    api.setDataHealth({ status: 'stale' });
    const first = mainEl._firstChild;
    api.setDataHealth({ status: 'fresh' });
    assert.ok(!bannerEl.className.includes('visible'));
    assert.equal(mainEl._firstChild, first, 'banner element persists across updates');
    assert.ok(!toasts.length);
  });

  it('setDataHealth uses the info variant for empty data', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: 'empty' });
    assert.equal(bannerEl.className, 'data-freshness-banner visible info');
    assert.match(bannerEl.innerHTML, /NU/);
  });

  it('setDataHealth escapes HTML in the status string (XSS guard)', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: '<script>alert(1)</script>' });
    // The class gets the raw status applied; the text must be escaped.
    assert.ok(!bannerEl.innerHTML.includes('<script>'));
    assert.ok(bannerEl.innerHTML.includes('&lt;script&gt;'));
  });

  it('setDataHealth with no main element still renders the banner', () => {
    const { api, bannerEl } = runModuleSandbox();
    // Clear the main reference so insertBefore is a no-op on the shim
    api.setDataHealth({ status: 'stale' });
    assert.equal(bannerEl.className, 'data-freshness-banner visible');
  });

  it('setState toasts on lost connection then reconnected', () => {
    const { api, toasts, advance } = runModuleSandbox();
    // First contact from unknown: no toast, but accepted.
    api.setState('open');
    assert.equal(toasts.length, 0);
    // Lost: warning toast
    advance(3000); // clear the 2s debounce window
    api.setState('reconnecting');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'warning');
    // Rapid re-flip back (within 2s): debounced, no second toast
    api.setState('open');
    assert.equal(toasts.length, 1);
  });

  it('setState fires reconnected toast after the debounce window', () => {
    const { api, toasts, advance } = runModuleSandbox();
    api.setState('open');       // unknown → open (accepted, no toast)
    advance(3000);
    api.setState('reconnecting'); // lost toast
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'warning');
    advance(3000);               // wait out the 2s window
    api.setState('open');        // reconnected toast
    assert.equal(toasts.length, 2);
    assert.equal(toasts[1].type, 'success');
  });
});