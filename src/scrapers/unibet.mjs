import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { describeError, summariseReasons } from './feg-common.mjs';
import { unibetEventIsLive, markMarketsLive, eventIsLive, liveCoverageFor } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

/**
 * Unibet (RO) — Kindred XNS sports BFF.
 *
 * The old Kambi offer endpoint (`/api/kambi/offer/v1/betoffer/list.json`) is
 * gone, but the feed is NOT behind MQTT as the retired adapter's docblock
 * claimed. The live public REST surface is:
 *
 *   https://sportsbff-ams.kindredext.net/sports-api/api/v2/...
 *
 * Two things about that surface are not discoverable from a 404 and are the
 * reason this adapter exists at all:
 *
 *  1. The load balancer answers 400 `InvalidRequestException` (or 503) unless
 *     the request carries the tenant headers the site's own `getBFFClient`
 *     sends. Those are plain lowercase names — `locale`, `jurisdiction`,
 *     `ksp_jurisdiction`, `brand` — NOT the `X-Brand` / `X-Locale` pair the
 *     separate *betting* client uses. Sending the `X-` names produces a 400
 *     that looks exactly like a malformed query, and the response headers
 *     (`x-browser-class`) give no hint why.
 *  2. There is no bulk fixture list. `v2/contests/list` — the endpoint whose
 *     `GetFixtureContestsRequest` model carries `from`/`size` — answers 503 on
 *     every request and is not used by the site either. The working bulk path
 *     is two-hop: `az-menu` for the sport list, then one `views/lobby` per
 *     sport for its leagues, then one `views/lobby` per league for its
 *     contests. Contests live at
 *     `view.matches[].contestGroups[].contests[]` as `_typ: LobbyFixtureContest`
 *     — note that the landing page's widgets use a different type,
 *     `FixtureContest`, so matching on the wrong one silently finds nothing.
 *
 * The lobby returns a one-market preview per contest (the default `1x2`), which
 * is exactly the market the arb engine needs for a result comparison — but only
 * that one market.
 *
 * A contest actually advertises far more: the lobby's `LobbyFixtureContest`
 * carries `propositionCount` (often 30-150) and `hasMorePropositions`, yet ships
 * a single `1x2` proposition. The full surface lives one request away at
 * `v2/views/contest-page?contestKey=...`, which returns a
 * `GetContestPage` whose `contest.propositions[]` is the whole menu — totals,
 * BTTS, double chance, handicaps, half-time, and a long tail of player props.
 * That detail call is opt-in (`fullMarkets`) because it is one request per
 * event: it multiplies the request count, so the default crawl still takes the
 * cheap lobby preview and the deep mode is what a scan that wants Unibet in the
 * arbitrage comparison turns on.
 */

/**
 * Sports whose `az-menu` key is crawled, measured 2026-09-28 against the live
 * feed: Football 697 events / 130 leagues, Tennis 267, IceHockey 109,
 * Basketball 97, AmericanFootball 77, TableTennis 68, ESports 57, Handball 25,
 * RugbyUnion 27, Mma 21, Baseball 13, Volleyball 10. The whole 30-sport menu
 * yields 1563 events in ~28s, so the default is the high-volume core rather
 * than everything — sports with no cross-book coverage add events the arb
 * engine can never pair.
 */
const DEFAULT_SPORTS = Object.freeze([
  'Football',
  'Tennis',
  'IceHockey',
  'Basketball',
  'AmericanFootball',
  'TableTennis',
  'ESports',
  'Handball',
  'RugbyUnion',
  'Mma',
  'Boxing',
  'Baseball',
  'Volleyball',
]);

const BFF = 'https://sportsbff-ams.kindredext.net/sports-api/api';

/**
 * Tenant headers. Names are the site's own; see the file header for why the
 * `X-` prefixed variants do not work.
 */
function tenantHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    locale: 'ro_RO',
    jurisdiction: 'RO',
    ksp_jurisdiction: 'mga',
    brand: 'unibet',
    origin: 'https://www.unibet.ro',
    referer: 'https://www.unibet.ro/betting/odds',
  };
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** `views/lobby` needs all four of these or it 400s. */
function lobbyQuery(category) {
  return new URLSearchParams({
    category,
    clientOffset: '-120',
    sortBy: 'relevance',
    tab: 'matches',
    timeFilter: 'all',
  }).toString();
}

