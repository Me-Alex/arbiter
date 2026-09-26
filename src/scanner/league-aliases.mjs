/**
 * league-aliases.mjs — decide whether two competition labels name the same
 * competition.
 *
 * Books label the same competition differently and in different languages:
 * "Nations League" / "UEFA Liga Natiunilor", "Premier League" / "Anglia -
 * Premier League", "MSFL" / "Czech Third League". Treating the label as part
 * of an event's identity meant those fixtures never matched, so cross-book
 * arbitrage was undetectable. Treating the label as irrelevant is worse: two
 * distinct fixtures — England in Nations League group A and group C — collapse
 * into one, and if their prices happen to line up the scanner reports an
 * arbitrage between two different matches.
 *
 * So the label is compared, not ignored, with three rules applied in order.
 *
 * The alias table is built from the capture in data-market-run, not from
 * guesswork: each entry is a pair observed on the *same* fixture (same teams,
 * same kickoff) across two books. One confirmed example, psim yogyakarta vs
 * persita tangerang on 2026-09-11, is labelled "Liga 1" by the six Altenar
 * tenants (all sharing provider id 17473188) and "Super League" by favbet.
 */

import { normalizeTeamName } from '../shared/text.mjs';
import { TRANSLATION_INDEX } from './league-translations.mjs';

/** Strips decorations that never distinguish one competition from another. */
const NOISE = /^(?:uefa|uefa -|sua -|franta -|spania -|anglia -|olanda -|italia -|cehia -|malaezia -|romania -|serbia -|polonia -|portugalia -|germania -)\s*/i;

