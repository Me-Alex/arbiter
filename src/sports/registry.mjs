/**
 * sports/registry.mjs — the single source of truth for supported sports.
 *
 * The router (GET /api/sports) and the scrape orchestrator (sport filter)
 * both read from here, so a sport is only offered in the UI once it exists
 * in this table *and* at least one enabled job can actually collect it. Ids
 * are lowercase and hyphenated: they are what `config/scrapers.json` declares
 * in each job's `supportedSports` array.
 *
 * The registry was football-only until 2026-10-08. It now carries every sport
 * an enabled job actually collects, because the adapters were already ahead
 * of it: superbet's offer-v3 is multi-sport, betano crawls 36 sport ids,
 * Altenar walks a per-tenant GetSportMenu (id map in
 * `src/scrapers/altenar-public.mjs`), Unibet crawls the az-menu, Winner reads
 * a sportFilter over a 30-sport payload, and the FEG feed publishes its own
 * per-sport market namespace. Measured over `data/workspace`: 146,393 football
 * markets alongside 4,558 across tennis (476), ice-hockey (798), basketball
 * (644), handball (552), American football (463), table-tennis (462), esports
 * (445), volleyball (252), futsal (186), rugby (158) and darts (122) — all
 * collected before any of it was offered.
 *
 * The one invariant this table now has to hold, in both directions, because
 * it was the failure mode of the football-only era:
 *   - every registered id is declared by at least one enabled, validated job
 *     (a registered sport no job can collect is a dropdown option that always
 *     fails — exactly why the other sports used to stay out);
 *   - every sport declared by such a job is registered here (a declaration
 *     outside the registry makes the orchestrator reject every scan for it:
 *     `getSport` returns null for an unknown id).
 * `test/sport-registry-consistency.test.mjs` checks both directions against
 * the live config, so a new sport lands in both files or neither.
 *
 * `hasDraw` drives how many outcomes a full-time result market may carry:
 * sports without a draw settle as 2-way (tennis, volleyball), sports with a
 * draw settle as 3-way (football, ice hockey, handball). The contract table
 * in `src/scanner/market-contracts.mjs` is what the engine actually consults;
 * this field records the intent.
 *
 * `markets` lists the families that sport's feeds really emit and the contract
 * table resolves for it — MATCH_ODDS is 3-way where `hasDraw` is true and
 * 2-way where it is false.
 */

/** @typedef {{ id: string, name: string, hasDraw: boolean, markets: string[] }} SportDefinition */

/** @type {SportDefinition[]} */
const SPORTS = [
  {
    id: 'football',
    name: 'Football',
    hasDraw: true,
    markets: ['MATCH_ODDS', 'OVER_UNDER', 'DOUBLE_CHANCE', 'BTTS', 'HANDICAP'],
  },
  {
    id: 'tennis',
    name: 'Tennis',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER', 'HANDICAP'],
  },
  {
    id: 'basketball',
    name: 'Basketball',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER', 'HANDICAP'],
  },
  {
    id: 'ice-hockey',
    name: 'Ice Hockey',
    hasDraw: true,
    markets: ['MATCH_ODDS', 'OVER_UNDER', 'HANDICAP'],
  },
  {
    id: 'volleyball',
    name: 'Volleyball',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'handball',
    name: 'Handball',
    hasDraw: true,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'american-football',
    name: 'American Football',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER', 'HANDICAP'],
  },
  {
    id: 'rugby',
    name: 'Rugby',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'futsal',
    name: 'Futsal',
    hasDraw: true,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'baseball',
    name: 'Baseball',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'table-tennis',
    name: 'Table Tennis',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'cricket',
    name: 'Cricket',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'boxing',
    name: 'Boxing',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'mma',
    name: 'MMA',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'esports',
    name: 'eSports',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'counter-strike-2',
    name: 'Counter-Strike 2',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'water-polo',
    name: 'Water Polo',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'australian-football',
    name: 'Australian Football',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'badminton',
    name: 'Badminton',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'cycling',
    name: 'Cycling',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'darts',
    name: 'Darts',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'dota-2',
    name: 'Dota 2',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'f1',
    name: 'Formula 1',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'floorball',
    name: 'Floorball',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'golf',
    name: 'Golf',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'league-of-legends',
    name: 'League of Legends',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'motorsport',
    name: 'Motorsport',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'overwatch',
    name: 'Overwatch',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'rainbow-six',
    name: 'Rainbow Six',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'snooker',
    name: 'Snooker',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'padel',
    name: 'Padel',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
  {
    id: 'billiards',
    name: 'Billiards',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'motogp',
    name: 'MotoGP',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'alpine-skiing',
    name: 'Alpine Skiing',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'figure-skating',
    name: 'Figure Skating',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'kitesurfing',
    name: 'Kitesurfing',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'swimming',
    name: 'Swimming',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'wrestling',
    name: 'Wrestling',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'canoeing',
    name: 'Canoeing',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'biathlon',
    name: 'Biathlon',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'ski-cross-country',
    name: 'Ski Cross-Country',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'surfing',
    name: 'Surfing',
    hasDraw: false,
    markets: ['MATCH_ODDS'],
  },
  {
    id: 'rugby-league',
    name: 'Rugby League',
    hasDraw: false,
    markets: ['MATCH_ODDS', 'OVER_UNDER'],
  },
];

/** @type {Map<string, SportDefinition>} */
const BY_ID = new Map(SPORTS.map((sport) => [sport.id, sport]));

/**
 * Look up a sport by id. Accepts the exact id, and tolerates surrounding
 * whitespace and case so a value typed in the UI or passed through a query
 * string still resolves. Returns null for anything unknown — callers treat
 * that as "no such sport" and reject the request rather than falling back to
 * a default, so a typo can never silently scan the wrong sport.
 *
 * @param {string} id
 * @returns {SportDefinition|null}
 */
export function getSport(id) {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return BY_ID.get(key) || null;
}

/**
 * Every supported sport, shaped for the UI dropdown: `[{ id, name }]`.
 * A new object per call so callers cannot mutate the registry.
 *
 * @returns {{ id: string, name: string }[]}
 */
export function sportOptions() {
  return SPORTS.map(({ id, name }) => ({ id, name }));
}


/**
 * The one canonical label for a sport, whichever form it arrived in.
 *
 * Feed adapters are inconsistent about casing: the modern publishers stamp
 * the display name ("Football") while the older EveryMatrix/NSoft adapters
 * stamp the registry id ("football"). Both reached the same workspace, so a
 * single scan published a sport field holding two spellings of one sport.
 *
 * That is not cosmetic. The console builds its sport filter by de-duplicating
 * the raw strings, and "Football" !== "football", so the dropdown listed
 * Football twice and filtering by one spelling silently hid every row carrying
 * the other - 156 middles simply vanished from view. Matching the canonical
 * label rather than the raw string is the fix, and it has to happen before a
 * signal is built so every consumer sees one value.
 *
 * An unrecognised value is passed through unchanged rather than dropped: a
 * sport the registry does not know about yet should still be visible and
 * filterable, not swallowed.
 *
 * @param {unknown} value
 * @returns {string|null} the canonical display name, or null when blank
 */
export function canonicalSportName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const byId = BY_ID.get(trimmed.toLowerCase());
  if (byId) return byId.name;
  const byName = SPORTS.find((sport) => sport.name.toLowerCase() === trimmed.toLowerCase());
  return byName ? byName.name : trimmed;
}