/** League categoryRns under a sport, from that sport's lobby view. */
export function leaguesIn(view) {
  const out = [];
  for (const accordion of view?.matches || []) {
    for (const child of accordion.children || []) {
      if (child && child.categoryRn) out.push(child.categoryRn);
    }
  }
  return out;
}

/**
 * Contests in a league lobby view.
 *
 * `view.matches[]` are date accordions whose `contestGroups[].contests[]` hold
 * the fixtures. `featuredMatches[]` repeats a handful of them at the top of the
 * page; both are read, and the caller dedupes by `contestKey`.
 */
export function contestsIn(view) {
  const out = new Map();
  const add = (c) => {
    if (c && c.contestKey) out.set(c.contestKey, c);
  };
  for (const accordion of view?.matches || []) {
    for (const group of accordion.contestGroups || []) {
      for (const c of group.contests || []) add(c);
    }
  }
  for (const featured of view?.featuredMatches || []) add(featured.contest || featured);
  return out;
}

/**
 * Unibet `propositionType` → the market key the engine resolves.
 *
 * The engine buckets by resolved family + period + line, and `resolveContract`
 * whitelists a handful of keys outright. Emitting the provider's own
 * `propositionType` would work for `1x2` (a literal whitelist hit) but leave
 * `total`, `2_way_handicap` and friends to the shape-based fallbacks, which is
 * fragile. Mapping to the documented keys makes the contract explicit.
 *
 * `null` means "not arbitrable / not worth publishing":
 *  - player props and player-card markets have no cross-book counterpart;
 *  - `1x2_{xup}up` is a two-goal-margin result no other book prices the same way;
 *  - `3_way_handicap` settles 1/X/2 against a spread, which the engine has no
 *    family for — and its selection shape is a literal 1/X/2 triple, so
 *    publishing it unfiltered is how a handicap price would get paired against
 *    another book's plain full-time result and reported as a profit;
 *  - `draw_no_bet` refunds the draw, so its two sides are not jointly
 *    exhaustive. Its selection names are a bare `1` / `2`, which the engine's
 *    generic two-way fallback reads as a clean match winner — publishing it
 *    would book an arbitrage whose third outcome is a stake return.
 */
const ENGINE_KEYS = {
  '1x2': '1x2',
  head_to_head: 'HEAD_TO_HEAD',
  'head-to-head': 'HEAD_TO_HEAD',
  moneyline: 'MONEYLINE',
  match_winner: 'MATCH_WINNER',
  winner: 'MATCH_WINNER',
  '2_way_match_winner': 'MATCH_WINNER',
  total: 'TOTAL',
  total_games: 'FTGO',
  games_total: 'FTGO',
  total_points: 'FTPO',
  points_total: 'FTPO',
  '1st_half_total': 'TOTAL',
  '1st_half_1x2': '1x2',
  '2nd_half_total': 'TOTAL',
  '2nd_half_1x2': '1x2',
  '1st_quarter_total': 'FTPO',
  'quarter_1_total': 'FTPO',
  '2nd_quarter_total': 'FTPO',
  'quarter_2_total': 'FTPO',
  '3rd_quarter_total': 'FTPO',
  'quarter_3_total': 'FTPO',
  '4th_quarter_total': 'FTPO',
  'quarter_4_total': 'FTPO',
  '1st_quarter_winner': 'MATCH_WINNER',
  'quarter_1_winner': 'MATCH_WINNER',
  '2nd_quarter_winner': 'MATCH_WINNER',
  'quarter_2_winner': 'MATCH_WINNER',
  '3rd_quarter_winner': 'MATCH_WINNER',
  'quarter_3_winner': 'MATCH_WINNER',
  '4th_quarter_winner': 'MATCH_WINNER',
  'quarter_4_winner': 'MATCH_WINNER',
  set_1_total: 'FTGO',
  set_1_winner: 'MATCH_WINNER',
  set_2_total: 'FTGO',
  set_2_winner: 'MATCH_WINNER',
  set_3_total: 'FTGO',
  set_3_winner: 'MATCH_WINNER',
  set_4_total: 'FTGO',
  set_4_winner: 'MATCH_WINNER',
  set_5_total: 'FTGO',
  set_5_winner: 'MATCH_WINNER',
  both_teams_to_score: 'BOTH_TEAMS_SCORE',
  '1st_half_both_teams_to_score': 'BOTH_TEAMS_SCORE',
  '2nd_half_both_teams_to_score': 'BOTH_TEAMS_SCORE',
  double_chance: 'DOUBLE_CHANCE',
  '1st_half_double_chance': 'DOUBLE_CHANCE',
  '2nd_half_double_chance': 'DOUBLE_CHANCE',
  '1st_half_handicap': 'HANDICAP',
  '2nd_half_handicap': 'HANDICAP',
  '2_way_handicap': 'HANDICAP',
  game_handicap: 'HANDICAP',
  games_handicap: 'HANDICAP',
  point_spread: 'HANDICAP',
  points_handicap: 'HANDICAP',
  total_corners: 'CNOU',
  corners_total: 'CNOU',
  total_cards: 'TCOU',
  cards_total: 'TCOU',
  home_team_total: 'TOTAL',
  away_team_total: 'TOTAL',
  '1st_team_total': 'TOTAL',
  '2nd_team_total': 'TOTAL',
  team_1_total: 'TOTAL',
  team_2_total: 'TOTAL',
  total_home: 'TOTAL',
  total_away: 'TOTAL',
  home_total: 'TOTAL',
  away_total: 'TOTAL',
  corners_home: 'CNOU',
  corners_away: 'CNOU',
  '1st_half_corners': 'CNOU',
  '1st_half_cards': 'TCOU',
};