/** Tokens that identify a competition group and must not be dropped. */
const GROUP_TOKENS = new Set(['gr', 'grupa', 'group', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);

/**
 * A season qualifier: "2026/2027", "2025-26", "2026". Never part of identity.
 *
 * The separator range is explicit: a bare `\d{2,4}` would match only the first
 * two digits of "2026/2027", leaving "2027" behind as a stray token and making
 * "Liga I 2026/2027" fail to match "Liga 1 2026/2027".
 */
const SEASON = /\b(?:19|20)\d{2}(?:\s*[-/]\s*(?:(?:19|20)?\d{2}|\d{2,4}(?=\s|$)))?\b/g;

/** Rodnei and friends: the leading digit is a division, not a group letter. */
const LEAGUE_ALIASES = [
  // English <-> Romanian, both observed on the same fixtures.
  ['premier league', 'liga 1'],
  ['liga 1', 'super league'],
  ['super league', 'super liga'],
  ['la liga', 'laliga'],
  ['la liga', 'spania laliga'],
  ['serie a', 'italia - serie a'],
  ['ligue 1', 'franta - ligue 1'],
  ['eredivisie', 'olanda - eredivisie'],
  ['bundesliga', 'germania - bundesliga'],
  ['national league south', 'conferinta de sud'],
  // The largest single source of lost pairings on the capture: admiral/stanleybet
  // label the competition in Romanian, netbet in English, for the same fixtures.
  // Entries are compared after the NOISE prefix and punctuation are stripped,
  // so "UEFA Liga Natiunilor" is compared as "liga natiunilor".
  ['nations league', 'liga natiunilor'],
  // Exalogic short codes <-> their full names.
  ['msfl', 'czech third league'],
  ['pfl', 'russian second league'],
  ['nb iii', 'czech third league'],
  ['iv liga', 'liga iv'],
  ['divizia 1', 'moldova - divizia 1'],
  // Country qualifiers.
  ['major league soccer', 'mls'],
  ['mls', 'sua - mls'],
  ['ekstraklasa', 'polonia - ekstraklasa'],
  ['czech republic fourth division', 'cehia - divizia 4'],
  ['russia top division women', 'premier league, feminin'],
  ['australia football federation northern territory', 'norzone premier league'],
  ['prva hnl academy, juniori', 'croatia - prva hnl'],
  // Country-prefixed versus bare second tiers, both observed on the same
  // fixtures in the capture.
  ['sweden 2nd division', 'division 2'],
  ['league two', 'liga 2'],
  ['league one', 'liga 1'],
  ['u19 championship', 'campionatul u19'],
  ['amicale internationales', 'friendly internationals'],
  ['amicale internationales', 'amicale internationale'],
  ['primera division rfef', 'primera federacion'],
  ['liga 2', 'ligue 2'],
];

/** Generic labels that carry no identifying information at all. */
const OPAQUE = /^(?:tournament\s*\d+|final|unknown|none|null)$/i;

/** A label that is only an opaque provider id, e.g. "26400" or "T 104". */
const OPAQUE_ID = /^(?:t?\s*\d+)$/i;

/**
 * Romanian division numerals, which providers write either as words or
 * digits: "III Liga" and "Liga III" are the same competition, and so are
 * "Liga I" and "Liga 1".
 */
const ROMAN_DIVISIONS = [
  ['i', '1'], ['ii', '2'], ['iii', '3'], ['iv', '4'], ['v', '5'],
  ['vi', '6'], ['vii', '7'], ['viii', '8'], ['ix', '9'], ['x', '10'],
];

/** English ordinals, which appear inline: "Sweden 2nd Division" → "2". */
const ORDINALS = new Map([
  ['1st', '1'], ['2nd', '2'], ['3rd', '3'], ['4th', '4'], ['5th', '5'],
  ['6th', '6'], ['7th', '7'], ['8th', '8'], ['9th', '9'], ['10th', '10'],
]);

function clean(label) {
  // The country qualifier is stripped from the raw form first: normalizeTeamName
  // turns hyphens into spaces, so a slug like "italia-serie-a-1" arrives as
  // "italia serie a 1" and the NOISE pattern can no longer see the prefix.
  const stripped = String(label || '').replace(NOISE, '');
  let s = normalizeTeamName(stripped);
  s = s.replace(/[.\-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Season qualifiers describe when a competition runs, not which competition
  // it is: "Liga I 2026/2027" and "Liga 1 2026/2027" are the same pairing.
  s = s.replace(SEASON, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * The competition group a label names.
 *
 * A trailing digit after a hyphenated slug is a group, not a division:
 * "liga-natiunilor-1" is group 1 of the Nations League, while "liga 2" is the
 * second division. Both forms are accepted so the comparison is symmetric.
 */
function groupOf(cleaned, raw) {
  const fromRaw = String(raw || '').trim().match(/-\s*([a-g]|\d{1,2})\s*$/i);
  if (fromRaw) return fromRaw[1].toLowerCase();
  const tokens = cleaned.split(' ').filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (GROUP_TOKENS.has(tokens[i])) return tokens[i];
    // "Liga Natiunilor 2" is the spaced spelling of the slug "liga-natiunilor-2",
    // so a trailing number on a multi-word name is a group too. A bare
    // "liga 2" is a division, and trailingNumberIsDivision rejects that.
    if (i === tokens.length - 1 && /^\d{1,2}$/.test(tokens[i]) && !trailingNumberIsDivision(cleaned)) {
      return tokens[i];
    }
  }
  return null;
}

/** True when neither label names a group, or both name the same one. */
function groupsCompatible(ca, cb, rawA, rawB) {
  const ga = groupOf(ca, rawA);
  const gb = groupOf(cb, rawB);
  if (ga === null || gb === null) return true; // an ungrouped competition cannot clash
  return ga === gb;
}

/**
 * A competition whose name *contains* a digit is a grouped competition, so its
 * trailing number is a group. Everything else treats a trailing number as a
 * division: "Premier League 2" is a reserve league, not a group of the Premier
 * League, and pairing them would compare two markets that settle differently.
 */
const GROUPED_COMPETITIONS = [
  'liga natiunilor', 'nations league', 'nations league a', 'nations league b',
  'european championship', 'campionat european', 'world cup', 'olimpiada',
];

function isGroupedCompetition(cleaned) {
  return GROUPED_COMPETITIONS.some((name) => cleaned.startsWith(name));
}

/**
 * True when a trailing number names a division rather than a group.
 * "Liga 1" is the first tier; "Liga Natiunilor 1" is group 1 of a competition
 * whose name happens to be several words long.
 */
function trailingNumberIsDivision(cleaned) {
  if (isGroupedCompetition(cleaned)) return false;
  return / \d{1,2}$/.test(cleaned);
}

function stripGroup(cleaned) {
  const tokens = cleaned.split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !GROUP_TOKENS.has(t));
  if (kept.length > 1 && /^\d{1,2}$/.test(kept[kept.length - 1]) && !trailingNumberIsDivision(kept.join(' '))) {
    kept.pop();
  }
  return kept.join(' ') || cleaned;
}

/**
 * True when two competition labels name the same competition.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function leaguesMatch(a, b) {
  const ca = clean(a);
  const cb = clean(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  // Neither label carries identity, so it cannot be used to separate two
  // fixtures; fall through to the other rules rather than refusing.
  if (OPAQUE.test(ca) || OPAQUE.test(cb) || OPAQUE_ID.test(ca) || OPAQUE_ID.test(cb)) return true;
  // Groups are compared first and must agree: "Nations League A" and
  // "Liga Natiunilor C" are two different fixtures even though the competitions
  // they belong to are the same.
  if (!groupsCompatible(ca, cb, a, b)) return false;
  // Containment must respect word boundaries. A bare substring test matched
  // "Premier League" to "Premier League 2" — a national top flight against its
  // reserve league, which settle differently and must never be paired.
  if (containsWordSequence(ca, cb) || containsWordSequence(cb, ca)) {
    // The same competition with a different trailing division is still two
    // different competitions.
    return !divisionsDiffer(ca, cb);
  }
  // Compare the competition without its group label, so an alias still applies
  // to a grouped fixture ("Liga 1" ~ "Super League" is also "Liga 1 A" ~
  // "Super League B" once the groups have been shown to agree).
  const base = stripGroup(ca);
  const other = stripGroup(cb);
  if (base === other) return true;
  // Token-set comparison, which absorbs word order ("III Liga" / "Liga III"),
  // Romanian numerals ("Serie A" / "Seria A" is a typo variant, but "Liga I" /
  // "Liga 1" is not) and residual spelling variants, without the risk of a
  // substring match spanning word boundaries.
  if (sameTokenSet(base, other)) return true;
  // The generated translation table, which covers the long tail of leagues whose
  // names differ by more than a word ("PFL" / "Russian Second League"). Entries
  // were confirmed on shared provider event ids, so a trailing tier code on one
  // side ("italia-serie-a-1" vs "italia-serie-a") is not a different division
  // here — the table is consulted before the division guard, which is only about
  // labels that name the competition themselves.
  if (isKnownTranslation(base, other)) return true;
  if (LEAGUE_ALIASES.some(([x, y]) => (
    (base === x && other === y) || (base === y && other === x)
  ))) return true;
  // Containment already failed above, so the only remaining case is a
  // confirmed translation that carries a tier code on one side.
  return isKnownTranslation(ca, cb) || isKnownTranslation(base, other);
}

/** True when the generated table records these two labels as one competition. */
function isKnownTranslation(a, b) {
  const partnersA = TRANSLATION_INDEX.get(a);
  if (partnersA && partnersA.has(b)) return true;
  const partnersB = TRANSLATION_INDEX.get(b);
  return Boolean(partnersB && partnersB.has(a));
}

/**
 * True when the two labels are the same competition with different trailing
 * divisions — "Premier League" against "Premier League 2". Those settle
 * differently, so they must never be paired.
 */
function divisionsDiffer(a, b) {
  // An absent trailing number is the first division, so "Premier League" and
  // "Premier League 2" differ just as "Liga 1" and "Liga 2" do.
  const numA = a.match(/(\d{1,2})$/);
  const numB = b.match(/(\d{1,2})$/);
  return (numA ? numA[1] : '1') !== (numB ? numB[1] : '1');
}

/**
 * True when `needle`'s words appear consecutively inside `haystack`.
 * Equivalent to a substring test but anchored on word boundaries.
 */
function containsWordSequence(haystack, needle) {
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * True when two labels are the same words in any order, with Roman numerals
 * folded onto their digits first.
 */
function sameTokenSet(a, b) {
  // Fold on every token, not just a single-word label: "Liga I" has to become
  // "liga 1" so it can meet "Liga 1", and "III Liga" has to become "3 liga".
  const numeral = new Map(ROMAN_DIVISIONS);
  const fold = (s) => s.split(' ').filter(Boolean).map((t) => numeral.get(t) || ORDINALS.get(t) || t);
  const sa = fold(a).sort();
  const sb = fold(b).sort();
  if (sa.length !== sb.length) return false;
  return sa.every((t, i) => t === sb[i]);
}
