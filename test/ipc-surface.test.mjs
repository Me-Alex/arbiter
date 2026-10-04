/**
 * ipc-surface.test.mjs — the desktop half of "is every backend capability
 * connected to the frontend".
 *
 * `api-surface.test.mjs` already closes the HTTP route census, field by field
 * and route by route. This file does the same job for the other backend →
 * frontend channel, which nothing measured: the Electron main process. It has
 * two surfaces that are easy to confuse and were confused here —
 *
 *   - `mainWindow`, a BrowserWindow that holds a BrowserView and loads no page
 *   - `browserView.webContents`, the one surface that actually renders the app
 *
 * The preload was attached to `mainWindow`, which never runs a preload because
 * it never loads a document. So `window.arbiter` was undefined in the page,
 * and the first rung of the alert ladder (public/js/alerts.js, fed by
 * `bridge: window.arbiter` in pages/scanner.js) could not fire: the page asked
 * the main process for a desktop notification, got nothing back, and degraded
 * a rung down with no error anywhere. The capability — `ipcMain.handle
 * ('arbiter:notify')`, a full implementation with tag replacement and a
 * bounded map — was there the whole time, unreachable. The updater had the
 * mirror image of the same mistake: `initAutoUpdater(mainWindow)` pushed five
 * `update-*` events at `mainWindow.webContents`, and nothing anywhere
 * subscribed to any of them.
 *
 * The measurements run in both directions on purpose. A census that only
 * counts what the renderer reads passes just as happily when the main process
 * has nothing to offer; one that only counts what the main process offers
 * passes when the renderer ignores all of it. Each side is asserted non-empty
 * before either is used to judge the other.
 *
 * Nothing here reads a number out of prose. The exemptions — the six bridge
 * functions the page does not call — each name a main-process path that
 * delivers the same capability, and each of those paths is re-measured here,
 * so an exemption cannot outlive the thing that justified it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT_DIR, path), 'utf8');

const mainSource = read('electron/main.mjs');
const preloadSource = read('electron/preload.mjs');
const autoUpdateSource = read('electron/auto-update.mjs');
const appSource = read('public/js/app.js');
const i18nSource = read('public/js/i18n.js');

// Comments are stripped once, per file, before anything is sliced out of it:
// `codeOnly` tokenizes a whole program, and it says so loudly if handed a
// fragment. Several of the reasons below name file positions in prose, so
// reading a measurement off the stripped text would let a comment answer.
const mainCode = codeOnly(mainSource, true);
const preloadCode = codeOnly(preloadSource, true);
const autoUpdateCode = codeOnly(autoUpdateSource, true);
const scannerCode = codeOnly(read('public/js/pages/scanner.js'), true);
const alertsCode = codeOnly(read('public/js/alerts.js'), true);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split(/\r?\n/).length;

/* ------------------------------------------------------------------ *
 * 1. The main process: what it answers, and what it can push.
 * ------------------------------------------------------------------ */

/** Every channel the main process answers, with the verb it answers on. */
const mainChannels = [...mainCode.matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)]
  .map((m) => ({ channel: m[2], via: m[1], line: lineOf(mainSource, m.index) }));