/**
 * Market keys whose variant lines must be half-lines (`.5`) to be arbitrable.
 *
 * The engine's Asian-handicap contract only accepts `a === -b` where the
 * magnitude is a half: a whole line pushes, and a quarter line splits the stake
 * two ways, so neither is the clean "exactly one side pays" contract the
 * inverse-sum arithmetic assumes.
 *
 * This matters beyond a lost opportunity. Unibet lists 13 two-way handicap
 * lines per event, of which only 4 are half-lines. A whole-line variant like
 * `1 -1 | 2 +1` carries no "handicap" word in its selection names, so if it is
 * published it reaches the engine's generic two-way fallback and resolves as a
 * 2-way MATCH_ODDS — which would then be compared against a real full-time
 * result from another book and produce an arbitrage that cannot exist.
 */
const HALF_LINE_ONLY = new Set(['HANDICAP']);

/** True for `.5` / `-.5` / `1.5` / `-1.5` — the only arbitrable handicap lines. */
function isHalfLine(line) {
  const n = Number(line);
  return Number.isFinite(n) && Math.abs(n) % 1 !== 0 && Math.abs(n) * 2 === Math.round(Math.abs(n) * 2);
}

/**
 * Option types that name a person rather than an event outcome. A market built
 * from these is a player prop: correct in isolation, but never comparable
 * against another book (Unibet spells players "Desire Doue 1+", others use
 * different line notation), so pairing one would fabricate an arbitrage out of
 * two different bets.
 */
const PLAYER_OPTION_TYPES = new Set(['Participant', 'Player']);

/** Proposition types that settle before the final whistle. */
function periodFor(propositionType, displayName = '') {
  const pt = String(propositionType || '');
  if (/1st_half|half_time|first_half/.test(pt)) return 'half1';
  if (/2nd_half|second_half/.test(pt)) return 'half2';
  const setM = /(?:set_?([1-5])|([1-5])(?:st|nd|rd|th)?_set)/i.exec(pt);
  if (setM) return `set${setM[1] || setM[2]}`;
  const qM = /(?:quarter_?([1-4])|q([1-4])|([1-4])(?:st|nd|rd|th)?_quarter)/i.exec(pt);
  if (qM) return `q${qM[1] || qM[2] || qM[3]}`;
  return extractPeriodFromName(displayName) || 'fulltime';
}

/**
 * One engine-shaped market from a single *variant* (one priceable row) of a
 * Unibet proposition.
 *
 * A contest-page proposition is `variants: [[opts], [opts], ...]` — one inner
 * array per line. Totals arrive with six of them (0.5 / 1.5 / 2.5 / …), the
 * 2-way handicap with thirteen. Each is a distinct market at a distinct line, so
 * each becomes its own engine market; collapsing them would put six different
 * lines in one bucket and let the engine pair Over 0.5 against Over 3.5.
 *
 * @returns {object|null} null when the variant has no two-sided price.
 */
