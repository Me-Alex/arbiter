import { normalizeTeamName } from '../shared/text.mjs';

const DRAW_NAMES = new Set(['draw', 'x', 'd', 'egalitate', 'remiza']);
const HOME_NAMES = new Set(['home', 'h', '1', 'gazde']);
const AWAY_NAMES = new Set(['away', 'a', '2', 'oaspeti', 'oaspete']);

export function supportedContractForMarket(marketKey) {
  const key = String(marketKey || '').toUpperCase();
  if (key === 'MATCH_ODDS' || key === '1X2') {
    return { key: 'MATCH_ODDS', outcomes: ['home', 'draw', 'away'] };
  }
  const totals = key.match(/^(?:(?:CORNERS|CARDS|POINTS|GAMES)_)?OVER_UNDER_([0-9_]+)$/);
  if (totals) return { key, outcomes: ['over', 'under'], line: totals[1].replace('_', '.') };
  return null;
}

/**
 * True when a market's selections look exactly like a complete 1X2 contract
 * (three distinct outcomes named 1, X and 2). Providers emit opaque market
 * keys for the same full-time result market — superbet uses numeric IDs like
 * 547, winner uses bet IDs like 1, netbet uses `default`, betano uses MRES,
 * FEG uses ufo:mtyp:00-00 — so the scanner recognises them by selection shape
 * instead of requiring a shared key.
 */
export function isLiteral1x2SelectionSet(selections) {
  if (!Array.isArray(selections) || selections.length !== 3) return false;
  const names = selections.map((s) => String(s && s.name).trim());
  return names.includes('1') && names.includes('X') && names.includes('2')
    && new Set(names).size === 3;
}

/**
 * True when an opaque provider market key denotes the *match result* contract,
 * i.e. the same settlement as a plain full-time 1X2.
 *
 * Generic keys (547, 1, default, MRES, Final) name no settlement window, so a
 * 1/X/2 selection set is enough to accept them.
 *
 * FEG / EveryMatrix keys do encode the market, as `ufo:mtyp:<sport>-<type>`.
 * The second field is the market *type*, not a period: observed values are
 * `00` "Meci" (full-time 1X2), `01` double chance, `03` draw-no-bet, `04`
 * "Pauza sau Final" (half-time OR full-time — a different payoff function),
 * `0u` goals total, `1c` both teams to score. Only `00` settles like a plain
 * full-time 1X2. An earlier version of this function read the *first* field as
 * the period, which accepted the goals-total and BTTS keys and rejected the
 * real match-result key — exactly backwards.
 */
export function isOpaqueMatchResultKey(marketKey) {
  const key = String(marketKey || '').trim();
  if (!key) return false;
  // A FEG-shaped key must parse. If it does not, the market type is unknown and
  // accepting it would let a settlement window nobody can name stand in for a
  // full-time 1X2 — an unrecognised FEG key is rejected, not assumed benign.
  if (/^ufo:mtyp:/i.test(key)) {
    const feg = /^ufo:mtyp:[0-9a-z]{2}-([0-9a-z]{2})$/i.exec(key);
    return Boolean(feg) && feg[1].toLowerCase() === '00';
  }
  return true;
}

/**
 * Combined guard used by the engine: a market may be treated as the full-time
 * 1X2 contract when it declares full-time settlement — and its own name does
 * not contradict that — AND (its key is a known contract OR it is an opaque
 * key that really denotes the match result).
 */
export function isMatchResultMarket(m = {}) {
  if (!isDeclaredFullTimeMarket(m)) return false;
  // Encoded totals must not be rescued as MATCH_ODDS by the engine's legacy
  // fallback after the totals resolver rejects an incomplete/conflicting line.
  if (/^OVER_UNDER_/i.test(String(m.key || ''))) return false;
  if (supportedContractForMarket(m.key)) return true;
  return isLiteral1x2SelectionSet(m.selections) && isOpaqueMatchResultKey(m.key);
}

/**
 * Settlement-period guard for a market. Only full-time (or unknown/absent,
 * which matches the majority of emitted markets) result markets may be
 * compared as MATCH_ODDS. First-half, second-half, and other period markets
 * that also use 1/X/2 labels must NOT be bucketed together with full-time odds.
 *
 * The literal strings 'unknown'/'unspecified' count as absent. Providers emit
 * them when they have no settlement window to report, and treating them as a
 * real period silently dropped every such market — the FEG family publishes
 * `period: 'unknown'` on all of them, so its full-time 1X2 never reached the
 * engine at all.
 */
export function isFullTimeMarket(m = {}) {
  const period = String(m?.period || '').trim().toLowerCase();
  if (!period) return true; // absent period is the common emission; treat as full-time
  if (period === 'unknown' || period === 'unspecified' || period === 'n/a') return true;
  return period === 'fulltime' || period === 'full time' || period === 'ft';
}

/**
 * Words in a market's own name that say it settles before the final whistle.
 *
 * This is a second, independent check on the declared `period`, and it exists
 * because a declared period is only as good as the adapter that wrote it. Four
 * adapters stamped `period: 'fulltime'` on every market they emitted — excelbet
 * and its two siblings mapped the double-chance codes onto the same literal
 * 1/X/2 outcome labels, and winner stamped every bet type — so a first-half or
 * double-chance price carried a full-time label and passed every period check.
 *
 * The name is the provider's own text, so it is evidence the adapter never
 * looked at. When the two disagree, the name wins: a market called "Repriza 1"
 * is not a full-time result market, whatever the adapter labelled it.
 */
const SUB_SETTLEMENT_WORDS = [
  // Romanian, in both the ordinal-first and the word-first orderings a book
  // actually emits. `1. repriza` is the FEG spelling and the one a new adapter
  // is most likely to copy, so matching only `repriza 1` left it open. The
  // `repriz[aă]` classes are diacritic-insensitive AND the lookahead replaces
  // the trailing `\b` because JS `\w` is ASCII-only: `ă` is a non-word char, so
  // `\b` never fires after it and the live spelling "repriză" was missed.
  /\brepriz[aă]\s*[12](?![a-z0-9])/i, /\b[12]\.?\s*repriz[aă](?![a-z0-9])/i,
  /\bprima\s*repriz[aă](?![a-z0-9])/i, /\ba\s*doua\s*repriz[aă](?![a-z0-9])/i,
  /\b1st\s*half\b/i, /\b2nd\s*half\b/i, /\bfirst\s*half\b/i, /\bsecond\s*half\b/i,
  /\bhalf\s*time\s*or\s*full\b/i, /\bpauz[aă]\s*sau\s*final\b/i,
  /\bhalf\s*time\b/i, /\bpauz[aă]\b/i,
  /\bdouble\s*chance\b/i, /\bdubla\s*(?:sansa|sanșa|șansă|chance)\b/i,
  /\bset\s*[1-5](?![a-z0-9])/i, /\b[1-5]\.?\s*set\b/i, /\b(?:1st|2nd|3rd|4th|5th)\s*set\b/i,
  /\bsfert(?:ul)?\s*[1-4](?![a-z0-9])/i, /\b[1-4]\.?\s*sfert\b/i, /\bquarter\s*[1-4](?![a-z0-9])/i, /\b[1-4](?:st|nd|rd|th)?\s*quarter\b/i,
  /\bq[1-4]\b/i,
];

/**
 * Market names that state the settlement window INCLUDES overtime, extra time,
 * a super over, or extra innings. A full-time "Final" and an "incl.
 * prelungiri" winner award the stake to different outcomes whenever extra time
 * is needed, so they are different contracts — and they must never share a
 * bucket with the genuine full-time market. This is the same class of defect as
 * a first-half price stamped full-time, one window later.
 *
 * Measured on the live workspace (2026-10-05): superbet emits
 * "Câştigă meciul (incl. prelungiri)", "Câștigător (incl. prelungiri)",
 * "Final (incl. super over)" and "Câștigător (incl. inning-uri extra)" stamped
 * `period: 'fulltime'`, and netbet emits "Castigator Meci (Inclusiv
 * Prelungiri)" and "Total Puncte (Inclusiv Prelungiri)" the same way. None of
 * those strings matched SUB_SETTLEMENT_WORDS, because that list looks for
 * halves and double chance — words about EARLIER settlement, not LATER.
 */
const OVERTIME_INCLUSIVE_WORDS = [
  /\bincl(?:usiv|\.?)\s*(?:prelungi(?:ri|r\u012f)?|prel\.?|extra\s*time|over\s*time|\bot\b|inn?ing[\s-]*ur?i?\s*extra|super\s*over)/i,
  /\bsuper\s*over\b/i,
  /\b(?:prelungiri|extra\s*time|over\s*time|inning[\s-]*ur?i?\s*extra)\b/i,
];

function nameSettlesPastFullTime(m) {
  const name = String(m?.name || '');
  return OVERTIME_INCLUSIVE_WORDS.some((re) => re.test(name));
}

/**
 * True when a market declares full-time settlement *and* nothing in its own
 * name contradicts that.
 *
 * Used where a wrong answer fabricates an arbitrage: a first-half or
 * double-chance price accepted as a full-time result is paired against another
 * book's full-time legs and reported as a profit that cannot exist.
 *
 * @param {{ key?: string, name?: string, period?: string }} m
 * @returns {boolean}
 */
export function isDeclaredFullTimeMarket(m = {}) {
  if (!isFullTimeMarket(m)) return false;
  const name = String(m.name || '');
  if (!name) return true;
  if (nameSettlesPastFullTime(m)) return false;
  return !SUB_SETTLEMENT_WORDS.some((re) => re.test(name));
}

function isLiteral1x2SelectionName(value) {
  return ['1', 'X', '2'].includes(String(value || '').trim());
}

