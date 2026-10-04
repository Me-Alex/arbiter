/**
 * Read a decimal price from whatever shape the provider sent it in.
 *
 * Most feeds send a bare number, but Kambi wraps it: `{ decimal: 1.95 }`. The
 * legacy adapters read those with `Number(value)`, which is NaN for an object,
 * so every selection was filtered out and the event silently disappeared.
 * Returning `null` rather than NaN keeps the caller's `> 1` check meaningful.
 *
 * @param {unknown} odds
 * @returns {number|null}
 */
export function decimalOdds(odds) {
  if (odds && typeof odds === 'object') {
    // Kambi: { decimal: 1.95 }. Anything else in this shape is not a price.
    if (odds.decimal !== undefined) return decimalOdds(odds.decimal);
    if (odds.price !== undefined) return decimalOdds(odds.price);
    if (odds.value !== undefined) return decimalOdds(odds.value);
    return null;
  }
  const n = Number(odds);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** Implicit probability of an outcome priced at decimal odds o. */
export function impliedProbability(odds) {
  const n = decimalOdds(odds);
  return n ? 1 / n : null;
}

/** Strip diacritics + lowercase + collapse whitespace for event matching. */
export function normalizeTeamName(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(input) {
  return normalizeTeamName(input).split(' ').filter(Boolean);
}

/**
 * Club identity for cross-source event matching.
 *
 * Providers disagree on legal suffixes, gender prefixes and sponsorship
 * naming ("FC Dinamo Bucuresti", "Dinamo B.", "ACS FC Dinamo"), so a plain
 * diacritic-stripped comparison is too brittle. This drops the noise tokens
 * that never distinguish one club from another and collapses the rest into a
 * space-separated string, so equivalent spellings normalize to the same key.
 *
 * @param {string} input
 * @returns {string}
 */
const CLUB_NOISE_TOKENS = new Set([
  'fc', 'sc', 'cf', 'ac', 'acs', 'afc', 'as', 'ss', 'ssc', 'us', 'ud', 'cd', 'ce', 'rc', 'rcd',
  'sv', 'vfl', 'vfb', 'tsv', 'bsc', 'fsv', 'sg', 'spvgg', 'fs', 'acfc', 'fk', 'bk',
  'sport', 'sports', 'club', 'fotbal', 'football', 'calcio', 'the',
]);

export function normalizeClubIdentity(input) {
  const words = normalizeTeamName(input).split(' ').filter(Boolean);
  const kept = words.filter((w) => !CLUB_NOISE_TOKENS.has(w));
  // Fall back to the full token list rather than returning '' for a name that
  // is entirely made of noise tokens (e.g. "FC" alone).
  return (kept.length > 0 ? kept : words).join(' ');
}

/**
 * Canonical sport label.
 *
 * Providers mix English, Romanian and platform-specific names for the same
 * sport: maxbet sends "Basketball" where winner sends "Baschet", and admiral
 * sends "Baseball" where others send "Baseball". Since the sport is part of the
 * identity key, an untranslated label means the same fixture is treated as two
 * different events.
 */
const SPORT_CANON = new Map(Object.entries({
  // football
  football: 'football', fotbal: 'football', soccer: 'football',
  'american football': 'american-football', 'fotbal american': 'american-football',
  // basketball
  basketball: 'basketball', baschet: 'basketball',
  // racket sports
  tennis: 'tennis', tenis: 'tennis', 'tenis de masa': 'table-tennis', 'table tennis': 'table-tennis',
  // winter
  'ice hockey': 'ice-hockey', hochei: 'ice-hockey', hockey: 'ice-hockey',
  // other
  baseball: 'baseball', handball: 'handball', handbal: 'handball',
  volleyball: 'volleyball', volei: 'volleyball', volley: 'volleyball',
  cricket: 'cricket', rugby: 'rugby', 'rugby union': 'rugby', futsal: 'futsal',
  badminton: 'badminton', floorball: 'floorball', polo: 'polo', boxing: 'boxing', box: 'boxing',
  'mma': 'mma', 'arte martiale': 'mma', 'martial arts': 'mma',
  // normalizeTeamName turns '-' into a space, so these are the spellings the
  // lookup actually sees.
  'e football': 'esports', 'e sports': 'esports', esports: 'esports', efootball: 'esports',
}));

export function canonicalSport(input) {
  const key = normalizeTeamName(input);
  if (!key) return '';
  return SPORT_CANON.get(key) || key.replace(/ /g, '-');
}

/**
 * Build a canonical identity key for an event across books.
 * Used for cross-book event matching.
 *
 * The league is deliberately NOT part of the key. Books name the same
 * competition differently — netbet says "Nations League" where admiral says
 * "UEFA Liga Natiunilor" — so including it meant identical fixtures never
 * matched and cross-book arbitrage could not be detected at all. Measured on a
 * live capture, 0 independent source pairs matched with the league included
 * and ~54 do without it.
 *
 * The trade-off: two fixtures with the same teams, same kickoff and same sport
 * but different competition group (e.g. England's Nations League group A and
 * group C) collapse into one group. A false arbitrage from that would still
 * require both books to quote a complete 1X2, which is a much stronger
 * constraint than the naming mismatch it replaces.
 */
export function eventIdentityKey(e) {
  if (!e) return '';
  // `new Date(...).toISOString()` throws a RangeError on a malformed timestamp,
  // and this runs once per event inside groupByEvent — so one corrupt snapshot
  // failed the whole scan. An unusable kickoff becomes an explicit `unknown`
  // bucket, which keeps the event visible instead of crashing the pipeline.
  const ms = Date.parse(e.kickoff || e.startDate || '');
  const day = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'unknown';
  const parts = [
    canonicalSport(e.sport || ''),
    day,
    normalizeClubIdentity(e.homeTeam || e.home || ''),
    normalizeClubIdentity(e.awayTeam || e.away || ''),
  ];
  return parts.join('|');
}

/**
 * Do two club names name the same club when a single letter is allowed to stand
 * for the first letter of the other side's word?
 *
 * This is the loose rule, and it exists because some books publish an initial
 * where the others publish the name: "Sporting L." for "Sporting Lisboa",
 * "Bayern M." for "Bayern Munchen". The exact key never pairs those, so the
 * fixture exists on one book and not on the other and no cross-book
 * opportunity can be priced at all.
 *
 * Three conditions, each of which is load-bearing:
 *
 *  - the same number of tokens, so "Augsburg" cannot absorb "A. Augsburg";
 *  - compared by position, so a merged first name is not accepted either;
 *  - a difference is tolerated only when one of the two tokens is a single
 *    letter that prefixes the other. "Munich" against "Munchen" is a spelling
 *    difference rather than an initial and stays out of scope: across the
 *    whole workspace, every single-letter token that ever matched was a
 *    truncation of the same word.
 *
 * The result is a strict superset of exact equality — equal names give equal
 * token lists — so this can never reject a pair the exact rule accepted. That
 * is what makes it safe as a second pass over groups already built.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function teamsMatch(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    const short = x.length === 1 ? x : y;
    const long = x.length === 1 ? y : x;
    if (short.length !== 1 || !long.startsWith(short)) return false;
  }
  return true;
}
