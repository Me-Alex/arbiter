/**
 * sports/registry.mjs — the single source of truth for supported sports.
 *
 * The router (GET /api/sports) and the scrape orchestrator (sport filter)
 * both read from here, so a sport is only offered in the UI once it exists
 * in this table *and* at least one enabled job can actually collect it. Ids
 * are lowercase and hyphenated: they are what `config/scrapers.json` declares
 * in each job's `supportedSports` array.
 *
 * Scope note (honest about implementation state, see README "Multi-sport
 * architecture"): football is the only sport with live, verified scrapers.
 * Every bookmaker feed in config/scrapers.json currently returns prematch
 * football only, so that is what is registered.
 *
 * The other sports (tennis, basketball, ice hockey, volleyball, handball) are
 * deliberately NOT served. Registering them made the UI offer a filter that
 * cannot succeed: the scrape orchestrator only keeps jobs declaring a matching
 * `supportedSports`, and those jobs are disabled `sport-generic` stubs whose
 * scraper files do not exist. Picking any of them returned
 * "no enabled bookmaker jobs selected" (HTTP 400). To add a sport back:
 *   1. write the per-sport adapter in src/scrapers/,
 *   2. point the matching `sport-generic` job's `script` at it and set
 *      `enabled: true`,
 *   3. add the sport here, with the markets its feeds really emit.
 *
 * `hasDraw` drives how many outcomes a full-time result market may carry:
 * sports without a draw settle as 2-way (tennis, volleyball), sports with a
 * draw settle as 3-way (football, ice hockey, handball).
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
