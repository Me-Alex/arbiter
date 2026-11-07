/**
 * frontend-labels.test.mjs — the market words a Romanian trader actually reads.
 *
 * `api.ts` publishes English market names and `test/frontend-normalize.test.mjs`
 * pins them, because that label is the thing the subject rule reasons about.
 * This file covers the other half: `labels.ts`, which turns that English label
 * into the interface's language at render time.
 *
 * The translator is injected, which is the whole reason this is testable in
 * Node: `labels.ts` imports nothing, so a test can drive it with a translator
 * that prints the key it was asked for and see the decision rather than a
 * string in one language.
 *
 * What these tests cannot see is whether the keys exist in the dictionary —
 * they are asked for, not looked up. `test/i18n-dictionary.test.mjs` covers
 * that: it reads `LABEL_KEYS` out of the table below and fails on a key
 * either language does not define.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeMarketLabel } from '../frontend/src/labels.ts';

/** Shows which key was asked for, so the assertion is about the choice. */
const key = (name) => `<${name}>`;

test('the controls: the fixtures reach the map at all', () => {
  // An empty string is returned as it came, and one known label is translated.
  // Without both halves a broken import would read as "nothing to translate".
  assert.equal(localizeMarketLabel('', key), '');
  assert.equal(localizeMarketLabel('Market', key), '<market>');
  assert.equal(localizeMarketLabel('Double Chance', key), '<marketDoubleChance>');
});

test('the line a key carried is kept, and only the market word changes', () => {
  // `OVER_UNDER_2_5` resolves through its line, so the number is the line and
  // translating it would name a different bet.
  assert.equal(localizeMarketLabel('Total Goals 2.5', key), '<marketTotalGoals> 2.5');
  assert.equal(localizeMarketLabel('Total Goals 3.5', key), '<marketTotalGoals> 3.5');
  assert.equal(localizeMarketLabel('Games 5.5', key), '<appSubjectGames> 5.5');
});

test('the longer phrase wins, so Goals does not eat Total Goals', () => {
  // Ordered by length at runtime rather than by hand: a prefix table that is
  // sorted wrong translates "Total Goals 2.5" as "Goals" plus a stray "Total".
  assert.equal(localizeMarketLabel('Total Goals', key), '<marketTotalGoals>');
  assert.equal(localizeMarketLabel('Goals', key), '<appSubjectGoals>');
  assert.equal(localizeMarketLabel('Corners Over/Under', key), '<appMarketCornersOverUnder>');
  assert.equal(localizeMarketLabel('Corners', key), '<marketTotalCorners>');
});

test('a subject no market name stands behind still gets a word', () => {
  // `rounds` and `legs` are subjects the engine derives and no key names, so
  // the label reaches here as the bare word plus its line. Without an entry
  // the table returns it unchanged, which is how the backend token would be
  // drawn to a trader as-is.
  assert.equal(localizeMarketLabel('Rounds 21.5', key), '<appSubjectRounds> 21.5');
  assert.equal(localizeMarketLabel('Legs 2.5', key), '<appSubjectLegs> 2.5');
});

test('the period suffix is translated and an unknown one is left alone', () => {
  assert.equal(localizeMarketLabel('Total Goals 2.5 · FT', key), '<marketTotalGoals> 2.5 · <appPeriodFullTime>');
  assert.equal(localizeMarketLabel('Total Goals 2.5 · 1H', key), '<marketTotalGoals> 2.5 · <appPeriodFirstHalf>');
  // `formatMarketName` uppercases an unrecognised period; inventing a
  // translation for a period nobody has seen would be worse than "ET".
  assert.equal(localizeMarketLabel('Total Goals 2.5 · ET', key), '<marketTotalGoals> 2.5 · ET');
});

