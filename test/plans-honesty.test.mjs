/**
 * plans-honesty.test.mjs — the plans page must not describe a product that
 * does not exist yet.
 *
 * The tiers are an outline: a decision about what each level will contain, made
 * before any of it is enforced. That is a reasonable thing to publish. What is
 * not reasonable is publishing it in the grammar of a live product — a green
 * "Active Tier" badge on the free column, a list of caps that reads as "this is
 * what you get", a hardcoded "9,900+ signals" that is true for one afternoon in
 * October and wrong every day after.
 *
 * Three separate faults, and they fail differently:
 *
 *   - the missing disclaimer is a claim of enforcement where there is none, so
 *     a reader concludes the free tier is capped when every visitor in fact
 *     sees the whole dataset;
 *   - the badge is the same claim compressed to a colour, and survives a
 *     disclaimer written above it;
 *   - a count inside marketing copy is true at the moment it is typed and false
 *     as soon as a scrape lands, and nothing in the tree notices.
 *
 * These are source checks, not rendered ones. `App.tsx` is not loadable in Node
 * (no jsdom, and type stripping cannot read `.tsx`), so the file is read as
 * text — which is enough to pin which keys the Plans view asks for and which it
 * does not, since a key that is not named there cannot be rendered by it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const APP = read('frontend/src/App.tsx');
const I18N = read('public/js/i18n.js');

/**
 * The Plans view, sliced out of the shell.
 *
 * Anchored on the view guard and the next sibling view, so a card added to this
 * one block is read and a card moved to another workspace is not silently
 * counted as part of it.
 */
function plansBlock() {
  const start = APP.indexOf("{view === 'Plans' && (");
  assert.notEqual(start, -1, 'the Plans view is gone; this file is checking a block that no longer exists');
  const end = APP.indexOf("{view === 'Settings' &&", start);
  assert.notEqual(end, -1, 'the Plans slice has no end marker; the assertions below would read to end of file');
  return APP.slice(start, end);
}

/** Every `key: 'value'` pair in the dictionary, in both languages. */
function dictionary() {
  const map = new Map();
  for (const m of I18N.matchAll(/^\s{6}([A-Za-z0-9_]+):\s*'((?:[^'\\]|\\.)*)',?$/gm)) {
    if (!map.has(m[1])) map.set(m[1], []);
    map.get(m[1]).push(m[2]);
  }
  return map;
}

const dict = dictionary();
const PLANS = plansBlock();

test('the dictionary was actually read, so the lookups below are not passing on nothing', () => {
  // Without this the whole file goes green if the parse regex stops matching.
  assert.ok(dict.size > 500, `the dictionary parse found only ${dict.size} keys`);
  assert.ok(dict.has('appPlansHeading'), 'a known plans key is missing from the parse');
  assert.deepEqual(dict.get('appPlansHeading').length, 2, 'the plans keys are expected once per language');
});

test('the plans view states that no tier is enforced yet', () => {
  // The claim has to be on the page, not only in the dictionary: a string
  // nothing renders is a disclaimer for whoever reads the diff.
  assert.match(PLANS, /appPlansEnforcementTitle/, 'the Plans view renders no enforcement headline');
  assert.match(PLANS, /appPlansEnforcementNote/, 'the Plans view renders no enforcement note');
});

test('the disclaimer is written in both languages, and says what it means', () => {
  const [ro, en] = dict.get('appPlansEnforcementTitle') ?? [];
  const [roNote, enNote] = dict.get('appPlansEnforcementNote') ?? [];

  assert.ok(ro && en, 'the enforcement headline is not defined once per language');
  assert.ok(roNote && enNote, 'the enforcement note is not defined once per language');

  assert.match(en, /no tier is enforced/i);
  assert.match(ro, /nu este\s+.*aplicat/i);
  // The note has to name the present state, not only the future one: "these are
  // the intended gates" without "everything is visible today" leaves a reader
  // free to assume the caps are already on.
  assert.match(enNote, /now|today/i);
  assert.match(roNote, /acum|astăzi/i);
});

test('no plan card is labelled as an active or enforced tier', () => {
  // The badge this replaced said "Active Tier" in green on the free column
  // while every restriction it listed was unapplied. The key is gone from the
  // dictionary too, so restoring the badge fails here rather than only looking
  // wrong to a human.
  assert.doesNotMatch(PLANS, /appPlanCurrentTag/, 'a plan card labels itself as the active tier again');
  assert.equal(dict.has('appPlanCurrentTag'), false, 'the retired "active tier" string is back in the dictionary');

  // And the free column carries the not-enforced state instead.
  assert.match(PLANS, /appPlanNotEnforced/, 'the free column no longer says its caps are unapplied');
  assert.equal((dict.get('appPlanNotEnforced') ?? []).length, 2, 'the not-enforced label is not defined once per language');
});

test('no plan feature or description hardcodes a dataset size', () => {
  // "9,900+ signals" and "110+ sportsbooks" were both true of one published
  // board. A count written into copy has no reader that updates it, so it is
  // false the next time the scrape lands — and it reads as a promise.
  const priced = new Set(['appPlanFreePrice', 'appPlanProPrice', 'appPlanAllPrice']);
  const offenders = [];
  for (const [key, values] of dict) {
    if (!/^appPlan[A-Za-z0-9]*$/.test(key)) continue;
    if (priced.has(key)) continue;
    if (!/(Desc$|F\d+$)/.test(key)) continue;
    for (const value of values) {
      // Separators are stripped first so `9,900` and the Romanian `9.900` are
      // both read as one number. Thresholds stay legal: `profit ≤ 1%` and a
      // `2.5` line are two digits or fewer, a dataset size is three or more.
      const unseparated = value.replace(/(\d)[,.\u00a0 ](?=\d)/g, '$1');
      if (/\d{3,}/.test(unseparated)) offenders.push(`${key}: ${value}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a plan line counts a dataset that moves. Describe the capability, not the snapshot it had on the day it was written.');
});

test('the plans disclaimer is stated once, not in the header and again in the panel', () => {
  // Rendered at 1440px the page printed the same sentence twice: under the
  // workspace title, and again at the top of the panel about 150px below it.
  // The header owns that line — the subtitle map is the one place a workspace
  // says what it is — so the panel must not repeat it.
  assert.match(APP, /Plans: 'appPlansDisclaimer'/,
    'the Plans workspace lost the header subtitle that carries its disclaimer');
  assert.equal([...PLANS.matchAll(/appPlansDisclaimer/g)].length, 0,
    'the panel repeats the header subtitle verbatim instead of letting the header state it');
});

test('a cross-marked plan row does not repeat the negation in its own label', () => {
  // Every row prints its glyph and then the string, so a label that carries its
  // own negation renders as `✗ No CSV export` — "not: no CSV export". A reader
  // resolves that either way, and one of the two readings is the opposite of the
  // tier. The glyph owns the polarity; the label names the capability.
  const rows = [...PLANS.matchAll(/<li>(✗|✓)\s*\{t\('([A-Za-z0-9_]+)'\)\}<\/li>/g)];
  assert.ok(rows.length >= 10,
    `only ${rows.length} plan rows were read; the row markup changed shape and this check is reading nothing`);

  const offenders = [];
  for (const [, glyph, key] of rows) {
    if (glyph !== '✗') continue;
    for (const value of dict.get(key) ?? []) {
      if (/^(no|not|without|none|fără|nu)\b/i.test(value)) offenders.push(`${key}: ${value}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a ✗ row repeats the negation in its own label, so the line says the opposite of what it means');
});