/** The channels `auto-update.mjs` pushes, named as it names them. */
const pushedChannels = [...autoUpdateCode.matchAll(/\btoPage\(\s*'([^']+)'/g)]
  .map((m) => m[1]);

/**
 * The surface a push is aimed at, read at the one call site that decides it.
 * `initAutoUpdater` takes the window (to parent a dialog to) and a separate
 * function (to push with); those are different surfaces, and reading the
 * argument is what keeps them from being swapped back.
 */
const pushTarget = (() => {
  const call = /initAutoUpdater\(\s*(\w+)\s*,\s*\(?[^)]*\)?\s*=>\s*(\w+)\??\.webContents\.send\(/.exec(mainCode);
  return call ? { window: call[1], target: call[2] } : null;
})();

/* ------------------------------------------------------------------ *
 * 2. The bridge: one export per line, in preload.mjs.
 * ------------------------------------------------------------------ */

/** Each `window.arbiter` export, the channel it forwards, and the direction. */
const bridged = preloadCode.split(/\r?\n/).flatMap((line) => {
  const m = /^\s{2}(\w+):\s*\(.*?\)\s*=>\s*ipcRenderer\.(invoke|send|on)\(\s*'([^']+)'/.exec(line);
  return m ? [{ name: m[1], via: m[2], channel: m[3] }] : [];
});

const listeners = bridged.filter((b) => b.via === 'on');

/* ------------------------------------------------------------------ *
 * 3. The renderer: who reads the bridge.
 * ------------------------------------------------------------------ */

/**
 * Reads of the bridge, over code only, in both of the shapes the pages use.
 *
 * The dotted form alone is not enough, and missing it is what made the first
 * run of this file report zero renderer reads on a tree where two pages use the
 * bridge: neither of them says `window.arbiter.notify`. `app.js` takes the
 * whole object (`const bridge = window.arbiter`) and then reads properties off
 * the local name, and `pages/scanner.js` injects it as a dependency
 * (`bridge: window.arbiter`). So both a bare read and the alias it is bound to
 * are followed. The dotted form is required rather than a bare
 * `window.arbiter[A-Z]`: the other page globals are `arbiterApi`,
 * `arbiterI18n`, `arbiterSse`, `arbiterApp` and `arbiterConnectionStatus`, and
 * a looser pattern would let any of them answer for the desktop bridge.
 */
const rendererReads = new Map();
const note = (name, where) => {
  if (!rendererReads.has(name)) rendererReads.set(name, []);
  rendererReads.get(name).push(where);
};
for (const file of walk(join(ROOT_DIR, 'public'))) {
  const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  const code = codeOnly(raw, true);
  for (const m of code.matchAll(/\bwindow\.arbiter\.(\w+)/g)) {
    note(m[1], `${rel}:${lineOf(raw, m.index)}`);
  }
  // The whole-object read, and the name it is bound to. `bridge` here is a
  // local alias and nothing else: the match is on the assignment itself, so
  // an unrelated `bridge` in another file cannot answer for it.
  const aliases = new Set();
  for (const m of code.matchAll(/\bconst\s+(\w+)\s*=\s*window\.arbiter\b/g)) aliases.add(m[1]);
  if (!aliases.size) continue;
  const aliasSource = aliases.size === 1
    ? [...aliases][0]
    : [...aliases].join('|');
  for (const m of code.matchAll(new RegExp(`\\b(?:${aliasSource})\\.(\\w+)`, 'g'))) {
    note(m[1], `${rel}:${lineOf(raw, m.index)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. The menu: capabilities the operator triggers without the renderer.
 * ------------------------------------------------------------------ */

const menuBlock = (() => {
  const start = mainSource.indexOf('function buildAppMenu()');
  assert.notEqual(start, -1, 'the menu builder moved; this census cannot find it');
  // The working tree is CRLF, so a `'\n}\n'` slice finds nothing at all here
  // and the two measurements below would both be vacuously true.
  const end = /\r?\n\}\r?\n/.exec(mainSource.slice(start));
  assert.ok(end, 'the menu builder has no closing brace on its own line');
  return mainSource.slice(start, start + end.index);
})();

/** Every function the menu calls on the operator's behalf. */
const menuCalls = new Set(
  [...menuBlock.matchAll(/click:\s*\(\)\s*=>\s*([A-Za-z_$][\w$.]*)\(/g)].map((m) => m[1]),
);

/* ------------------------------------------------------------------ *
 * 5. The two surfaces, sliced out of createWindow.
 * ------------------------------------------------------------------ */

function constructorBlock(constructor) {
  const start = mainSource.indexOf(`new ${constructor}({`);
  if (start < 0) return '';
  const end = mainSource.indexOf('});', start);
  return end < 0 ? '' : mainSource.slice(start, end + 3);
}

const windowBlock = constructorBlock('BrowserWindow');
const viewBlock = constructorBlock('BrowserView');

/* ================================================================== *
 * The measurements.
 * ================================================================== */

test('both sides of the desktop channel are non-empty, or nothing below can say anything', () => {
  // The census is only meaningful over a channel that exists in both
  // directions. Each count is asserted against the file it came from, so an
  // extractor that silently found nothing fails here instead of reporting a
  // clean bill of health.
  assert.equal(mainChannels.length, 7,
    'the main process answers this many channels; a smaller number means the extractor moved, not that the app shrank');
  assert.equal(bridged.length, 12,
    'the bridge exposes this many functions');
  assert.equal(pushedChannels.length, 5,
    'the updater pushes this many events');
  assert.equal(listeners.length, pushedChannels.length,
    'and the bridge listens for exactly that many');
  // Tied to the preload rather than written out: the sixth function the page
  // reaches is `notify`, and it is reached by dependency injection rather than
  // by a read of the bridge, so it is measured in its own test below rather
  // than counted here.
  assert.equal(rendererReads.size, listeners.length,
    'the renderer reads one bridge function per listener the preload exposes');
  assert.ok(pushedChannels.length > 0 && rendererReads.size > 0,
    'a census needs at least one sender and one subscriber to have anything to classify');
});

test('the preload rides on the surface that renders the app', () => {
  // The whole defect in one assertion pair. `mainWindow` loads no document, so
  // a preload on it never executes; `browserView` is what `loadURL` is called
  // on. Both blocks must be non-empty for this to be a measurement rather than
  // two matches against nothing.
  assert.ok(windowBlock.length > 20 && viewBlock.length > 20,
    `both webPreferences blocks were sliced out (got ${windowBlock.length} and ${viewBlock.length} bytes); a short one means the extractor lost them`);
  assert.match(viewBlock, /preload:\s*join\(__dirname,\s*'preload\.mjs'\)/,
    'the view that renders the page carries the preload');
  assert.doesNotMatch(windowBlock, /preload/,
    'the window that only holds a view must not carry it: a preload there never runs, which is how the alert ladder lost its first rung');
});

test('the updater pushes at the page surface and not at the frame around it', () => {
  assert.ok(pushTarget, 'the initAutoUpdater call no longer passes a push target');
  assert.equal(pushTarget.target, 'browserView',
    'the pushes go to the surface that renders the app');
  assert.doesNotMatch(autoUpdateSource, /mainWindow\?\.webContents\.send/,
    'auto-update.mjs derives its target from the window again, which is the mistake this census exists to catch');
});

test('every channel the main process answers is reached from the page or the menu', () => {
  const viaBridge = new Set(bridged.filter((b) => b.via !== 'on').map((b) => b.channel));
  assert.deepEqual(mainChannels.filter((c) => !viaBridge.has(c.channel)).map((c) => `${c.via} ${c.channel}`), [],
    'these main-process channels have nothing in the bridge that would ever reach them');
  // The control for the direction that matters: a bridge forwarding nothing
  // would satisfy the assertion above vacuously.
  assert.ok(viaBridge.size >= mainChannels.length,
    `the bridge forwards ${viaBridge.size} channels for ${mainChannels.length} handlers`);
});

test('every pushed event has a listener, and every listener has a push behind it', () => {
  const listened = new Set(listeners.map((b) => b.channel));
  assert.deepEqual([...pushedChannels].filter((c) => !listened.has(c)).sort(), [],
    'the updater pushes events nobody in the page listens for');
  assert.deepEqual([...listened].filter((c) => !pushedChannels.includes(c)).sort(), [],
    'the bridge listens for events the updater never sends — `update-progress` was one of these, reading as a wired feature');
});

/**
 * The six bridge functions the page does not call. Each one is a capability
 * the operator can still reach, through the main process directly — and each of
 * those paths is measured below rather than credited, so deleting the menu
 * item that justifies an exemption fails this test instead of leaving it.
 */
const BY_MAIN_PROCESS = {
  restart: () => menuCalls.has('restartServer'),
  quit: () => /\{\s*role:\s*isMac\s*\?\s*'close'\s*:\s*'quit'\s*\}/.test(menuBlock),
  openExternal: () => /setWindowOpenHandler\([\s\S]{0,200}shell\.openExternal\(/.test(mainSource),
  checkForUpdates: () => menuCalls.has('checkForUpdates'),
  installUpdate: () => menuCalls.has('installUpdate'),
  getVersion: () => /label:\s*'About Arbiter'[\s\S]{0,400}getVersion\(\)/.test(menuBlock),
};

/**
 * `notify` is the one bridge function the page reaches without a dotted read:
 * it is injected into the alert client as a dependency (`bridge:
 * window.arbiter`) and read off the parameter there, so the alias scan above
 * cannot see it. It is credited here — measured on both ends of that path, not
 * asserted in prose — because crediting it as "main-process-only" would be the
 * exact lie this file was written to stop telling.
 */
const INJECTED = {
  notify: () => /bridge:\s*window\.arbiter\b/.test(scannerCode)
    && /\bbridge\.notify\b/.test(alertsCode)
    && /return\s*'electron'/.test(alertsCode),
};

test('every bridge function the page does not call has a main-process path that reaches the operator', () => {
  const uncalled = bridged
    .filter((b) => !rendererReads.has(b.name) && !Object.hasOwn(INJECTED, b.name))
    .map((b) => b.name);
  assert.deepEqual(uncalled.sort(), Object.keys(BY_MAIN_PROCESS).sort(),
    'these bridge functions are called by neither the page nor a measured main-process path');
  for (const [name, measured] of Object.entries(BY_MAIN_PROCESS)) {
    assert.ok(measured(), `\`${name}\` is exempted because the main process delivers it too, and that path is gone`);
  }
  for (const [name, measured] of Object.entries(INJECTED)) {
    assert.ok(measured(), `\`${name}\` is credited as called, and the injection path it was credited through is gone`);
  }
  // And the exemptions are not a hole: the functions the page does call are
  // measured the same way, against the page, and an exempt name that the page
  // starts calling is a stale exemption rather than a harmless overlap.
  for (const b of bridged.filter((x) => rendererReads.has(x.name))) {
    assert.ok(!Object.hasOwn(BY_MAIN_PROCESS, b.name),
      `\`${b.name}\` is now read by the page as well as exempted as main-process-only; one of the two is stale`);
  }
});

test('the alert ladder still offers the main process as its first rung', () => {
  // The reason the lot exists, pinned at the call site that consumes the
  // bridge. Before the repair this read `bridge: window.arbiter` against a
  // binding the page never had, so rung 1 could not return 'electron'.
  assert.match(scannerCode, /bridge:\s*window\.arbiter\b/,
    'the alert client still offers the main process as its first rung');
  assert.match(alertsCode, /if\s*\(bridge\s*&&\s*typeof bridge\.notify\s*===\s*'function'\)/,
    'and the ladder still tests the bridge before falling a rung down');
  assert.match(alertsCode, /return\s*'electron'/,
    'so a working bridge is what earns the top rung');
});

/* ------------------------------------------------------------------ *
 * 6. Behaviour, not just shape: the page's own reaction to a push.
 * ------------------------------------------------------------------ */

/**
 * The real page file and the real dictionary, with a bridge built from the
 * real preload: the export names come from `bridged`, so the harness cannot
 * claim a listener the preload does not expose.
 */
function pageWith({ bridge } = {}) {
  const toasts = [];
  const listenersSeen = new Map();
  const exposed = bridge === null
    ? undefined
    : Object.fromEntries(listeners.map((b) => [b.name, (cb) => listenersSeen.set(b.channel, cb)]));
  const context = {
    // The dictionary picks its language from storage and defaults to Romanian;
    // the assertions below are written in English, so it has to be pinned
    // rather than inherited.
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? 'en' : null), setItem() {} },
    document: { documentElement: { dataset: {} }, addEventListener() {} },
    console,
  };
  context.window = context;
  context.showToast = (message, type, opts) => toasts.push({ message, type, duration: opts && opts.duration });
  vm.runInNewContext(i18nSource, context);
  context.arbiterI18n = context.window.arbiterI18n;
  context.arbiter = exposed;
  vm.runInNewContext(appSource, context);
  return { toasts, listenersSeen };
}

