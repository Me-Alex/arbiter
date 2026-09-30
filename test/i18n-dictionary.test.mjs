/**
 * i18n-dictionary.test.mjs — the dictionary's own invariants.
 *
 * Every other frontend test checks that the keys a page renders exist. This
 * checks the dictionary from the other side: the keys nobody renders, the keys
 * that exist in one language and not the other, and the keys whose value is
 * nothing at all.
 *
 * The dead-key check is the one that found the rot. It is also the one that
 * needed the most care, because "this key name never appears in a string
 * literal" is not the same as "this key is never read":
 *
 *   - `connection-status.js` builds the name on the line above the call,
 *     `const statusKey = 'status' + …` then `t(statusKey)`, so statusStale,
 *     statusPartial and statusEmpty are read but never spelled. A first version
 *     of this test only looked for a literal and reported all three as dead.
 *   - keys can also be assembled inside the call, `t(`betFrom_${v}`)`.
 *
 * Both shapes are resolved here, and a key reached by assembly counts as used
 * only when the dictionary actually holds something with that prefix — a
 * prefix that matches nothing is reported, not silently accepted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, dirname } from 'node:path';

// fileURLToPath, not URL.pathname: the checkout path has a space in it and
// pathname hands it back percent-encoded, which then fails as a missing file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const i18nSource = readFileSync(join(ROOT, 'public/js/i18n.js'), 'utf8');

/** The `const dict = {…}` literal, cut by brace matching and evaluated. */
function extractConst(name, from) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(from);
  assert.ok(m, `cannot find const ${name}`);
  let depth = 0;
  let i = from.indexOf('{', m.index);
  for (; i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}' && --depth === 0) break;
  }
  return from.slice(m.index, i + 1);
}
const DICT = new Function(`${extractConst('dict', i18nSource)}; return dict;`)();
const RO = DICT.ro;
const EN = DICT.en;

const LANGS = ['ro', 'en'];

test('both languages define the same keys', () => {
  // t() falls back to English and then to the key name, so a key present in
  // one language only is not an error at runtime — it is a Romanian user
  // reading English, discovered by whoever notices, which is never.
  assert.deepEqual(
    Object.keys(RO).filter((k) => !(k in EN)).sort(), [],
    'defined in ro but not en',
  );
  assert.deepEqual(
    Object.keys(EN).filter((k) => !(k in RO)).sort(), [],
    'defined in en but not ro',
  );
  assert.ok(Object.keys(RO).length > 300, 'the dictionaries were not cut short by the extractor');
});

test('no key translates to nothing', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
      assert.notEqual(value.trim(), '', `${lang}.${key} is empty — t() would render nothing at all`);
    }
  }
});

test('no Romanian key is left as its own name', () => {
  // The signature of a key that was stubbed with its own name and never
  // written. It renders as a key, which is worse than not existing, because it
  // looks translated.
  //
  // This is asserted for Romanian only, and the reason it took a second look to
  // get right is the point. Applied to English it fires on eleven keys —
  // unverified, opps, middles, connected, fresh, items, item, enabled,
  // finished, markets, vs — and every one of them is correct: English needs no
  // translation of "enabled", and Romanian does translate it. A key whose
  // English value equals its own name is a working localisation hook, not a
  // stub. In Romanian the same shape is a genuine smell, because a Romanian
  // sentence is not a camelCase identifier.
  //
  // `vs` is the one Romanian exception, and it is a real word in both
  // languages rather than a convenient exemption. It is read — analytics.js
  // builds the separator between the two sides of a market with it.
  const SAME_WORD = new Set(['vs']);
  for (const [key, value] of Object.entries(RO)) {
    if (SAME_WORD.has(key)) continue;
    assert.notEqual(value, key, `ro.${key} is set to its own key name`);
  }

  // The controls, so the rule above cannot be quietly widened or narrowed:
  // Romanian really does translate a key that English leaves alone, and the
  // English list really is longer than the Romanian one.
  assert.equal(RO.unverified, 'neverificat');
  assert.equal(EN.unverified, 'unverified');
  const selfNamed = (d) => Object.keys(d).filter((k) => d[k] === k).length;
  assert.ok(selfNamed(EN) > selfNamed(RO),
    `English legitimately has more self-named keys than Romanian (${selfNamed(EN)} vs ${selfNamed(RO)}) — `
    + 'if that inverts, the rule belongs on both languages and this comment is wrong');
  assert.equal(EN.vs, 'vs', 'the one Romanian exception is the same word in both');
});

