/**
 * page-scripts.test.mjs — which pages load /js/format.js, and whether a script
 * on a page can reach an `arbiterFormat` key that page never gets.
 *
 * This file closes a report rather than opening one. I filed "`arbiterFormat
 * .formatKickoff` does not exist on the admin pages, because they do not load
 * format.js" as a hazard, with a local formatter written into scanner.js to work
 * around it. Measured, the hazard is not there: 8 of the 11 pages load no
 * format.js, and no script on them reads a key format.js alone defines. The
 * workaround is correct and stays. The report does not, and a fact that closes
 * a question is worth as much as one that opens it — otherwise the next reader
 * either re-derives it or believes the report.
 *
 * The first version of this file pinned the wrong numbers and carried a
 * regex-based guard detector that was wrong about six reads in one direction,
 * so both are recorded here rather than quietly replaced:
 *
 *   - "18 unguarded reads" was a miscount. 18 was the TOTAL of the regex's
 *     matches, not the unguarded ones. The tree has 22 reads of the object (the
 *     regex could not see the four that go through `?.`, which is exactly the
 *     shape a guard usually takes), of which 2 have nothing in front of them.
 *   - the guard was decided by looking 60 characters to the left of a match, so
 *     it could not see a guard in the condition of an enclosing `if` while the
 *     call sits after the closing paren — `if (f && f.key) return f.key(x)` —
 *     nor two lines below inside the block that `if` opened. All six misses are
 *     reads that ARE guarded, every one of them on a page that loads format.js,
 *     so the hazard answer held by accident rather than by measurement.
 *
 * Both are why the guard now comes from `guardedPropertyReads` in
 * helpers/code-only.mjs, which walks the parse tree, and why that function
 * carries its own pinned cases at the foot of this file.
 *
 * The third file in this tree's line on the same question: `fieldsOn` in
 * code-only.mjs decides which payload fields a page reads, and codeOnly() is
 * what keeps a mention in a comment from counting as one. This file asks the
 * same shape about script loading, and uses the same helper for the same reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeOnly, guardedPropertyReads, objectKeys } from './helpers/code-only.mjs';

// Rooted at the repository, not at this file: `new URL(path, import.meta.url)`
// from a test under test/ resolves `public` to `test/public`, and the first run of
// this file failed on ENOENT for a directory that has existed all along.
const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

/** Every file under a directory, relative to the repository root. */
function walk(dir, out = []) {
  for (const entry of readdirSync(new URL(`${dir}/`, ROOT), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const PAGES = walk('public').filter((p) => p.endsWith('.html'));
const SCRIPTS_UNDER_JS = walk('public/js').filter((p) => p.endsWith('.js'));

/** The `src` of every `<script>` a page loads, in document order. */
const scriptsOf = (html) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const PAGE_SCRIPTS = new Map(PAGES.map((page) => [page, scriptsOf(read(page))]));

/** The pages whose markup loads this script. */
const pagesLoading = (script) => {
  const suffix = script.replace(/^public/, '');
  return PAGES.filter((page) => PAGE_SCRIPTS.get(page).some((src) => src.endsWith(suffix)));
};

const loads = (page, script) => PAGE_SCRIPTS.get(page).some((src) => src.includes(script));

// The two files define one object between them, so its key list is read by the
// same instrument every other census in this tree uses — `objectKeys` in
// helpers/code-only.mjs, which locates the literal from text and then reads its
// keys off the parse tree. Both rationales (last brace, own nesting level) live
// with it, because that is where the next census will look for them.

const FORMAT_KEYS = objectKeys(read('public/js/format.js'), 'window.arbiterFormat = {');
const COMMON_KEYS = objectKeys(read('public/js/pages/common.js'), 'window.arbiterFormat = Object.assign');

/**
 * Every read of the object, with the guard in front of it.
 *
 * Two receivers, because there are two names for one object: `helpers.
 * arbiterFormat` is handed the global by event-detail.js:64 and dashboard.js:713,
 * so a read through it is a read of the real object. Counting only the
 * `window.` spelling would have dropped that read and made the tree look
 * quieter than it is.
 */
const RECEIVERS = ['window.arbiterFormat', 'helpers.arbiterFormat'];
const CALLS = SCRIPTS_UNDER_JS.flatMap((file) =>
  guardedPropertyReads(read(file), RECEIVERS).map((r) => ({ ...r, file })));

/** What a page can get, from the two files that define the object. */
function keysOn(page) {
  const keys = new Set();
  if (loads(page, '/js/format.js')) for (const k of FORMAT_KEYS) keys.add(k);
  if (loads(page, '/js/pages/common.js')) for (const k of COMMON_KEYS) keys.add(k);
  return keys;
}

const PAGES_WITHOUT_FORMAT_JS = PAGES.filter((p) => !loads(p, '/js/format.js'));
const PAGES_WITHOUT_THE_OBJECT = PAGES.filter((p) => keysOn(p).size === 0);

test('no page reaches an arbiterFormat key it cannot get', () => {
  // The hazard, in both directions at once and as a check rather than a worry.
  // A read of a key the page's own scripts never define is a TypeError the first
  // time that line runs; four pages define seven keys and no format.js, and one
  // (login.html) defines nothing at all. Only a guard that names the same key, or
  // `?.`, survives a missing key — guarding the OBJECT alone does not, which is
  // why the rule below accepts only those two.
  const hazardous = [];
  for (const c of CALLS) {
    if (c.guard === 'key' || c.optional) continue;
    for (const page of pagesLoading(c.file)) {
      if (keysOn(page).has(c.key)) continue;
      hazardous.push(`${c.file.replace(/^public\/js\//, '')}:${c.line} ${c.key} -> ${page.replace(/^public\//, '')} (guard: ${c.guard})`);
    }
  }
  assert.deepEqual(hazardous, [],
    `these read a key the page cannot get: ${hazardous.join('; ')}`);
});

test('the guard detector tells the four kinds of guard apart, on cases it cannot fake', () => {
  // The self-test, and it is here because the detector was wrong twice before
  // it was pinned: a regex over source text that could not see `?.`, and a
  // 60-character window that could not see a guard standing over an enclosing
  // `if`. Both errors pointed the same way — reporting a guarded read as bare —
  // and an instrument that only ever over-reports still reports a clean bill of
  // health, so each kind is pinned to a known site, by line and key.
  const at = (file, line, key) => CALLS.filter((c) => c.file === file && c.line === line && c.key === key);
  const shape = (site) => `${site.map((c) => c.guard).join('/')}${site.some((c) => c.optional) ? '+?' : ''}`;

  // `key`: the condition names the key, the call sits after the closing paren on
  // the SAME line. The shape the character window could not see.
  const sameLine = at('public/js/pages/dashboard.js', 513, 'formatKickoff');
  assert.equal(shape(sameLine), 'receiver/key',
    `expected a receiver probe and a key-guarded call at dashboard.js:513, measured ${shape(sameLine)}`);

  // `key`: the condition names the key and the call is inside the block it
  // opened, two lines down. The other half of the same miss.
  assert.equal(shape(at('public/js/pages/dashboard.js', 151, 'fmtStake')), 'key',
    'the read inside the block opened at dashboard.js:150 is guarded by that block\'s condition');

  // `receiver`: guarded on the object only — safe against no object at all, not
  // against no key. dashboard.js:555 is the only site in the tree.
  assert.equal(shape(at('public/js/pages/dashboard.js', 555, 'timeAgo')), 'receiver',
    'the `x && x.key(…)` form guards the object, not the key, and must not read as `key`');

  // `optional`: `?.` short-circuits, so this cannot throw whatever the object
  // holds. It is a flag and not a fourth level of strength, because dashboard.js:228
  // is BOTH optional-chained and covered by an enclosing condition — and a single
  // score had nowhere to put that, which is how `receiver` came to overwrite it.
  assert.equal(shape(at('public/js/pages/dashboard.js', 228, 'roiClass')), 'none+?',
    'window.arbiterFormat?.roiClass(…) keeps its `?.` — and it keeps it even when a condition also covers it, which is the case a single strength score had nowhere to put');

  // `none`, and no `?.`: bare, and bare is only safe because event.html loads
  // format.js — which is the premise the page above is written on, so it is
  // asserted here too rather than assumed there.
  assert.equal(shape(at('public/js/pages/event-detail.js', 51, 'formatKickoff')), 'none',
    'the call at event-detail.js:51 is bare');
  assert.ok(loads('public/event.html', '/js/format.js'), 'and event.html is one of the three pages that load format.js');
});

test('the key lists are the ones they claim to be', () => {
  assert.deepEqual(FORMAT_KEYS,
    ['fmtMarketKey', 'fmtMoney', 'fmtOdds', 'fmtStake', 'formatKickoff', 'paletteFor', 'parseDate', 'parseStakeAmount', 'timeAgo'],
    'format.js no longer defines this set of keys — has a formatter moved or been renamed?');
  assert.deepEqual(COMMON_KEYS,
    ['count', 'ev', 'odds', 'roi', 'roiClass', 'stake', 'timeAgo'],
    'common.js no longer defines this set of keys');

  // Exactly one name is defined by both files, and it is the one the two files
  // disagree about in prose. common.js:209 says fmtOdds, fmtStake and timeAgo
  // are "deliberately not redefined here"; that is true of the first two — it
  // does not define those names at all — and false of timeAgo, which common.js
  // does define, as `(window.arbiterFormat || {}).timeAgo || function
  // timeAgoFallback(ms)`. So the intersection is pinned to [`timeAgo`], and the
  // deferral itself is pinned too: a common.js that stopped deferring would look
  // identical by name and would silently give the admin pages a second
  // implementation of a formatter only three pages load from format.js.
  const shared = FORMAT_KEYS.filter((k) => COMMON_KEYS.includes(k));
  assert.deepEqual(shared, ['timeAgo'],
    `the two files now share these keys: ${shared.join(', ')} — the ownership of timeAgo moved`);
  assert.match(codeOnly(read('public/js/pages/common.js'), true),
    /timeAgo:\s*\(window\.arbiterFormat \|\| \{\}\)\.timeAgo \|\|/,
    'common.js no longer prefers format.js\'s timeAgo when format.js is loaded');
  assert.ok(FORMAT_KEYS.includes('formatKickoff') && !COMMON_KEYS.includes('formatKickoff'),
    'formatKickoff is format.js-only, which is the premise the first test rests on');
  assert.ok(!FORMAT_KEYS.includes('if') && !COMMON_KEYS.includes('if'),
    'the extractor found a keyword instead of a key — its depth handling is broken again');
});

test('the numbers the withdrawn report quoted still hold', () => {
  // 11 pages, 8 without format.js, 23 reads, 3 bare, 0 hazardous. If a page is
  // added, a script is loaded onto an admin page, or a formatter is called for
  // the first time, one of them moves — and a measurement nobody re-checks is
  // the same as no measurement.
  //
  // The four ArbEdge console pages are in the no-format.js set below, and they
  // are there for a stronger reason than the older admin pages: they never read
  // window.arbiterFormat at all. They format through locals, because
  // test/scan-fields-census.test.mjs runs each of them with the global set to
  // null on purpose, to catch a reader that assumes the object exists at load
  // time. Loading format.js on a page that never touches it would be a parse for
  // nothing, so it is not loaded.
  //
  // They still load pages/common.js, which is where escapeHtml, showToast and
  // the toast host come from, so they are not in the set below that has neither
  // file. What covers them is the hazard test above: every key they call is one
  // common.js defines, and it passes.
  //
  // The 23rd read joined when `guardedPropertyReads` learned to see through a
  // fallback receiver: `timeAgo: (window.arbiterFormat || {}).timeAgo || …` at
  // common.js:281 is a read of the object whose only trace used to be the word
  // `window.arbiterFormat` in a file the count was measured over. It counts as
  // bare on purpose — a `|| {}` stands in for a missing object, not for a
  // missing key, and this file's hazard is a key called on a page that never
  // defined it.
  assert.equal(PAGES.length, 11, `expected 11 pages, measured ${PAGES.length}`);
  assert.deepEqual(PAGES_WITHOUT_FORMAT_JS.map((p) => p.replace(/^public\//, '')).sort(),
    ['admin/ai.html', 'admin/analytics.html', 'admin/arbitrage.html', 'admin/bookies.html',
      'admin/live.html', 'admin/login.html', 'admin/scanner.html', 'admin/settings.html'],
    'the set of pages without format.js changed');
  assert.deepEqual(PAGES_WITHOUT_THE_OBJECT.map((p) => p.replace(/^public\//, '')), ['admin/login.html'],
    'login.html loads neither format.js nor common.js, so window.arbiterFormat does not exist there at all');
  assert.equal(CALLS.length, 23, `expected 23 reads of the object, measured ${CALLS.length}`);
  const byGuard = (g) => CALLS.filter((c) => c.guard === g);
  const bare = CALLS.filter((c) => c.guard === 'none' && !c.optional);
  assert.deepEqual([byGuard('key').length, byGuard('receiver').length, byGuard('none').length, CALLS.filter((c) => c.optional).length],
    [8, 8, 7, 4], 'the reads are no longer split the way this file measured them');
  assert.equal(bare.length, 3, `expected 3 reads with nothing in front of them, measured ${bare.length}`);
  // The line number is absent from the expected list on purpose. It moves
  // whenever a comment is reworded, and a read that did not change shape has
  // not stopped being hazardous because it slid down two lines — pinning it
  // makes this test report a defect where none happened, which is how a
  // measurement teaches the reader to ignore it. What this file knows about is
  // the set: which file, which key, read with nothing in front of it. The
  // numbers are still printed on failure, computed from the same read, so
  // there is a line to open.
  assert.deepEqual(bare.map((c) => `${c.file.replace(/^public\/js\//, '')} ${c.key}`),
    ['pages/common.js timeAgo', 'pages/event-detail.js formatKickoff', 'pages/scrape.js fmtOdds'],
    'the reads with nothing in front of them are not the three this file knows about — measured at '
    + bare.map((c) => `${c.file.replace(/^public\/js\//, '')}:${c.line} ${c.key}`).join(', '));
});