function normalizeVariant(proposition, variant, key, sport = '') {
  const selections = [];
  for (const option of variant || []) {
    // Player props are excluded here rather than filtered by propositionType so
    // a new player-market type is dropped automatically instead of leaking
    // through an allowlist that has to be kept current.
    if (PLAYER_OPTION_TYPES.has(option?.optionType)) continue;

    const odds = Number(option?.price);
    if (!Number.isFinite(odds) || odds <= 1) continue;
    if (option.bettingOpen === false) continue;

    const label = String(option.optionDisplayName || option.optionName || '').trim();
    if (!label) continue;

    // `variantName` carries the line for over/under ("2.5") and the handicap
    // ("-1", "+1"); on a plain market it is the literal "Plain" and must not
    // leak into the selection name, or every 1X2 would read as "1 Plain".
    // The leading `+` matters: Unibet writes the two sides of a handicap as
    // "-0.5" and "+0.5", and dropping the plus would leave the second side
    // line-less and break the symmetric pair the AH resolver needs.
    const rawLine = String(option.variantName || '').trim();
    const isLine = /^[+-]?\d+(?:\.\d+)?$/.test(rawLine);
    const line = isLine ? rawLine : null;

    selections.push({
      id: String(option.priceKey || option.optionKey || ''),
      name: line ? `${label} ${line}` : label,
      odds,
      handicap: line,
      group: 'Main',
    });
  }

  if (selections.length < 2) return null;

  // Reject a handicap line the engine cannot settle as a surebet. See
  // HALF_LINE_ONLY — without this, a whole-line handicap is published and
  // resolves as a 2-way MATCH_ODDS, which is an arbitrage that cannot exist.
  const line = selections[0]?.handicap ?? null;
  if (HALF_LINE_ONLY.has(key) && !(line && isHalfLine(line))) return null;

  const rawPropType = String(proposition.propositionType || '').trim().toLowerCase();
  const rawDisplayName = String(proposition.displayName || '');
  const team = /home|1st_team|team_1|prim[aă]\s*echip[aă]/i.test(rawPropType) || /(?:echip[aă]\s*1|echip[aă]\s*i\b|gazde|gazd[aă]|home\s*team)/i.test(rawDisplayName)
    ? 'home'
    : /away|2nd_team|team_2|a\s*doua\s*echip[aă]/i.test(rawPropType) || /(?:echip[aă]\s*2|echip[aă]\s*ii\b|oaspe[tț]i|oaspete|away\s*team)/i.test(rawDisplayName)
      ? 'away'
      : undefined;

  let subject;
  if (/corners?/.test(rawPropType)) subject = 'corners';
  else if (/cards?/.test(rawPropType)) subject = 'cards';
  else if (/points?/.test(rawPropType)) subject = 'points';
  else if (/games?/.test(rawPropType)) subject = 'games';
  else if (key === 'TOTAL' || key === 'FTPO' || key === 'FTGO') {
    const s = String(sport || '').toLowerCase();
    if (s === 'basketball' || s === 'americanfootball' || s === 'baseball') subject = 'points';
    else if (s === 'tennis' || s === 'tabletennis') subject = 'games';
    else subject = 'goals';
  }

  return {
    id: `${String(proposition.propositionKey || key)}:${String(variant?.[0]?.variantKey ?? '')}`,
    key,
    // The provider's own market label, deliberately kept out of `key`: the
    // engine's full-time guard reads `name` and rejects anything naming a
    // sub-settlement window. "Pauză/Final" and "Total Goluri - Repriză a 1-a"
    // are exactly the names that must survive that check — and `period` is what
    // actually separates them, not the label.
    name: String(proposition.displayName || key),
    period: periodFor(proposition.propositionType, proposition.displayName),
    line,
    team,
    ...(subject ? { subject } : {}),
    selections,
  };
}

function resolveUnibetEngineKey(rawType) {
  const t = String(rawType || '').trim().toLowerCase();
  if (ENGINE_KEYS[t]) return ENGINE_KEYS[t];
  if (/(?:quarter_?[1-4]|q[1-4]|[1-4](?:st|nd|rd|th)?_quarter)_winner/.test(t)) return 'MATCH_WINNER';
  if (/(?:quarter_?[1-4]|q[1-4]|[1-4](?:st|nd|rd|th)?_quarter)_total/.test(t)) return 'FTPO';
  if (/(?:set_?[1-5]|[1-5](?:st|nd|rd|th)?_set)_winner/.test(t)) return 'MATCH_WINNER';
  if (/(?:set_?[1-5]|[1-5](?:st|nd|rd|th)?_set)_total/.test(t)) return 'FTGO';
  if (/(?:1st|2nd|first|second)_half_both_teams_to_score|both_teams_to_score_(?:1st|2nd|first|second)_half/.test(t)) return 'BOTH_TEAMS_SCORE';
  if (/(?:1st|2nd|first|second)_half_double_chance|double_chance_(?:1st|2nd|first|second)_half/.test(t)) return 'DOUBLE_CHANCE';
  if (/(?:1st|2nd|first|second)_half_handicap|handicap_(?:1st|2nd|first|second)_half/.test(t)) return 'HANDICAP';
  if (/(?:1st|2nd|first|second)_half_total|total_(?:1st|2nd|first|second)_half/.test(t)) return 'TOTAL';
  if (/(?:1st|2nd|first|second)_half_1x2|1x2_(?:1st|2nd|first|second)_half/.test(t)) return '1x2';
  return null;
}

