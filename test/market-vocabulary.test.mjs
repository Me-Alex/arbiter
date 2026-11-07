/**
 * market-vocabulary.test.mjs — the app's names for the markets the engine
 * measures.
 *
 * Two modules have to agree and neither can check the other. The backend
 * measures what a total's line counts and publishes the answer in
 * `SUBJECT_BY_KEY` (`src/scanner/market-contracts.mjs`); the app turns a
 * market key into the words a trader reads (`frontend/src/api.ts`). They are
 * written in different languages — one runs in Node, the other in a browser —
 * so a disagreement is invisible to both: the engine pairs the right contracts
 * while the row is titled a different bet.
 *
 * It has happened. The app called `TCOU` "Total Goals" while the backend
 * measured that key as cards, whose provider title is "Total cartonașe
 * Peste/Sub", and it called `FTGO` "Full Time Goals" while the backend measured
 * it as games — the key betano publishes on Tennis as "Game-uri". A trader
 * reading a cards line as a goals line is looking at the wrong market.
 *
 * So this file reads the backend table out of its own source and drives the
 * app's real normalizer with it. Reading the source rather than restating the
 * table is the point: a key added to one side and not the other fails here, and
 * `subjectFor` is asserted against the same parse so the parse cannot quietly
 * become a stale copy that passes by matching itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeScan } from '../frontend/src/api.ts';
import { subjectFor } from '../src/scanner/market-contracts.mjs';

const SOURCE = readFileSync(new URL('../src/scanner/market-contracts.mjs', import.meta.url), 'utf8');

/** The measured key → subject table, read from the backend's own source. */
function measuredSubjects() {
  const block = /const SUBJECT_BY_KEY = new Map\(\[([\s\S]*?)\n\]\);/.exec(SOURCE);
  assert.ok(block, 'SUBJECT_BY_KEY is no longer a Map literal in market-contracts.mjs, which is where this guard reads it');
  const pairs = [...block[1].matchAll(/\['([A-Z_0-9]+)',\s*'([a-z_]+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 8, `parsed ${pairs.length} keys out of SUBJECT_BY_KEY — the table's shape changed`);
  return pairs;
}

/** The word the app titles a market with, per subject. */
const WORDS = { corners: 'Corners', cards: 'Cards', points: 'Points', games: 'Games', goals: 'Goals' };

/** The payload shape every row here is built from, as `scan.opportunities` publishes it. */
const ROW = {
  type: 'arb', family: 'OVER_UNDER', period: 'fulltime', line: '3.5', marketKey: 'OVER_UNDER_3_5',
  eventKey: 'football|2026-10-17T11:30:00.000Z|home|away',
  sport: 'Football', homeTeam: 'Home', awayTeam: 'Away', marginPercent: 4,
  legs: [
    { sourceId: 'favbet', selection: 'Over', odds: 2.1 },
    { sourceId: 'betano', selection: 'Sub', odds: 2.02 },
  ],
};

/** One row's rendered market name, through the real normalizer. */
function nameFor(overrides) {
  const [row] = normalizeScan({ opportunities: [{ ...ROW, ...overrides }] });
  assert.ok(row, `${JSON.stringify(overrides)} produced no row at all, so nothing about its name was checked`);
  return row.marketName;
}

/** The same, for a market key alone. */
const labelFor = (key) => nameFor({ marketKey: key });

test('the control: the table is read from the backend, not restated', () => {
  // Without this, a regex that stopped matching would let the loop below run
  // over nothing and report a cross-module check that checked nothing. Asking
  // `subjectFor` the same questions is what proves the parse reads the live
  // table rather than a copy of it.
  const pairs = measuredSubjects();
  assert.ok(pairs.some(([key]) => key === 'TCOU'), 'TCOU is not among the parsed keys');
  for (const [key, subject] of pairs) {
    assert.equal(subjectFor({ key, name: '' }), subject, `the backend no longer resolves ${key} to ${subject}`);
  }
});

test('every measured key is titled with the subject the backend measured', () => {
  for (const [key, subject] of measuredSubjects()) {
    const word = WORDS[subject];
    assert.ok(word, `the app has no word for the subject "${subject}" (${key})`);
    const label = labelFor(key);
    assert.ok(label.includes(word), `${key} counts ${subject} and the row reads "${label}", which never says ${word}`);
    if (subject !== 'goals') {
      assert.ok(!label.includes('Goals'), `${key} counts ${subject}, so it must not be titled "${label}" — a goals market`);
    }
  }
});

test("a subject the book carries separately is named, not printed raw", () => {
  // Half the books key a total by its family and carry the subject beside it,
  // so `OVER_UNDER_4_5` on its own says goals: what the row is CALLED comes
  // from the subject. Each of these is a subject the backend measures, driven
  // through the normalizer the browser runs. A missing word here does not
  // throw — it prints the raw field, "cards 4.5", in the market's title.
  assert.equal(nameFor({ marketKey: 'OVER_UNDER_4_5', subject: 'cards', line: '4.5' }), 'Total Cards 4.5 · FT');
  assert.equal(nameFor({ marketKey: 'OVER_UNDER_41_5', subject: 'points', line: '41.5' }), 'Points 41.5 · FT');
  assert.equal(nameFor({ marketKey: 'OVER_UNDER_21_5', subject: 'games', line: '21.5' }), 'Games 21.5 · FT');
  assert.equal(nameFor({ marketKey: 'OVER_UNDER_8_5', subject: 'corners', line: '8.5' }), 'Corners 8.5 · FT');
});

test('the keys that were wrong are pinned by name as well', () => {
  // The loop above would still pass if a subject and its word were both wrong
  // for that subject, so the two measured defects are asserted literally.
  assert.equal(labelFor('TCOU'), 'Total Cards 3.5 · FT');
  assert.equal(labelFor('TSMF'), 'Total Cards 3.5 · FT');
  assert.equal(labelFor('FTGO'), 'Total Games 3.5 · FT');
  assert.equal(labelFor('TOTAL_GAMES'), 'Total Games 3.5 · FT');
  assert.equal(labelFor('FTPO'), 'Total Points 3.5 · FT');
  assert.equal(labelFor('CNOU'), 'Corners Over/Under 3.5 · FT');
});
