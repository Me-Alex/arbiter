// Unit tests for connection-status.js:
//  - the PURE top-level decision functions (decideStateTransition,
//    decideHealthBanner) extracted by brace-matching — no DOM needed.
//  - the IIFE plumbing (setDataHealth → banner DOM, handleStateChange →
//    toasts + indicator refresh) exercised end-to-end against a DOM shim.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guardedPropertyReads, objectEntries, objectKeys } from './helpers/code-only.mjs';
import { extractFn } from './helpers/extract-fn.mjs';

const src = readFileSync(join(import.meta.dirname, '..', 'public/js/connection-status.js'), 'utf8');
const i18nSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/i18n.js'), 'utf8');
// The chip paints itself with class names, and nothing else in this file can
// see whether the stylesheet defines them — see the "classes it writes" suite.
const themeCss = readFileSync(join(import.meta.dirname, '..', 'public/css/theme.css'), 'utf8');

// Extract the `const dict = { ro: {...}, en: {...} };` literal from i18n.js by
// brace matching, then evaluate it so the sandbox uses the REAL dictionary.
function extractConst(name, from) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\{`);
  const m = re.exec(from);
  if (!m) throw new Error('cannot find const ' + name);
  let depth = 0;
  let i = from.indexOf('{', m.index);
  if (i === -1) throw new Error('no open brace for ' + name);
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return from.slice(m.index, i + 1);
}

// In the real dictionary, keys are quoted or bare; the extracted literal is
// valid JS, so evaluate it directly.
const dictSrc = `${extractConst('dict', i18nSrc)}; return dict;`;
const realDict = new Function(dictSrc)();
const REAL_RO = realDict.ro;
const REAL_EN = realDict.en;

// Replace the sandbox i18n with the REAL dictionary (RO so translated words
// like 'învechit' land in the banner), mirroring i18n.js's t() exactly.
function makeRealT(lang) {
  return (key) => (realDict[lang] && realDict[lang][key]) || (realDict.en[key]) || key;
}

// Contract anchor: the camelCase status keys connection-status.js looks up
// (status + Capitalized(token)) must exist in BOTH dictionaries, or a future
// snake_case regression would silently render raw tokens.
describe('i18n status keys', () => {
  for (const lang of ['ro', 'en']) {
    for (const token of ['stale', 'partial', 'empty']) {
      it(`${lang}.status${token[0].toUpperCase()}${token.slice(1)} exists`, () => {
        assert.ok(realDict[lang]['status' + token[0].toUpperCase() + token.slice(1)],
          `missing ${lang} key status${token[0].toUpperCase()}${token.slice(1)}`);
      });
    }
  }
});

// Extract a top-level `function NAME(...) { ... }` — the shared helper, which
// skips the parameter list before counting braces. See test/helpers/extract-fn.mjs
// for what the naive version of this returned on a default argument.
const fnSrc = `${extractFn('decideStateTransition', src)}
${extractFn('decideHealthBanner', src)}
${extractFn('formatUptime', src)}
${extractFn('decideHealthChip', src)}
return { decideStateTransition, decideHealthBanner, formatUptime, decideHealthChip };`;
const { decideStateTransition, decideHealthBanner, formatUptime, decideHealthChip } = new Function(fnSrc)();

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

  // ---- the window the verdict was reached with ----------------------------
  //
  // These are on the DECISION, not on the rendered banner, and that level is
  // the point. A rendering-level assertion cannot see the guards: a negative
  // window renders "limita: -100 min", which no `includes(freshnessLimit)`
  // check matches, because that check looks for the template with its
  // placeholder still in it. Reading the returned value sees every branch.

  it('carries the window an age verdict was reached with', () => {
    assert.equal(decideHealthBanner({ status: 'stale', prematchMaxAgeMs: 600000 }).maxAgeMs, 600000);
    assert.equal(decideHealthBanner({ status: 'partial', prematchMaxAgeMs: 600000 }).maxAgeMs, 600000);
    // A sub-minute window is still carried as sent — rounding belongs to the
    // renderer, and a decision that rounded would be a second place holding a
    // number derived from the same millisecond count.
    assert.equal(decideHealthBanner({ status: 'stale', prematchMaxAgeMs: 90_000 }).maxAgeMs, 90_000);
  });

  it('resolves no window for an empty verdict, even when the scan carries one', () => {
    // `empty` is "the source observed no usable events" — not an age verdict at
    // all. A window on it would describe a comparison that never happened.
    assert.equal(decideHealthBanner({ status: 'empty', prematchMaxAgeMs: 600000 }).maxAgeMs, null);
  });

  it('resolves no window it cannot stand behind', () => {
    const cases = [
      ['absent', {}],
      ['null', { prematchMaxAgeMs: null }],
      ['zero', { prematchMaxAgeMs: 0 }],
      ['negative', { prematchMaxAgeMs: -600000 }],
      ['not a number', { prematchMaxAgeMs: 'soon' }],
      ['NaN', { prematchMaxAgeMs: Number.NaN }],
      ['Infinity', { prematchMaxAgeMs: Number.POSITIVE_INFINITY }],
    ];
    for (const [label, extra] of cases) {
      assert.equal(decideHealthBanner({ status: 'stale', ...extra }).maxAgeMs, null,
        `a ${label} window must resolve to null, not to a number the banner would print`);
    }
  });

  it('resolves no window for a hidden banner', () => {
    // The early return names the key explicitly so a stale copy of this object
    // cannot carry a window on a decision nothing reads.
    assert.equal(decideHealthBanner({ status: 'fresh', prematchMaxAgeMs: 600000 }).maxAgeMs, null);
    assert.equal(decideHealthBanner({ status: 'unknown', prematchMaxAgeMs: 600000 }).maxAgeMs, null);
  });
});

describe('formatUptime', () => {
  it('renders sub-minute uptimes in seconds', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(1), '1s');
    assert.equal(formatUptime(45), '45s');
    assert.equal(formatUptime(59), '59s');
  });

  it('switches to minutes at 60 and drops the seconds that follow', () => {
    // Seconds are printed only when no larger unit exists, so a chip reading
    // '5h 12m' ticks once a minute instead of changing on every 30s poll.
    // (This caught the first implementation, which returned '1m 30s' for 90 —
    // the code and its own comment disagreed, and the comment was the intent.)
    assert.equal(formatUptime(60), '1m');
    assert.equal(formatUptime(90), '1m');
    assert.equal(formatUptime(3599), '59m');
    assert.equal(formatUptime(3600), '1h');
  });

  it('keeps at most two units, largest first', () => {
    assert.equal(formatUptime(3661), '1h 1m');
    assert.equal(formatUptime(90061), '1d 1h'); // 1d 1h 1m 1s → the tail is dropped
    assert.equal(formatUptime(93784), '1d 2h');
    assert.equal(formatUptime(172800), '2d');
    // The one that separates truncation from rounding: 86399/86400 is 0.99998,
    // which rounds up to a whole day and would print '1d' for 23h 59m of
    // uptime. It is also what pins the floor() inside the loop.
    assert.equal(formatUptime(86399), '23h 59m');
  });

  it('truncates a fractional input', () => {
    assert.equal(formatUptime(90061.9), '1d 1h');
    assert.equal(formatUptime(59.9), '59s');
    assert.equal(formatUptime(86399.9), '23h 59m');
  });

  it('refuses anything that is not a usable number', () => {
    // The trap this guards: Number(null), Number('') and Number([]) are all 0,
    // so a coerced read would print '0s' for a value the server never sent —
    // a chip claiming a process that has been up for zero seconds.
    for (const bad of [null, undefined, '', '90061', [], {}, NaN, Infinity, -Infinity, -1]) {
      assert.equal(formatUptime(bad), '', `formatUptime(${JSON.stringify(bad) ?? String(bad)}) must not invent a value`);
    }
  });
});

describe('decideHealthChip', () => {
  it('is unreachable when there is no payload at all', () => {
    const r = decideHealthChip(null);
    assert.equal(r.state, 'unreachable');
    assert.equal(r.className, 'chip red');
    assert.equal(r.uptimeText, '');
  });

  it('is ok with the uptime when the payload carries one', () => {
    const r = decideHealthChip({ ok: true, uptimeSeconds: 90061, timestamp: 'x' });
    assert.equal(r.state, 'ok');
    assert.equal(r.className, 'chip green');
    assert.equal(r.uptimeSeconds, 90061);
    assert.equal(r.uptimeText, '1d 1h');
  });

  it('treats a just-started process as ok, not as unknown', () => {
    // 0 is a real reading, and the only one that would be flattened to ''
    // by a truthiness test.
    const r = decideHealthChip({ uptimeSeconds: 0 });
    assert.equal(r.state, 'ok');
    assert.equal(r.uptimeText, '0s');
  });

  it('floors the uptime it reports', () => {
    assert.equal(decideHealthChip({ uptimeSeconds: 90061.9 }).uptimeSeconds, 90061);
  });

  it('does not read the payload\'s own ok flag', () => {
    // src/router.mjs hardcodes ok: true, so a constant is not a signal.
    // Pinned here so nobody "fixes" this into a trust-the-flag check.
    const r = decideHealthChip({ ok: false, uptimeSeconds: 90061 });
    assert.equal(r.state, 'ok');
  });

  it('is unknown — not unreachable — when the body is not the payload', () => {
    // The route answered 200 with something this chip cannot read. Painting
    // that red would report an outage that is not happening.
    for (const payload of [{}, { uptimeSeconds: null }, { uptimeSeconds: 'x' }, { uptimeSeconds: -5 }, { uptimeSeconds: NaN }, { uptimeSeconds: Infinity }]) {
      const r = decideHealthChip(payload);
      assert.equal(r.state, 'unknown', `${JSON.stringify(payload)} must not read as ok`);
      assert.equal(r.className, 'chip yellow');
      assert.equal(r.uptimeText, '');
    }
  });
});

// ── IIFE plumbing integration ──────────────────────────────────────────────// Evaluate the WHOLE module in a sandbox with a DOM shim, then drive the
// exported window.arbiterConnectionStatus.setDataHealth / setState to verify
// the full path (decision fn → DOM effect), not just the pure functions.

// A DOM shim just large enough for this module: children, because the
// health chip is BUILT here (three nested spans) and inserted after the
// connection chip; textContent, kept as its own property from innerHTML so a
// test can prove which of the two the module writes to.
function el(tag) {
  const node = {
    tagName: tag,
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    _removed: false,
    _listeners: {},
    _children: [],
    parentNode: null,
    nextSibling: null,
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
    insertBefore(child, ref) { this._firstChild = child; },
    appendChild(child) { child.parentNode = node; node._children.push(child); return child; },
    querySelector(sel) {
      if (sel === '.dot') return node._children.find((c) => /(^|\s)dot(\s|$)/.test(c.className)) || null;
      if (sel === 'span:last-child') {
        const last = node._children[node._children.length - 1];
        return last && last.tagName === 'span' ? last : null;
      }
      return null;
    },
  };
  return node;
}

function runModuleSandbox({ noMain = false, withApi = false, noAnchor = false, health } = {}) {
  // Fresh DOM shim per invocation so tests are isolated.
  const mainEl = el('main');
  const bannerEl = el('div');
  let created = 0;

  // The header: the connection chip, and the container the health chip is
  // inserted into. `noAnchor` models a page that has no #sse-status.
  const headerEl = el('div');
  const sseEl = el('span');
  sseEl.id = 'sse-status';
  sseEl.className = 'sse-status chip green';
  if (!noAnchor) {
    headerEl.appendChild(sseEl);
    headerEl.insertBefore = (child, ref) => {
      const at = ref ? headerEl._children.indexOf(ref) : headerEl._children.length;
      child.parentNode = headerEl;
      child.nextSibling = headerEl._children[at + 1] || null;
      headerEl._children.splice(at < 0 ? headerEl._children.length : at, 0, child);
      return child;
    };
  }

  // The health chip, as the page ends up with it.
  const healthChip = () => headerEl._children.find((c) => c.id === 'health-status') || null;
  const healthText = () => {
    const chip = healthChip();
    return chip ? chip.querySelector('span:last-child') : null;
  };

  const documentShim = {
    readyState: 'complete',
    createElement: (tag) => { if (tag === 'div' && created === 0) { created++; return bannerEl; } return el(tag); },
    getElementById: (id) => {
      if (id === 'data-freshness-banner') return created > 0 ? bannerEl : null;
      if (id === 'sse-status' && !noAnchor) return sseEl;
      return null;
    },
    querySelector: (sel) => (sel === 'main' ? (noMain ? null : mainEl) : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const toasts = [];
  // Monotonic fake clock: returns the last-set "now" so tests can control time.
  let fakeNow = 1_000_000;
  const FakeDate = {
    now: () => fakeNow,
    _advance: (ms) => { fakeNow += ms; },
  };

  // Optional arbiterApi stub for wrapApiForToasts tests. Injected BEFORE the
  // module wraps, so the wrapper captures these exact functions.
  const apiStub = withApi
    ? {
        get: async () => 'ok',
        post: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
        put: async () => { throw new Error('put fail'); },
        del: async () => { throw new Error('del fail'); },
      }
    : undefined;

  // The /api/health stub. `health` is swapped per test; it is a function so
  // a test can replace the whole transport (reject, 500, non-JSON body)
  // without rebuilding the sandbox.
  const fetchCalls = [];
  const HEALTHY = { ok: true, uptimeSeconds: 90061, timestamp: '2026-05-06T08:00:00.000Z' };
  let healthImpl = health || (async () => ({ ok: true, json: async () => HEALTHY }));
  const fetchStub = (...args) => { fetchCalls.push(args); return healthImpl(...args); };

  // Interval capture, so a test can fire the poll without waiting 30s of
  // wall clock — and assert the period the module actually asked for.
  const intervals = [];

  const sandbox = {
    window: {
      showToast: (msg, type, opts = {}) => { toasts.push({ msg, type, opts }); },
      arbiterI18n: {
        t: makeRealT('ro'), // RO dictionary: 'învechit' etc. land in the banner
      },
      arbiterApi: apiStub,
      document: documentShim,
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval: () => {},
      fetch: fetchStub,
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
  return {
    api, bannerEl, mainEl, toasts, documentShim, apiStub,
    advance: (ms) => FakeDate._advance(ms),
    headerEl, sseEl, healthChip, healthText, intervals, fetchCalls,
    setHealth: (impl) => { healthImpl = impl; },
  };
}

describe('connection-status IIFE plumbing', () => {
  it('setDataHealth creates the banner once and shows it for stale data', () => {
    const { api, bannerEl, toasts } = runModuleSandbox();
    api.setDataHealth({ status: 'stale', actionableSourceCount: 2 });
    assert.equal(bannerEl.className, 'data-freshness-banner visible');
    // Status token is localized via the REAL RO dictionary ('învechit').
    assert.match(bannerEl.innerHTML, /Starea datelor: învechit \(2 surse actuale\)/);
    // The link text is read from the dictionary rather than typed out here.
    // A hand-typed literal had drifted: this line carried U+01CE (a with DOUBLE
    // breve) where i18n.js holds the standard U+0103, so the assertion failed on a
    // spelling variant rather than on any behaviour. The sandbox already loads the
    // real dictionary, so reading the value makes that class of drift impossible.
    assert.ok(bannerEl.innerHTML.includes(REAL_RO.runScrape), 'banner must carry the dictionary runScrape text');
    assert.ok(!toasts.length);
  });

  it('the banner names the window the stale verdict was reached with', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: 'stale', actionableSourceCount: 2, prematchMaxAgeMs: 600000 });
    // Read the phrase from the dictionary rather than typing it, for the same
    // reason the runScrape assertion above does.
    const limit = REAL_RO.freshnessLimit.replace('{minutes}', '10');
    assert.ok(bannerEl.innerHTML.includes(limit), `banner names the 10-minute window: ${limit}`);
    // And it is part of the same sentence as the verdict, not a second element
    // bolted on: "stale" with no threshold is a verdict the reader cannot weigh
    // against the "Run scrape" call to action sitting next to it.
    assert.match(bannerEl.innerHTML, /Starea datelor: învechit \(2 surse actuale\)/);
    // The rounding is seconds → whole minutes, so a window that is not a round
    // number of minutes still reads as the number of minutes it is.
    const g = runModuleSandbox();
    g.api.setDataHealth({ status: 'stale', prematchMaxAgeMs: 90_000 });
    assert.ok(g.bannerEl.innerHTML.includes(REAL_RO.freshnessLimit.replace('{minutes}', '2')),
      'a 90s window is shown as the 2 minutes it rounds to');
  });

  it('a scan that does not carry a window is not given one', () => {
    // The control for the assertion above, and the more important of the two.
    // `stale` is produced by comparing a source age against this window, so a
    // scan published before the field existed cannot say how stale is too
    // stale — and this module must not answer with a constant of its own. That
    // is precisely the fault the scanner page's live-window note was rewritten
    // to stop making: a UI asserting a backend constant it cannot observe.
    const cases = [
      ['absent', { status: 'stale', actionableSourceCount: 2 }],
      ['undefined', { status: 'stale', actionableSourceCount: 2, prematchMaxAgeMs: undefined }],
      ['zero', { status: 'stale', prematchMaxAgeMs: 0 }],
      ['negative', { status: 'stale', prematchMaxAgeMs: -600000 }],
      ['not a number', { status: 'stale', prematchMaxAgeMs: 'soon' }],
      ['NaN', { status: 'stale', prematchMaxAgeMs: Number.NaN }],
    ];
    // The literal text BEFORE the placeholder, not the whole phrase. Checking
    // for `freshnessLimit` itself would never match rendered output — the
    // placeholder is gone by then — so a banner printing "limita: -100 min"
    // would have passed. Mutation showed exactly that, and this line is the
    // repair; the decision-level tests above pin the same branch from the other
    // side.
    const prefix = REAL_RO.freshnessLimit.split('{')[0];
    assert.ok(prefix.length > 0, 'the phrase must have literal text before the placeholder');
    for (const [label, health] of cases) {
      const { api, bannerEl } = runModuleSandbox();
      api.setDataHealth(health);
      assert.ok(!bannerEl.innerHTML.includes(prefix),
        `a ${label} window must not be rendered as a threshold`);
      // The verdict itself still renders — omitting the threshold must not
      // take the banner down with it.
      assert.match(bannerEl.innerHTML, /Starea datelor: învechit/, `the verdict still shows for ${label}`);
    }
  });

  it('only an age verdict names a window', () => {
    // `empty` means "the source observed no usable events", which has nothing
    // to do with age. A 10-minute pre-match limit printed beside it would be a
    // claim about a cause the verdict does not have.
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: 'empty', prematchMaxAgeMs: 600000 });
    assert.match(bannerEl.innerHTML, /Nu există date proaspete/);
    assert.ok(!bannerEl.innerHTML.includes(REAL_RO.freshnessLimit),
      'an empty verdict is not an age verdict and names no window');
    // The positive beside that negative: `partial` is reached by the same age
    // comparison as `stale`, so it does name the window. Without this the
    // assertion above would pass just as well if the limit were never printed.
    const g = runModuleSandbox();
    g.api.setDataHealth({ status: 'partial', actionableSourceCount: 1, prematchMaxAgeMs: 600000 });
    assert.ok(g.bannerEl.innerHTML.includes(REAL_RO.freshnessLimit.replace('{minutes}', '10')),
      'partial is an age verdict too and does name the window');
    // And a window on a hidden banner changes nothing, because nothing renders.
    const f = runModuleSandbox();
    f.api.setDataHealth({ status: 'fresh', prematchMaxAgeMs: 600000 });
    assert.ok(!f.bannerEl.className.includes('visible'));
  });

  it('the threshold phrase exists in both languages', () => {
    // A key missing from one dictionary does not throw here — t() hands back the
    // key itself — so the banner would silently print "freshnessLimit" to a
    // reader. That is the failure this pins.
    for (const [lang, dict] of [['ro', REAL_RO], ['en', REAL_EN]]) {
      assert.notEqual(dict.freshnessLimit, 'freshnessLimit', `${lang} is missing freshnessLimit`);
      assert.match(dict.freshnessLimit, /\{minutes\}/, `${lang} interpolates the number`);
    }
    // And the two are not the same string left untranslated, which is the
    // other way this key goes wrong.
    assert.notEqual(REAL_EN.freshnessLimit, REAL_RO.freshnessLimit);
    // The unit is part of the claim, not decoration: "limita: 10" is a bare
    // figure and "limita: 10 h" would be a different verdict entirely. Nothing
    // else in this file reads the rendered unit, so without this line the
    // phrase could lose it silently.
    assert.match(REAL_RO.freshnessLimit.replace('{minutes}', '10'), /10 min$/,
      'the substituted phrase still carries its unit');
    assert.match(REAL_EN.freshnessLimit.replace('{minutes}', '10'), /10 min$/);
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
    // Real RO text for empty status.
    assert.match(bannerEl.innerHTML, /Nu există date proaspete/);
  });

  it('setDataHealth neutralizes an injection-style status via the allowlist (XSS guard)', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: '<script>alert(1)</script>' });
    // The payload is not in the allowlist → treated as unknown → hidden, so
    // nothing script-like ever reaches innerHTML (defense in depth).
    assert.equal(bannerEl.className, 'data-freshness-banner');
    assert.ok(!bannerEl.classList.contains('visible'));
    assert.ok(!bannerEl.innerHTML.includes('<script>'));
  });

  it('setDataHealth still renders when <main> is absent', () => {
    const { api, bannerEl, mainEl } = runModuleSandbox({ noMain: true });
    api.setDataHealth({ status: 'stale' });
    assert.equal(bannerEl.className, 'data-freshness-banner visible');
    assert.equal(mainEl._firstChild, undefined, 'banner not inserted into <main>');
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

  it('wrapApiForToasts toasts on a failing POST', async () => {
    const { apiStub, toasts } = runModuleSandbox({ withApi: true });
    await assert.rejects(apiStub.post('/api/x', {}), /boom/);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'error');
    assert.equal(toasts[0].msg, 'boom');
  });

  it('wrapApiForToasts stays silent for 401 and 403', async () => {
    const { apiStub, toasts } = runModuleSandbox({ withApi: true });
    apiStub.post = async () => {
      throw Object.assign(new Error('nope'), { status: 403 });
    };
    apiStub.get = async () => {
      throw Object.assign(new Error('no auth'), { status: 401 });
    };
    await assert.rejects(apiStub.post('/api/y', {}), /nope/);
    await assert.rejects(apiStub.get('/api/z'), /no auth/);
    assert.equal(toasts.length, 0);
  });

  it('wrapApiForToasts does not double-wrap (single _toastsWired guard)', async () => {
    const { apiStub, toasts } = runModuleSandbox({ withApi: true });
    // The module wrapped once at init. Re-entering init / calling the wrapper
    // twice must not stack wrappers.
    assert.equal(apiStub._toastsWired, true);
    const before = toasts.length;
    // The wrapper captured the ORIGINAL post (which throws 'boom').
    await assert.rejects(apiStub.post('/api/x', {}), /boom/);
    assert.equal(toasts.length, before + 1, 'exactly one toast: not double-wrapped');
  });

  it('wrapApiForToasts toasts for failing PUT and DEL', async () => {
    const { apiStub, toasts } = runModuleSandbox({ withApi: true });
    // The wrappers captured the throwing put/del injected via withApi.
    await assert.rejects(apiStub.put('/api/a', {}), /put fail/);
    await assert.rejects(apiStub.del('/api/b'), /del fail/);
    assert.equal(toasts.length, 2);
    assert.ok(toasts.every((t) => t.type === 'error'));
  });

  it('wrapApiForToasts honors _silent errors (no toast)', async () => {
    const { apiStub, toasts } = runModuleSandbox({ withApi: true });
    const silent = Object.assign(new Error('quiet'), { _silent: true });
    apiStub.post = async () => { throw silent; };
    await assert.rejects(apiStub.post('/api/x', {}), /quiet/);
    assert.equal(toasts.length, 0);
  });

  it('setDataHealth hides the banner for unknown statuses (allowlist)', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: 'weird' });
    // 'weird' is not in the allowlist → treated as 'unknown' → no banner.
    assert.equal(bannerEl.className, 'data-freshness-banner');
    assert.ok(!bannerEl.classList.contains('visible'));
  });

  it('setDataHealth hides the banner for the real-but-unallowlisted failed status', () => {
    const { api, bannerEl } = runModuleSandbox();
    // 'failed' is a real DATA_STATUS but not in the banner allowlist →
    // treated as 'unknown' → hidden (defense in depth).
    api.setDataHealth({ status: 'failed' });
    assert.equal(bannerEl.className, 'data-freshness-banner');
    assert.ok(!bannerEl.classList.contains('visible'));
  });

  it('setDataHealth localizes partial via the real RO dictionary', () => {
    const { api, bannerEl } = runModuleSandbox();
    api.setDataHealth({ status: 'partial', actionableSourceCount: 1 });
    assert.match(bannerEl.innerHTML, /Starea datelor: parțial \(1 surse actuale\)/);
  });
});

// ── the GET /api/health chip ───────────────────────────────────────────────
// A liveness panel, so the header answers two different questions: the SSE
// chip says the socket is open, this one says the API still answers. They
// fail independently, which is the whole reason both are there.

const flush = () => new Promise((r) => setImmediate(r));

describe('health chip: creation and the first paint', () => {
  it('inserts itself after the connection chip, not before it', () => {
    const { headerEl, sseEl, healthChip } = runModuleSandbox();
    const chip = healthChip();
    assert.ok(chip, 'the chip must exist after init');
    assert.equal(headerEl._children[0], sseEl, 'the SSE chip stays where the page put it');
    assert.equal(headerEl._children[1], chip, 'the health chip is inserted after it');
    assert.equal(chip.nextSibling, null);
  });

  it('is neutral until the first answer arrives — never green', () => {
    // A chip that claims a healthy server before it has asked is a lie the
    // user reads as data.
    const { healthChip } = runModuleSandbox({ health: () => new Promise(() => {}) });
    const chip = healthChip();
    assert.equal(chip.className, 'chip outline');
    assert.equal(chip.getAttribute('role'), 'status');
  });

  it('never builds a second chip, however many times it paints', async () => {
    const { headerEl, api, setHealth } = runModuleSandbox();
    await flush();
    setHealth(async () => ({ ok: true, json: async () => ({ uptimeSeconds: 10 }) }));
    await api.refreshHealth();
    await api.refreshHealth();
    assert.equal(headerEl._children.length, 2, 'SSE chip + exactly one health chip');
  });

  it('does nothing on a page with no #sse-status anchor, and does not throw', async () => {
    const { api, healthChip } = runModuleSandbox({ noAnchor: true });
    assert.equal(healthChip(), null);
    await api.refreshHealth();
    assert.equal(healthChip(), null);
  });
});

describe('health chip: the three states', () => {
  it('paints green with the uptime and a named tooltip when the route answers', async () => {
    const { api, healthChip, healthText, fetchCalls } = runModuleSandbox();
    await api.refreshHealth();
    const chip = healthChip();
    assert.equal(chip.className, 'chip green');
    assert.equal(chip.querySelector('.dot').className, 'dot ok');
    assert.equal(healthText().textContent, '1d 1h');
    // The tooltip names the field, so a bare uptime is not read as a level.
    assert.equal(chip.title, `${REAL_RO.systemHealth}: 1d 1h`);
    // A liveness probe must not be served from cache: a stale 200 would hide
    // the outage this chip exists to show.
    assert.equal(fetchCalls.at(-1)[0], '/api/health');
    assert.deepEqual(fetchCalls.at(-1)[1], { cache: 'no-store' });
  });

  it('paints red with the real RO label when the request fails, and stays quiet', async () => {
    const { api, healthChip, healthText, toasts } = runModuleSandbox({
      health: async () => { throw new Error('connection refused'); },
    });
    await api.refreshHealth();
    const chip = healthChip();
    assert.equal(chip.className, 'chip red');
    assert.equal(chip.querySelector('.dot').className, 'dot error');
    assert.equal(healthText().textContent, REAL_RO.healthUnreachable);
    // The control on the biggest risk in this feature: the chip goes through
    // window.fetch precisely so wrapApiForToasts cannot turn a 30s probe into
    // a 30s error toast.
    assert.equal(toasts.length, 0, 'a failing liveness probe must not toast');
  });

  it('paints red when the route answers with an error status', async () => {
    const { api, healthChip, healthText } = runModuleSandbox({
      health: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    });
    await api.refreshHealth();
    assert.equal(healthChip().className, 'chip red');
    assert.equal(healthText().textContent, REAL_RO.healthUnreachable);
  });

  it('paints yellow with the plain label when the body is not JSON', async () => {
    // Reached the route, cannot read the answer: a state of its own, because
    // red here would be a false outage report.
    const { api, healthChip, healthText, toasts } = runModuleSandbox({
      health: async () => ({ ok: true, json: async () => { throw new SyntaxError('<html>'); } }),
    });
    await api.refreshHealth();
    const chip = healthChip();
    assert.equal(chip.className, 'chip yellow');
    assert.equal(chip.querySelector('.dot').className, 'dot warn');
    assert.equal(healthText().textContent, REAL_RO.systemHealth);
    assert.equal(toasts.length, 0);
  });

  it('recovers to green on the next good poll', async () => {
    const { api, healthChip, setHealth } = runModuleSandbox({
      health: async () => { throw new Error('down'); },
    });
    await api.refreshHealth();
    assert.equal(healthChip().className, 'chip red');
    setHealth(async () => ({ ok: true, json: async () => ({ uptimeSeconds: 61 }) }));
    await api.refreshHealth();
    assert.equal(healthChip().className, 'chip green');
  });
});

describe('health chip: the text sink', () => {
  it('writes textContent and never innerHTML', async () => {
    // Measured in a real browser last batch: escapeHtml('run&7') is
    // 'run&amp;7', and textContent renders that literally. So this chip must
    // write textContent raw — pre-escaping it here would double-encode.
    const { api, healthText, healthChip } = runModuleSandbox();
    await api.refreshHealth();
    const span = healthText();
    assert.equal(span.textContent, '1d 1h');
    assert.equal(span.innerHTML, '', 'the label must not go through the HTML parser');
    assert.equal(healthChip().innerHTML, '');
  });
});

describe('health chip: the poll', () => {
  it('polls once on init, without waiting for the first interval', async () => {
    const { fetchCalls } = runModuleSandbox();
    await flush();
    assert.equal(fetchCalls.length, 1, 'init must paint the first answer on its own');
  });

  it('registers exactly one 30s interval, and firing it re-polls', async () => {
    const { intervals, fetchCalls, healthChip, setHealth } = runModuleSandbox();
    await flush();
    assert.equal(intervals.length, 1, 'one timer, not one per render');
    assert.equal(intervals[0].ms, 30_000);

    setHealth(async () => ({ ok: true, json: async () => ({ uptimeSeconds: 7200 }) }));
    await intervals[0].fn();
    assert.equal(fetchCalls.length, 2);
    assert.equal(healthChip().querySelector('span:last-child').textContent, '2h');
  });

  it('keeps a rejected poll from escaping as an unhandled rejection', async () => {
    const { intervals, setHealth } = runModuleSandbox();
    await flush();
    setHealth(async () => { throw new Error('socket hang up'); });
    // The interval callback is invoked bare, exactly as the browser does it:
    // a rejection here would surface as an unhandled rejection in the page.
    await assert.doesNotReject(Promise.resolve(intervals[0].fn()));
  });
});

describe('health chip: the classes it writes are defined in the stylesheet', () => {
  // The module writes class names into the DOM and no JavaScript assertion can
  // see whether the stylesheet defines them. Dropping `.dot.ok` renders a grey
  // dot on a green chip — a chip that claims the server is fine while showing
  // the neutral colour — and the whole suite would stay green. So the contract
  // between the two files is asserted here, one selector at a time.
  const SELECTORS = [
    '.dot.ok', '.dot.error', '.dot.warn',
    '.chip.green', '.chip.red', '.chip.yellow', '.chip.outline',
  ];
  for (const selector of SELECTORS) {
    it(`${selector} is defined in theme.css`, () => {
      const escaped = selector.replace(/\./g, '\\.');
      assert.ok(new RegExp(`${escaped}\\s*[,{]`).test(themeCss),
        `connection-status.js writes ${selector} but theme.css defines no rule for it`);
    });
  }

  // The control beside those seven: a selector that is NOT written by the
  // module must not pass the same check, or the assertion is a tautology that
  // matches anything containing a dot.
  it('the check is not satisfied by a class that does not exist', () => {
    assert.ok(!new RegExp('\\.dot\\.nope\\s*[,{]').test(themeCss));
  });
});

// ── GET /api/health: the payload contract ────────────────────────────────────
// A census, because a field nobody reads is either a lost feature or a
// deliberate one, and only a written reason can tell them apart. The route
// publishes three fields (src/router.mjs:55); the chip reads one of them. The
// other two are excused below, each with the measurement its excuse rests on —
// and each excuse is written to EXPIRE: the assertion that carries it fails the
// day the premise changes, instead of the excuse quietly outliving it.
//
// The census is scoped by FUNCTION, not by receiver name, because `health` is
// the parameter name of two different payloads in this one file:
//   - decideHealthChip(health) — the /api/health payload, painted as the chip;
//   - decideHealthBanner(health) — /api/scan's dataHealth ({status,
//     actionableSourceCount, prematchMaxAgeMs}), painted by setDataHealth.
// A census keyed on the receiver alone reports FOUR fields read for /api/health
// and is wrong about three of them — presence counted as evidence. So the split
// is pinned at the bottom of this section rather than merely explained here.

const routerSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'router.mjs'), 'utf8');
const HEALTH_MARKER = "'GET /api/health': () => sendJson(null, 200, {";
const HEALTH_KEYS = objectKeys(routerSrc, HEALTH_MARKER);
const healthField = (name) => objectEntries(routerSrc, HEALTH_MARKER).find((f) => f.key === name);

const chipReads = guardedPropertyReads(extractFn('decideHealthChip', src), ['health']);
const paintReads = guardedPropertyReads(extractFn('renderHealth', src), ['health']);
const bannerReads = guardedPropertyReads(extractFn('decideHealthBanner', src), ['health']);
const readKeys = (reads) => reads.map((r) => r.key).sort();

/**
 * Line in connection-status.js where a named function begins.
 *
 * The detector reports `loc` against the text it was GIVEN, and what it is given
 * here is an extracted function — so `decideHealthChip`'s read of
 * `health.uptimeSeconds` arrives as line 5, not as the 158 a reader needs to
 * open. Pinning 5 would be pinning a property of the extraction; adding the
 * function's own start line back puts the number back where it came from, which
 * is the only version a reader can check against the file.
 */
const fnStartLine = (name) => src.slice(0, src.indexOf(extractFn(name, src))).split('\n').length;
const fileLine = (name, lineInFn) => fnStartLine(name) + lineInFn - 1;

describe('GET /api/health: the payload contract', () => {
  it('publishes exactly ok, timestamp and uptimeSeconds', () => {
    // router.test.mjs already pins that each of the three is present and of the
    // right type. This pins that there is no FOURTH, which that test cannot see:
    // a new field would pass every assertion there while nothing on any page
    // read it.
    assert.deepEqual(HEALTH_KEYS, ['ok', 'timestamp', 'uptimeSeconds'],
      'the route publishes a different field set; every unread one has to be read or excused below');
  });

  it('the chip reads uptimeSeconds and nothing else off the payload', () => {
    assert.deepEqual(readKeys(chipReads), ['uptimeSeconds'],
      'the payload field the chip acts on changed — the three states are decided from it alone');
    assert.equal(fileLine('decideHealthChip', chipReads[0].line), 158,
      'the read moved: decideHealthChip is the one function allowed to name a payload field');
    assert.deepEqual(readKeys(paintReads), [],
      'renderHealth paints the decision and forwards the payload; it reads no field of it');
  });

  it('names both unread fields, so neither can go unnoticed', () => {
    const unread = HEALTH_KEYS.filter((k) => !readKeys(chipReads).includes(k));
    assert.deepEqual(unread, ['ok', 'timestamp'],
      'the unread set changed: read the new field or write an excuse for it here');
  });

  it('excuse for `ok`: it is the constant true, and a constant is not a signal', () => {
    // The measurement the excuse rests on: objectEntries reports the value node
    // as a LITERAL. The response arriving is the signal this chip acts on — a
    // route that answers 200 with a body is the only thing it can observe — so
    // a flag that is always true would add a field to trust and nothing to read.
    const ok = healthField('ok');
    assert.ok(ok, 'the route stopped publishing `ok`');
    assert.equal(ok.value, 'true',
      'ok no longer publishes the literal true. A literal that is not true is a different sentence from "a constant is not a signal" — measure what it is now and write the excuse that matches it');
    assert.ok(ok.literal,
      'ok is no longer a constant: a computed flag is a signal the chip may be ignoring. This excuse has expired — read the field, or write the new one, and do not leave it unread');
  });

  it('excuse for `timestamp`: zero reads, and one stamp per response cannot carry what it would be read for', () => {
    // The measurements. (1) Zero reads: the census above names `timestamp` as
    // unread and the detector is pinned below against being flattered by a
    // comment. (2) The only thing a server-side stamp can add to what the page
    // already has is the SERVER's clock, and detecting skew needs two samples —
    // one response stamp beside the Date.now() the browser already has is not a
    // comparison, it is a second copy of a moment the client can time itself.
    // (3) It is paid for on every poll: 39 bytes, and the chip polls every 30s
    // (the interval is pinned at "registers exactly one 30s interval" above),
    // which is 4,680 bytes an hour for a field nothing reads.
    const ts = healthField('timestamp');
    assert.ok(ts, 'the route stopped publishing `timestamp`');
    assert.ok(!ts.literal,
      'timestamp is now a constant: it has stopped being a stamp of this response and is the same on every poll, so whatever it was for no longer holds. Re-measure and re-excuse, do not keep this sentence');
    assert.ok(ts.value.includes('new Date()'),
      `timestamp is no longer built per request — it now reads: ${ts.value}`);

    const stamp = '2026-09-28T18:40:18.804Z';
    const withField = JSON.stringify({ ok: true, uptimeSeconds: 3600, timestamp: stamp });
    const without = JSON.stringify({ ok: true, uptimeSeconds: 3600 });
    assert.equal(withField.length - without.length, 39,
      'the cost the excuse quotes has moved; re-measure it rather than leaving a stale number in a comment');
  });

  it('the read detector cannot be flattered by a comment naming the field', () => {
    // The whole census rests on "zero reads", and a prose mention of
    // `health.timestamp` in a future comment must not be able to pay that debt
    // off — or, in the other direction, a detector that saw comments would make
    // this section's own count meaningless. Both directions, because the control
    // is the half that fails silently.
    const prose = ['function f(health) {',
      '  // health.timestamp is deliberately never read',
      '  return health.uptimeSeconds;',
      '}'].join('\n');
    assert.deepEqual(readKeys(guardedPropertyReads(prose, ['health'])), ['uptimeSeconds'],
      'a comment was counted as a read');
    assert.deepEqual(guardedPropertyReads('function f(health) { return 1; }', ['health']), [],
      'the detector reported a read where there is none — it is measuring something other than reads');
  });

  it('the receiver named `health` carries two payloads, and the split is pinned', () => {
    // The trap this section is scoped around, fixed in numbers so a future
    // census cannot walk into it: three of the four `health.*` reads in this
    // file belong to /api/scan's dataHealth, not to /api/health.
    assert.deepEqual(readKeys(bannerReads), ['actionableSourceCount', 'prematchMaxAgeMs', 'status'],
      'the /api/scan dataHealth fields this file reads changed');
    assert.deepEqual(bannerReads.map((r) => fileLine('decideHealthBanner', r.line)).sort((a, b) => a - b), [59, 62, 76],
      'those reads moved');
    assert.equal(guardedPropertyReads(src, ['health']).length, 4,
      'the whole file no longer reads `health` exactly four times — re-measure the split before quoting any of these numbers');
  });
});