export function canonicalOutcome(selectionName, { homeTeam = '', awayTeam = '', marketKey = '' } = {}) {
  const contract = supportedContractForMarket(marketKey);

  const raw = String(selectionName || '').trim();
  const lower = raw.toLowerCase().trim();

  // Provider-opaque markets (547, 1, default, MRES, ufo:mtyp:00-00) are exposed
  // as MATCH_ODDS by selection shape; map literal 1/X/2 selections directly so
  // canonicalOutcome agrees with the inferred contract.
  if (!contract && isLiteral1x2SelectionName(raw)) {
    if (lower === '1') return 'home';
    if (lower === 'x') return 'draw';
    if (lower === '2') return 'away';
    return null;
  }

  if (!contract) return null;
  const normalized = normalizeTeamName(raw.replace(/^\s*[12x]\s*(?:[.)-]|\([^)]*\))?\s*/i, '')).replace(/\s+/g, ' ');

  if (contract.key === 'MATCH_ODDS') {
    const home = normalizeTeamName(homeTeam);
    const away = normalizeTeamName(awayTeam);
    if (DRAW_NAMES.has(lower) || lower === 'x' || /^x\s*(?:\(|\.|$)/i.test(raw)) return 'draw';
    if (HOME_NAMES.has(lower) || lower === '1' || /^1\s*(?:\(|\.|$)/i.test(raw) || (home && normalized === home)) return 'home';
    if (AWAY_NAMES.has(lower) || lower === '2' || /^2\s*(?:\(|\.|$)/i.test(raw) || (away && normalized === away)) return 'away';
    return null;
  }

  if (contract.outcomes.includes('over') && /^(over|peste)\b/i.test(raw)) return 'over';
  if (contract.outcomes.includes('under') && /^(under|sub)\b/i.test(raw)) return 'under';
  return null;
}

export function roundedArbitrageAllocation(legs, bankroll) {
  const total = Math.max(0, Number(bankroll) || 0);
  if (!Array.isArray(legs) || legs.length < 2 || total <= 0) return null;
  const inverseSum = legs.reduce((sum, leg) => sum + 1 / Number(leg.odds), 0);
  if (!(inverseSum > 0 && inverseSum < 1)) return null;

  const allocated = legs.map((leg) => ({
    ...leg,
    stake: round2(total * (1 / leg.odds) / inverseSum),
  }));
  const allocatedTotal = round2(allocated.reduce((sum, leg) => sum + leg.stake, 0));
  const correction = round2(total - allocatedTotal);
  if (correction !== 0) {
    // Fold residual cent drift into the largest stake (lowest odds) to minimize
    // payout distortion, matching arbitrage.js and standard Dutch betting practice.
    let targetIdx = 0;
    for (let i = 1; i < allocated.length; i++) {
      if (allocated[i].stake > allocated[targetIdx].stake) {
        targetIdx = i;
      }
    }
    allocated[targetIdx].stake = round2(allocated[targetIdx].stake + correction);
  }

  const payouts = allocated.map((leg) => round2(leg.stake * leg.odds));
  const worstCasePayout = Math.min(...payouts);
  const guaranteedProfit = round2(worstCasePayout - total);

  const hasLiquidity = allocated.some((leg) => leg.liquidity !== null && leg.liquidity !== undefined);
  const legsWithFill = allocated.map((leg, index) => {
    const res = {
      ...leg,
      payout: payouts[index],
      profit: guaranteedProfit,
    };
    if (leg.liquidity !== null && leg.liquidity !== undefined && Number.isFinite(Number(leg.liquidity))) {
      const liquidityVal = Number(leg.liquidity);
      res.fillVolume = round2(Math.min(leg.stake, liquidityVal));
      res.fillRate = leg.stake > 0 ? round2(Math.min(1, res.fillVolume / leg.stake)) : 1;
    }
    return res;
  });

  const res = {
    legs: legsWithFill,
    inverseSum,
    totalStake: total,
    worstCasePayout,
    guaranteedProfit,
    // Rounding is observable disclosure, not a reason to hide a mathematically
    // valid arb: `marginPercent` is the clean margin from the inverse sum, and
    // `roundingRisk` says whether the staked worst case still clears the bankroll.
    marginPercent: round2((1 - inverseSum) * 100),
    roundingRisk: guaranteedProfit < 0,
  };

  if (hasLiquidity) {
    res.executableStake = round2(legsWithFill.reduce((sum, leg) => sum + (leg.fillVolume ?? leg.stake), 0));
    res.isLiquidityConstrained = allocated.some(
      (leg) => leg.liquidity !== null && leg.liquidity !== undefined && Number.isFinite(Number(leg.liquidity)) && Number(leg.liquidity) < leg.stake,
    );
    const limits = allocated
      .filter((leg) => leg.liquidity !== null && leg.liquidity !== undefined && Number.isFinite(Number(leg.liquidity)) && Number(leg.liquidity) > 0)
      .map((leg) => Number(leg.liquidity) * Number(leg.odds) * inverseSum);
    res.maxExecutableBankroll = limits.length > 0 ? round2(Math.min(total, ...limits)) : total;
  }

  return res;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ===========================================================================
// WHAT IS BEING COUNTED — the `subject` and `team` dimensions
// ===========================================================================

// The countable things a total or a spread can be about are decided by the
// resolver below, not enumerated here. A vocabulary constant with no reader is
// backend surface nobody can act on: `export-use.test.mjs` refused this file
// over one, and the list was documentation pretending to be a contract.

/**
 * Subject words, taken from the captures rather than invented.
 *
 * Measured on `data/endpoints/captures/wamp-match-odds.json`,
 * `bet7_api.json`, `mrplay_api.json` and `topbet_api.json`:
 *
 *   Cornere Peste/Sub  66    Corners Over/Under  22    Corner  33
 *   Total cartonașe Peste/Sub  14                  Cartonașe  1
 *   Total Goluri Echipă Peste/Sub  62               Gol / Goluri  468
 *   Game-uri 2    Total Puncte (betano FTPO/FOUT, from the key table below)
 *
 * Both scripts are listed because the feeds are bilingual on the same market:
 * the Romanian books title a market "Cornere Peste/Sub" and the same product
 * appears as "Corners Over/Under" elsewhere. Diacritics are matched
 * insensitively — `cartonașe` is written `cartonase` by some providers and the
 * ș (U+0219) is not the ASCII s — so every class lists both spellings.
 *
 * Every pattern ends with `(?![a-z0-9])` rather than `\b`, and that is not a
 * style choice. JS `\b` and `\w` are ASCII-only, so a Romanian letter such as
 * `ă` or `ț` counts as a NON-word character: `\bcolturi\b` matches "colturi"
 * and silently fails on "colțuri", and `\bechipă\b` would match "echipa" and
 * silently fail on the very spelling it was written for. `(?![a-z0-9])` is the
 * Unicode-safe "not followed by another word character" test and fires for
 * both spellings. The same trap is documented at length on the period words
 * above; it is the same defect in a different table.
 */
const SUBJECT_WORDS = [
  ['corners', /\b(?:corners?|cornere|colturi|col[tț]uri)(?![a-z0-9])/i],
  // `cards` needs the word "total" in front of "hărți", and that is not
  // redundancy — it is the only thing separating CARDS from a SET.
  //
  // Measured 2026-10-05 on the live capture, same feed, two readings of one
  // Romanian word:
  //
  //   ufo:mtyp:02-02  "Total harti 2.5"        cards total   legs + 2.5 / - 2.5
  //   ufo:mtyp:03-03  "Total harti 4.5"        cards total   legs - 4.5 / + 4.5
  //   ufo:mtyp:02-04  "Harta 1. castigator"    tennis SET    legs 1 / 2
  //   ufo:mtyp:03-06  "Harta 1. castigator"    hockey SET    legs 2 / 1
  //
  // "harta" is the Romanian for a MAP, and a set is a map of a match — hence
  // "Harta 1." = "Set 1". A bare `hărți` matcher would file a tennis set winner
  // under cards, so the class requires `total` and the set-winner stays out.
  ['cards', /\b(?:cards?|cartonase|cartona[sș]e|total\s+h[ăa]r[tț]i)(?![a-z0-9])/i],
  // `runs/sets` — measured "Harta 1.: total runde 21.5" (ufo:mtyp:02-06,
  // basketball total sets) and "Total runde 7.5 / 9.5 / 10.5" (ufo:mtyp:14-02,
  // MMA total rounds). Distinct from `games` because the word is different and
  // because an MMA round is not a tennis set, even though both are "rounds".
  ['rounds', /\b(?:total\s+runde|runde)(?![a-z0-9])/i],
  // `legs` — darts, measured as "Total Leg-uri" on the `ou_legs` key. It gets its
  // own class rather than being folded into `rounds` for the same reason
  // `TOTAL_180S` is withheld outright elsewhere in this file: a darts leg and a
  // darts 180 are both darts counters and neither is a scoring total, so letting
  // one stand in for the other would be the subject collision by another name.
  ['legs', /\b(?:leg[\s-]?uri|total\s+leg[\s-]?uri)(?![a-z0-9])/i],
  // `shots on target` is the English surebet.com renders. The Romanian
  // spelling these books use is NOT in any capture we hold, so it is listed as
  // unverified rather than guessed — see the note on `subjectFor`.
  ['shots_on_target', /\b(?:shots?\s*on\s*target|[sș]uturi\s*(?:pe|la)\s*poart[aă]|tiruri\s*(?:pe|la)\s*poart[aă])(?![a-z0-9])/i],
  ['points', /\b(?:points?|puncte)(?![a-z0-9])/i],
  // `games` = tennis/basketball sets, not video games. The captures contain
  // casino URLs containing "games" on the same books, so the class requires the
  // Romanian hyphenated spelling or an explicit set-word.
  ['games', /\b(?:game[\s-]?uri|sets?)(?![a-z0-9])/i],
  // `goals` LAST: it is the weakest match (a bare "gol" appears inside
  // "goluri") and every other subject here is checked first, so a corners
  // market titled "Cornere / Goluri" resolves to corners.
  ['goals', /\b(?:goluri|total\s+goluri|gol|goals?|gole|goli|liczba\s+goli)(?![a-z0-9])/i],
];

/**
 * Keys whose subject was measured, per the live-feed table in `docs/` and the
 * FEG catalogue walk. Only keys whose subject this project has actually
 * observed are listed — a key that is present in the old refusal regex but has
 * no measured meaning stays refused, because guessing it would put two
 * different products in one bucket, which is the failure the whole dimension
 * exists to remove.
 */
const SUBJECT_BY_KEY = new Map([
  ['CNOU', 'corners'],   // "Cornere Peste/Sub"
  ['TCOU', 'cards'],     // "Total cartonașe Peste/Sub"
  ['TSMF', 'cards'],     // "Total Hărți"
  ['FTPO', 'points'],    // "Total Puncte"
  ['FOUT', 'points'],    // "Total Puncte"
  ['FTGO', 'games'],     // "Game-uri"
  ['TOTAL_POINTS', 'points'],
  ['TOTAL_GAMES', 'games'],
]);

/**
 * Resolve what a market's line counts, or null when nothing proves it.
 *
 * Reads the market's own NAME first — that is the provider's text, so it is
 * evidence the adapter never wrote — and falls back to a measured key. Returns
 * null rather than a guess: a total whose subject cannot be named must not be
 * filed under a subject, and the caller's fallback is what keeps that safe.
 *
 * @param {{ key?: string, name?: string }} market
 * @returns {string|null}
 */
export function subjectFor(market = {}) {
  if (market.subject) return market.subject;
  const key = String(market.key || '').trim().toUpperCase();
  const name = String(market.name || '');

  if (name) {
    for (const [subject, re] of SUBJECT_WORDS) {
      if (re.test(name)) return subject;
    }
  }
  // FEG encodes the market in the key as `ufo:mtyp:<sport>-<type>`; the football
  // goals total is `00-0u` and the two per-team goal totals are `00-10`/`00-13`.
  const feg = /^UFO:MTYP:00-(0U|10|13)$/i.exec(key);
  if (feg) return 'goals';

  if (key.startsWith('CORNERS_')) return 'corners';
  if (key.startsWith('CARDS_')) return 'cards';
  if (key.startsWith('POINTS_')) return 'points';

  const byKey = SUBJECT_BY_KEY.get(key);
  if (byKey) return byKey;

  return null;
}

/**
 * The subject a resolved total carries, defaulting to `goals`.
 *
 * The default is the whole point and it is not a shortcut. Every total this
 * engine could resolve BEFORE this dimension existed was a goals total — that
 * is precisely why the non-goal ones were refused, and `docs/no-arbitrage-
 * root-cause.md` measured the reachable totals as goals and nothing else. So
 * `goals` reproduces the old behaviour exactly for every market that already
 * traded, while a market whose name or key PROVES a different subject now gets
 * its own bucket and can no longer collide with a goals line of the same
 * number.
 *
 * A total whose subject is genuinely unknowable therefore still lands in the
 * goals bucket and can still pair with a goals market. That residual is not
 * worse than the status quo — it is the status quo — and it is the safe
 * direction: the alternative, refusing every unprovable total, would delete
 * working coverage across every adapter to remove a collision that has never
 * been observed.
 *
 * @returns {'goals'|'corners'|'cards'|'points'|'games'|'shots_on_target'}
 */
function handicapSubject(market, ctx = {}, key = '') {
  if (market.subject) return market.subject;
  const s = subjectFor(market);
  if (s === 'corners' || s === 'cards') return s;
  if (/^TGHC$/i.test(key)) return 'games';
  if (/^(?:POINT_SPREAD|POINTS_HANDICAP|SPREAD|BASKETBALL_HANDICAP)$/i.test(key)) return 'points';
  const sport = String(market?.sport || ctx?.sport || '').trim().toLowerCase();
  if (sport === 'basketball') return 'points';
  if (sport === 'tennis') return 'games';
  return null;
}

function totalSubject(market, ctx = {}) {
  const direct = subjectFor(market);
  if (direct) return direct;
  const sport = String(market?.sport || ctx?.sport || '').trim().toLowerCase();
  if (sport === 'basketball' || sport === 'american-football' || sport === 'rugby') return 'points';
  if (sport === 'tennis') return 'games';
  if (sport === 'handball') return 'goals';
  if (sport === 'ice-hockey' || sport === 'ice_hockey' || sport === 'hockey') return 'goals';
  return 'goals';
}

/**
 * Build an OVER_UNDER contract with its subject and team attached.
 *
 * Every OVER_UNDER return in this file goes through here, so no resolution path
 * can quietly produce a contract that buckets differently from its siblings.
 * That matters because the bucket key now includes both dimensions: a contract
 * built without them would land in `_::_` while an identical market resolved
 * two branches away landed in `corners::match`, and the two would never pair
 * even though they are the same market.
 *
 * Returns null — refusing the market — when `teamFor` cannot name the side of a
 * per-team total. Defaulting it to `match` would file a team's own goals under
 * the match's goals and re-create the exact collision the `team` dimension was
 * added to prevent, so it is refused instead. Measured cost: the EveryMatrix
 * feed publishes "Total Goluri Echipă Peste/Sub" (62 occurrences in
 * `wamp-match-odds.json`) which names no side, so that family on getsbet and
 * contibet stops resolving. That is a real coverage loss and it is the correct
 * trade — the alternative is a bucket in which one team's goal count is priced
 * as the match's, which is a fabricated arbitrage.
 *
 * @param {{lineKey: string}} inline result of classifyAndExtractLine
 * @param {object} market the provider market, for subject and side
 * @param {string} [period]
 */
function ouContract(inline, market, period, ctx) {
  const team = market.team || inline?.team || teamFor(market, ctx);
  if (team === null) return null;
  return {
    family: 'OVER_UNDER',
    period,
    lineKey: inline.lineKey,
    outcomes: ['over', 'under'],
    subject: inline?.subject || totalSubject(market, ctx),
    team,
  };
}

/**
 * Whose count a total is about: the match, or one side.
 *
 * A per-team total ("Over 0.5 2nd team", "Echipa 1 Total goluri") settles on a
 * different number than the match total of the same line, so it needs its own
 * dimension for the same reason `subject` does. Measured on the FEG catalogue
 * the two per-team football totals are `00-10` "Echipa 1" and `00-13`
 * "Echipa 2"; on WAMP the market is titled "Total Goluri Echipă" and names
 * NEITHER side, so the side cannot be read off it.
 *
 * Returns `null` for a per-team total whose side cannot be identified. That
 * refusal is deliberate: a total that is one team's but does not say which would
 * otherwise file itself under `match` and pair with a real match total, which
 * is the same subject collision this dimension exists to prevent. A caller
 * receiving null must refuse the market, not default it.
 *
 * @returns {'match'|'home'|'away'|null}
 */
export function teamFor(market = {}, ctx = {}) {
  if (market.team === 'home' || market.team === 'away' || market.team === 'match') {
    return market.team;
  }
  if (market.side === 'home' || market.side === 'away' || market.side === 'match') {
    return market.side;
  }
  const key = String(market.key || '').trim().toUpperCase();
  const hay = `${market.name || ''} ${(market.selections || []).map((s) => s?.name ?? '').join(' ')}`;

  // FEG names the side in the key.
  if (key === 'UFO:MTYP:00-10') return 'home';
  if (key === 'UFO:MTYP:00-13') return 'away';

  // Superbet per-event detail keys
  if (key.startsWith('SB:544:') || key.startsWith('SB:2529:')) return 'home';
  if (key.startsWith('SB:535:') || key.startsWith('SB:2531:')) return 'away';

  // Betano team total keys
  if (/^H(?:TGOT|CTG)$/i.test(key)) return 'home';
  if (/^A(?:TGOT|CTG)$/i.test(key)) return 'away';

  // Romanian and English side tokens. Checked against the whole market text,
  // which is what lets a total that names its side in the SELECTION ("Over 0.5
  // 2nd team") resolve the same way as one that names it in the market name.
  const isHome = /(?:echip[aă]\s*1|echip[aă]\s*i\b|1st\s*team|prim[aă]\s*echip[aă]|home\s*team|gazde|gazd[aă]|echip[aă]\s*gazd[aă])(?![a-z0-9])/i.test(hay);
  const isAway = /(?:echip[aă]\s*2|echip[aă]\s*ii\b|2nd\s*team|a\s*doua\s*echip[aă]|away\s*team|oaspe[tț]i|oaspete|echip[aă]\s*oaspete)(?![a-z0-9])/i.test(hay);
  if (isHome && !isAway) return 'home';
  if (isAway && !isHome) return 'away';

  const homeTeam = market.homeTeam || ctx?.homeTeam;
  const awayTeam = market.awayTeam || ctx?.awayTeam;
  if (homeTeam || awayTeam) {
    const hasHome = homeTeam && hay.toLowerCase().includes(homeTeam.toLowerCase());
    const hasAway = awayTeam && hay.toLowerCase().includes(awayTeam.toLowerCase());
    if (hasHome && !hasAway) return 'home';
    if (hasAway && !hasHome) return 'away';
  }

  // "Echipă" / "Team" with no number: it IS one team's total, but not a
  // nameable one. null makes the caller refuse rather than guess. The trailing
  // lookahead is load-bearing for the same reason as above — with `\b` this test
  // silently returned false for the exact Romanian spelling it was written for,
  // and the market then resolved as a MATCH total, which is the collision the
  // `team` dimension exists to prevent.
  if (/(?:total\s+goluri\s+echip[aă]|team\s+total|team\s+goals?)(?![a-z0-9])/i.test(hay)) return null;

  return 'match';
}

// ===========================================================================
// Generic contract resolver — every arbitration-eligible market resolves to
// exactly one of these. Period, line, subject and team are first-class so
// cross-book pairs always agree on the SAME settlement window, line, subject
// and side before prices are combined. (engine.mjs buckets by the resulting
// family+period+line+subject+team key.)
// ===========================================================================

/**
 * Settlement-window words that appear in a market's own NAME, used to correct a
 * declared `period` that the adapter stamped too broadly.
 *
 * A subset of SUB_SETTLEMENT_WORDS above, split by WHICH half they name so the
 * contract can be bucketed as half1/half2 rather than merely "not full-time" —
 * the period is part of the bucket key, so a first-half total must not land in
 * the same bucket as the full-time total of the same line.
 *
 * These are the spellings measured on the live feeds: betano's first-half goals
 * total is `OUH1 "Goluri prima repriză Peste/Sub"`, FEG writes `1. repriza`,
 * and the English books write "1st half"/"First Half".
 *
 * The Romanian spellings are written diacritic-insensitively on purpose, and
 * they deliberately avoid a trailing `\b`. JS `\b`/`\w` are ASCII-only
 * (`[A-Za-z0-9_]`), so a Romanian letter such as `ă` counts as a NON-word
 * character: `\brepriz[aă]\b` matches "repriza" but silently fails on
 * "repriză" — the char after `[aă]` is a non-word letter and the next is a
 * space, so no boundary exists there. `(?![a-z0-9])` is the Unicode-safe "not
 * followed by another word character" test and fires for both spellings.
 */
const FIRST_HALF_WORDS = [
  /\bprima\s*rep(?:riz[aă])?(?![a-z0-9])/i, /\brepriz[aă]\s*[1i](?![a-z0-9])/i, /\b[1i]\.?\s*rep(?:riz[aă])?(?![a-z0-9])/i,
  /\b1st[\s_-]+half\b/i, /\bfirst[\s_-]+half\b/i, /\b1\s*h\b/i,
  /\bpauz[aă](?!\s*sau\s*final)(?![a-z0-9])/i, /\bhalf[\s_-]*time(?![\s_-]*or[\s_-]*full)\b/i,
  /\bpr\b(?!\s*sau\s*final)/i,
  /\b1\.?\s*po[łl]owa(?![a-z0-9])/i, /\bpierwsza\s*po[łl]owa(?![a-z0-9])/i,
];
const SECOND_HALF_WORDS = [
  /\ba\s*doua\s*rep(?:riz[aă])?(?![a-z0-9])/i, /\brepriz[aă]\s*[2ii](?![a-z0-9])/i, /\b[2ii]\.?\s*rep(?:riz[aă])?(?![a-z0-9])/i,
  /\b2nd[\s_-]+half\b/i, /\bsecond[\s_-]+half\b/i, /\b2\s*h\b/i,
  /\bsr\b/i,
  /\b2\.?\s*po[łl]owa(?![a-z0-9])/i, /\bdruga\s*po[łl]owa(?![a-z0-9])/i,
];

export const TRADABLE_PERIODS = new Set([
  'fulltime',
  'half1',
  'half2',
  'set1',
  'set2',
  'set3',
  'set4',
  'set5',
  'q1',
  'q2',
  'q3',
  'q4',
  'unknown',
]);

export function isTradablePeriod(period) {
  return TRADABLE_PERIODS.has(String(period || '').trim().toLowerCase());
}

/**
 * A family is `arbEligible: true` when its outcomes are mutually exclusive and
 * jointly exhaustive — i.e. exactly one outcome is guaranteed to pay out at
 * full stake. Only such families admit the inverse-sum < 1 arbitrage math.
 *
 * DOUBLE_CHANCE is deliberately excluded: its 1X/12/X2 outcomes overlap, so
 * paying out on every leg is not a surebet, and a cross-book combination is
 * bounded by a different (and intractable) formula. The family is still
 * recognized for cataloging and reporting, just not scanned for arbitrage.
 */
function extractSetPeriod(name) {
  const setM = /(?:\bset(?:ul)?\s*([1-5])\b|\b([1-5])\.?\s*set\b|\b(1st|2nd|3rd|4th|5th)\s*set\b|\bprimul\s*set\b|\bal\s*doilea\s*set\b|\bal\s*treilea\s*set\b|\bhart[aă]\s*([1-5])(?![a-z0-9])|\b([1-5])\.?\s*hart[aă](?![a-z0-9]))/i.exec(name);
  if (!setM) return null;
  let num = setM[1] || setM[2] || (setM[3] ? { '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5' }[setM[3].toLowerCase()] : null) || setM[4] || setM[5];
  if (!num) {
    if (/\bprimul\s*set\b/i.test(setM[0])) num = '1';
    else if (/\bal\s*doilea\s*set\b/i.test(setM[0])) num = '2';
    else if (/\bal\s*treilea\s*set\b/i.test(setM[0])) num = '3';
  }
  return num ? `set${num}` : null;
}

function extractQuarterPeriod(name) {
  const qM = /(?:\bsfert(?:ul)?\s*([1-4])\b|\b([1-4])\.?\s*sfert\b|\bquarter\s*([1-4])\b|\b([1-4])(?:st|nd|rd|th)?\s*quarter\b|\bq([1-4])\b|\bprimul\s*sfert\b|\bal\s*doilea\s*sfert\b|\bal\s*treilea\s*sfert\b|\bal\s*patrulea\s*sfert\b)/i.exec(name);
  if (!qM) return null;
  let num = qM[1] || qM[2] || qM[3] || qM[4] || qM[5];
  if (!num) {
    if (/\bprimul\s*sfert\b/i.test(qM[0])) num = '1';
    else if (/\bal\s*doilea\s*sfert\b/i.test(qM[0])) num = '2';
    else if (/\bal\s*treilea\s*sfert\b/i.test(qM[0])) num = '3';
    else if (/\bal\s*patrulea\s*sfert\b/i.test(qM[0])) num = '4';
  }
  return num ? `q${num}` : null;
}

export function extractPeriodFromName(name) {
  if (!name || typeof name !== 'string') return null;
  if (FIRST_HALF_WORDS.some((re) => re.test(name))) return 'half1';
  if (SECOND_HALF_WORDS.some((re) => re.test(name))) return 'half2';
  const setPeriod = extractSetPeriod(name);
  if (setPeriod) return setPeriod;
  const quarterPeriod = extractQuarterPeriod(name);
  if (quarterPeriod) return quarterPeriod;
  return null;
}

export function canonicalPeriod(market = {}) {
  const p = String(market?.period || '').trim().toLowerCase();
  const name = String(market?.name || '').trim();

  // If the period is explicitly set to a half, set, or quarter:
  if (p === 'half1' || p === '1st_half' || p === 'first_half' || p === 'halftime' || p === 'half_time' || p === '1h' || p === 'ht' || p === 'pr' || /prima[\s_]*rep(?:riza)?|^repriza[\s_]*1\b|^1[\s_]*repriza|1(?:st)?[\s_]*half/.test(p)) return 'half1';
  if (p === 'half2' || p === '2nd_half' || p === 'second_half' || p === '2h' || p === 'sr' || /a[\s_]*doua[\s_]*rep(?:riza)?|^repriza[\s_]*2\b|^2[\s_]*repriza|2(?:nd)?[\s_]*half/.test(p)) return 'half2';
  const setP = /^(?:set(?:ul)?|map|hart[aă])[\s_]*([1-5])$|^([1-5])(?:st|nd|rd|th)?[\s_]*(?:set|map|hart[aă])$/i.exec(p);
  if (setP) return `set${setP[1] || setP[2]}`;
  const qP = /^(?:q|quarter|sfert(?:ul)?)[\s_]*([1-4])$|^([1-4])(?:st|nd|rd|th)?[\s_]*quarter$/.exec(p);
  if (qP) return `q${qP[1] || qP[2]}`;

  if (isFullTimeMarket(market)) {
    // A declared `fulltime` period is only as trustworthy as the adapter that
    // wrote it, and several adapters stamp it on every market they emit.
    // betano hardcodes `period: 'fulltime'` on all of them, so its first-half
    // goals total ("Goluri prima repriza Peste/Sub", key OUH1) declared
    // fulltime and resolved to OVER_UNDER/0.5 — the exact bucket a genuine
    // full-time goals 0.5 uses. A first-half price and a full-time price then
    // pair and the scanner reports an arbitrage over two different settlement
    // windows. The market's own name is the provider's text, so when the two
    // disagree the name wins, the same rule isDeclaredFullTimeMarket applies.
    if (name) {
      if (FIRST_HALF_WORDS.some((re) => re.test(name))) return 'half1';
      if (SECOND_HALF_WORDS.some((re) => re.test(name))) return 'half2';
      const setPeriod = extractSetPeriod(name);
      if (setPeriod) return setPeriod;
      const quarterPeriod = extractQuarterPeriod(name);
      if (quarterPeriod) return quarterPeriod;
      // A declared `fulltime` with an overtime-inclusive name is the same lie,
      // just on the other side of the final whistle: "Câştigă meciul (incl.
      // prelungiri)" labels a different payoff function than the genuine
      // full-time result, so the honest period is the one the engine refuses
      // rather than one it trades.
      if (OVERTIME_INCLUSIVE_WORDS.some((re) => re.test(name))) return 'unknown';
    }
    return 'fulltime';
  }

  // Name check when p is neither empty nor recognized above
  if (name) {
    if (FIRST_HALF_WORDS.some((re) => re.test(name))) return 'half1';
    if (SECOND_HALF_WORDS.some((re) => re.test(name))) return 'half2';
    const setPeriod = extractSetPeriod(name);
    if (setPeriod) return setPeriod;
    const quarterPeriod = extractQuarterPeriod(name);
    if (quarterPeriod) return quarterPeriod;
  }
  // An explicitly non-full-time period that names no half this function can read
  // is NOT full-time, and it must not be defaulted into one.
  //
  // The safe default below used to be `fulltime`, and while findArbitrage also
  // gated on `isFullTimeMarket` that was harmless twice over: the gate dropped
  // these markets anyway, and a mislabelled contract never reached a bucket. Both
  // assumptions were doing the same job, and the gate is now gone — the engine
  // admits a resolved contract and lets `bucketKeyForContract` isolate periods,
  // which is the right place for that job because the period travels WITH the
  // contract instead of being re-derived from a field the adapter wrote.
  //
  // So the default had to change with it. Two tests pin this: one feeds a market
  // declared `period: 'firsthalf'` with 1/X/2 legs next to a real full-time 1X2
  // and requires no arbitrage, the other marks a whole fixture `firsthalf` and
  // requires none either. `firsthalf` matches none of the half1 spellings above
  // (they need `1st half`, `first_half` or a Romanian form), so with the old
  // default it resolved as MATCH_ODDS/fulltime and paired with the genuine
  // full-time result — a false arbitrage over two different settlement windows,
  // which is the exact failure the surrounding comments describe.
  //
  // Measured on the 24 live books this changes nothing: the declared values there
  // are 43757 fulltime, 4163 unknown, 2129 half1, 1047 half2 and 673 absent, and
  // the first two take the branch above. It is a spelling no live adapter emits
  // today and a synthetic one does, which is why a test found what a live
  // census of the feeds could not.
  //
  // 'unknown' is the honest answer: the settlement window exists and is not
  // full-time, but this function cannot name it. Callers treat it as not
  // tradable rather than as the most common emission — see the period guard in
  // scanner/engine.mjs and the same guard in scripts/market-coverage.mjs.
  return 'unknown';
}

/**
 * Resolve a market to a contract: { family, period, lineKey, outcomes }.
 * Returns null if the market is not arbitrable.
 *
 * Resolution order:
 *   1. Explicit key whitelist (MATCH_ODDS, DC, BTTS, OVER_UNDER, ASIAN_HANDICAP)
 *   2. Provider-specific whitelists (FEG ufo:mtyp keys, betano HTTP-only keys, superbet numerics)
 *   3. Line-in-name fallback for O/U and AH (netbet-style shape)
 *   4. Generic 2-way match winner for any 1 vs 2 / two-name shape that doesn't
 *      look like totals or handicap
 *
 * Line collision is the largest single class of historical bugs. Every line
 * is normalised to a canonical string ("2.5" / "-1.5" / "1.5") so OVER 2.5
 * never buckets with OVER 3.5 even when the key is generic.
 */
export function resolveContract(market = {}, ctx = {}) {
  const rawKey = String(market.key || '');
  const key = rawKey.toUpperCase();
  const period = canonicalPeriod(market);

  // The frozen Favbet adapter assigned BOTH_TEAMS_SCORE to three different
  // propositions. Yes/no labels do not make a goals threshold or a both-halves
  // condition equivalent to plain BTTS. No independent capture quotes these
  // variants, so withhold them before any key/selection fallback can reopen them.
  const title = normalizeTeamName(market.name);
  if (/^ambele echipe (?:marcheaza mai (?:mult|putin) de 1 5 goluri|sa inscrie in ambele reprize)$/.test(title)) return null;

  // Frozen Betano/EveryMatrix captures carry bare Over/Under labels, with the
  // line in OVER_UNDER_2_5 (or Betano's _1H suffix) and selection.handicap.
  // The generic name parser drops all 504 of these markets. This canonical
  // namespace is authoritative: malformed or conflicting lines stay refused.
  if (key.startsWith('OVER_UNDER_') || /^(?:CORNERS|CARDS|POINTS|GAMES)_OVER_UNDER_/i.test(key)) return encodedTotalContract(key, market, period, ctx);

  // ---- 1. MATCH_ODDS (3-way: home/draw/away or 2-way: home/away for tennis/basketball) ----
  if (key === 'MATCH_ODDS' || key === '1X2' || key === 'MRES' || key === 'MR12' || key === 'MONEYLINE' || key === 'MATCH_WINNER' || key === 'HEAD_TO_HEAD' || key === 'WINNER_2WAY' || key === 'WINNER' || key === 'SET_WINNER' || key === 'QUARTER_WINNER' || key === 'HALF_WINNER' || key === 'PERIOD_WINNER' || key === 'MRH1' || key === 'MRH2') {
    if (market.selections?.length === 2) {
      return { family: 'MATCH_ODDS', period, lineKey: '_', outcomes: ['home', 'away'] };
    }
    return { family: 'MATCH_ODDS', period, lineKey: '_', outcomes: ['home', 'draw', 'away'] };
  }
  // Opaque keys (superbet 547, winner 1, netbet default, betano MRES, FEG
  // ufo:mtyp:00-00). Fall through to the 1/X/2 + opaque-key confirmation.
  if (isLiteral1x2SelectionSet(market.selections) && isOpaqueMatchResultKey(market.key)) {
    return { family: 'MATCH_ODDS', period, lineKey: '_', outcomes: ['home', 'draw', 'away'] };
  }

  // ---- 2. DOUBLE_CHANCE (3-way: 1X / 12 / X2) — recognized but NOT arb-eligible.
  // FEG publishes double chance per sport via ufo:mtyp:XX-YY where YY – {01, 0t}.
  // The selection shape is the same regardless of sport, so we accept the shape
  // on any FEG key, plus the provider-specific named keys.
  if (key === 'DOUBLE_CHANCE' || key === 'DBLC' || key === 'DCH1' || key === 'DCH2') {
    if (isDoubleChanceSelectionSet(market.selections)) {
      return { family: 'DOUBLE_CHANCE', period, lineKey: '_', outcomes: ['home_or_draw', 'home_or_away', 'draw_or_away'], arbEligible: false };
    }
  }
  // FEG shape-side detection: ufo:mtyp:*-01 / *-0t with 1X/12/X2 selections.
  if (/^UFO:MTYP:[0-9A-Z]{2}-(01|0T)$/i.test(key)) {
    if (isDoubleChanceSelectionSet(market.selections)) {
      return { family: 'DOUBLE_CHANCE', period, lineKey: '_', outcomes: ['home_or_draw', 'home_or_away', 'draw_or_away'], arbEligible: false };
    }
  }
  // 2-outcome degenerate DC (FEG feeds that publish only 2 of 3 outcomes,
  // e.g. ["1X","12"] with X2 missing). Catalogued for reporting but never
  // arbitrable because picking 2 of 3 double-chances is not a surebet.
  if (/^UFO:MTYP:/i.test(key)) {
    const norm = (market.selections || []).map((s) => String(s?.name || '').trim().toLowerCase().replace(/\s+/g, ''));
    const has2Of3 = (norm.includes('1x') && norm.includes('12'))
      || (norm.includes('1x') && norm.includes('x2'))
      || (norm.includes('12') && norm.includes('x2'));
    if (has2Of3) {
      return { family: 'DOUBLE_CHANCE', period, lineKey: '_', outcomes: ['home_or_draw', 'home_or_away', 'draw_or_away'], arbEligible: false, degraded: true };
    }
  }

  // ---- 3. BTTS (2-way: yes/no) ----
  if (key === 'BOTH_TEAMS_SCORE' || key === 'BTTS' || key === 'BTSC' || key === 'BTH1' || key === 'BTH2' || key === 'UFO:MTYP:00-1C') {
    if (isBttsSelectionSet(market.selections)) {
      return { family: 'BTTS', period, lineKey: '_', outcomes: ['yes', 'no'] };
    }
  }

  // ---- 3b. DRAW_NO_BET (2-way, draw refunds) — recognized, NEVER arbitrable ----
  //
  // This is the highest-consequence family in this file and the easiest to get
  // wrong, because a draw-no-bet market *looks* exactly like a two-way match
  // winner: two priced sides, the winner pays, the loser loses. The difference
  // is the third outcome. On a draw the stake is REFUNDED, so the two legs are
  // NOT jointly exhaustive — one outcome out of three returns the stake instead
  // of paying. The inverse-sum < 1 test assumes exactly one leg pays in full for
  // every outcome, so on a draw it books an "arbitrage" whose real payout is a
  // partial stake return. Nothing about the selection shape distinguishes it,
  // which is why this must be keyed off the market, never inferred from "1|2".
  //
  // Measured on the live feeds, DNB is served as:
  //   FEG     ufo:mtyp:00-03  "Victorie fara egal"  1/2 sides
  //   Betano  DNOB            "Niciun pariu pe egal"  team-name sides
  // Both were routed to a 2-outcome MATCH_ODDS — arbitrable — which put a DNB
  // "1" in the same engine bucket as a real full-time result "1". A Fortuna DNB
  // "1" at 2.10 paired against another book's full-time "1" at 1.90 reads as a
  // surebet and then evaporates on any draw. It is catalogued here (arbEligible
  // :false) rather than dropped, so a run can still report that the feed carries
  // it and exactly why it is not a candidate.
  const isDnbKey = (
    key === 'DRAW_NO_BET' ||
    key === 'DNB' ||
    key === 'DNOB' ||
    key === 'DNH1' ||
    key === 'DNH2' ||
    key === 'DRAW_NO_BET_2WAY' ||
    key === 'UFO:MTYP:00-03' ||
    key === 'ASIAN_HANDICAP_0' ||
    key === 'AH_0' ||
    key === 'AH0' ||
    key === 'HA_0' ||
    key === 'HANDICAP_0' ||
    key === 'AH(0)' ||
    key === 'AH 0'
  );
  const isDnbName = /\b(?:draw\s*no\s*bet|victorie\s+f[aă]r[aă]\s+egal|niciun\s+pariu\s+pe\s+egal|f[aă]r[aă]\s+egal|pariu\s+f[aă]r[aă]\s+egal|miz[aă]\s+(?:returnat[aă]|înapoiat[aă]|inapoiat[aă])\s+în\s+caz\s+de\s+egal)\b/i.test(market.name || '');
  if (isDnbKey || isDnbName) {
    const sides = market.selections || [];
    if (sides.length === 2) {
      return { family: 'DRAW_NO_BET', period, lineKey: '_', outcomes: ['home', 'away'], arbEligible: false };
    }
  }

  // ---- 3c. netbet segment winners and secondary-subject totals: WITHHELD ----
  //
  // Sportify's taxonomy is complete enough to key on (the adapter reads the
  // side from `kind` and the line from `handicap`), and two of its market
  // codes are not the contract the engine would otherwise read them as.
  // Measured 2026-09-29 over a 1,466-event inventory capture:
  //
  //   current_frame_winner "Frame 4 Castigator"  snooker  4 priced markets
  //   leg_winner          "Castigator Leg-ul 1"  darts    1 unpriced market
  //   total_180s          "Total 180-uri"        darts   13 priced markets
  //
  // The two winners resolve as MATCH_ODDS/_ off names of "1"/"2", which is the
  // very bucket the match winner occupies: on all 4 snooker events that carry
  // both, netbet's own "Frame 4 Castigator" price and its "Castigator Meci"
  // price landed in one bucket. findArbitrage refuses to pair a book with
  // itself, so nothing is reported today — but the moment a second book quotes
  // that snooker match, the frame price is offered against the other book's
  // MATCH price, and the engine books an arbitrage between two contracts that
  // settle on different events. A frame winner and a match winner are not a
  // market pair, and "which frame" is provider text, not an engine dimension.
  //
  // "Total 180-uri" counts 180s scored, which is not the match's scoring
  // total. The OVER_UNDER contract is (family, period, lineKey) and carries no
  // subject, so on a darts event that also publishes "Total Leg-uri" the two
  // would share a bucket at any coinciding line, and no book publishes a
  // "total 180s" that the engine can prove as a counterparty. Same call as
  // betano's corners and cards totals.
  //
  // Authoritative, and placed before every fallback on purpose: returning null
  // from the whitelists below would not be enough, because "Peste (0.5)"/
  // "Sub (0.5)" is a valid equal-magnitude O/U shape that the generic
  // line-in-name resolver would re-admit, and "1"/"2" is a valid 2-way shape
  // the match-winner fallback would re-admit.
  if (/^(CURRENT_FRAME_WINNER|LEG_WINNER|TOTAL_180S)$/.test(key)) {
    return null;
  }
  // FEG 'Se califica' (00-12) and 'Castigator finala' (00-1d) are asserted as
  // NOT the full-time result. 'Se califica' settles on who advances (extra time
  // and penalties can decide it), and 'Castigator finala' settles on who wins
  // the final, which for a knockout game is likewise not the 90-minute result.
  // Neither is exhaustive with the two-way/three-way full-time contract: pairing
  // one against a genuine full-time price books an arbitrage that the draw /
  // pens / extra-time branch erases. Refuse rather than let them fall through
  // to the generic two-way match-winner path (which only tests the selection
  // shape, not what the market settles).
  if (/^UFO:MTYP:00-(12|1D)$/.test(key)) {
    return null;
  }

  // ---- 4. OVER/UNDER and ASIAN_HANDICAP via provider whitelists ----
  // data/workspace/{fortuna,casa-pariurilor}_events.json: 11-01 is
  // "Total goluri 9.5" (20 markets), and 07-05 is "Meci: Total puncte 58.5"
  // (8 markets). Both use bare +/- lines. Route these measured totals before
  // the broad FEG winner table / generic spread heuristic, carrying the subject.
  // Do not infer a sport from these ids: some captured sport labels are wrong.
  if (key === 'UFO:MTYP:11-01' || key === 'UFO:MTYP:07-05') {
    const title = key === 'UFO:MTYP:11-01'
      ? /^Total goluri ([0-9]+\.[0-9]+)$/i
      : /^Meci:\s*Total puncte ([0-9]+\.[0-9]+)$/i;
    const namedLine = title.exec(String(market.name || '').trim());
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!namedLine || !inline || Number(namedLine[1]) !== Number(inline.lineKey)) return null;
    const contract = ouContract(inline, market, period, ctx);
    return hasTotalSides(market, contract) ? contract : null;
  }
  // FEG routing table — sport-prefix in XX selects the family, market-suffix in
  // YY names the contract shape. This covers the football projection (`00`),
  // its second market namespace (`0c`, see fegRoute), and the tennis, basketball,
  // ice hockey, handball, darts, futsal, rugby and unnamed-id sports the same
  // catalogue walks.
  const feg = fegRoute(rawKey, market, period, ctx);
  if (feg) return { ...feg, period };

  // betano whitelisted keys: keys the betano adapter exposes with provider-
  // specific abbreviations. Most common shapes are O/U and AH at a line, a few
  // are 2-way match winners.
  const betanoRoute = betanoKeyRoute(rawKey, market);
  if (betanoRoute) return { ...betanoRoute, period };

  // superbet per-event detail markets: the provider's market id AND its exact
  // market name, which together are the contract. See superbetDetailRoute.
  if (key.startsWith('SB:')) {
    const declared = superbetDetailRoute(key, market);
    // Authoritative, and placed before the numeric fallback on purpose.
    // superbetNumericRoute reads any two distinct names that lack a
    // totals/handicap keyword as a 2-way match winner, and superbet's
    // handicap legs are exactly that: "Belgia (-1.5)" / "Turcia (1.5)" name
    // the two teams and no keyword. It resolves to MATCH_ODDS/_ — a contract
    // whose two sides cannot tie — so a score-adjusted spread is priced
    // against another book's result market and settles on a different event.
    // And returning null is not enough on its own: the last-resort 2-way path
    // would re-admit the same pair. This branch is terminal either way.
    //
    // The OVER_UNDER half must go through `ouContract` like every other total
    // path, and this is measured rather than theoretical. `superbetDetailRoute`
    // builds its contract directly, so before this was routed through
    // `ouContract` superbet's goals totals left here with NO subject —
    // `superbetDetailRoute` never had one to give. They bucketed as `_::_`
    // while the same goals total from any of the other fifteen books bucketed
    // as `goals::match`, and a bucket key is equality: superbet could not pair
    // its own goals 2.5 with another book's goals 2.5 at all.
    //
    // Measured 2026-10-05 on the live workspace: 562 such markets on superbet
    // alone, across lines 0.5 to 6.5 — which is the largest single block of
    // unpaired goals totals in the capture. Nothing raised, because a lost
    // opportunity and a quiet market look identical in a scan that reports rows.
    // It showed up as `superbet — single book` in `scripts/market-coverage.mjs`.
    if (declared) {
      if (declared.family === 'OVER_UNDER') return ouContract(declared, market, declared.period || period, ctx);
      return { ...declared, period: declared.period || period };
    }
    return null;
  }

  // superbet numerics + nsoft + others: most are 2-way match winners (1|2)
  // with literally-named selections. Route them to MATCH_ODDS with 2 outcomes.
  const superbetRoute = superbetNumericRoute(rawKey, market);
  if (superbetRoute) return { ...superbetRoute, period };

  // ---- 5. netbet-style keys with line in name only (no `handicap` field) ----
  // game_handicap / handicap / goals_handicap from netbet publish the line in
  // the selection name ("1 (-7.5)") instead of an explicit handicap field.
  //
  // ASIAN_HANDICAP is an explicit, adapter-asserted key (nsoft emits it only
  // after proving both legs are the market's line and its negation), so it
  // routes on the key rather than through the name heuristics below, and it is
  // authoritative: a market that declares itself a handicap either resolves as
  // one or resolves to nothing. Both halves matter, and both are reachable
  // defects. Letting it fall through to the auto-detector reads nsoft's
  // "H1 -0.5" / "H2 0.5" as OVER_UNDER — the handicap keyword only matches
  // names starting with "1"/"2", these start with "H1"/"H2", and the
  // equal-magnitude fallback then buckets a 0.5 handicap into the same line as a
  // 0.5 goals total, two contracts with opposite payouts reported as one. And
  // returning null for a whole line is not enough on its own: the generic
  // resolver below would still classify "H1 -1"/"H2 1" as OVER_UNDER/1, so the
  // market would keep trading, mislabelled, on a line where a push returns the
  // stake instead of settling it.
  if (key === 'ASIAN_HANDICAP') {
    const declared = classifyAndExtractLine(market.selections, { kind: 'AH' });
    const subject = handicapSubject(market, ctx, key);
    return declared ? { family: 'ASIAN_HANDICAP', period, lineKey: declared.lineKey, outcomes: declared.outcomes, ...(subject ? { subject } : {}) } : null;
  }
  if (key === 'GAME_HANDICAP' || key === 'GAMES_HANDICAP' || key === 'GOALS_HANDICAP' || key === 'HANDICAP' || key === 'TGHC' || key === 'FAHC' || key === 'HCAP' || key === 'AHCP' || key === 'FHOT' || key === 'POINT_SPREAD' || key === 'POINTS_HANDICAP' || key === 'SPREAD' || key === 'BASKETBALL_HANDICAP') {
    const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
    const subject = handicapSubject(market, ctx, key);
    return inline ? { family: 'ASIAN_HANDICAP', period, lineKey: inline.lineKey, outcomes: inline.outcomes, ...(subject ? { subject } : {}) } : null;
  }
  // Goal totals (favbet/netbet style bundled keys + betano *GOT keys + FEG
  // *-0U/-02 totals) — line in name. Non-goal totals (corners, cards, points,
  // games) are deliberately absent from THIS list: they are routed by the guard
  // below, which resolves them under their own measured `subject` rather than
  // folding them in here as goals.
  // netbet's TOTAL_180S used to sit in this list; it is a darts 180 count, not
  // a scoring total, and is withheld with the other segment markets in 3c.
  if (key === 'TOTAL_GOALS' || key === 'TOTAL' || /^H?CTG$/i.test(key) || /^[HA]?T?GOT$/i.test(key) || /^OUH\d?$/i.test(key) || key === 'OVUN' || key === 'UFO:MTYP:00-0U' || key === 'UFO:MTYP:14-02' || key === 'UFO:MTYP:11-01' || key === 'UFO:MTYP:0C-03' || key === 'UFO:MTYP:35-01' || key === 'UFO:MTYP:02-06') {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (inline) return ouContract(inline, market, period, ctx);
  }

  // ---- 5b. Non-goal totals now RESOLVE, carrying their measured subject ----
  //
  // This branch used to return null for every one of these keys. The reason is
  // still exactly right and is preserved below: the OVER_UNDER contract was
  // (family, period, lineKey) and nothing in that tuple said what the line
  // counts, so a corners 8.5 landed in the same bucket as a goals 8.5 — two
  // markets that settle on entirely different events, and a cross-book
  // "arbitrage" that is arithmetic on one contract and priced from another.
  //
  // What changed is that the contract now HAS somewhere to put the answer. The
  // `subject` dimension resolves the collision at the key rather than refusing
  // the market, so OVER_UNDER/fulltime/8.5/corners/match and
  // OVER_UNDER/fulltime/8.5/goals/match are different buckets and each can only
  // ever pair with its own kind.
  //
  // Measured subjects, from the live-feed names (see `subjectFor`):
  //
  //   CNOU  "Cornere Peste/Sub"        corners
  //   TCOU  "Total cartonașe Peste/Sub" cards
  //   TSMF  "Total Hărți"              cards
  //   FTPO  "Total Puncte"             points
  //   FOUT  "Total Puncte"             points
  //   FTGO  "Game-uri"                 games
  //
  // TOTP, TSCR and TCOR are still refused. They sit in the old refusal regex
  // but no capture in `data/endpoints/` attributes a subject to them, and
  // guessing is the one thing this dimension must not do: an unmeasured key
  // filed under the wrong subject would pair two different products and
  // fabricate the exact arbitrage the refusal existed to prevent. They stay out
  // until a capture says what they count.
  //
  // The line still comes from the selection names, and the market NAME is
  // preferred over the key for the subject, because the name is the provider's
  // own text and a key id is a label this project would otherwise be guessing
  // at. `totalSubject` falls back to `goals` for a market whose subject nothing
  // proves, which is the pre-existing behaviour rather than a new default.
  if (/^(CNOU|TCOU|TSMF|FTPO|FOUT|FTGO|TOTAL_POINTS|TOTAL_GAMES|TOTP|TSCR|TCOR)$/.test(key)) {
    const subject = subjectFor(market);
    // No measured subject for this key: refuse, exactly as before.
    if (!subject) return null;
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (inline) return ouContract(inline, market, period, ctx);
    // A named non-goal total whose legs do not carry a legible line is not a
    // two-sided contract, and admitting it with a placeholder line would put it
    // in a bucket no real line occupies. Refuse rather than invent a line.
    return null;
  }

  // ---- 5c. A PER-TEAM goal total: same collision, now carried by `team` ----
  //
  // ufo:mtyp:00-10 "Echipa 1 Total goluri <line>" and ufo:mtyp:00-13 "Echipa 2
  // Total goluri <line>" are ONE TEAM's own goals, not the match margin. The
  // football vocabulary on this feed is closed — ten types, one name each — and
  // these two are the only per-team totals in it. The real match handicap is
  // 00-0b, whose legs carry the team names and which resolves correctly, so
  // nothing else in the football branch is affected.
  //
  // These were refused for the same reason as 5b and are now resolved for the
  // same reason: the difference between "the margin between two teams" and "the
  // goals of one team" is real, and it now has a dimension to live in. The
  // subject is still `goals` — it IS a goal count — so what separates them from
  // a match goals total is `team`, and a match total carries `team: 'match'`.
  // That is the whole collision: OVER_UNDER/fulltime/2.5/goals/match cannot meet
  // OVER_UNDER/fulltime/2.5/goals/away.
  //
  // The `kind: 'OU'` hint is load-bearing and must not be dropped. These legs
  // are bare signed numbers with no team token at all — "+ 4.5" and "- 4.5" —
  // and a signed pair is exactly the shape `classifyAndExtractLine` auto-detects
  // as a SPREAD. Measured 2026-10-02 on the live Fortuna feed, before the
  // refusal existed: 3 such markets across 763 football events, every one
  // agreeing with its id, resolving as ASIAN_HANDICAP -4.5/4.5 (twice) and
  // -2.5/2.5. Forcing OU keeps a team total out of the handicap family, and
  // `canonicalOutcomeFor` already reads "+" as over and "-" as under, which is
  // the correct reading of these two legs.
  //
  // A caveat that is NOT fixed here, so it is stated rather than implied: on the
  // live Fortuna feed these markets declare `period: 'unknown'`, and the engine
  // refuses any contract whose period it cannot name. So resolving them here is
  // necessary but not sufficient — the adapter that stamps `period` has to say
  // `fulltime` for these two ids, exactly as it already must for the rest of
  // the football branch. Until then they resolve correctly and are then dropped,
  // which is the safe order: correctly labelled, then not traded.
  if (key === 'UFO:MTYP:00-10' || key === 'UFO:MTYP:00-13') {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return {
      family: 'OVER_UNDER',
      period,
      lineKey: inline.lineKey,
      outcomes: ['over', 'under'],
      subject: 'goals',
      team: teamFor(market, ctx),
    };
  }

  // ---- 6. Generic line-in-name resolver (handles any 2-outcome market whose
  // names encode the line) ----
  // netbet / betano / FEG emittă o piață cu doar două selecții ale căror nume
  // codifică linia — "1 (-7.5) / 2 (7.5)", "+ 21.5 / - 21.5" etc. Categorisim
  // dacă forma perechii este O/U (magnitudini egale) sau AH (semn opus).
  // Rulează Şnainte de fallback-ul generic 2-way ca să nu fie umbrit de acesta.
  if (market.selections && market.selections.length === 2) {
    const inline = classifyAndExtractLine(market.selections);
    if (inline) {
      // This is the last-resort resolver, so it is also the last place a subject
      // can be unknown. It routes a totals pair the named branches above did not
      // claim, and it now attaches the same `subject`/`team` every other path
      // attaches — without that, this branch's contracts would bucket as `_::_`
      // while an identical market resolved two branches earlier bucketed as
      // `goals::match`, and the two would never pair.
      //
      // The ASIAN_HANDICAP half is left exactly as it was: a handicap carries a
      // line and a side, and this project's measured history with it is a long
      // record of false pairs (superbet 535, netbet's mirrored legs, betano's
      // player spreads). Widening that family is not part of this change.
      if (inline.family === 'OVER_UNDER') return ouContract(inline, market, period, ctx);
      const ahSub = handicapSubject(market, ctx, rawKey);
      return { family: inline.family, period, lineKey: inline.lineKey, outcomes: inline.outcomes, ...(ahSub ? { subject: ahSub } : {}) };
    }
  }

  // ---- 7. Generic 2-way match winner fallback ----
  // Two-name or 1|2 markets without O/U keywords resolve as MATCH_ODDS with
  // 2 outcomes. Skipped if the names look like totals or handicap, because
  // those have already been handled by the line-in-name fallback above.
  const twoWay = resolveTwoWayMatchWinner(rawKey, market);
  if (twoWay) return { ...twoWay, period };

  return null;
}

function hasTotalSides(market, contract) {
  if (!contract || market.selections?.length !== 2) return false;
  const outcomes = market.selections.map((s) => canonicalOutcomeFor(s.name, contract));
  return outcomes.includes('over') && outcomes.includes('under');
}

function encodedTotalContract(key, market, period, ctx) {
  const encoded = /^(?:(CORNERS|CARDS|POINTS|GAMES)_)?OVER_UNDER_(\d+)(?:_(\d+))?(_1H)?$/i.exec(key);
  if (!encoded) return null;
  const line = Number(`${encoded[2]}.${encoded[3] || '0'}`);
  if (!Number.isFinite(line) || line % 1 !== 0.5) return null;
  if (encoded[4]) {
    if (period !== 'fulltime' && period !== 'half1') return null;
    period = 'half1';
  }
  let altSubject = null;
  if (encoded[1]) {
    const s = encoded[1].toUpperCase();
    if (s === 'CORNERS') altSubject = 'corners';
    else if (s === 'CARDS') altSubject = 'cards';
    else if (s === 'POINTS') altSubject = 'points';
    else if (s === 'GAMES') altSubject = 'games';
  }
  const contract = ouContract({ lineKey: normalizeLine(line) }, market, period, ctx);
  if (!contract) return null;
  if (altSubject) contract.subject = altSubject;
  if (!hasTotalSides(market, contract)) return null;
  // The key supplies a missing line, never overrides contrary provider data.
  const declaredLines = [market.line, ...market.selections.flatMap((s) =>
    [s.handicap, extractLineFromName(String(s.name || ''))])];
  for (const value of declaredLines) {
    if (value === null || value === undefined) continue;
    if (String(value).trim() === '' || Number(value) !== line) return null;
  }
  return contract;
}

/**
 * FEG routing table. Keys are ufo:mtyp:XX-YY where XX is a sportId and YY is
 * the market type. Only `00` is football, and this function is reached for the
 * rest, so the sport map is load-bearing rather than a caption.
 *
 * Measured 2026-09-29 from the live FEG catalogue, the same map
 * `FEG_SPORT_NAMES` in scrapers/feg-common.mjs carries, which is fed by the
 * dealer's own `ufo:sprt:XX` records:
 *
 *   00 football  01 tennis  02 basketball  03 ice hockey
 *   04 handball  07 rugby   09 darts       11 futsal
 *
 * 26 and 27 also appear in the catalogue and have no friendly name, so they are
 * left as bare ids rather than guessed. The routing below is deliberately
 * per-sport-id and does not depend on what the sport is called: it reads the
 * market type and the leg names, which is what an unlabelled sport can still
 * prove. An earlier version of this comment named 02 as Counter-Strike and 04
 * as Dota 2 and called the whole range "eSports", which is how basketball
 * points totals ended up filed beside football goal totals in a report that
 * claimed to be about football.
 */
function fegRoute(rawKey, market, period = 'fulltime', ctx = {}) {
  const m = /^ufo:mtyp:([0-9a-z]{2})-([0-9a-z]{2})$/i.exec(rawKey);
  if (!m) return null;
  const sport = m[1].toLowerCase();
  const mtype = m[2].toLowerCase();

  const fegSport = (
    sport === '00' || sport === '0c' ? 'football' :
    sport === '01' ? 'tennis' :
    sport === '02' ? 'basketball' :
    sport === '03' ? 'ice-hockey' :
    sport === '04' ? 'handball' :
    sport === '07' ? 'rugby' :
    sport === '09' ? 'darts' :
    sport === '11' ? 'futsal' : null
  );
  const fegCtx = { ...ctx, ...(fegSport ? { sport: fegSport } : {}) };

  // Football 00-XX — already routed for the 1X2 / DC / totals / DNB cases via
  // the primary matchers above; only the sport-specific extras land here.
  if (sport === '00') {
    // 00-03 "Victorie fara egal" is draw-no-bet, handled in resolveContract as
    // DRAW_NO_BET (arbEligible:false). It must not resolve as a 2-way match
    // winner: its 1/2 sides are not exhaustive because a draw refunds.
    if (mtype === '03') return null;
    // 00-10 "Echipa 1 Total goluri" and 00-13 "Echipa 2 Total goluri" are ONE
    // TEAM's own goal total, not the match spread, and resolve to nothing —
    // see the authoritative refusal in resolveContract for the measurement and
    // for why a bare signed pair cannot be rescued by the generic resolver.
    // The real match handicap on this feed is 00-0b, whose legs carry the team
    // names; that one is routed above and is unaffected.
    if (mtype === '12') return twoWayFootball(); // To qualify
    return null;
  }

  // Every non-football sport FEG publishes. The routing does not branch on
  // which one it is: a two-outcome match winner is a two-outcome match winner
  // in darts as much as in handball, and the market type plus the leg names are
  // what prove it. Basketball and ice hockey are here — measured 2026-09-29,
  // 02-06 is a basketball points total and 03-03 an ice hockey handicap.
  if (sport === '01' || sport === '02' || sport === '03' || sport === '04' || sport === '09' || sport === '11' || sport === '14' || sport === '26' || sport === '27' || sport === '35') {
    if (mtype === '06' || mtype === '0u') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
      if (inline) return ouContract(inline, market, period, fegCtx);
    }
    if (mtype === '00' || mtype === '01' || mtype === '04' || mtype === '05' || mtype === '0u') {
      // 02-04, 04-05, 03-01, 04-01, 09-00, 11-0u, 14-00, 14-01, 27-01, 26-01, 35-XX
      const selNames = (market.selections || []).map((s) => String(s?.name || '').trim());
      // 14-01 carries a 3-way {1, X, 2}; treat as full MATCH_ODDS
      if (selNames.length === 3 || /^[12x]$/i.test(selNames.join(''))) {
        return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'draw', 'away'] };
      }
      return twoWayFootball(`${sport}-${mtype}`, ['1', '2']);
    }
    if (mtype === '02') {
      // total points / total rounds etc., line in name
      const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
      if (inline) return ouContract(inline, market, period, fegCtx);
    }
    if (mtype === '03') {
      // A name that says "Total" beats the key's default family for this slot.
      //
      // Measured 2026-10-05 on the live capture: `ufo:mtyp:03-03` is
      // "Total harti 4.5" and "Total harti 3.5" — CARDS totals on the ice
      // hockey feed — and the `kind: 'AH'` hint below routed both as
      // ASIAN_HANDICAP, because their legs are the signed pair `- 4.5` / `+ 4.5`
      // and a signed pair is exactly the shape a spread looks like. That is the
      // worst way to be wrong: a handicap is push-capable, so the inverse-sum
      // test books an "arbitrage" whose two legs can both push and refund.
      //
      // The rule is the one this file already applies everywhere else — the
      // market's own name is the provider's text, so when a key's family and the
      // name disagree, the name wins. It is deliberately narrow: only the word
      // "total", so a genuine `Harta 1. castigator` set-winner on the same feed
      // (ufo:mtyp:02-04 / 03-06) still resolves as a match winner.
      if (/\btotal(?![a-z0-9])/i.test(String(market.name || ''))) {
        const asTotal = classifyAndExtractLine(market.selections, { kind: 'OU' });
        if (asTotal) return ouContract(asTotal, market, period, fegCtx);
      }
      // handicap
      const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
      if (inline) return { family: 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: ['home', 'away'] };
    }
  }
  // 0c — a SECOND football market namespace on this feed, not American
  // football, which is what the comment here used to claim. Measured
  // 2026-09-29 on the Fortuna projection: 8 events carry `0c` markets and
  // none of them carries a `00` one, so this is not a duplicate spelling —
  // it is the only place some of these fixtures are quoted. The families are
  // football's own:
  //
  //   0c-00 "Meci"                          1/X/2, three-way match result
  //   0c-02 "Handicap" / "Handicap asiatic"  "1 -1.5" / "2 +1.5"
  //   0c-03 "Total goluri / ... asiatice"   "- 4.5" / "+ 4.5"
  //   0c-01 "Meci - sansa dubla"            1X / X2 / 12, not arbitrable
  //   0c-04 "prima repriza"                 1/X/2, first half
  //
  // Four of the eight sit in `esports-battle-liga-campionilor-2x4-min` and
  // friends, which quote real clubs with player aliases ("Real Madrid
  // (Krkula) v Atlético Madrid (llulle)"); the other four include a real
  // fixture, `turcia-super-lig / Basaksehir v Fenerbahce`. The esports ones
  // settle on a simulation, but their league slug is part of the event key,
  // so they can never be paired against another book's real football — and
  // nothing else publishes these leagues, so they simply sit unpaired.
  if (sport === '0c') {
    if (mtype === '02') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
      if (inline) return { family: 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: ['home', 'away'] };
    }
    if (mtype === '03') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
      if (inline) return ouContract(inline, market, period, fegCtx);
    }
  }
  return null;
}