test('an update event is said out loud, and "nothing to install" is not', () => {
  const { toasts, listenersSeen } = pageWith();
  assert.equal(listenersSeen.size, 5, 'the page listens for all five events the updater pushes');

  listenersSeen.get('update-checking')();
  assert.match(toasts.at(-1).message, /Checking for updates/);
  assert.equal(toasts.at(-1).type, 'info');

  listenersSeen.get('update-available')({ version: '9.9.9' });
  assert.equal(toasts.at(-1).message, 'Update available: 9.9.9',
    'the version comes from the payload, not from a placeholder');

  listenersSeen.get('update-downloaded')({ version: '9.9.9' });
  assert.equal(toasts.at(-1).message, 'Update 9.9.9 is downloaded — Install update and restart to apply it.');
  assert.equal(toasts.at(-1).type, 'success');

  listenersSeen.get('update-error')({ error: 'feed unreachable' });
  assert.equal(toasts.at(-1).message, 'Update check failed: feed unreachable');

  // The fifth is the control for the other four: the same subscriber shape, and
  // it deliberately says nothing, because "nothing to install" is the absence
  // of news. A page that toasted on every channel would pass the four
  // assertions above without this one.
  const before = toasts.length;
  listenersSeen.get('update-not-available')();
  assert.equal(toasts.length, before, 'a check that found nothing must not train the operator to dismiss toasts');
});

