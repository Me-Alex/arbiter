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

// The composed label is the string a trader reads, so the rule below is checked
// against the real dictionary rather than against the two halves of it.
import { LABEL_KEYS, localizeMarketLabel } from '../frontend/src/labels.ts';

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

/**
 * One language's block, as the text that was written.
 *
 * The object built above cannot answer a question about duplicates: by the time
 * a literal has been evaluated the second `finished` has already overwritten
 * the first, and both look like one correct entry. So the block is cut out of
 * the source again and read as text.
 */
function langBlock(lang) {
  const dict = extractConst('dict', i18nSource);
  const m = new RegExp(`\\b${lang}\\s*:\\s*\\{`).exec(dict);
  assert.ok(m, `cannot find the ${lang} block`);
  let depth = 0;
  let i = dict.indexOf('{', m.index);
  for (; i < dict.length; i++) {
    if (dict[i] === '{') depth++;
    else if (dict[i] === '}' && --depth === 0) break;
  }
  return dict.slice(m.index, i + 1);
}

/** The key names as written, in order, repeats included. */
const keysAsWritten = (lang) => [...langBlock(lang).matchAll(/^ {6}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);

test('no key is defined twice in one language', () => {
  // A repeated key in an object literal is not a syntax error: the last one
  // wins and the first is dead text that reads like a real entry. `finished`
  // was written a second time for the last-run panel note while the job band
  // already owned it, with a different capitalisation — so the note silently
  // rendered the caption's lowercase word and the new entry was unreachable.
  // The count comparison in the first test cannot see that, because by then the
  // object has one `finished` and no trace of the argument.
  for (const lang of LANGS) {
    const written = keysAsWritten(lang);
    const dupes = [...new Set(written.filter((k, i) => written.indexOf(k) !== i))];
    assert.deepEqual(dupes, [], `${lang} defines these keys more than once: ${dupes.join(', ')}`);
  }

  // The control beside it: the extractor really does see the keys. A duplicate
  // check that found nothing because it had read nothing would pass the line
  // above, so the text count is compared against the object built from the same
  // literal — and any duplicate makes the two disagree.
  for (const lang of LANGS) {
    assert.equal(keysAsWritten(lang).length, Object.keys(DICT[lang]).length,
      `${lang}: the block as written and the object built from it hold different numbers of keys`);
  }
});

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
  // Was `> 300`, and it failed for the right reason: this batch deleted 24
  // keys per language, so the honest floor moved. A number that only ever goes
  // one way is a number that will be deleted or ignored, so the real check is
  // against the text — the same equality the duplicate test leans on — and this
  // is only there so that an extractor and a regex that both see nothing cannot
  // pass together.
  assert.equal(Object.keys(RO).length, keysAsWritten('ro').length,
    'the ro object holds a different number of keys than the ro block has written — the extractor is wrong');
  assert.ok(Object.keys(RO).length > 250,
    `the dictionaries were not cut short by the extractor: only ${Object.keys(RO).length} keys`);
});