function twoWayFootball() {
  // Helper for 1|2 markets with literal "1" "2" selection names. Returns a
  // 2-outcome MATCH_ODDS contract; the actual names are matched later in
  // isLiteralTwoWaySelectionSet.
  return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
}

/**
 * betano HTTP-only keys. These come from the betano-top-events-json feed and
 * use opaque abbreviations; sample names in comments. Most are O/U or AH at a
 * line encoded in the selection name; a few are 2-way match winners.
 */
function betanoKeyRoute(rawKey, market) {
  const key = rawKey; // case-sensitive: betano keys are usually UPPERCASE
  // 2-way match winners (player or team names): H2HT tennis winner, HTOH match
  // winner, HHTT table tennis winner, 4191 american-football match winner.
  if (key === 'H2HT' || key === 'HTOH' || key === 'HHTT' || key === '4191') {
    const selNames = (market.selections || []).map((s) => String(s?.name || '').trim());
    if (selNames.length === 2 && selNames.every((n) => n && n.length > 0)) {
      return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
    }
  }
  // Draw-No-Bet (DNOB) is draw-no-bet: 2-way, and a draw REFUNDS the stake, so
  // the pair is not jointly exhaustive. It is handled in resolveContract as
  // DRAW_NO_BET (arbEligible:false) and must never resolve here as a generic
  // 2-way match winner — a DNB "1" leg does not share a payoff with another
  // book's full-time result "1", so pairing them books an arbitrage that a draw
  // erases. Return null here so the family stays the single source of truth.
  if (key === 'DNOB') {
    return null;
  }
  // BTSC — BTTS yes/no with a slightly different spelling ("Da (GG)" / "Nu (NG)")
  if (key === 'BTSC') {
    if (isBttsSelectionSet(market.selections)) {
      return { family: 'BTTS', lineKey: '_', outcomes: ['yes', 'no'] };
    }
  }
  return null;
}