// ---------------------------------------------------------------------------
// The dead-key check.
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const CORPUS = [
  ...walk(join(ROOT, 'public')),
  ...walk(join(ROOT, 'electron')),
  ...walk(join(ROOT, 'scripts')),
]
  .filter((f) => !f.endsWith(join('js', 'i18n.js')))
  .map((f) => [relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')]);

/** Literal prefixes whose keys are assembled at runtime, with where that happens. */
const DYNAMIC = [];
for (const [file, body] of CORPUS) {
  const prefixes = new Map();
  for (const m of body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*'([A-Za-z0-9_]+)'\s*\+/g)) {
    prefixes.set(m[1], m[2]);
  }
  for (const m of body.matchAll(/\bt\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (prefixes.has(m[1])) DYNAMIC.push({ file, prefix: prefixes.get(m[1]) });
  }
  for (const m of body.matchAll(/\bt\(\s*`([A-Za-z0-9_]*)\$\{/g)) {
    DYNAMIC.push({ file, prefix: m[1] });
  }
}

test('every prefix assembled at runtime really reaches a key', () => {
  // The other half of the dead-key check. A prefix that matches nothing is a
  // lookup that will print its own key at runtime, and a literal search cannot
  // see it — so it has to be asserted here or not at all.
  for (const { file, prefix } of DYNAMIC) {
    const reached = Object.keys(RO).filter((k) => k.startsWith(prefix));
    assert.ok(reached.length, `${file} builds keys starting with "${prefix}" and the dictionary has none — t() will print the key`);
  }
});

const isUsed = (key) => CORPUS.some(([, body]) =>
  body.includes(`'${key}'`) || body.includes(`"${key}"`) || body.includes(`\`${key}\``))
  || DYNAMIC.some(({ prefix }) => key.startsWith(prefix));

/**
 * Keys that are translated in both languages and read by nothing.
 *
 * Named one by one, with the reason, rather than left as a number: this list
 * is a to-do, and a count would let a new dead key hide behind an old one
 * being fixed. Delete an entry when the key is deleted or when the thing it
 * labels is actually rendered.
 */
const KNOWN_DEAD = new Set([
  'admin', 'password', 'enter',
  'lastScan', 'jobs', 'progress', 'payout',
  'autoVerified', 'nearMiss', 'middleReview', 'trusted', 'review',
  'enable', 'disable',
  'aiTitle', 'askAi',
  'sources_count', 'liveLabel', 'etaLabel', 'andMore', 'liveEvery15s',
  'loadingDataHealth', 'failedToLoadMsg',
  'configuration', 'sourcesSelected', 'recentScanHistory', 'runId', 'started',
  'toastBetTracked', 'detailUnavailable', 'allOddsForEvent',
  'systemHealth', 'engineActive', 'arbNoLive', 'arbNoLiveHint',
]);

test('no key is translated and then never read', () => {
  const dead = Object.keys(RO).filter((k) => !isUsed(k));
  const unlisted = dead.filter((k) => !KNOWN_DEAD.has(k));
  assert.deepEqual(unlisted, [],
    `translated in both languages and read by nothing: ${unlisted.join(', ')} — render it, or delete it and add nothing to KNOWN_DEAD`);

  // And the control beside the negative: the keys this file's own assertions
  // depend on, and keys known to be live, must not be reported dead. A
  // detector that finds nothing wrong finds nothing wrong.
  for (const key of ['toastImportDone', 'betUpdated', 'placed', 'markWon', 'noBets', 'dataHealth', 'runScrape']) {
    assert.ok(isUsed(key), `the detector lost a key that is demonstrably live: ${key}`);
  }
});
