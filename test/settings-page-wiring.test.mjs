/**
 * settings-page-wiring.test.mjs — the Settings page against the route that
 * serves it, key by key.
 *
 * The page reads five routes and posts to two, and nothing measured it: the
 * scheduler block sent `bookId` and `profileId`, names no file under src/ has
 * ever read, while the route forwards `body.bookIds` and `scheduler.enable()`
 * throws `EBADINPUT` on an empty array — so saving from this page answered 400
 * whenever the schedule was running and did nothing at all when it was not.
 * The profile select was fed from `scrapers.profiles`, a key `GET /api/scrapers`
 * does not publish, and was pre-selected from `status().profileId`, which is not
 * published either.
 *
 * Everything below is measured twice, on both sides of the wire: what the page
 * sends comes out of its own payload literal, what the route accepts comes out
 * of the handler's `body`, and what the page reads back is compared against a
 * `status()` that is executed rather than transcribed from the source. A census
 * that quotes the source on both sides agrees with itself even when the wire is
 * broken, which is exactly how this page shipped broken.
 *
 * The fifth test measures what the form posts against what the backend reads.
 * It used to pin a gap — two inputs the whole backend had never read — and the
 * gap is paid now: `maxStake` and `maxAgeMinutes` are destructured, clamped
 * and applied. What is pinned is the two-sided claim: nothing the form posts
 * is dropped, and the caps are read in exactly the files that turn them into
 * a budget and a window.
 *
 * The sixth test executes the page: a save while the schedule is off must
 * refuse in a sentence both dictionaries have, before any POST — a disabled
 * save used to reach the route, which answers disable() and keeps the stored
 * options, so the form displayed numbers the server had just declined.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { codeOnly, fieldReads, functionSource, objectEntries } from './helpers/code-only.mjs';
import { SchedulerService } from '../src/scheduler-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const settingsSource = readFileSync(new URL('../public/js/pages/settings.js', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router.mjs', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const settingsCode = codeOnly(settingsSource, true);

/** The scheduler POST handler, cut between two route keys that are themselves pinned. */
function schedulerHandler() {
  const from = routerSource.indexOf("'POST /api/scheduler':");
  const to = routerSource.indexOf("'GET /api/live':");
  assert.ok(from !== -1 && to > from, 'the scheduler route moved — this census is now pointing at nothing');
  // The slice begins at a route key, i.e. at a property of the route table —
  // a fragment that is not a program on its own and cannot be tokenized as
  // one. Re-seat it in the object literal it was cut out of.
  return codeOnly(`const __routes = {${routerSource.slice(from, to)}\n};`, true);
}

/** The profiles GET handler, bounded the same way. */
function profilesHandler() {
  const from = routerSource.indexOf("'GET /api/profiles':");
  const to = routerSource.indexOf("'GET /api/scheduler':");
  assert.ok(from !== -1 && to > from, 'the profiles route moved — this census is now pointing at nothing');
  return codeOnly(`const __routes = {${routerSource.slice(from, to)}\n};`, true);
}

test('the payload the Settings page posts is the payload the route forwards', () => {
  const keys = objectEntries(settingsSource, 'const payload = {').map((e) => e.key).sort();
  assert.deepEqual(keys, ['bookIds', 'enabled', 'intervalMinutes', 'scanOptions'],
    'the scheduler payload changed — the route has to be told about it, not handed a key it drops');
  assert.ok(!keys.includes('bookId'), 'the route takes bookIds, an array: bookId is a name nothing reads');
  assert.ok(!keys.includes('profileId'), 'no file under src/ reads profileId — a profile is applied, not stored');

  // The other half of the same wire: every key the page sends has to be read
  // off `body` by the handler, or the page is writing into a field that does
  // not exist and the value is gone before the service sees it.
  const route = schedulerHandler();
  const dropped = keys.filter((k) => !route.includes(`body.${k}`));
  assert.deepEqual(dropped, [], `the route never reads these off the body: ${dropped.join(', ')}`);
});