/**
 * Superbet's markets as read from the per-event detail payload, keyed by the
 * provider's own market id AND its exact market name. Both halves of the key
 * are load-bearing, and the adapter's comment on DETAIL_MARKETS carries the
 * measurement; the short version is that the same id names a different
 * contract depending on the fixture. 535 is "Total goluri <Team>" — a single
 * team's goals, not the match's — so an id-only table reads a team total as
 * the match total, and the OVER_UNDER contract has no subject dimension to
 * catch it.
 *
 * The line lives in the selection name ("Sub 2.5" / "Belgia (-1.5)"), so both
 * families resolve through the same line parser every other book uses, and the
 * half-line rule that keeps push-capable spreads out is applied there rather
 * than restated here.
 */
const SUPERBET_DETAIL = new Map([
  ['SB:200734:TOTAL GOLURI', 'OU'],
  ['SB:200735:PRIMA REPRIZĂ - TOTAL GOLURI', 'OU'],
  ['SB:200736:HANDICAP', 'AH'],
  ['SB:539:AMBELE ECHIPE MARCHEAZĂ (GG)', 'BTTS'],
  ['SB:562:PRIMA REPRIZĂ - 1X2', '1X2'],
  ['SB:560:A DOUA REPRIZĂ - 1X2', '1X2'],
  ['SB:200734:LICZBA GOLI', 'OU'],
  ['SB:200735:1.POŁOWA - LICZBA GOLI', 'OU'],
  ['SB:539:OBIE DRUŻYNY STRZELĄ', 'BTTS'],
]);

