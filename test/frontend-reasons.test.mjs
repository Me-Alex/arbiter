/**
 * frontend-reasons.test.mjs — the verification verdicts, in the reader's language.
 *
 * `src/verification.mjs` decides whether an opportunity's legs still add up and
 * states the verdict it reached as an English sentence. Two places in the shell
 * render that sentence: the risk tag's tooltip on the card and the settlement
 * notice in the execution slip. In the Romanian interface it was the last
 * English on the screen.
 *
 * `reasons.ts` maps it, and the mapping is closed on purpose — a verdict is the
 * last thing to guess at, so an unknown one is passed through rather than
 * approximated. "Closed" is only worth saying if something checks it, so the
 * test below reads the engine's own source, extracts every sentence it can say,
 * and requires each one to reach a translation. Add a verdict to
 * `verification.mjs` without mapping it and this file goes red by name.
 *
 * The translator is injected, like `labels.ts`, which is what lets the
 * assertions be about the *choice* (`<appReasonRepriced>`) rather than about a
 * sentence in one language. Substitution is checked against the real dictionary,
 * because "the id survived" is not something a key-printer can show.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RULE_REASONS, RULE_REASON_KEYS, RULE_REASON_PATTERNS, localizeRuleReason } from '../frontend/src/reasons.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shows which key was asked for, so the assertion is about the choice. */
const key = (name) => `<${name}>`;

// The dictionary is a browser script, not a module, so the two language blocks
// are cut out of the source. `test/i18n-dictionary.test.mjs` evaluates the whole
// literal; here only two values are ever read, and reading them as text keeps
// the failure readable when a key is missing.
const i18nSource = readFileSync(join(ROOT, 'public/js/i18n.js'), 'utf8');
const EN_AT = i18nSource.indexOf('\n    en: {');
const RO_BLOCK = i18nSource.slice(0, EN_AT);
const EN_BLOCK = i18nSource.slice(EN_AT);
const valueIn = (block, name) => {
  const match = block.match(new RegExp(`\\n\\s+${name}:\\s*'((?:[^'\\\\]|\\\\.)*)'`));
  return match ? match[1] : null;
};

/** The interpolation tokens a value carries, so the two languages can be compared. */
const tokens = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('the controls: a known verdict is translated and an unknown one is left alone', () => {
  // Without the first half a broken import reads as "nothing needs saying", and
  // without the second a table that answered everything would read as complete.
  assert.equal(localizeRuleReason('', key), '');
  assert.equal(localizeRuleReason(null, key), '');
  assert.equal(localizeRuleReason(undefined, key), '');
  assert.equal(localizeRuleReason('all legs re-priced within tolerance', key), '<appReasonRepriced>');
  assert.equal(localizeRuleReason('a verdict nobody has written yet', key), 'a verdict nobody has written yet');
  // And the table is exact, not fuzzy. A near-miss has to fall through: a
  // mapping that matched on a prefix would translate a sentence it does not
  // recognise by the meaning of a different one.
  assert.equal(localizeRuleReason('all legs re-priced within tolerance.', key), 'all legs re-priced within tolerance.');
  assert.equal(localizeRuleReason('all legs re-priced within toleranc', key), 'all legs re-priced within toleranc');
});

test('every verdict the engine states in full is mapped', () => {
  // Named one by one rather than counted, so a key that stops being reached is
  // reported as itself.
  const unmapped = Object.entries(RULE_REASONS)
    .filter(([reason, name]) => localizeRuleReason(reason, key) !== `<${name}>`)
    .map(([reason]) => reason);
  assert.deepEqual(unmapped, [], 'these verdicts no longer reach their translation');
  // The control: the table is a real one, and its size is pinned so that
  // deleting entries to make the assertion above pass is itself a failure.
  assert.equal(Object.keys(RULE_REASONS).length, 12);
  assert.deepEqual(Object.keys(RULE_REASONS).sort()[0], 'Backend verification rejected this contract.');
});

test('the verdicts built around data keep the data', () => {
  // The engine's identifiers and figures are substituted, not translated: a
  // book's own name and a price are not words in anyone's language. The
  // dictionary is real here, so this pins the Romanian phrasing as well.
  const ro = (name) => valueIn(RO_BLOCK, name) ?? key(name);
  assert.equal(localizeRuleReason('superbet ambiguous selection', ro), 'selecție ambiguă la superbet');
  assert.equal(localizeRuleReason('betano selection missing from re-scrape (event present)', ro),
    'selecția betano lipsește din rescaneare (evenimentul există)');
  assert.equal(localizeRuleReason('unibet leg missing from re-scrape (event not reached)', ro),
    'piciorul unibet lipsește din rescaneare (evenimentul nu a fost atins)');
  assert.equal(localizeRuleReason('favbet odds drift 2.1 → 1.95', ro), 'cota favbet s-a mișcat 2.1 → 1.95');
  assert.equal(localizeRuleReason('margin dropped to 2.40%', ro), 'marja a scăzut la 2.40%');
  // A pattern has to be anchored at both ends. An unanchored one would translate
  // a longer sentence by the meaning of its first clause.
  for (const [pattern] of RULE_REASON_PATTERNS) {
    assert.ok(pattern.source.startsWith('^') && pattern.source.endsWith('$'), `unanchored pattern: ${pattern}`);
  }
});

