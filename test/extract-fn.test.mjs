/**
 * extract-fn.test.mjs — the shared extractor returns a function, not a signature.
 *
 * Five test files used to carry their own copy of this helper and there were two
 * of them doing different things, so nothing could be said about whether the
 * tests agreed. Three located a function with a regex and counted braces from
 * the first `{` after the name; one did the same with indexOf; the fifth skipped
 * the parameter list first, because a default argument like `qualityOptions = {}`
 * opens a brace that closes again before the body begins.
 *
 * Measured over every pair these tests actually ask for, the two answers
 * are identical — so nothing was measured wrongly. The one place they part is
 * `loadWorkspace`, and it parts completely: asked for it, the brace-first copies
 * return 51 characters, `function loadWorkspace(dataDir, qualityOptions = {}`,
 * with no parameter list and no body, against 7,139 characters for the real
 * thing. Only source-health-list.test.mjs asks for that function, and only it
 * held a copy that survives it, so the trap was armed and not yet fired.
 *
 * That is a trap that fires silently: the short answer is balanced, ends in `}`,
 * and contains the function's name, so a census pointed at it reads zero and
 * reports the zero as a fact. Hence a test rather than a convention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { extractFn } from './helpers/extract-fn.mjs';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SOURCES = {
  'public/js/connection-status.js': read('public/js/connection-status.js'),
  'public/js/pages/dashboard.js': read('public/js/pages/dashboard.js'),
  'public/js/pages/event-detail-modal.js': read('public/js/pages/event-detail-modal.js'),
  // Comment-blanked, the way source-health-list.test.mjs hands it over: an
  // extracted function has to eval in a context that has no DOM.
  'src/scanner/scanner.mjs': codeOnly(read('src/scanner/scanner.mjs'), true),
};

/**
 * Every [source, function] pair a test in this tree asks the helper for.
 *
 * Hand-written, and checked against the call sites in the test below — a list
 * nobody compares to the code it describes is how the pairs go stale, which is
 * the failure this whole file is about.
 */
const PAIRS = [
  ['public/js/connection-status.js', 'decideStateTransition'],
  ['public/js/connection-status.js', 'decideHealthBanner'],
  ['public/js/connection-status.js', 'formatUptime'],
  ['public/js/connection-status.js', 'decideHealthChip'],
  ['public/js/connection-status.js', 'renderHealth'],
  ['public/js/pages/dashboard.js', 'parseStakeAmount'],
  ['public/js/pages/dashboard.js', 'renderOppV2'],
  ['public/js/pages/dashboard.js', 'dashRenderLeg'],
  ['public/js/pages/dashboard.js', 'formatKickoff'],
  ['public/js/pages/dashboard.js', 'dashLiveBadge'],
  ['public/js/pages/dashboard.js', 'sourceHealthRows'],
  ['public/js/pages/event-detail-modal.js', 'collectCardLegs'],
  ['public/js/pages/event-detail-modal.js', 'isEventUrl'],
  ['public/js/pages/event-detail-modal.js', 'buildFallbackFromLegs'],
  ['src/scanner/scanner.mjs', 'loadWorkspace'],
];

test('the shared extractor returns a function and not its signature', () => {
  assert.ok(PAIRS.length >= 10, `only ${PAIRS.length} pairs pinned — the census over them proves little`);
  for (const [file, name] of PAIRS) {
    const src = SOURCES[file];
    assert.ok(src, `${file} is not one of the sources this tree extracts from`);
    const extracted = extractFn(name, src);
    // The discriminator, and the only one that holds: the brace-first copies
    // return a string with no `)` in it at all, because they stop inside the
    // parameter list. Every real extraction closes that list first.
    const close = extracted.indexOf(')');
    assert.ok(close !== -1,
      `${file} :: ${name} — the extractor returned a truncated signature and no body: ${JSON.stringify(extracted.slice(0, 90))}`);
    assert.ok(extracted.length > close + 1,
      `${file} :: ${name} — the extraction ends at the parameter list, ${extracted.length} characters`);
  }
});

test('the pairs pinned above are the ones the tests actually ask for', () => {
  const dir = new URL('./', import.meta.url);
  // Only the files that import the shared helper; anything still carrying its own
  // copy is a different problem and shows up here as a file with no import.
  const callers = readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs') && f !== 'extract-fn.test.mjs')
    .filter((f) => read(`test/${f}`).includes("from './helpers/extract-fn.mjs'"));
  assert.ok(callers.length >= 5, `only ${callers.length} files import the shared extractor — a fifth copy is still out there`);

  const asked = new Set();
  const computed = [];
  for (const f of callers) {
    const text = read(`test/${f}`);
    for (const m of text.matchAll(/extractFn\(\s*(['"])([A-Za-z_$][\w$]*)\1/g)) asked.add(m[2]);
    // Anything whose first argument is not a literal is either a parameter being
    // forwarded (`extractFn(name, src)` inside a small local helper, whose real
    // names reach the literal set from that helper's own callers) or a name
    // computed at runtime.
    for (const m of text.matchAll(/extractFn\(\s*([A-Za-z_$][\w$]*)/g)) computed.push(`${f}:${m[1]}`);
  }
  // Exactly one name is computed rather than forwarded: `listenerName`, read out
  // of dashboard.js by brace matching in the file that uses it.
  const forwarded = computed.filter((c) => c.endsWith(':name') || c.endsWith(':n'));
  assert.equal(forwarded.length, 3,
    `forwarding call sites moved: ${JSON.stringify(computed)} — re-read which of these still receives its name from a caller`);
  const computedNames = computed.filter((c) => !forwarded.includes(c));
  assert.deepEqual(computedNames, ['event-detail-wiring.test.mjs:listenerName'],
    'a test now extracts by a name it computes and does not forward — the pinned pairs cannot cover that name, so add its functions by hand');

  const pinned = new Set(PAIRS.map(([, name]) => name));
  const missing = [...asked].filter((n) => !pinned.has(n)).sort();
  assert.deepEqual(missing, [],
    `a test extracts a function this file does not check: ${missing.join(', ')}`);
  assert.ok(asked.size >= 10, `only ${asked.size} distinct functions are extracted anywhere in test/ — the pairs above have stopped tracking the tree`);
});

test('the default argument that separated the two copies is still in the tree', () => {
  // The witness expires honestly. If `loadWorkspace` loses its `= {}` default the
  // two algorithms start agreeing again, and this says so rather than letting the
  // pair above quietly become the case where nothing can be told apart.
  const src = SOURCES['src/scanner/scanner.mjs'];
  const start = src.indexOf('function loadWorkspace(');
  const signature = src.slice(start, src.indexOf(')', start) + 1);
  assert.match(signature, /=\s*\{\s*\}/,
    'loadWorkspace no longer takes an object default, so the brace-first extractor is correct for it again — re-measure before trusting either helper');
});