function superbetDetailRoute(key, market) {
  if (key.startsWith('SB:544:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'home' };
  }
  if (key.startsWith('SB:535:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'away' };
  }
  if (key.startsWith('SB:2529:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'home', period: 'half1' };
  }
  if (key.startsWith('SB:2531:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'away', period: 'half1' };
  }
  if (key.startsWith('SB:201506:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'home', period: 'half2' };
  }
  if (key.startsWith('SB:201507:')) {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (!inline) return null;
    return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: inline.outcomes, team: 'away', period: 'half2' };
  }
  const kind = SUPERBET_DETAIL.get(key);
  if (!kind) return null;
  if (kind === 'BTTS') {
    if (isBttsSelectionSet(market.selections)) {
      return { family: 'BTTS', lineKey: '_', outcomes: ['yes', 'no'] };
    }
    return null;
  }
  if (kind === '1X2') {
    if (isLiteral1x2SelectionSet(market.selections)) {
      return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'draw', 'away'] };
    }
    if (Array.isArray(market.selections) && market.selections.length === 3) {
      const norm = market.selections.map((s) => normalizeTeamName(s?.name));
      const hasDraw = norm.some((n) => /^(egal|egalitate|draw|x)$/i.test(n));
      if (hasDraw && new Set(norm).size === 3) {
        return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'draw', 'away'] };
      }
    }
    return null;
  }
  const inline = classifyAndExtractLine(market.selections, { kind });
  if (!inline) return null;
  return { family: kind === 'OU' ? 'OVER_UNDER' : 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: inline.outcomes };
}

