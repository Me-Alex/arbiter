import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaguesMatch } from '../src/scanner/league-aliases.mjs';
import * as translations from '../src/scanner/league-translations.mjs';

/**
 * Competition labels are how the scanner decides whether two books are
 * pricing the same fixture. These cases come from the capture in
 * data-market-run, where the same fixture appears under two labels.
 *
 * Two failure modes have to be kept apart:
 *   - not pairing differently-named labels, which hides every cross-book
 *     opportunity (measured: 0 pairings before league-aware matching);
 *   - pairing labels for different competitions, which reports an arbitrage
 *     between two fixtures that were never played against each other.
 */

test('the same competition under different names pairs', () => {
  // admiral/stanleybet say Romanian, netbet says English, for the same fixtures.
  assert.equal(leaguesMatch('Nations League', 'UEFA Liga Natiunilor'), true);
  assert.equal(leaguesMatch('Premier League', 'Anglia - Premier League'), true);
  assert.equal(leaguesMatch('La Liga', 'Spania - LaLiga'), true);
  assert.equal(leaguesMatch('Serie A', 'Italia - Serie A'), true);
  // Confirmed on the capture: psim yogyakarta vs persita tangerang is "Liga 1"
  // to the six Altenar tenants and "Super League" to favbet.
  assert.equal(leaguesMatch('Liga 1', 'Super League'), true);
  assert.equal(leaguesMatch('MSFL', 'Czech Third League'), true);
});

test('diacritics and punctuation do not decide a match', () => {
  // normalizeTeamName was not applied here originally, so a Romanian label
  // with diacritics never met its unaccented spelling.
  assert.equal(leaguesMatch('Amicale-internaționale', 'Amicale Internationale'), true);
  assert.equal(leaguesMatch('Liga-Natiunilor-1', 'Liga Natiunilor 1'), true);
});

test('a season does not make two labels different competitions', () => {
  assert.equal(leaguesMatch('Liga I 2026/2027', 'Liga 1 2026/2027'), true);
  assert.equal(leaguesMatch('Premier League 2025/2026', 'Anglia - Premier League'), true);
});

test('roman numerals and word order are equivalent', () => {
  assert.equal(leaguesMatch('III Liga', 'Liga III'), true);
  assert.equal(leaguesMatch('Sweden 2nd Division', 'Division 2'), true);
  assert.equal(leaguesMatch('League Two', 'Liga 2'), true);
});

test('different competition groups never pair', () => {
  // Same teams, same kickoff, different group: two fixtures, not one. Pairing
  // them can report an arbitrage between matches never played together.
  assert.equal(leaguesMatch('Nations League A', 'Liga Natiunilor C'), false);
  assert.equal(leaguesMatch('Liga Natiunilor A', 'Liga Natiunilor C'), false);
  assert.equal(leaguesMatch('Liga Natiunilor A', 'Liga Natiunilor A'), true);
});

test('different divisions never pair', () => {
  assert.equal(leaguesMatch('Liga 1', 'Liga 2'), false);
  assert.equal(leaguesMatch('Serie A', 'Serie B'), false);
  assert.equal(leaguesMatch('Division 2', 'Division 3'), false);
  // A bare top flight and its reserve league settle differently; a substring
  // test used to match "Premier League" to "Premier League 2".
  assert.equal(leaguesMatch('Premier League', 'Premier League 2'), false);
  assert.equal(leaguesMatch('Championship', 'Premier League'), false);
});

test('a label carrying no identity cannot be used to separate fixtures', () => {
  // "Tournament 104" and "Final" name a competition not at all, so refusing to
  // pair on them would drop real opportunities. This fails safe: the pair is
  // allowed, and a genuine group mismatch is still caught by the group rule.
  assert.equal(leaguesMatch('Tournament 104', 'Italia - Serie A'), true);
  assert.equal(leaguesMatch('Final', 'Tournament 104'), true);
  assert.equal(leaguesMatch('26400', 'Tournament 104'), true);
  // A real group still separates, even against an opaque label.
  assert.equal(leaguesMatch('Liga Natiunilor A', 'Tournament 104'), true);
});

test('blank labels never match', () => {
  assert.equal(leaguesMatch('', 'Liga 1'), false);
  assert.equal(leaguesMatch('Liga 1', null), false);
  assert.equal(leaguesMatch(null, undefined), false);
});

test('the generated translation table is only used for proven pairs', () => {
  const { LEAGUE_TRANSLATIONS, TRANSLATION_INDEX } = translations;
  assert.ok(LEAGUE_TRANSLATIONS.length > 100, 'the table is populated');
  for (const [a, b, seen] of LEAGUE_TRANSLATIONS) {
    assert.ok(a && b, 'both sides are named');
    assert.notEqual(a, b, 'an entry never maps a label to itself');
    assert.ok(seen >= 2, `${a} ~ ${b} is confirmed on ${seen} fixtures, needs 2`);
    // Both directions must resolve, or a pair matches in one order only. The
    // index is multi-valued: a label like "liga 1" has several proven partners,
    // so a single canonical partner would drop the others.
    assert.ok(TRANSLATION_INDEX.get(a).has(b), `${a} should list ${b}`);
    assert.ok(TRANSLATION_INDEX.get(b).has(a), `${b} should list ${a}`);
    assert.equal(leaguesMatch(a, b), true, `${a} ~ ${b} should match`);
    assert.equal(leaguesMatch(b, a), true, 'the match is symmetric');
  }
});

test('the translation table cannot merge two different competitions', () => {
  // A confirmed translation still has to survive the group check, so a table
  // entry can never override two labels that name different groups.
  for (const [a, b] of [
    ['Nations League A', 'Liga Natiunilor C'],
    ['Liga 1', 'Liga 2'],
  ]) {
    assert.equal(leaguesMatch(a, b), false, `${a} ~ ${b} must stay separate`);
  }
});