test('the engine cannot say a verdict this file does not know', () => {
  // The closure guard, and the reason the mapping may be called closed. Every
  // sentence the engine builds is read, in both shapes it is built in: a
  // `reason:` it is returned under, and the `rejectedReason` /
  // `missingLegReason` it is assigned to several lines earlier and returned by
  // name at the end. A first version of this read only the first shape and
  // reported ten verdicts where the engine states fourteen — the control below
  // is what caught that, which is the whole reason it is there.
  //
  // The scan runs to the end of the line rather than to the quoted value right
  // after the colon, because two of the engine's verdicts sit behind a ternary
  // on the same line.
  const engine = readFileSync(join(ROOT, 'src/verification.mjs'), 'utf8');
  const said = new Set();
  for (const line of engine.split(/\r?\n/)) {
    const at = line.search(/\breason\s*:|Reason\s*=/);
    if (at < 0) continue;
    const tail = line.slice(at);
    for (const match of tail.matchAll(/'([^']*)'/g)) said.add(match[1]);
    // A template is turned into a sample by standing its interpolations in as a
    // bare token, which is what the patterns match on: `\S+`.
    for (const match of tail.matchAll(/`([^`]*)`/g)) said.add(match[1].replace(/\$\{[^}]*\}/g, 'X'));
  }

  const unmapped = [...said].filter((reason) => localizeRuleReason(reason, key) === reason);
  assert.deepEqual(unmapped, [],
    `the engine can state these and the interface would print them in English: ${unmapped.join(', ')}`);

  // The controls. A scan that stopped matching reports a perfectly closed
  // mapping, so the extractor has to be seen finding something, and the
  // detector has to be seen reporting an unmapped verdict when one exists.
  assert.equal(said.size, 18, `the extractor read ${said.size} verdicts out of the engine, not the eighteen it states`);
  assert.ok([...said].some((reason) => reason.includes('X leg re-quoted from X-scope, not X-scope')),
    'the team-scope verdict is not being read');
  assert.ok([...said].some((reason) => reason.includes('X odds drift X')),
    'the templated verdicts are not being read — the closure claim is empty');
  assert.ok(said.has('event past') && said.has('event kickoff unknown'),
    'the two verdicts behind a ternary are not being read');
  assert.equal(localizeRuleReason('a verdict the engine has not written yet', key),
    'a verdict the engine has not written yet', 'the detector cannot see an unmapped verdict');
});

test('the api fallback sentence is mapped and still says what this table maps', () => {
  // `api.ts` writes this one when a rejection arrives without a reason, so the
  // table is pinned to the sentence that is actually there rather than to a
  // copy of it.
  const api = readFileSync(join(ROOT, 'frontend/src/api.ts'), 'utf8');
  const match = api.match(/reason \?\? '([^']+)'/);
  assert.ok(match, 'api.ts no longer carries the fallback this table maps');
  assert.equal(localizeRuleReason(match[1], key), '<appReasonRejectedGeneric>');
});

test('every key a verdict needs exists in both languages', () => {
  // `reasons.ts` holds key *names* as values, which is the one shape the
  // dictionary's own census cannot resolve: it looks for keys named in a call,
  // so a typo here would read as a used key and print itself at runtime.
  const missing = [];
  for (const name of RULE_REASON_KEYS) {
    for (const [lang, block] of [['ro', RO_BLOCK], ['en', EN_BLOCK]]) {
      if (valueIn(block, name) === null) missing.push(`${lang}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `a verdict key is named and never defined: ${missing.join(', ')}`);
  // No table may name one key twice, or the second entry shadows the first and
  // the tests above would be checking the winner.
  assert.equal(new Set(RULE_REASON_KEYS).size, RULE_REASON_KEYS.length, 'a verdict key is mapped twice');
  assert.equal(RULE_REASON_KEYS.length, Object.keys(RULE_REASONS).length + RULE_REASON_PATTERNS.length);
});

test('the two languages interpolate the same tokens', () => {
  // A Romanian entry missing `{id}` drops the source the verdict is about, and
  // one carrying a token the pattern cannot fill prints the token itself.
  for (const name of RULE_REASON_KEYS) {
    const ro = valueIn(RO_BLOCK, name);
    const en = valueIn(EN_BLOCK, name);
    assert.deepEqual(tokens(ro), tokens(en), `${name} does not interpolate the same tokens in both languages`);
  }
  // The control: the token reader can see tokens at all, and sees none where
  // there are none. A reader that returned nothing would satisfy the loop above.
  assert.deepEqual(tokens('cota {id} s-a mișcat {from} → {to}'), ['from', 'id', 'to']);
  assert.deepEqual(tokens('toate picioarele au fost recotate în toleranță'), []);
});