/**
 * superbet numerics (and other books with opaque integer keys) route to a
 * 2-way match winner when their selections look like 1/2/winner pairs. The
 * numeric ID itself carries no semantic meaning — the SCAN is driven entirely
 * by the selection shape.
 */
function superbetNumericRoute(rawKey, market) {
  // Only attempt the fallback for opaque (numeric) keys. Named keys like
  // MATCH_ODDS / DOUBLE_CHANCE / etc. are handled earlier.
  if (!/^\d+$/.test(rawKey)) return null;
  const selNames = (market.selections || []).map((s) => String(s?.name || '').trim());
  if (selNames.length !== 2) return null;
  const norm = selNames.map((s) => s.toLowerCase());
  // Only treat as MATCH_ODDS if the names are clearly {1, 2}, {home, away}, or
  // two distinct team/player names. Bare letter codes (a/b/yes/no) and totals-
  // like words (over/under) are rejected — they're handled elsewhere.
  if (norm[0] === '1' && norm[1] === '2') {
    return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
  }
  if (/^home\b/i.test(norm[0]) && /^away\b/i.test(norm[1])) {
    return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
  }
  // two distinct non-empty names that don't contain peste/sub/over/under keywords
  if (norm[0] && norm[1] && norm[0] !== norm[1]) {
    const blob = norm.join(' | ');
    if (!/\b(peste|sub|over|under|ma(i|î)\s*mult|pu(t|ț)in|tot(c|ș)|handicap)\b/.test(blob)) {
      return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
    }
  }
  return null;
}