/**
 * Every arbitrable market on one Unibet proposition.
 *
 * The lobby's preview propositions ship `options[]` with no `variants` wrapper;
 * contest-page propositions ship `variants[][]`. Both are accepted so the same
 * function serves the cheap crawl and the deep one.
 *
 * @returns {object[]}
 */
export function marketsFromProposition(proposition, sport = '') {
  const rawType = String(proposition?.propositionType || '').trim();
  const key = resolveUnibetEngineKey(rawType);
  if (!key) return [];

  const groups = Array.isArray(proposition.variants) && proposition.variants.length
    ? proposition.variants
    : [proposition.options || []];

  const out = [];
  const seen = new Set();
  for (const variant of groups) {
    const market = normalizeVariant(proposition, variant, key, sport);
    if (!market) continue;
    // Same key + same line + team + subject must appear once; the feed repeats a proposition
    // under both its display and its raw type on some events.
    const slot = `${market.key}@${market.line ?? '_'}@${market.period}@${market.team ?? '_'}@${market.subject ?? '_'}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push(market);
  }
  return out;
}

export default class UnibetScraper extends ScraperBase {
  id = 'unibet';
  name = 'Unibet';
  sourceIds = ['unibet'];

  constructor(opts = {}) {
    super(opts);
    // Three-hop traversal: 1 sports list + 1 lobby per sport + 1 per league.
    // Football alone is ~130 leagues, so the per-attempt deadline has to sit
    // well above the base default or the run aborts mid-crawl.
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.concurrency = Math.max(1, Number(opts.concurrency ?? 6));
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0) {
      throw new ValidationError('Unibet: invalid maxEvents');
    }
    const requested = Array.isArray(opts.sports) && opts.sports.length ? opts.sports : DEFAULT_SPORTS;
    this.sports = [...new Set(requested.map(String))];
    // The sport the scan is filtering on, if any. Unibet crawls many sports but
    // the arb scan reads one, so this is what tells the detail pass which
    // contests are worth the extra request.
    this.sport = String(opts.sport || '').trim();
    // When that single sport is named but no explicit `sports` list was given,
    // the crawl targets only that sport. The scan filters every other sport out
    // of its result, so the other sports' lobbies spend the cycle budget on
    // events that can never pair — measured 2026-10-08: the 13-sport crawl plus
    // fullMarkets runs 76s, most of it on sports the scan discards. An explicit
    // `sports` still wins, because a deliberate multi-sport crawl is not the
    // scan's doing.
    if (!(Array.isArray(opts.sports) && opts.sports.length) && this.sport) {
      this.sports = [this.sport];
    }
    // Deep mode costs one contest-page request per event, on top of the lobby
    // crawl. It is the difference between Unibet contributing only a 1X2
    // result market and Unibet contributing totals, BTTS and handicaps — but
    // it also multiplies request count and load, so it is configured per job
    // rather than hardcoded on.
    this.fullMarkets = Boolean(opts.fullMarkets ?? opts.jobConfig?.fullMarkets);
    // Cap on how many events get the detail call. A full football crawl is ~700
    // contests; without a cap a deep run issues 700 extra requests.
    this.detailLimit = String(opts.detailLimit ?? opts.jobConfig?.detailLimit ?? '').toLowerCase() === 'all'
      ? Infinity
      : Number.isInteger(opts.detailLimit)
        ? opts.detailLimit
        : Number.isInteger(opts.jobConfig?.detailLimit)
          ? opts.jobConfig.detailLimit
          : this.maxEvents;
    if ((!Number.isInteger(this.detailLimit) && this.detailLimit !== Infinity) || this.detailLimit < 0) {
      throw new ValidationError('Unibet: invalid detailLimit');
    }
    this.observedAt = new Date().toISOString();
    // This feed publishes in-play contests and says so on the contest itself, so
    // the flag is honoured rather than warned about. Measured 2026-09-29 22:5x
    // UTC: 12-13 started contests, every one `status: "InPlay"` against
    // `PreGame` on all ~830 future ones.
    this.includeLive = opts.includeLive === true;
  }

  /**
   * One request against the BFF, with retry on the load balancer's transient
   * 503. A 400 is NOT retried: it means the tenant headers are wrong, and
   * retrying it just spends the whole run's budget proving the same thing.
   */
  async _get(path, { signal, stats }) {
    const url = `${BFF}/${path}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, ...tenantHeaders() },
          signal,
          redirect: 'error',
        });
        if (res.ok) {
          stats.attempted += 1;
          return JSON.parse(await res.text());
        }
        if (res.status !== 503 && res.status !== 429) {
          stats.attempted += 1;
          stats.record(path, `HTTP ${res.status}`);
          return null;
        }
        stats.record(path, `HTTP ${res.status}`);
      } catch (err) {
        if (signal?.aborted) throw err;
        stats.record(path, describeError(err));
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    return null;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.observedAt = new Date().toISOString();

    const stats = {
      attempted: 0,
      failed: 0,
      reasons: new Map(),
      record(stage, why) {
        this.failed += 1;
        const key = `${stage}: ${why}`;
        this.reasons.set(key, (this.reasons.get(key) || 0) + 1);
      },
    };

    const azMenu = await this._get('v2/views/az-menu', { signal, stats });
    if (!azMenu) {
      throw new UpstreamError(
        `Unibet: az-menu unavailable — ${summariseReasons(stats.reasons)}. ` +
          'The BFF rejects requests without the locale/jurisdiction/ksp_jurisdiction/brand tenant headers.',
      );
    }

    const available = new Map((azMenu.items || []).map((i) => [String(i.key), i.displayName]));
    // The caller names the sport the way the scan does (`football`, the registry
    // id); the az-menu keys come back capitalized (`Football`). An exact match
    // against that key drops the requested sport entirely, and a single-sport
    // crawl would then collect nothing at all — a silent empty feed.
    const menuKey = (name) => {
      if (available.has(name)) return name;
      const lower = name.toLowerCase();
      for (const key of available.keys()) {
        if (key.toLowerCase() === lower) return key;
      }
      return null;
    };
    const wanted = [];
    const missing = [];
    for (const name of this.sports) {
      const key = menuKey(name);
      if (key) wanted.push(key);
      else missing.push(name);
    }
    if (missing.length) {
      this.logger('warn', `Unibet: sports not offered by the feed: ${missing.join(', ')}`);
    }
    this.logger('info', `Unibet: crawling ${wanted.length} sports (${wanted.join(', ')})`);

    /** @type {Map<string, object>} contestKey → contest */
    const events = new Map();
    let leagues = 0;

    for (const sport of wanted) {
      signal?.throwIfAborted();
      const sportView = await this._get(`v2/views/lobby?${lobbyQuery(sport)}`, { signal, stats });
      const sportLeagues = sportView ? leaguesIn(sportView.view) : [];
      leagues += sportLeagues.length;

      // Seed from the sport view itself: its featuredMatches are real contests
      // and come free with the league list.
      if (sportView) {
        for (const [key, contest] of contestsIn(sportView.view)) {
          if (!events.has(key)) events.set(key, { ...contest, _sport: sport, _league: contest.category });
        }
      }

      const queue = [...sportLeagues];
      await Promise.all(
        Array.from({ length: this.concurrency }, async () => {
          while (queue.length) {
            signal?.throwIfAborted();
            const league = queue.shift();
            const view = await this._get(`v2/views/lobby?${lobbyQuery(league)}`, { signal, stats });
            if (!view?.view) continue;
            for (const [key, contest] of contestsIn(view.view)) {
              if (events.has(key)) continue;
              events.set(key, { ...contest, _sport: sport, _league: league });
            }
          }
        }),
      );
      this.logger('info', `Unibet: ${sport} — ${sportLeagues.length} leagues, ${events.size} events so far`);
    }

    if (stats.attempted > 0 && stats.failed >= stats.attempted) {
      throw new UpstreamError(`Unibet: all ${stats.attempted} requests failed — ${summariseReasons(stats.reasons)}`);
    }
    if (events.size === 0) {
      throw new UpstreamError(`Unibet: ${leagues} leagues crawled, 0 contests — ${summariseReasons(stats.reasons)}`);
    }

    const contests = [...events.values()];
    let enriched = 0;
    if (this.fullMarkets) {
      enriched = await this._enrichMarkets(contests, { signal, stats });
    }

    this.sourceUrl = `${BFF}/v2/views/az-menu`;
    this.discovery = { sports: wanted.length, leagues, contests: contests.length, enrichedMarkets: enriched };
    this.extraction = { ok: 0, failed: 0 };
    return { contests };
  }

  /**
   * Replace each contest's one-market lobby preview with its full proposition
   * set from `v2/views/contest-page`.
   *
   * The detail view returns the same contest object with `propositions[]`
   * populated in full, so the swap is a field replacement rather than a merge —
   * no risk of the preview and the detail disagreeing about teams or kickoff.
   *
   * A contest whose detail call fails keeps its lobby preview. That is the right
   * failure mode: a partial market set on one event must not cost the event.
   *
   * The budget is spent on the contests most likely to pair with another book.
   * Contests arrive in crawl order, which is alphabetical by sport, so a plain
   * `slice` spends the whole budget on the first sport in the menu while the
   * scan — which filters to one sport — reads only the last. Ranking by the
   * requested sport first is what makes the cap pay for itself.
   */
  async _enrichMarkets(contests, { signal, stats }) {
    const priority = String(this.sport || '').trim().toLowerCase();
    const rank = (c) => {
      if (!priority) return 0;
      const type = String(c.contestType || c._sport || '').trim().toLowerCase();
      return type === priority ? 0 : 1;
    };
    // Stable: within a rank the crawl order is preserved, so this is a
    // partition by sport rather than a reshuffle.
    const queue = contests
      .map((contest, i) => ({ contest, i }))
      .sort((a, b) => rank(a.contest) - rank(b.contest) || a.i - b.i)
      .slice(0, this.detailLimit)
      .map((x) => x.contest);
    let enriched = 0;

    await Promise.all(
      Array.from({ length: this.concurrency }, async () => {
        while (queue.length) {
          signal?.throwIfAborted();
          const contest = queue.shift();
          const page = await this._get(
            `v2/views/contest-page?contestKey=${encodeURIComponent(contest.contestKey)}`,
            { signal, stats },
          );
          const full = page?.contest;
          if (!full || !Array.isArray(full.propositions) || full.propositions.length === 0) continue;
          // Keep the crawl's own _sport/_league annotations: the detail view
          // carries `category` but the league label we already resolved is the
          // one the rest of the pipeline matched on.
          contest.propositions = full.propositions;
          enriched += 1;
        }
      }),
    );

    this.logger(
      'info',
      `Unibet: deep markets — ${enriched}/${queue.length + enriched} contests expanded beyond 1X2`,
    );
    return enriched;
  }

  normalize(raw) {
    const contests = raw?.contests;
    if (!Array.isArray(contests)) throw new ValidationError('Unibet: missing contests');

    const out = [];
    for (const contest of contests) {
      const kickoffRaw = contest?.startDateTimeUtc?.value || contest?.startDateTimeUtc?.unixms;
      const kickoff = new Date(typeof kickoffRaw === 'number' ? kickoffRaw : kickoffRaw);
      if (!Number.isFinite(+kickoff)) continue;

      const sport = String(contest.contestType || contest._sport || 'Unknown');
      const markets = [];
      const taken = new Set();
      for (const proposition of contest.propositions || []) {
        for (const market of marketsFromProposition(proposition, sport)) {
          // One market per (key, line, period, subject): the feed repeats a
          // propositionType (Unibet lists "Rezultat final" and "Cote meci" as
          // two 1x2 markets on some events). Emitting both would put two
          // full-time result legs in the same engine bucket, so the first
          // priced one wins.
          const slot = `${market.key}@${market.line ?? '_'}@${market.period}@${market.team ?? '_'}@${market.subject ?? '_'}`;
          if (taken.has(slot)) continue;
          taken.add(slot);
          markets.push(market);
        }
      }
      if (markets.length === 0) continue;

      // Unibet states live-ness on the CONTEST, so every market of an in-play
      // contest is a live market. The flag is stamped here rather than in
      // extractEvents because `includeLive` is a collection decision: a run that
      // did not ask for in-play should not pay to carry those markets at all.
      const live = unibetEventIsLive(contest);
      if (live && !this.includeLive) continue;
      markMarketsLive(markets, () => live);

      const { home, away } = resolveTeams(contest);
      if (!home || !away) continue;

      out.push({
        id: String(contest.contestKey),
        sport: String(contest.contestType || contest._sport || 'Unknown'),
        league: leagueNameOf(contest, contest._league),
        kickoff: kickoff.toISOString(),
        homeTeam: home,
        awayTeam: away,
        status: contest.status || 'PreGame',
        markets,
      });
    }
    return out;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const r of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.markets.length === 0) continue;

      const eventKey = [
        normalizeTeamName(r.sport),
        normalizeTeamName(r.league),
        r.kickoff,
        normalizeTeamName(r.homeTeam),
        normalizeTeamName(r.awayTeam),
      ].join('|');

      out.push({
        id: r.id,
        sourceId: 'unibet',
        sourceUrl: this.sourceUrl,
        transport: 'kindred-sports-bff-v2',
        observedAt: this.observedAt,
        status: r.status,
        sport: r.sport,
        league: r.league,
        kickoff: r.kickoff,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        eventKey,
        // The scanner's live gate and the 90-second live freshness window both
        // read this. It was previously absent on every Unibet event, so an
        // in-play contest was dropped on kickoff exactly like a finished one.
        live: eventIsLive(r),
        markets: r.markets,
      });
    }
    if (this.extraction) this.extraction.ok = out.length;
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: 'https://www.unibet.ro/betting/odds',
      transport: 'kindred-sports-bff-v2',
      observedAt: this.observedAt,
      coverage: {
        sport: this.sports.length > 1 ? 'multi-sport' : this.sports[0],
        // False means "1X2 preview only", which is all the lobby gives. With
        // fullMarkets the crawl carries totals, BTTS, double chance and
        // handicaps — still not literally every market, since player props are
        // deliberately dropped as un-comparable across books.
        allMarkets: Boolean(this.fullMarkets),
        markets: this.fullMarkets ? 'result/totals/btts/double-chance/handicap' : 'result-only',
        // Was a blanket `true`, which described the transport rather than the
        // run: it said "live" even on a pre-match-only collection. The measured
        // capability, and whether THIS run actually collected in-play contests.
        ...liveCoverageFor(this.id),
        liveCollected: this.includeLive,
        maxEvents: this.maxEvents,
        detailLimit: this.fullMarkets ? this.detailLimit : 0,
      },
    };
  }
}