test('every key the page reads off the scheduler status is one the status publishes', async () => {
  // Executed, not quoted: a status() transcribed from the same source the page
  // is compared against would agree with it even while the real one publishes
  // something else — and the two keys this page did read, `bookId` and
  // `profileId`, are exactly the ones the real status has never carried.
  const dataDir = mkdtempSync(join(tmpdir(), 'arbiter-settings-'));
  try {
    const scheduler = new SchedulerService({
      dataDir,
      configPath: join(dataDir, 'scrapers.json'),
      orchestrator: { isRunning: () => false, launch: async () => ({}) },
      logger: () => {},
    });
    const published = Object.keys(await scheduler.status());
    const read = fieldReads(settingsCode, 's');
    assert.ok(read.length > 0, 'the receiver this census reads is not bound anywhere');
    const unpublished = read.filter((k) => !published.includes(k));
    assert.deepEqual(unpublished, [], `the status publishes none of these: ${unpublished.join(', ')}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the profile options come from the route that publishes profiles', () => {
  assert.ok(settingsCode.includes("'/api/profiles'"),
    'the page never asks for the profiles the backend publishes');
  assert.ok(!settingsCode.includes('scrapers.profiles'),
    'GET /api/scrapers publishes jobs and three counters, and no profiles key among them');
  assert.ok(profilesHandler().includes('profiles'), 'the profiles route no longer publishes profiles');
  // The profile list is labelled, not named: scan-profiles.json carries `label`
  // on every entry, and a select that asks for `name` renders the raw id.
  assert.ok(settingsCode.includes('label'), 'the profile select reads a field the profile documents do not carry');
});

test('the guard for a schedule with no book is a sentence both languages have', () => {
  assert.ok(settingsCode.includes('noBookmakersSelected'),
    'the page needs a message for the one case enable() refuses outright');
  const defined = (codeOnly(i18nSource, true).match(/^\s*noBookmakersSelected:/gm) || []).length;
  assert.equal(defined, 2, 'the key must exist in the Romanian dictionary and the English one');
});

test('every key the Settings form posts is one the backend reads, and where', () => {
  // scanOptionsFromForm posts six keys; resolveScanRequest destructures its
  // input and returns eleven, clamped. The gap this test used to pin —
  // `maxStake` and `maxAgeMinutes` posted on every save and dropped on every
  // save, their values never reaching a scanner, a store, or a clamp — is
  // paid: both are destructured now, clamped by clampOptional, and the stake
  // cap becomes the scanner's budget. What is pinned instead is the
  // two-sided claim — nothing the form posts is dropped, and the caps are
  // read in exactly the files that apply them, comments stripped first, so a
  // comment cannot be credited with a read (the hole that shipped once here
  // already, see helpers/code-only.mjs).
  const posted = [...functionSource(settingsCode, 'scanOptionsFromForm').text.matchAll(/\bout\.(\w+)\s*=/g)]
    .map((m) => m[1]).sort();
  const orchestrator = codeOnly(readFileSync(join(ROOT, 'src/scrape-orchestrator.mjs'), 'utf8'), true);
  const resolved = functionSource(orchestrator, 'resolveScanRequest').text;
  const destructure = resolved.slice(resolved.indexOf('const {'), resolved.indexOf('} = input'));
  const read = [...destructure.matchAll(/^\s{4}(\w+)[\s=,]/gm)].map((m) => m[1]);
  assert.ok(posted.length > 0 && read.length > 0, 'one side of this census read nothing');
  const unread = posted.filter((k) => !read.includes(k)).sort();
  assert.deepEqual(unread, [],
    `posted but dropped by resolveScanRequest: ${unread.join(', ')} — clamp it or stop posting it`);

  // The readers, named file by file: the resolver turns the age cap into the
  // scan's prematch window and hands the stake cap to the scanner, which
  // turns it into the budget every allocation is computed from. A third file
  // reading either key — or one of the two going quiet — moves this pin.
  const offenders = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.mjs'))
    .map((f) => join(f.parentPath, f.name))
    .filter((f) => /\b(maxStake|maxAgeMinutes)\b/.test(codeOnly(readFileSync(f, 'utf8'), true)))
    .sort();
  assert.deepEqual(offenders, [
    join(ROOT, 'src', 'scrape-orchestrator.mjs'),
    join(ROOT, 'src', 'scanner', 'scanner.mjs'),
  ].sort(), 'the two caps must be read by the resolver and the scanner, and by nothing else');
});

/**
 * The page, run: real i18n, real settings.js, a recorded wire.
 *
 * Every element is a generic record — the page touches dozens of ids and this
 * test drives two of them, so the harness answers any getElementById instead
 * of transcribing a DOM the test would then be asserting against itself. What
 * is real is everything under test: the dictionary (evaluated from its own
 * source, English), save(), the guards, and the payload on the wire.
 */
async function loadSettingsPage(scheduler) {
  const posts = [];
  const toasts = [];
  const elements = new Map();
  const handlers = new Map();
  let sseHandler = null;

  const makeElement = (id) => {
    if (elements.has(id)) return elements.get(id);
    const byType = new Map();
    let rawValue = '';
    const el = {
      id, checked: false, textContent: '', innerHTML: '', className: '',
      style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, getAttribute: () => null,
      appendChild() {}, removeChild() {}, focus() {}, blur() {},
      addEventListener(type, fn) {
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(fn);
      },
      removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
    };
    // `input.value` is a string in a browser, always. `renderFields` writes the
    // scheduler's numbers straight into it, so without this the harness handed
    // the page a number and `scanOptionsFromForm`'s `.value.trim()` threw — the
    // launch failed, and the page reported it as a toast rather than as a crash.
    // A harness defect that reads as a page defect is the one thing this
    // harness must not do.
    Object.defineProperty(el, 'value', {
      get: () => rawValue,
      set: (v) => { rawValue = v === null || v === undefined ? '' : String(v); },
      enumerable: true,
      configurable: true,
    });
    elements.set(id, el);
    handlers.set(id, byType);
    return el;
  };

  const context = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById: makeElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeElement(`created-${elements.size}`),
      addEventListener() {}, removeEventListener() {},
      body: makeElement('body'),
    },
    arbiterApp: { mount() {} },
    arbiterSse: { connect(fn) { sseHandler = fn; } },
    arbiterApi: {
      async get(url) {
        if (url === '/api/scheduler') return scheduler;
        if (url === '/api/scrapers') return { jobs: [] };
        if (url === '/api/health') return { ok: true };
        if (url === '/api/sports') return { sports: [] };
        if (url === '/api/profiles') return { profiles: [] };
        return {};
      },
      async post(url, payload) {
        posts.push({ url, payload });
        return { ...payload };
      },
    },
    escapeHtml: (s) => String(s),
    localStorage: { getItem: (k) => (k === 'arbiter.lang' ? 'en' : null), setItem() {} },
    window: {
      showToast: (message, type) => toasts.push({ message, type }),
      confirm: () => true,
      addEventListener() {}, removeEventListener() {},
      setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    },
  };
  context.globalThis = context;

  // The real dictionary first, in English, then the real page on top of it.
  runInNewContext(i18nSource, context);
  context.window.arbiterI18n = context.window.arbiterI18n ?? context.arbiterI18n;
  runInNewContext(settingsSource, context);

  const flush = async () => {
    // refresh() and save() each chain two async turns: the allSettled fetch
    // and the render, or the POST and its then-handler. Two macrotask turns
    // settle both.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  };
  await flush();

  return {
    posts, toasts, elements, scheduler,
    fire(id, type) {
      const byType = handlers.get(id);
      assert.ok(byType, `${id} was never created — the page does not listen on it`);
      for (const fn of byType.get(type) || []) fn();
    },
    emitSse(type) { if (sseHandler) sseHandler(type); },
    flush,
  };
}

test('a save while the schedule is off refuses in words instead of posting', async () => {
  // Executed, not read. A save with the schedule off posted `enabled: false`,
  // the route answered with disable(), and disable() keeps the stored
  // scanOptions — so the form showed values the server had just declined to
  // take. The refusal has to happen before the POST, in a sentence both
  // dictionaries have.
  const dictKeys = (name) => [...codeOnly(i18nSource, true).matchAll(new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'gm'))]
    .map((m) => m[1]);
  const sentences = dictKeys('schedulerDisabledSave');
  assert.equal(sentences.length, 2, 'the key must exist in the Romanian dictionary and the English one');
  assert.notEqual(sentences[0], 'schedulerDisabledSave', 'the Romanian value must not be its own key name');
  const enSentence = sentences[1]; // ro block first, en second; the harness runs lang en.
  const failedShort = dictKeys('failedShort')[1];

  const scheduler = { enabled: false, intervalMinutes: 15, bookIds: [], scanOptions: {} };
  const page = await loadSettingsPage(scheduler);

  // A numeric change on a field the load-time wiring registered (NUMERIC row).
  page.fire('set-interval', 'change');
  await page.flush();
  assert.equal(page.posts.length, 0, 'no POST is sent while the schedule is off');
  assert.equal(page.toasts.at(-1) && page.toasts.at(-1).message, enSentence,
    'the operator is told why, in the exact English sentence the dictionary holds');
  assert.equal(page.elements.get('save-state').textContent, failedShort,
    'the save line reports the refusal as a failure');

  // Flip the schedule on through the status refresh the SSE hook triggers,
  // and the same change must post — with the flag it read, not a constant.
  scheduler.enabled = true;
  page.emitSse('scrape-update');
  await page.flush();
  page.elements.get('set-book').value = 'fortuna';
  page.fire('set-book', 'change');
  await page.flush();
  assert.equal(page.posts.length, 1, 'with the schedule on, the save posts');
  assert.equal(page.posts[0].payload.enabled, true, 'and posts the flag it read');
  // Spread first: the payload was built inside the vm context, and a vm Array
  // fails deepStrictEqual against a host one on its prototype, not its items.
  assert.deepEqual([...page.posts[0].payload.bookIds], ['fortuna'], 'with the book the form holds');
});

test('a scrape launched from this page runs with the options this page shows', async () => {
  // The blind spot of the test above it. That one censuses the KEYS the form
  // posts; this page also has to answer where they are posted TO. It saved them
  // to /api/scheduler and launched with `bookIds` alone, so `resolveScanRequest({})`
  // answered with its defaults and a run started from the page that owns these
  // six fields ignored every one of them. Over the real router, eight of eight
  // configured options dropped.
  //
  // The control is the same POST one line later carrying the options: the route
  // and the orchestrator keep all eight, so the equality below is about the
  // request the page builds and not about a backend that ignores them anyway.
  const CONFIGURED = {
    bankroll: 77777,
    minMarginPercent: 8.5,
    minEvPercent: 9.5,
    maxStake: 4321,
    maxAgeMinutes: 30,
    includePast: true,
    // Not this form's: `maxMiddleRiskPercent`, `minMiddleRoiPercent` and
    // `includeLive` have no input here and must ride along from what is stored,
    // alongside `sport` and `maxEvents`. Dropping the stored half is the other
    // half of the same defect.
    maxMiddleRiskPercent: 6,
    minMiddleRoiPercent: 4,
    sport: 'tennis',
    maxEvents: 120,
  };
  const scheduler = {
    enabled: true, intervalMinutes: 15, bookIds: ['fortuna'], scanOptions: { ...CONFIGURED },
  };
  const page = await loadSettingsPage(scheduler);
  page.elements.get('set-book').value = 'fortuna';

  const scrapePosts = () => page.posts.filter((p) => p.url === '/api/scrape');

  page.fire('btn-scrape-now', 'click');
  await page.flush();
  assert.equal(scrapePosts().length, 1,
    `the button did not launch a scrape; what the page said: ${JSON.stringify(page.toasts)}`);

  const options = scrapePosts()[0].payload.scanOptions;
  assert.ok(options, 'the launch carried no scanOptions, so the route fell back to its defaults');
  for (const [key, value] of Object.entries(CONFIGURED)) {
    assert.equal(options[key], value,
      `the launch ignored the configured ${key}: sent ${JSON.stringify(options[key])}`);
  }

  // The save and the launch must answer the same question. Asserted rather than
  // assumed: the two were separate expressions, and one of them was left out.
  page.fire('set-min-ev', 'change');
  await page.flush();
  const saved = page.posts.filter((p) => p.url === '/api/scheduler').at(-1);
  assert.ok(saved, 'the save did not post');
  assert.deepEqual({ ...saved.payload.scanOptions }, { ...options },
    'the schedule is saved under one set of options and the run launched under another');
});