/**
 * Last-resort 2-way match winner: if a market has exactly 2 selections, both
 * look like distinct non-empty identifiers, and neither name contains a totals/
 * handicap keyword, treat it as a 2-way MATCH_ODDS.
 *
 * Strictness: we also reject obvious role labels ('home', 'away', 'yes', 'no',
 * '1', '2', 'x') and bare English numerals, because those shapes attach to a
 * wide variety of bookmaker-specific markets (price boosts, draw-no-bet
 * variants, qualifier markets) where a synthetic 2-way pairing could fabricate
 * an arb from unrelated sides.
 */
function resolveTwoWayMatchWinner(rawKey, market) {
  // Never admit Draw-No-Bet markets as 2-way match winners (draw refunds stake).
  if (/\b(?:draw\s*no\s*bet|victorie\s+f[aă]r[aă]\s+egal|niciun\s+pariu\s+pe\s+egal|f[aă]r[aă]\s+egal|pariu\s+f[aă]r[aă]\s+egal)\b/i.test(market.name || '')) return null;
  const selNames = (market.selections || []).map((s) => String(s?.name || '').trim());
  if (selNames.length !== 2) return null;
  if (selNames.some((n) => !n)) return null;
  if (selNames[0] === selNames[1]) return null;
  const norm = selNames.map((s) => s.toLowerCase());
  // Literal "1" + "2" or "Gazde" + "Oaspeti" — clean 2-outcome match winner regardless of the market
  // key. Captures superbet 919/521/759, netbet default "Castigator Meci",
  // current_frame_winner "Frame 1 Castigator", and FEG ufo:mtyp:*-02-00/04-01/etc.
  if ((norm[0] === '1' && norm[1] === '2') || (norm[0] === 'gazde' && (norm[1] === 'oaspeti' || norm[1] === 'oaspeți'))) {
    return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
  }
  if ((norm[0] === '2' && norm[1] === '1') || ((norm[0] === 'oaspeti' || norm[0] === 'oaspeți') && norm[1] === 'gazde')) {
    return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
  }
  // Reject role labels for everything else.
  const ROLE = /\b(home|away|yes|no|da|nu|gg|ng|draw|egal|remiz|home\s+team|away\s+team|host|guest|castigator|winner|final)\b/i;
  if (selNames.some((n) => ROLE.test(n))) return null;
  // Reject bare numerals and 1-3-letter words (would otherwise match lots of
  // role labels: "t1", "p1", "x", "f").
  if (selNames.some((n) => /^[-+\d.\s()]+$/.test(n) && n.length <= 5)) return null;
  if (selNames.some((n) => /^[a-z]{1,3}$/i.test(n))) return null;
  // Both names together must NOT contain a totals/handicap keyword.
  const blob = norm.join(' | ');
  if (/\b(peste|sub|over|under|ma(i|î)\s*mult|pu(t|ț)in|tot(c|ș)|handicap)\b/.test(blob)) return null;
  if (/\b(x|egal|draw|remiz)\b/.test(blob)) return null;
  return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
}

/**
 * Universal line extractor — reads the first signed-or-unsigned decimal in a
 * selection name. Used by netbet (game_handicap/goals_handicap/handicap with
 * line in name only), FEG (ufo:mtyp:00-10 "1 -0.5"), betano (TGHC, FAHC, OVUN).
 *
 * Disambiguation: the same regex extracts a line from both an O/U and an AH
 * selection. We classify by inspecting the pair:
 *   - Same magnitude on both sides          ’ OVER_UNDER family
 *   - Opposite sign on each side, equal mag ’ ASIAN_HANDICAP family
 *   - Both sides prefix "Peste/Sub/Over/Under" ’ OVER_UNDER even if signs differ
 *   - Both sides prefix "1/2" or a team name    ’ ASIAN_HANDICAP
 */
export function classifyAndExtractLine(selections, { kind } = {}) {
  if (!Array.isArray(selections) || selections.length !== 2) return null;
  const lines = selections.map((s) => extractLineFromName(String(s?.name || '')));
  if (lines.some((l) => l === null || l === undefined)) return null;
  const [a, b] = lines;
  const aMag = Math.abs(a), bMag = Math.abs(b);
  const blob = selections.map((s) => String(s?.name || '').toLowerCase()).join(' | ');
  const ouKeyword = /\b(peste|sub|over|under|total|ma(i|î)\s*mult|pu(t|ț)in|powyzej|powyżej|ponizej|poniżej)\b/;
  const ahKeyword = /^(?:[12]|h[12]|ah[12])\s*(\(|\.|-)?|^\s*[+-]\s*\d|\b(handicap|asiatic|asiatic[ăa]|spread)\b/i;
  const isHalf = (x) => x % 1 !== 0 && x * 2 === Math.round(x * 2);
  // The one place an AH lineKey is built, so the two orderings below cannot
  // drift apart.
  const ah = () => ({ family: 'ASIAN_HANDICAP', lineKey: handicapLineKey(selections, a, b), outcomes: ['home', 'away'] });
  // The one place an O/U lineKey is built, and it refuses a line that is not on
  // the half. A total on a whole or quarter line is NOT a two-sided contract:
  // at 2 goals, "Over 2.25" is half a push and "Under 2.25" is half a push, so
  // the pair leaves money on the table exactly when the match lands on the
  // line — and pricing it as exhaustive books a surebet that cannot be hedged.
  // The AH branch above already refused those; this one did not, and the
  // adapters that guard their own lines (unibet, everymatrix, nsoft, betano)
  // were carrying a rule the router then re-opened for anyone else. Measured
  // live: the Altenar feed publishes "Peste 2.25"/"Sub 2.25" under a shared key,
  // and the report listed it as an arbitrable line where the engine's
  // exhaustive-pair precondition does not hold. Half lines only.
  const ou = () => (isHalf(aMag)
    ? { family: 'OVER_UNDER', lineKey: normalizeLine(aMag), outcomes: ['over', 'under'] }
    : null);

  // Force the user's hint when present (used by tests / explicit routing).
  if (kind === 'OU') {
    if (aMag !== bMag) return null; // a /b with differing magnitudes is bogus
    return ou();
  }
  if (kind === 'AH') {
    return a === -b && isHalf(aMag) ? ah() : null;
  }

  // Auto-detect. AH/O-U keywords win when present.
  if (ouKeyword.test(blob)) {
    if (aMag !== bMag) return null;
    return ou();
  }
  if (ahKeyword.test(blob)) {
    return a === -b && isHalf(aMag) ? ah() : null;
  }
  // Fallback heuristic. The SIGN is tested before the magnitude, and the order
  // matters: a two-leg market whose lines are exact negations of each other is
  // a SPREAD however equal their magnitudes look, and a total's two legs sit at
  // the same value. Checking magnitude first read every spread as a total —
  // netbet's baseball `run_line` ("P. Phillies (1.5)" / "A. Braves (-1.5)",
  // the market the feed itself names "Handicap Puncte") resolved as
  // OVER_UNDER 1.5, which is a run total. A book quoting a real total at 1.5
  // on the same fixture would then have paired with it as a surebet between
  // two contracts that settle on different events entirely.
  // Zero is excluded from the spread branch: a === -b is true for 0/0 in JS,
  // and a 0/0 pair is neither a spread nor a meaningful total.
  if (a !== 0 && a === -b) return ah();
  if (aMag === bMag) return ou();
  return null;
}

/**
 * The bucket key for a two-way handicap, in home/away order rather than in
 * whatever order the provider happened to list the two legs.
 *
 * The lineKey is what two books are matched on, so it has to mean the same
 * thing on both sides of a comparison. Taking it from array position did not:
 * "1 -1.5"/"2 1.5" and "2 1.5"/"1 -1.5" are the same contract — the engine
 * already labels the sides by their "1"/"2" token, not by position — but the
 * positional reading gave them "-1.5/1.5" and "1.5/-1.5", so two books that
 * merely list the legs in the opposite order never paired, and a single book's
 * own mirrored markets landed in different buckets.
 *
 * When neither leg names a side (a bare "- 6.5"/"+ 6.5" spread), there is
 * nothing to order by and the line is kept as found rather than guessed at:
 * an unordered key that is at least stable for one provider beats a
 * confidently wrong one.
 */
function handicapLineKey(selections, a, b) {
  const isHome = (name) => {
    const s = String(name ?? '').trim();
    if (/^(?:1\b|h1\b|ah1\b|home\b|gazde\b)/i.test(s)) return true;
    if (/^(?:2\b|h2\b|ah2\b|away\b|oaspeti\b|oaspeți\b)/i.test(s)) return false;
    return null;
  };
  const first = isHome(selections[0]?.name);
  const second = isHome(selections[1]?.name);
  if (first === null || second === null || first === second) {
    // Neither leg carries a side token, so fall back to the SIGN.
    //
    // This is sound only for a provider that publishes ONE handicap per
    // magnitude, where the negative side is the home handicap by definition.
    // That is not universal, and getting it wrong is not a labelling nit: it
    // merges a line with its own reciprocal. Superbet publishes "Moldova (-1.5)
    // / Feroe (1.5)" AND "Moldova (1.5) / Feroe (-1.5)" as two markets, both
    // of which sort to "-1.5/1.5" here, so the bucket then held home -1.5 and
    // away -1.5 and the engine priced them as one contract. They pay on
    // opposite results and neither covers the other, so a real surebet is
    // booked on two legs that can both lose. Measured live: 33 of 33 reported
    // arbitrages on the first superbet deep capture were that artifact.
    //
    // Adapters whose legs name teams must therefore re-label them with a side
    // token before publishing ("1 (-1.5)" / "2 (1.5)"), which is the path
    // above and the shape every other adapter already emits. What is left here
    // is a bare spread that names nobody — casa-pariurilor's "+ 1.5" / "- 1.5"
    // and betano's "Karen Khachanov +2.5" style legs.
    //
    // The provider's leg order is deliberately not used. It used to be kept
    // here "rather than guess at" one, which was right for a bare spread and
    // wrong for a leg named after the player, which is betano's tennis TGHC
    // ("Karen Khachanov +2.5" / "Felix Auger Aliassime -2.5"): neither name
    // starts with a side token, so betano's own handicaps landed in TWO
    // buckets for one contract — "2.5/-2.5" on the events listing the home
    // player first, "-4.5/4.5" on the rest. A book quoting the same spread
    // could then pair with one of them and never the other. Measured on the
    // 2026-09-29 capture: 9 lineKeys for 9 distinct magnitudes, split 4/5
    // purely by leg order.
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo === -hi) return `${normalizeLine(lo)}/${normalizeLine(hi)}`;
    return `${normalizeLine(a)}/${normalizeLine(b)}`;
  }
  return first ? `${normalizeLine(a)}/${normalizeLine(b)}` : `${normalizeLine(b)}/${normalizeLine(a)}`;
}

function extractLineFromName(name) {
  if (!name) return null;
  const trimmed = name.replace(/\s+/g, ' ').trim();
  // Tokenize on ( — first segment is often a side label like "1" or "Home",
  // last segment (or sole) carries the line. Then look for any signed number.
  const matches = [];
  const regex = /([+-]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = regex.exec(trimmed)) !== null) {
    const raw = m[1];
    const num = Number(raw.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(num)) matches.push({ num, raw, idx: m.index });
  }
  if (matches.length === 0) return null;
  // Prefer signed numbers (those with explicit + or -) because "1 (-7.5)"
  // starts with an unsigned "1" before the real line. Failing that, prefer a
  // decimal. Otherwise take the last number (after the player/team name).
  const signed = matches.find((x) => /[+-]/.test(x.raw));
  if (signed) return signed.num;
  const decimal = matches.find((x) => x.raw.includes('.') || x.raw.includes(','));
  if (decimal) return decimal.num;
  return matches[matches.length - 1].num;
}

