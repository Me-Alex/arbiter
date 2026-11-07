/**
 * labels.ts — the market vocabulary the engine publishes in English, translated
 * at the moment it is drawn.
 *
 * `api.ts` derives `marketName` from the scanner's market key while it
 * normalizes a payload: `OVER_UNDER_2_5` becomes "Total Goals 2.5", an
 * unrecognised key falls back to its family, and the period is appended as
 * " · FT". That
 * derivation is pinned by `test/frontend-normalize.test.mjs`, and it is also
 * what the subject rule reads: `subjectCorrectedBase` asks whether the label
 * already names its subject, comparing English words. Translating inside it
 * would put a display string into the pipeline whose only job is to decide what
 * a market *is*, and that decision would then depend on the interface language.
 *
 * So the row keeps an English label and it is translated here, at render. The
 * module is deliberately pure — no dictionary import, the translator is passed
 * in — which is what lets a Node test drive it with a fake translator and see
 * exactly which suffixes and which words it rewrote.
 *
 * A label this file does not recognise is returned unchanged. A book's
 * vocabulary is not knowable in advance, and an English word a trader can still
 * read beats a confident mistranslation of a market they are about to bet on.
 */
export type Translator = (key: string) => string;

/**
 * Base names, with the market vocabulary first and bare subjects after it.
 *
 * Two of these are deliberate collisions. `Match Result` and `Match Odds` are
 * the same 1X2 market under two book spellings, so both resolve to one label
 * rather than inventing a distinction the prices do not carry. `Corners`
 * (a subject) and `Total Corners` (a market) read differently in English but
 * describe one market once a line is attached.
 *
 * `Full Time Goals` used to sit here for the FTGO key alone, and it went with
 * the correction rather than staying behind unused: the backend measures that
 * key as `games` — "Game-uri" on Tennis — so the entry named a market that
 * does not exist. The two entries that replaced it, `Total Cards` and
 * `Total Points`, are the vocabulary the same table measures.
 *
 * `Rounds` and `Legs` are here for the same reason. The engine derives both
 * from text the books publish - "Total runde 21.5", "Total Leg-uri" - but no
 * key or family names them, so a row carrying either subject reached this
 * table as an unrecognised word and was drawn exactly as the backend spelled
 * it. Naming the subject is what turns that back into a market label.
 */
const BASE_LABELS: [string, string][] = [
  ['Draw or Away vs Home Win', 'marketSyntheticX2VsHome'],
  ['Home or Draw vs Away Win', 'marketSynthetic1xVsAway'],
  ['Match Result + AH (±0.5)', 'appMarketSynthetic1x2Ah05'],
  ['Home or Away vs Draw', 'appMarketSynthetic12VsDraw'],
  ['Derived equivalence contract', 'appMarketDerived'],
  ['Both Teams to Score', 'marketBothTeamsScore'],
  ['Corners Over/Under', 'appMarketCornersOverUnder'],
  ['Draw No Bet (level)', 'appMarketDrawNoBet'],
  ['Equivalent Market', 'marketSyntheticEquivalence'],
  ['Asian Handicap', 'marketAsianHandicap'],
  ['Double Chance', 'marketDoubleChance'],
  ['Total Points', 'marketTotalPoints'],
  ['Total Cards', 'marketTotalCards'],
  ['Total Goals', 'marketTotalGoals'],
  ['Total Games', 'marketTotalGames'],
  ['Match Result', 'marketMatchResult'],
  ['Match Odds', 'marketMatchResult'],
  ['Set Winner', 'marketSetWinner'],
  ['Corners', 'marketTotalCorners'],
  ['Points', 'appSubjectPoints'],
  ['Games', 'appSubjectGames'],
  ['Goals', 'appSubjectGoals'],
  ['Rounds', 'appSubjectRounds'],
  ['Legs', 'appSubjectLegs'],
  ['Market', 'market'],
];

/**
 * The side a total belongs to, as the prefix `api.ts` puts in front of a label.
 *
 * The engine publishes `team` only when it names a real side, so "Home Total Goals
 * 2.5" and the plain "Total Goals 2.5" are two different bets. Both this table and
 * the market vocabulary already open with the same two words - `Home or Draw vs Away
 * Win`, `Home or Away vs Draw` - so an exact or phrase match is tried first and the
 * prefix is only peeled off when what follows it is itself a label this table knows.
 */
const SIDES: Record<string, string> = { Home: 'appSideHome', Away: 'appSideAway' };

/** The period suffixes `formatMarketName` appends. Anything else is left alone. */
const PERIODS: Record<string, string> = {
  FT: 'appPeriodFullTime',
  '1H': 'appPeriodFirstHalf',
  HALF1: 'appPeriodFirstHalf',
  '2H': 'appPeriodSecondHalf',
  HALF2: 'appPeriodSecondHalf',
  FULLTIME_OT: 'appPeriodFullTimeOt',
  SET1: 'appPeriodSet1',
  SET2: 'appPeriodSet2',
  SET3: 'appPeriodSet3',
  SET4: 'appPeriodSet4',
  SET5: 'appPeriodSet5',
};

/**
 * Every dictionary key this table can ask for.
 *
 * Exported for `test/i18n-dictionary.test.mjs`, which is the only place the
 * English half and the dictionary half meet: the labels test can prove this
 * module asks for a key, and only the dictionary can prove the key exists.
 * Derived rather than listed, so it cannot drift from the table above.
 */
export const LABEL_KEYS: readonly string[] = [
  ...new Set([
    ...BASE_LABELS.map(([, key]) => key),
    // The side prefixes and period suffixes, for the same reason: this module asks
    // for them, and only the dictionary can prove both languages define them.
    ...Object.values(SIDES),
    ...Object.values(PERIODS),
  ]),
];

/** Longest phrase first, so `Total Goals` is tried before `Goals`. */
const BY_LENGTH = [...BASE_LABELS].sort((a, b) => b[0].length - a[0].length);

function baseLabel(head: string, tr: Translator): string {
  const exact = BY_LENGTH.find(([phrase]) => phrase === head);
  if (exact) return tr(exact[1]);
  // A line the key carried (`Total Goals 2.5`, `Games 5.5`): the phrase is the
  // market and everything after it is the number, which needs no translation.
  for (const [phrase, key] of BY_LENGTH) {
    if (head.startsWith(`${phrase} `)) return `${tr(key)} ${head.slice(phrase.length + 1)}`;
  }
  // A team-scoped total. The remainder has to resolve on its own: an unrecognised
  // market behind a known side is left whole, so the row is not half translated.
  const side = Object.keys(SIDES).find((word) => head.startsWith(`${word} `));
  if (side) {
    const rest = head.slice(side.length + 1);
    const inner = baseLabel(rest, tr);
    if (inner !== rest) return `${tr(SIDES[side])} ${inner}`;
  }
  return head;
}

/**
 * Translate one label, keeping whatever suffix it was built with.
 *
 * @param label the English label `api.ts` produced
 * @param tr the dictionary lookup, normally `t`
 */
export function localizeMarketLabel(label: string, tr: Translator): string {
  if (!label) return label;
  const [head, ...periods] = label.split(' · ');
  const translated = baseLabel(head, tr);
  if (!periods.length) return translated;
  const suffix = periods.map((period) => (period in PERIODS ? tr(PERIODS[period]) : period));
  return `${translated} · ${suffix.join(' · ')}`;
}