/**
 * Deepest `categoriesDetailed` entry is the league. The feed orders it from most
 * to least specific, so the first entry is the league the fixture belongs to;
 * `category` is the fallback for a contest that carries no detail list.
 */
function leagueNameOf(contest, fallback) {
  const detailed = contest?.categoriesDetailed;
  if (Array.isArray(detailed) && detailed.length && detailed[0]?.name) return String(detailed[0].name);
  if (typeof contest?.category === 'string' && contest.category) return contest.category.split(':').pop();
  return String(fallback || 'unknown');
}

/**
 * Home and away from the result market's own options.
 *
 * Read off the *proposition*, not the normalised market. The market's
 * selections are deliberately the literal `1` / `X` / `2` labels the engine
 * needs to recognise a full-time result, so the team names have to come from
 * the provider's `optionName` on the `T1` / `T2` options instead — they are
 * already normalised by the feed (correct diacritics, no trailing " (Live)").
 *
 * Falls back to splitting the contest's `"A vs B"` label, which is all the feed
 * gives when the result market is not priced yet.
 */
function resolveTeams(contest) {
  const matchWinnerTypes = new Set([
    '1x2',
    'head_to_head',
    'head-to-head',
    'moneyline',
    'match_winner',
    'winner',
    '2_way_match_winner',
  ]);
  for (const proposition of contest.propositions || []) {
    const pType = String(proposition.propositionType || '').toLowerCase().trim();
    if (!matchWinnerTypes.has(pType)) continue;
    let home = '';
    let away = '';
    const opts = (Array.isArray(proposition.variants) && proposition.variants[0]) || proposition.options || [];
    for (const option of opts) {
      const name = String(option.optionName || '').trim();
      if (!name) continue;
      if (option.optionType === 'T1' || option.optionType === 'Home') home = name;
      else if (option.optionType === 'T2' || option.optionType === 'Away') away = name;
    }
    if (home && away) return { home, away };
  }
  const label = String(contest?.name || '');
  const parts = label.split(/\s+(?:vs\.?|-)\s+/i);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return { home: '', away: '' };
}