function normalizeLine(n) {
  // Always render with a dot decimal so 25 and 2.5 don't collide in line keys.
  const s = String(n);
  if (s.includes('.')) return s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/**
 * Deterministic bucket key for the arbitration engine. Period and line are
 * first-class so half-time BTTS can never pair with full-time BTTS and an
 * OVER 2.5 can never pair with OVER 3.5 — both are real prior bugs.
 */
export function bucketKeyForContract(eventKey, contract) {
  // The outcome set is part of the identity, not a detail of it. Family +
  // period + lineKey alone let two genuinely different products collide:
  // MATCH_ODDS resolves both to `MATCH_ODDS/fulltime/_` whether it came from a
  // 3-way 1X2 ([home, draw, away]) or a 2-way result market ([home, away]) —
  // netbet's `default`, FEG's `ufo:mtyp:00-05`. Measured on a live capture,
  // one event carrying both shapes threw
  // `TypeError: Cannot read properties of undefined (reading 'get')` on every
  // scan for two days: the first market to arrive seeded `bucket.choices` from
  // its own outcomes, and the second market's `draw` leg then indexed a map
  // that had no `draw` key. One thrown TypeError aborts the whole scan, so the
  // app published `dataHealth: "empty"` with zero opportunities while the
  // books were being scraped normally.
  //
  // It was not only a crash. Merged the other way round — 3-way first, 2-way
  // second — the 2-way legs landed in a bucket whose completeness test only
  // demanded [home, away], which is satisfied, so the engine would have priced
  // a two-leg "surebet" from a 3-way home win against a 2-way away selection
  // that pushes on a draw. Different settlement, guaranteed profit that cannot
  // be placed. Carrying the outcomes makes the two shapes distinct contracts
  // and closes both failures at the key.
  const outcomes = Array.isArray(contract.outcomes) ? contract.outcomes.join('+') : '';
  // subject and team are appended, never inserted. `test/favbet.test.mjs` reads
  // the LINE out of this key by index (`bucket.split('::')[2]`), so anything
  // added ahead of lineKey silently breaks that test's line assertions.
  // Appending keeps every existing consumer working unchanged.
  //
  // A family with no subject (MATCH_ODDS, BTTS, DOUBLE_CHANCE, DRAW_NO_BET)
  // normalises to `_` rather than the string "null", so the key stays readable
  // in `scripts/market-coverage.mjs` output and cannot be confused with a real
  // subject named "null".
  const subject = contract.subject || '_';
  const team = contract.team || '_';
  return `${eventKey}::${contract.family}::${contract.period}::${contract.lineKey}::${outcomes}::${subject}::${team}`;
}

/**
 * Canonical outcome label for the *family*, not the market. The legacy
 * canonicalOutcome only handled 1X2; the new router routes by family so
 * "Peste 2.5" reaches the totals resolver instead of being silently dropped.
 *
 * `ctx.homeTeam` / `ctx.awayTeam` are required for MATCH_ODDS when the
 * selection is a team / player name rather than the literal "1" / "2" / "X".
 */
export function canonicalOutcomeFor(selectionName, contract, ctx = {}) {
  if (!contract) return null;
  const raw = String(selectionName || '').trim();
  const lower = raw.toLowerCase();

  if (contract.family === 'MATCH_ODDS') {
    if (lower === '1' || lower === 'home' || lower === 'h' || lower === 'gazde') return 'home';
    if (lower === 'x' || lower === 'draw' || lower === 'egalitate' || lower === 'remiza' || lower === 'egal') return 'draw';
    if (lower === '2' || lower === 'away' || lower === 'a' || lower === 'oaspeti' || lower === 'oaspeți') return 'away';
    // 2-way match winner with team/player names: match against home/away from ctx.
    if (contract.outcomes.length === 2) {
      const home = normalizeTeamName(ctx.homeTeam || '');
      const away = normalizeTeamName(ctx.awayTeam || '');
      const stripped = raw.replace(/^\s*[12]\s*(?:[.)-]|\([^)]*\))?\s*/i, '');
      const normSel = normalizeTeamName(stripped);
      if (home && normSel && normSel === home) return 'home';
      if (away && normSel && normSel === away) return 'away';
      if (home && normSel && (home.includes(normSel) || normSel.includes(home))) return 'home';
      if (away && normSel && (away.includes(normSel) || normSel.includes(away))) return 'away';
    }
    // 3-way match winner with team names
    if (contract.outcomes.length === 3) {
      const home = normalizeTeamName(ctx.homeTeam || '');
      const away = normalizeTeamName(ctx.awayTeam || '');
      const stripped = raw.replace(/^\s*[12]\s*(?:[.)-]|\([^)]*\))?\s*/i, '');
      const normSel = normalizeTeamName(stripped);
      if (home && normSel && normSel === home) return 'home';
      if (away && normSel && normSel === away) return 'away';
      if (home && normSel && (home.includes(normSel) || normSel.includes(home))) return 'home';
      if (away && normSel && (away.includes(normSel) || normSel.includes(away))) return 'away';
    }
    return null;
  }

  if (contract.family === 'DOUBLE_CHANCE') {
    if (lower === '1x' || lower === '1 x') return 'home_or_draw';
    if (lower === 'x2' || lower === 'x 2') return 'draw_or_away';
    if (lower === '12' || lower === '1 2') return 'home_or_away';
    return null;
  }

  if (contract.family === 'DRAW_NO_BET') {
    if (lower === '1' || lower === 'home' || lower === 'h' || lower === 'gazde' || /^(?:1\b|1\s*\(|home\b|gazde\b)/.test(lower)) return 'home';
    if (lower === '2' || lower === 'away' || lower === 'a' || lower === 'oaspeti' || lower === 'oaspeți' || /^(?:2\b|2\s*\(|away\b|oaspeti\b|oaspeți\b)/.test(lower)) return 'away';
    const home = normalizeTeamName(ctx.homeTeam || '');
    const away = normalizeTeamName(ctx.awayTeam || '');
    const stripped = raw.replace(/^\s*[12]\s*(?:[.)-]|\([^)]*\))?\s*/i, '');
    const normSel = normalizeTeamName(stripped);
    if (home && normSel && normSel === home) return 'home';
    if (away && normSel && normSel === away) return 'away';
    if (home && normSel && (home.includes(normSel) || normSel.includes(home))) return 'home';
    if (away && normSel && (away.includes(normSel) || normSel.includes(away))) return 'away';
    return null;
  }

  if (contract.family === 'BTTS') {
    if (['yes', 'da', 'gg', 'y', 'da (gg)', 'gg', 'tak'].includes(lower)) return 'yes';
    if (['no', 'nu', 'ng', 'n', 'nu (ng)', 'ng', 'nie'].includes(lower)) return 'no';
    return null;
  }

  if (contract.family === 'OVER_UNDER') {
    // O/U family uses signed +/- as well as peste/sub/over/under text. Decode
    // signed selections: +X.X ’ over, -X.X ’ under, magnitude is in lineKey.
    // Matched against `lower`, not `raw`: these patterns are case-SENSITIVE and
    // the Romanian bookmakers that dominate this feed title the selection
    // "Peste 2.5" / "Sub 2.5" with a capital letter. Tested against `raw` they
    // never matched, so every Romanian O/U leg routed to null and the contract
    // resolved but could not be priced — the totals family was silently dead
    // for exactly the books that publish the most of them.
    const sign = /^\s*[+]\s*\d/.test(raw) ? '+' : /^\s*[-]\s*\d/.test(raw) ? '-' : null;
    if (sign === '+') return 'over';
    if (sign === '-') return 'under';
    if (/^(?:over|peste|mai mult|powyzej|powyżej)\b/.test(lower)) return 'over';
    if (/^(?:under|sub|putin|mai\s*(?:putin|pu[tț]in)|ponizej|poniżej)\b/.test(lower)) return 'under';
    // betano TGOT: P X.X = peste / over; S X.X = sub / under
    if (/^p\s/i.test(raw)) return 'over';
    if (/^s\s/i.test(raw)) return 'under';
    return null;
  }

  if (contract.family === 'ASIAN_HANDICAP') {
    // Selection is either "1 (-1.5)" / "2 (+1.5)", "H1 -1.5" / "H2 1.5",
    // "AH1 -1.5" / "AH2 1.5", "Gazde" / "Oaspeti", or a player prefix; the line
    // is in ctx — we just need to label home / away.
    if (/^(?:1\b|h1\b|ah1\b)/i.test(raw)) return 'home';
    if (/^(?:2\b|h2\b|ah2\b)/i.test(raw)) return 'away';
    if (/^(?:home|gazde)\b/i.test(raw)) return 'home';
    if (/^(?:away|oaspeti|oaspeți)\b/i.test(raw)) return 'away';
    const home = normalizeTeamName(ctx.homeTeam || '');
    const away = normalizeTeamName(ctx.awayTeam || '');
    // The line may LEAD the player name ("-1.5 Alcaraz") or TRAIL it. betano's
    // tennis TGHC ("Total Game-uri Handicap") publishes the trailing form —
    // "Karen Khachanov +2.5" / "Felix Auger Aliassime -2.5" — and stripping
    // only a leading line left "karen khachanov +2.5" to be compared against the
    // event's "karen khachanov", which never matches. The contract resolved
    // (the line is legible) and then priced no leg, so every tennis handicap on
    // the feed resolved into a bucket nothing could quote against. The trailing
    // strip only fires inside the ASIAN_HANDICAP family and only when a signed
    // number closes the name, so no totals or match-winner shape is affected.
    const stripped = raw
      .replace(/^[+-]\s*\d+(?:[.,]\d+)?\s*/, '')
      .replace(/^\d+(?:[.,]\d+)?\s+/, '')
      // Parenthesised line. Superbet's "Handicap" legs name the two teams and
      // put the spread in brackets — "Belgia (-1.5)" / "Turcia (1.5)" — and
      // every strip above left the bracket, so "belgia (-1.5)" was compared
      // against the event's "belgia" and never matched. The contract resolved
      // and then priced no leg, so all 158 measured handicap lines landed in
      // buckets nothing could quote against. Scoped to this family and to a
      // trailing bracketed number, which no player or team name ends with.
      .replace(/\s*[[(]\s*[+-]?\d+(?:[.,]\d+)?\s*[)]\s*$/, '')
      .replace(/\s*[+-]\s*\d+(?:[.,]\d+)?\s*$/, '');
    const normSel = normalizeTeamName(stripped);
    if (home && normSel && normSel === home) return 'home';
    if (away && normSel && normSel === away) return 'away';
    // Nothing but a signed line left — a bare spread. The sign is then the side,
    // which is what a handicap without team or player names means: the negative
    // leg is the home handicap. Measured live: casa-pariurilor's FEG feed
    // publishes ufo:mtyp:00-10 ("Echipa 1 Total goluri 1.5") as "+ 1.5" / "- 1.5"
    // and nothing else, so both candidates stripped to empty and neither leg
    // found a side. handicapLineKey already orders this shape by sign; labelling
    // it here by anything else would put the two halves of one contract out of
    // step with each other.
    //
    // This replaces a comment claiming the opposite — that for these signs "the
    // numeric sign doesn't tell us" and the side comes from the outcome index.
    // The keys it cited (ufo:02-06, 0c-02, 14-02) are TOTALS: they route to
    // OVER_UNDER above, where "+" is over and "-" is under, and they never reach
    // this branch. Here the family is ASIAN_HANDICAP and the sign does tell us.
    const bare = /^\s*([+-])\s*\d+(?:[.,]\d+)?\s*$/.exec(raw);
    if (bare) return bare[1] === '-' ? 'home' : 'away';
    return null;
  }

  return null;
}

// ---- Per-family set-shape helpers (test-and-resolve contract presence) ----

function isDoubleChanceSelectionSet(selections) {
  if (!Array.isArray(selections) || selections.length !== 3) return false;
  const norm = selections.map((s) => String(s?.name || '').trim().toLowerCase().replace(/\s+/g, ''));
  return norm.includes('1x') && norm.includes('x2') && norm.includes('12');
}

function isBttsSelectionSet(selections) {
  if (!Array.isArray(selections) || selections.length !== 2) return false;
  const norm = selections.map((s) => String(s?.name || '').trim().toLowerCase());
  // Verify each side carries a yes-marker or no-marker respectively, in any
  // of the spellings the books use (English / Romanian / single-letter
  // shorthand / "GG"/"NG" inline annotation).
  const hasYes = norm.some((n) => /\b(yes|da|gg|y|tak)\b/.test(n) || /^(yes|da|gg|y|tak)$/.test(n) || /\b(da|gg|tak)\b/i.test(n));
  const hasNo = norm.some((n) => /\b(no|nu|ng|n|nie)\b/.test(n) || /^(no|nu|ng|n|nie)$/.test(n) || /\b(nu|ng|nie)\b/i.test(n));
  return hasYes && hasNo && new Set(norm).size === 2;
}