test('a label the table does not know is returned unchanged', () => {
  // The honest fallback. A book's vocabulary is not knowable in advance, and an
  // English word a trader can still read beats a confident mistranslation.
  assert.equal(localizeMarketLabel('Under 2.5', key), 'Under 2.5');
  assert.equal(localizeMarketLabel('Some Book Market', key), 'Some Book Market');
  assert.equal(localizeMarketLabel('Both Teams to Score · FT', key), '<marketBothTeamsScore> · <appPeriodFullTime>');
});

test('a side prefix does not eat a market that opens with the same word', () => {
  // The engine publishes `team` only when it resolved a real side, so the row
  // says which total it is: a home total and the match total settle on
  // different numbers. The word is a prefix, and two labels in this table
  // already open with the same two words - so the whole head is matched first
  // and only a recognised market behind the word gets a translated side.
  assert.equal(localizeMarketLabel('Home Total Goals 2.5', key), '<appSideHome> <marketTotalGoals> 2.5');
  assert.equal(localizeMarketLabel('Away Total Goals 2.5 · FT', key), '<appSideAway> <marketTotalGoals> 2.5 · <appPeriodFullTime>');
  assert.equal(localizeMarketLabel('Home Goals 2.5', key), '<appSideHome> <appSubjectGoals> 2.5');

  // The control: these are markets, not scopes, and each keeps its own meaning.
  assert.equal(localizeMarketLabel('Home or Away vs Draw', key), '<appMarketSynthetic12VsDraw>');
  assert.equal(localizeMarketLabel('Home or Draw vs Away Win', key), '<marketSynthetic1xVsAway>');

  // A side with a market this table cannot name is left whole rather than half
  // translated, and a bare word is not a label at all.
  assert.equal(localizeMarketLabel('Home Some Book Market', key), 'Home Some Book Market');
  assert.equal(localizeMarketLabel('Home', key), 'Home');
});

test('the two 1X2 spellings collapse to one label on purpose', () => {
  // "Match Result" and "Match Odds" are the same market under two book
  // spellings. One label for both is a decision, not an oversight, and this
  // pins it so a future edit has to argue with it.
  assert.equal(localizeMarketLabel('Match Result', key), '<marketMatchResult>');
  assert.equal(localizeMarketLabel('Match Odds', key), '<marketMatchResult>');
});

test('the table does not translate one label two ways', () => {
  // A duplicated phrase would silently shadow the earlier entry, and every test
  // above would still pass because it would be checking the winner.
  const labels = ['Match Result', 'Match Odds', 'Total Goals', 'Total Games', 'Total Cards', 'Total Points',
    'Corners', 'Corners Over/Under',
    'Goals', 'Points', 'Games', 'Rounds', 'Legs', 'Market', 'Set Winner', 'Double Chance',
    'Both Teams to Score', 'Draw No Bet (level)', 'Equivalent Market',
    'Derived equivalence contract', 'Draw or Away vs Home Win', 'Home or Draw vs Away Win', 'Home or Away vs Draw'];
  // The one collapse this table makes on purpose, named rather than tolerated:
  // `Match Result` and `Match Odds` are the same 1X2 market under two book
  // spellings, so they share a label. Anything else sharing a label is a
  // duplicate that would shadow whichever entry came first.
  const DELIBERATE = new Map([['<marketMatchResult>', 2]]);
  const seen = new Map();
  for (const label of labels) {
    const translated = localizeMarketLabel(label, key);
    assert.notEqual(translated, label, `${label} is not in the table — the fixture list has drifted`);
    seen.set(translated, [...(seen.get(translated) ?? []), label]);
  }
  const collapsed = [...seen].filter(([, sources]) => sources.length > 1);
  assert.deepEqual(
    collapsed.map(([label, sources]) => `${label} <- ${sources.join(' + ')}`).sort(),
    ['<marketMatchResult> <- Match Result + Match Odds'],
    'only the pinned 1X2 collapse may map two labels onto one',
  );
  for (const [label, expected] of DELIBERATE) {
    assert.equal(seen.get(label).length, expected, `${label} is expected to collect ${expected} spellings`);
  }
});