test('every label the market table names is a key both languages define', () => {
  // The labels test proves `labels.ts` asks for a key; only this file holds
  // the dictionary, so only this file can prove the key is there. The gap is
  // silent by construction: `t` falls back to the key name, so a missing
  // entry renders as the market label itself rather than raising anything.
  assert.ok(LABEL_KEYS.length > 20, `the table was not read: ${LABEL_KEYS.length} keys`);
  for (const key of LABEL_KEYS) {
    assert.ok(key in RO, `ro is missing ${key}`);
    assert.ok(key in EN, `en is missing ${key}`);
  }
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
    else if (/\.(js|mjs|html|cjs|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Where a key can be *read from*: the legacy pages, the desktop shell, the
 * scripts, and the React app's source.
 *
 * `public/app` is the built bundle and is excluded. It lives inside `public`,
 * it contains every key the app uses as a literal, and it is regenerated rather
 * than edited — so counting it as a consumer would let a key that no source file
 * mentions read as live for as long as the last build happened to contain it.
 * The source that produced it is in the corpus already.
 */
const CORPUS = [
  ...walk(join(ROOT, 'public')).filter((file) => !file.startsWith(join(ROOT, 'public', 'app'))),
  ...walk(join(ROOT, 'electron')),
  ...walk(join(ROOT, 'scripts')),
  ...walk(join(ROOT, 'frontend', 'src')),
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
 *
 * It was thirty-five entries. Every one of them is now either rendered or gone,
 * and the list is **empty**:
 *
 *   - the last one, `systemHealth`, waited on a product decision — where a
 *     `GET /api/health` (src/router.mjs:54, `{ok, uptimeSeconds, timestamp}`)
 *     panel belongs. It sits in the header beside the SSE chip, because the
 *     two answer different questions: the SSE chip says the socket is open,
 *     the health chip says the route is still answering, and they fail
 *     independently. `systemHealth` is its tooltip and its label for a payload
 *     it cannot read; `healthUnreachable` is its failure text.
 *
 * What the thirty-five had in common is the shape of the rot: a key written for
 * a panel that was designed, cut, or renamed, and never re-examined. Six of
 * them turned out to be constants rather than fields — `feedStatus`, `active`,
 * `provenanceLabel` and three more — and a field that is constant is not worth
 * rendering; those were dropped rather than wired up, and the two tests that
 * pin the decision live next to the page they belong to.
 *
 * The list is kept as an empty set rather than deleted, because the assertion
 * below reports an unlisted dead key by name and a reader has to be able to see
 * that the list is checked, not merely absent.
 */
const KNOWN_DEAD = new Set([
]);

test('no key is translated and then never read', () => {
  const dead = Object.keys(RO).filter((k) => !isUsed(k));
  const unlisted = dead.filter((k) => !KNOWN_DEAD.has(k));
  assert.deepEqual(unlisted, [],
    `translated in both languages and read by nothing: ${unlisted.join(', ')} — render it, or delete it and add nothing to KNOWN_DEAD`);

  // And the control beside the negative: the keys this file's own assertions
  // depend on, and keys known to be live, must not be reported dead. A
  // detector that finds nothing wrong finds nothing wrong.
  //
  // `systemHealth` is in that list deliberately: it was the one key the
  // detector had to be able to name, and it is here to prove the detector can
  // still see a live key it once reported dead. The negative half of that
  // claim — that the detector can still see a DEAD one — is the control in
  // scratch/control-dead-key.mjs, which swaps this module's t('healthUnreachable')
  // for the identical literal and shows this very assertion going red on it,
  // and nothing else.
  //
  // The last two are the app's: a key only the React source names, reached
  // through the interpolating call, proves both new doors are actually open.
  for (const key of ['toastImportDone', 'betUpdated', 'placed', 'markWon', 'noBets', 'dataHealth', 'runScrape', 'systemHealth', 'healthUnreachable', 'appFeedStatus', 'appSourcesFresh']) {
    assert.ok(isUsed(key), `the detector lost a key that is demonstrably live: ${key}`);
  }
});

test('the corpus covers the app source and not the bundle it produces', () => {
  // Both halves matter. Without the first, every app key is reported dead.
  // Without the second, the bundle answers for keys the source no longer has —
  // and the bundle is the one file that is rebuilt, so it lags exactly when a
  // key was just deleted.
  const files = CORPUS.map(([file]) => file.replace(/\\/g, '/'));
  assert.ok(files.some((file) => file.startsWith('frontend/src/')),
    `the app source is not in the corpus at all (${files.length} files)`);
  assert.ok(files.some((file) => /frontend\/src\/labels\.ts$/.test(file)),
    `the market-label table is not being read: ${files.filter((f) => f.startsWith('frontend/')).join(', ')}`);
  assert.deepEqual(files.filter((file) => file.startsWith('public/app/')), [],
    'the built bundle is generated output and cannot stand as a consumer');
});

// ---------------------------------------------------------------------------
// The other half of the dictionary: text that never reaches it.
// ---------------------------------------------------------------------------

/**
 * One line of a page with its comments off.
 *
 * Two kinds, and the trailing one is the case that bites. A full-line comment
 * starts in column zero and is dropped whole. A trailing comment is found by
 * whitespace before `//`, which is what a comment looks like and what the `//`
 * inside a URL is not: `https://…` has a colon in front of it. A trailing
 * comment can sit next to a template literal on the same line, and a comment
 * that quotes the markup it describes would otherwise read as markup.
 *
 * Block comments are not handled here. Every measurement that produced this
 * rule ran over pages whose block comments quote markup only in prose, and a
 * comment that opened on one line and closed on another would need the block
 * stripped across the whole file rather than per line.
 *
 * @param {string} line
 * @returns {string}
 */
function withoutComments(line) {
  if (/^\s*\/\//.test(line)) return '';
  const m = /\s\/\/(?!\/)/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

/**
 * The English a reader would see, in the two shapes it is written.
 *
 * A text node and a user-facing attribute. Both are anchored on a capital and a
 * closing delimiter, which is what keeps class lists and data attributes out:
 * `class="card p-4 flex"` has no `>…<` around it, and `title="…"` starting with
 * a capital is a label rather than a path.
 *
 * Two blind spots, named rather than papered over. A word sequence inside an
 * interpolation — `>${flag ? 'RISK-FREE' : ''}<` — is not a text node and this
 * does not find it; one was found and fixed by hand while this was written,
 * which is where `middleChip` and `riskFree` came from. And a line carrying
 * `data-i18n=` is skipped whole, because that is the other legitimate way to
 * write translatable text: the English is the first paint and the dictionary
 * fills it in on load. Skipping the whole line rather than the one span is a
 * deliberate over-permission, in the direction that hides a real offender
 * sharing a line with a data-i18n span.
 *
 * @param {string} source a page's whole source
 * @returns {string[]} what it found, as `kind: text`
 */
function hardcodedEnglish(source) {
  const out = [];
  source.split(/\r?\n/).forEach((raw) => {
    const line = withoutComments(raw);
    if (!line || /data-i18n=/.test(line)) return;
    for (const m of line.matchAll(/>([A-Z][A-Za-z0-9 ,.!?()%&/'-]{3,60})</g)) out.push(`text: ${m[1].trim()}`);
    for (const m of line.matchAll(/(?:title|placeholder|aria-label|alt)="([A-Z][A-Za-z0-9 ,.!?()%&/'-]{4,70})"/g)) out.push(`attribute: ${m[1].trim()}`);
  });
  return out;
}

test('no page prints English of its own into the interface', () => {
  // The pages are bilingual by default and Romanian is what the tree is written
  // in, so a literal here is a Romanian reader seeing English in the middle of
  // a translated card. Measured before this test existed: 10 of them, on four
  // pages, all in the middle/console surfaces.
  const dir = join(ROOT, 'public/js/pages');
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    for (const found of hardcodedEnglish(readFileSync(join(dir, name), 'utf8'))) {
      offenders.push(`${name}: ${found}`);
    }
  }
  assert.deepEqual(offenders, [], `these reach the reader without the dictionary: ${offenders.join('; ')}`);
});

test('the untranslated-text detector still finds one when there is one', () => {
  // The assertion above is a claim about the whole tree resting on a regex, and
  // a regex that quietly stopped matching reports a clean bill of health. So it
  // is run over text it has to find and text it has to leave alone, and the
  // leaves-alone list is the interesting half: a comment, a data-i18n span and a
  // lookup and a trailing comment are all things this is allowed to miss on purpose.
  const found = hardcodedEnglish([
    '  // <div>Commented Out</div>',
    "  const a = '<div class=\"x\">Add Bookmaker</div>'; // a comment quoting markup",
    "  const b = '<div title=\"Toggle group\">x</div>';",
    '  const c = `<span data-i18n="showMore">Show more</span>`;',
    "  const d = '<span>${escapeHtml(t('margin'))}</span>';",
    "  const e = '<a href=\"/event.html\">Go to market</a>';",
    '  const f = "<p>Live Text</p>"; // <div>Trailing Comment</div>',
  ].join('\n'));
  assert.deepEqual(found.sort(), ['attribute: Toggle group', 'text: Add Bookmaker', 'text: Go to market', 'text: Live Text'],
    'the detector sees both shapes, and leaves the comment, the data-i18n span and the lookup alone');
});

// ---------------------------------------------------------------------------
// The same question asked of the markup the twelve pages ship.
// ---------------------------------------------------------------------------
//
// The census above reads public/js/pages, which is where the console's rendered
// strings live. The static markup carries the other half of the same interface
// and had never been measured, so it was measured the same way, with the same
// two blind spots and one more of its own.
//
// It is deliberately not `public/app/`. That directory is `vite build` output
// produced from `frontend/`, a separate single-language shell with no dictionary
// at all, and scanning a bundle would measure the bundler rather than a page. The
// files below are the twelve the Node server hands out to a reader.

/**
 * Every HTML comment out of a page, before the page is cut into lines.
 *
 * The JS half cuts a trailing `//` per line. Markup cannot be read that way:
 * these pages are full of banner comments — `<!-- Masthead ---------` — that
 * open on one line and close several lines later, so a per-line rule would have
 * to guess where the art ends and the sentences begin. Removing every comment
 * from the whole file first means a comment's prose can never read as markup and
 * a banner's hyphens can never read as an attribute.
 *
 * The over-permission this buys, named: a `<!--` written inside a script string
 * would swallow real markup up to the next `-->`. No page here writes one. If
 * one ever did, the effect is a missed offender, not a false pass on an offender
 * this would otherwise have caught.
 *
 * @param {string} source a page's whole source
 * @returns {string} the source with its comments gone
 */
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The English a reader would see in a page's markup.
 *
 * The same two shapes `hardcodedEnglish` looks for — a text node and a
 * user-facing attribute — with two differences the markup forces.
 *
 * The character classes are ASCII, which makes this blind to any string carrying
 * a Romanian diacritic. That false negative has a useful shape: English cannot
 * hide behind a diacritic, so every string this can miss is a Romanian one, and
 * Romanian is exactly what a page is allowed to print for itself anyway.
 * `Filtreaza casele` is invisible here; `Filter the books` is not.
 *
 * The length floors are two and three characters after the capital, not the three
 * and four a first version used. That version reported twelve pages clean while
 * `arbitrage.html` shipped a tab labelled `All` — three characters, under the
 * floor, so the detector could not see the one label on the page that was still
 * English. Lowering the floor found exactly three more sites across the twelve
 * pages and no avalanche, which is the evidence that two and three are the right
 * floors rather than a guess.
 *
 * The line skip is wider than the JS half's `data-i18n=`. Markup writes four
 * hook forms — `data-i18n`, `data-i18n-title`, `data-i18n-placeholder`,
 * `data-i18n-aria-label` — and the last three sit on the same tag as the very
 * literal they replace: 33 lines across these twelve pages. A skip that matched
 * only `data-i18n=` would report all 33 as offenders. So the skip is any
 * `data-i18n` on the line, whole line — the same deliberate over-permission the
 * JS half names, in the same direction: an offender sharing a line with a hook
 * goes unseen, and that is the price of not flagging every correctly wired one.
 *
 * @param {string} source a page's whole source
 * @returns {string[]} what it found, as `kind: text`
 */
function hardcodedMarkupEnglish(source) {
  const out = [];
  stripHtmlComments(source).split(/\r?\n/).forEach((line) => {
    if (!line || /data-i18n/.test(line)) return;
    for (const m of line.matchAll(/>([A-Z][A-Za-z0-9 ,.!?()%&/'-]{2,60})</g)) out.push(`text: ${m[1].trim()}`);
    for (const m of line.matchAll(/(?:title|placeholder|aria-label|alt)="([A-Z][A-Za-z0-9 ,.!?()%&/'-]{3,70})"/g)) out.push(`attribute: ${m[1].trim()}`);
  });
  return out;
}

/** The twelve pages the Node server hands out, as `dir/name`. */
const MARKUP_PAGES = ['public', 'public/admin'].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => `${dir}/${name}`));

/**
 * Markup this census is allowed to find, one entry at a time with the reason.
 *
 * The first two are product names. `ArbEdge Admin` and `Arbiter Workstation` are
 * the product naming itself on the login card and in a tab title; a translated
 * product name is a different product, so they stay English in both languages.
 *
 * The third is not a name but a whole page. `workstation.html` is a legacy URL: a
 * 0-second `<meta http-equiv="refresh">` in the head plus a blocking
 * `location.replace()` take the reader away before anything renders, and it is
 * the one page of the twelve that never loads `/js/i18n.js`. Hooking its single
 * line would leave the hook with no dictionary behind it — the reader would get
 * the key's own name printed, then the redirect. Loading a dictionary ahead of
 * that redirect to translate a line nobody can read is the worse trade, so the
 * literal stays and is named here instead.
 */
const MARKUP_ALLOWED = new Set([
  'login.html: text: ArbEdge Admin',
  'workstation.html: text: Arbiter Workstation',
  'workstation.html: text: Loading the Arbiter workstation...',
]);

test('no page ships English of its own in its markup', () => {
  const offenders = [];
  const allowed = new Set();
  for (const page of MARKUP_PAGES) {
    const source = readFileSync(join(ROOT, page), 'utf8');
    for (const found of hardcodedMarkupEnglish(source)) {
      const site = `${page.split('/').pop()}: ${found}`;
      if (MARKUP_ALLOWED.has(site)) allowed.add(site);
      else offenders.push(`${page}: ${found}`);
    }
  }
  assert.deepEqual(offenders, [], `these reach the reader without the dictionary: ${offenders.join('; ')}`);

  // The allowances are not a switch that turns the census off. Each has to be
  // found on the page it names, or it is a permission nobody came back to remove
  // — and, less obviously, a run that found none of them is the empty-set pass
  // this file exists to rule out: it means the detector or the page list broke,
  // not that the markup got translated.
  const stale = [...MARKUP_ALLOWED].filter((site) => !allowed.has(site));
  assert.deepEqual(stale, [], `these allowances no longer match anything, so the census is not reading the pages it thinks it is: ${stale.join('; ')}`);
});
/**
 * The Romanian a reader would see in a page's markup with no hook over it.
 *
 * The English half above is ASCII-only, and the reason given for that used to
 * end in a reassurance: a string it cannot see is one carrying a diacritic, and a
 * diacritic-bearing string is a Romanian one, which a page is entitled to print
 * for itself. That holds while the element carries a hook - the Romanian is then
 * its no-JS fallback and `apply()` replaces it on load. It stopped holding the
 * moment a page printed Romanian with no hook at all, and `scrape.html` did it
 * five times: two checkbox tooltips, the run-status band, the log region and the
 * history table's caption. `apply()` only rewrites elements that declare a hook,
 * so all five stayed Romanian in English, and a screen reader read them in
 * Romanian. The English detector was structurally unable to report any of them,
 * which is the whole reason this one exists.
 *
 * The same line skip and the same two shapes as the sibling, with the diacritic
 * that one is blind to promoted from "invisible" to "the signal". Romanian text
 * written without a diacritic (`Filtreaza casele`) is still invisible here, and
 * that example is the sibling's own for the same reason. This is the false
 * negative to accept rather than close: closing it needs a word list, which has
 * to carry every Romanian word the pages might ever print and fails on the next
 * one it does not know, at which point the detector starts reporting its own
 * gaps as findings.
 *
 * The classes are written as escapes rather than as the characters themselves:
 * five lowercase (a-breve, a-circumflex, i-circumflex, s-comma, t-comma) and
 * their five uppercase forms. `new RegExp` reads them either way, so the escapes
 * survive being passed on as text.
 *
 * @param {string} source a page's whole source
 * @returns {string[]} what it found, as `kind: text`
 */
const ROMANIAN_DIACRITICS = '\u0103\u00e2\u00ee\u0219\u021b\u0102\u00c2\u00ce\u0218\u021a';

function hardcodedMarkupRomanian(source) {
  const out = [];
  const diac = `[${ROMANIAN_DIACRITICS}]`;
  stripHtmlComments(source).split(/\r?\n/).forEach((line) => {
    if (!line) return;
    // Text keeps the sibling's whole-line `data-i18n=` skip, and the false
    // negative that buys is pinned in the control below rather than papered
    // over. An attribute does not keep it: that hook names its attribute
    // exactly, so `data-i18n-aria-label` excuses `aria-label` and nothing else.
    // The whole-line rule is what reported `scrape.html` clean while its
    // bookmaker filter carried a bare `aria-label` next to a placeholder hook.
    if (!/data-i18n=/.test(line)) {
      for (const m of line.matchAll(new RegExp(`>([^<]*${diac}[^<]*)<`, 'g'))) out.push(`text: ${m[1].trim()}`);
    }
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      if (new RegExp(`data-i18n-${attr}=`).test(line)) continue;
      for (const m of line.matchAll(new RegExp(`(?:^|[\\s"'])${attr}="([^"]*${diac}[^"]*)"`, 'g'))) out.push(`attribute: ${m[1].trim()}`);
    }
  });
  return out;
}

/** Romanian markup this census is allowed to find. Empty, and staying empty is the claim. */
const ROMANIAN_ALLOWED = new Set([]);

test('no page prints Romanian of its own with no hook over it', () => {
  const offenders = [];
  const allowed = new Set();
  for (const page of MARKUP_PAGES) {
    const source = readFileSync(join(ROOT, page), 'utf8');
    for (const found of hardcodedMarkupRomanian(source)) {
      const site = `${page.split('/').pop()}: ${found}`;
      if (ROMANIAN_ALLOWED.has(site)) allowed.add(site);
      else offenders.push(`${page}: ${found}`);
    }
  }
  assert.deepEqual(offenders, [], `these reach an English reader in Romanian: ${offenders.join('; ')}`);

  const stale = [...ROMANIAN_ALLOWED].filter((site) => !allowed.has(site));
  assert.deepEqual(stale, [], `these allowances no longer match anything: ${stale.join('; ')}`);
});

test('the Romanian detector still finds one when there is one', () => {
  // A hooked line is not an offender however Romanian it reads: the markup is
  // the fallback and apply() replaces it. That is the property the scrape.html
  // five did not have, so the control asserts it directly.
  const hooked = '<label title="Include meciurile aflate \u00een desf\u0103\u0219urare" data-i18n-title="includeLiveTitle">';
  assert.deepEqual(hardcodedMarkupRomanian(hooked), [], 'a hooked line must stay invisible');

  // One attribute and one text node, asserted as an exact list: a detector that
  // reported everything on every line would pass a bare `length > 0`.
  const unhooked = [
    '<label title="Include meciurile aflate \u00een desf\u0103\u0219urare">',
    '<caption class="visually-hidden">Rezultate ultimei rul\u0103ri</caption>',
    // The shape the first version of this detector missed: an unhooked
    // `aria-label` sharing a line with a hook for a different attribute.
    '<input type="search" placeholder="Filtreaz\u0103\u2026" data-i18n-placeholder="filterSources" aria-label="Filtreaz\u0103 casele">',
    // And the gap that stays open on purpose: a Romanian text node sharing a
    // line with any data-i18n hook is invisible, which is the sibling's
    // documented over-permission kept for the text half. Pinned so that the
    // claim "the text half is whole-line" fails loudly if anyone tightens it.
    '<label data-i18n="bankroll"><span>Sum\u0103</span></label>',
  ].join('\n');
  assert.deepEqual(hardcodedMarkupRomanian(unhooked), [
    'attribute: Include meciurile aflate \u00een desf\u0103\u0219urare',
    'text: Rezultate ultimei rul\u0103ri',
    'attribute: Filtreaz\u0103 casele',
  ]);
});

test('every hook a page declares points at a key both languages define', () => {
  // The other side of the dead-key census, and the reason it is worth writing: a
  // hook naming a key that nobody added does not fail anywhere else. `apply()`
  // resolves a missing key to the key's own name, so the reader gets
  // `workstationLoading` printed into the interface, while the dead-key test sees
  // nothing wrong because it asks whether keys are read, not whether the markup
  // points at real ones.
  //
  // This is not hypothetical. The wiring report that produced these hooks printed
  // its candidate keys slash-joined, and one site was wired as
  // `data-i18n="export/exportCsv"` — a name no dictionary defines — while the
  // report called it resolved.
  const dangling = [];
  for (const page of MARKUP_PAGES) {
    const source = stripHtmlComments(readFileSync(join(ROOT, page), 'utf8'));
    for (const m of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) {
      for (const [lang, dict] of [['ro', RO], ['en', EN]]) {
        if (!(m[1] in dict)) dangling.push(`${page}: ${m[1]} is missing from ${lang}`);
      }
    }
  }
  assert.deepEqual(dangling, [], `hooks with nothing behind them: ${dangling.join('; ')}`);
});

test('the markup detector still finds one when there is one', () => {
  // Same reasoning as the control above: a regex that quietly stopped matching
  // reports a clean bill of health for twelve pages. This runs it over text it has
  // to find and text it has to leave alone, and the leaving-alone half is the
  // interesting one — a one-line comment, a comment spanning three lines, a full
  // hook, and each of the three attribute hooks are all things it is allowed to
  // miss on purpose.
  const found = hardcodedMarkupEnglish([
    '<!-- <div>Commented Out</div> -->',
    '<!-- Banner --------',
    '   Sector One',
    '-->',
    '<div title="Toggle group">x</div>',
    '<span data-i18n="showMore">Show more</span>',
    '<input aria-label="Toggle language" data-i18n-aria-label="toggleLanguage">',
    '<a href="/event.html">Go to market</a>',
  ].join('\n'));
  assert.deepEqual(found.sort(), ['attribute: Toggle group', 'text: Go to market'],
    'the detector sees both shapes, and leaves the comments and all four hook forms alone');
});

// ---------------------------------------------------------------------------
// The third surface: a key named in JavaScript rather than in markup.
// ---------------------------------------------------------------------------

/**
 * The keys one page names, in the two shapes a page has for naming one.
 *
 * A call, `t('margin')`, and a hook written into a template literal,
 * `data-i18n="showMore"`, which `apply()` resolves on the next pass. Both are
 * invisible to the census above: it reads `.html` files, and inside those it
 * treats any line carrying `data-i18n` as already wired.
 *
 * Comments are dropped first, through the same `withoutComments` the markup
 * detector uses. A commented-out call is not a page naming a key, and a fixture
 * below asserts that it is skipped rather than trusted.
 *
 * @param {string} source one page's whole source
 * @returns {{kind: string, key: string}[]}
 */
function jsKeyReferences(source) {
  const out = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = withoutComments(raw);
    if (!line) continue;
    // `t` and `tf`: the second one interpolates tokens, and it names a key in
    // exactly the same way, so leaving it out would have hidden the whole app.
    for (const m of line.matchAll(/\b(?:t|tf)\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*[,)]/g)) {
      out.push({ kind: 'call', key: m[2] });
    }
    for (const m of line.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
      out.push({ kind: 'hook', key: m[1] });
    }
  }
  return out;
}

test('no page names a key the dictionary does not hold', () => {
  // A name that is not a key is worse than an untranslated string: `t()` ends in
  // `|| key`, so the interface prints `marginOrRoi` in the reader's face in both
  // languages. One was live when this was written — `dashboard.js` named it for
  // the figure column, where a surebet row shows its margin and a middle row its
  // ROI — and it had been shipping as a raw identifier. Same defect class as the
  // dangling `export/exportCsv` hook the wiring report produced, on the surface
  // that report could not cover.
  const dirs = ['public/js', 'public/js/pages', 'frontend/src'];
  const offenders = [];
  let seen = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!/\.(js|ts|tsx)$/.test(name) || name === 'i18n.js') continue;
      const source = readFileSync(join(ROOT, dir, name), 'utf8');
      for (const ref of jsKeyReferences(source)) {
        seen++;
        const missing = LANGS.filter((lang) => !(ref.key in DICT[lang]));
        if (missing.length) offenders.push(`${dir}/${name}: ${ref.kind} '${ref.key}' missing from ${missing.join(' and ')}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `named but never defined, so the reader sees the name itself: ${offenders.join('; ')}`);

  // And the control that keeps the assertion above from passing on an empty set:
  // the scan has to have actually read something. A page tree that stopped
  // yielding references would otherwise report itself perfectly clean.
  assert.ok(seen > 400, `the scan only read ${seen} key references — the extractor has stopped matching`);
});

test('the key-name detector still finds one when there is one', () => {
  // The positive and the negative half of the same claim, on text this test
  // controls: both shapes are resolved, a real key passes, a near-miss fails,
  // and the commented-out line is not read at all.
  const fixture = [
    "const a = t('margin');",
    'const f = tf(\'appFeedStatus\', { n: 1 });',
    "const b = t('marginOrRoi');",
    'const c = `<span data-i18n="showMore">Show more</span>`;',
    'const d = `<span data-i18n="showMor">Show more</span>`;',
    "// const e = t('commentedOut');",
  ].join('\n');
  const found = jsKeyReferences(fixture);
  assert.deepEqual(found.map((r) => `${r.kind}:${r.key}`),
    ['call:margin', 'call:appFeedStatus', 'call:marginOrRoi', 'hook:showMore', 'hook:showMor'],
    'both shapes are read, tf() names a key too, and the commented-out call is not');

  const missing = found.filter((r) => LANGS.some((lang) => !(r.key in DICT[lang]))).map((r) => r.key);
  assert.deepEqual(missing, ['marginOrRoi', 'showMor'],
    'the dictionary resolves the two real keys and names the two that are not keys');
});

// ---------------------------------------------------------------------------
// The blind spot the markup detector documents: text longer than its ceiling.
// ---------------------------------------------------------------------------

/**
 * Every un-hooked text run longer than the markup detector's 60-character ceiling.
 *
 * `hardcodedMarkupEnglish` cannot see these at all. Its quantifier is `{3,60}`
 * and the closing `>` has to follow immediately, so a run of 61 characters does
 * not fail that match — it never starts one. The consequence is not a small
 * gap: the absolute worst offenders are the longest strings, and the length is
 * what hides them. That is how `arbitrage.html`'s subtitle, its middle and
 * low-hold notes and `live.html`'s engine note all survived a green census.
 *
 * This walks the document instead of the line. Tags are consumed in order and a
 * stack records whether any open ancestor declared a hook, so a text node
 * inherits the hook that wraps it rather than the hook that happens to share its
 * line — which is the second half of the same blind spot, since the prose that
 * hid also wrapped across lines.
 *
 * Only ASCII runs count. A run carrying a Romanian diacritic is Romanian, and
 * Romanian is what a page is allowed to print for itself.
 *
 * @param {string} source a page's whole source
 * @returns {string[]} the offending runs, whitespace collapsed
 */
function unhookedLongText(source) {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const out = [];
  const stack = [];
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let last = 0;
  let m;
  while ((m = tag.exec(cleaned))) {
    const text = cleaned.slice(last, m.index).replace(/\s+/g, ' ').trim();
    if (text && !stack.some(Boolean) && text.length > 60 && /^[\x20-\x7E]+$/.test(text)) out.push(text);
    last = tag.lastIndex;
    if (m[0].startsWith('</')) stack.pop();
    else if (!m[0].endsWith('/>') && !VOID.has(m[1].toLowerCase())) stack.push(/data-i18n/.test(m[0]));
  }
  return out;
}

/**
 * Long runs this census is allowed to find, with the reason, one at a time.
 *
 * Empty, and deliberately kept that way. The only two entries this ever held
 * were the two English sentences with an inline `<code>` in the middle of them.
 * `apply()` assigns `textContent`, so hooking the parent would have destroyed
 * the code element; both blocks were instead split into separately-keyed spans
 * around the code span — the no-injection option — so the code element survives
 * and the prose is translated. A non-empty entry here means a block is still
 * shipping its own English; the stale-allowance check below insists the list
 * shrink whenever a fix lands.
 */
const LONG_TEXT_ALLOWED = new Set([]);

test('no un-hooked text run is long enough to escape the detector', () => {
  const offenders = [];
  const allowed = new Set();
  for (const page of MARKUP_PAGES) {
    const source = readFileSync(join(ROOT, page), 'utf8');
    for (const found of unhookedLongText(source)) {
      const site = `${page.split('/').pop()}: ${found}`;
      if (LONG_TEXT_ALLOWED.has(site)) allowed.add(site);
      else offenders.push(`${page}: [${found.length}] ${found}`);
    }
  }
  assert.ok(MARKUP_PAGES.length >= 12, `the page list shrank to ${MARKUP_PAGES.length}`);
  assert.deepEqual(offenders, [],
    `long enough that the 60-character detector cannot match it, and not in the dictionary: ${offenders.join(' | ')}`);

  // Same stale-allowance self-check as the markup census: an allowance that is no
  // longer found is a fix that happened, and the list must shrink with it.
  const stale = [...LONG_TEXT_ALLOWED].filter((entry) => !allowed.has(entry));
  assert.deepEqual(stale, [], `no longer present, so delete the allowance: ${stale.join(' | ')}`);
});

test('the long-text detector still finds one when there is one', () => {
  // The three negatives are the interesting half: a hooked parent, a short run,
  // and a Romanian run all have to be left alone. The Romanian one is the one
  // that would make this test useless if it leaked — every page is full of
  // Romanian prose, and a detector that reported it would be switched off.
  const sentence = 'This run is long enough that the sixty character ceiling cannot match it at all.';
  const fixture = [
    `<p>${sentence}</p>`,
    `<p data-i18n="someKey">${sentence}</p>`,
    '<p>Short enough</p>',
    '<p>Text românesc suficient de lung pentru a fi raportat dacă detectorul ar ignora diacriticele.</p>',
  ].join('\n');
  const found = unhookedLongText(fixture);
  assert.deepEqual(found, [sentence],
    'only the un-hooked ASCII run over the ceiling counts');
  assert.ok(sentence.length > 60, 'the fixture sentence has to actually be over the ceiling');
});


test('a period suffix never restates the market it is appended to', () => {
  // Every 1X2 badge read "Rezultat final \u00b7 Final": the base label already named
  // full time and the suffix said it again in the same word. The suffix earns
  // its place on a market whose name does not imply a period — "Total goluri
  // 2.5 \u00b7 FT" is the difference between a full-time total and the same total
  // at half time — so what was wrong was the word, not the suffix, and dropping
  // the suffix would have thrown that information away to fix a translation.
  //
  // Written as a rule rather than as one expected string, because the defect
  // comes back the moment someone translates a period as the market's own name.
  const bases = ['marketMatchResult', 'marketBothTeamsScore', 'marketDoubleChance',
    'marketSetWinner', 'marketTotalGoals', 'marketTotalCorners', 'marketAsianHandicap'];
  const periods = ['appPeriodFullTime', 'appPeriodFirstHalf', 'appPeriodSecondHalf', 'appPeriodFullTimeOt', 'appPeriodSet1'];
  const clashes = (lang, key, period) => {
    const suffix = lang[period].toLowerCase().split(/\s+/);
    const words = lang[key].toLowerCase().split(/\s+/);
    return suffix.some((word) => words.includes(word));
  };

  // The control: the detector still sees the string it was written for. A
  // detector that found nothing anywhere would pass every assertion below.
  assert.ok(clashes({ appPeriodFullTime: 'Final', marketMatchResult: 'Rezultat final' },
    'marketMatchResult', 'appPeriodFullTime'),
    'the detector cannot see "Rezultat final \u00b7 Final"');

  for (const [name, lang] of [['ro', RO], ['en', EN]]) {
    for (const key of bases) {
      for (const period of periods) {
        assert.ok(lang[key] && lang[period], `${name} is missing ${key} or ${period}`);
        assert.ok(!clashes(lang, key, period),
          `${name}: "${lang[key]} \u00b7 ${lang[period]}" names the same thing twice`);
      }
    }
  }

  // And the badge itself, composed from the real dictionary. The two halves
  // above can each be fine while the rendered string is not.
  const tr = (lang) => (key) => (key in lang ? lang[key] : key);
  assert.equal(localizeMarketLabel('Match Result \u00b7 FT', tr(RO)), 'Rezultat final \u00b7 FT');
  assert.equal(localizeMarketLabel('Match Result \u00b7 1H', tr(RO)), 'Rezultat final \u00b7 Prima repriz\u0103');
  assert.equal(localizeMarketLabel('Total Goals 2.5 \u00b7 FT', tr(RO)), 'Total goluri 2.5 \u00b7 FT');
  assert.equal(localizeMarketLabel('Match Result \u00b7 FT', tr(EN)), 'Match result \u00b7 FT');
});