test('the same page in a browser tab subscribes to nothing and breaks nothing', () => {
  // A tab has no main process behind it, so `window.arbiter` is absent. This
  // is the other direction of the same guard: if it threw, every page in a
  // plain browser would fail at load.
  const { toasts, listenersSeen } = pageWith({ bridge: null });
  assert.deepEqual(toasts, []);
  assert.equal(listenersSeen.size, 0, 'a tab has no main process to subscribe to');
});

test('both update strings exist in both languages, with the placeholders the page substitutes', () => {
  // The dictionary is read through the page's own export line rather than a
  // copy of it, and the replacement is asserted to have happened — otherwise
  // this would pass on a missing label the same way it passed before.
  const EXPORT = 'window.arbiterI18n = { t, setLang, apply,';
  const exposed = i18nSource.replace(EXPORT, 'window.arbiterI18n = { dict, t, setLang, apply,');
  assert.notEqual(exposed, i18nSource,
    'the i18n export line moved; the dictionary is unreachable and this test would pass on a missing label');
  const context = {
    localStorage: { getItem: () => null, setItem() {} },
    document: { documentElement: { dataset: {} }, addEventListener() {} },
  };
  context.window = context;
  vm.runInNewContext(exposed, context);
  const { dict } = context.arbiterI18n;

  for (const key of ['updateChecking', 'updateAvailable', 'updateReady', 'updateFailed']) {
    for (const lang of ['en', 'ro']) {
      assert.equal(typeof dict[lang][key], 'string', `\`${key}\` is missing from ${lang}`);
      assert.notEqual(dict[lang][key], key, `\`${key}\` in ${lang} is the key itself, not a translation`);
    }
  }
  // The placeholders are the backend's payload keys, so a rename would leave
  // the operator reading a literal brace.
  assert.match(dict.en.updateAvailable, /\{version\}/);
  assert.match(dict.ro.updateAvailable, /\{version\}/);
  assert.match(dict.en.updateFailed, /\{error\}/);
  assert.match(dict.ro.updateFailed, /\{error\}/);
});