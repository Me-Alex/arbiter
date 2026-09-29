import { normalizeTeamName } from '../shared/text.mjs';

const DRAW_NAMES = new Set(['draw', 'x', 'd', 'egalitate', 'remiza']);
const HOME_NAMES = new Set(['home', 'h', '1', 'gazde']);
const AWAY_NAMES = new Set(['away', 'a', '2', 'oaspeti', 'oaspete']);

export function supportedContractForMarket(marketKey) {
  const key = String(marketKey || '').toUpperCase();
  if (key === 'MATCH_ODDS' || key === '1X2') {
    return { key: 'MATCH_ODDS', outcomes: ['home', 'draw', 'away'] };
  }
  const totals = key.match(/^OVER_UNDER_([0-9_]+)$/);
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
  return period === 'fulltime' || period === 'full time';
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
];

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
  allocated[0].stake = round2(allocated[0].stake + correction);

  const payouts = allocated.map((leg) => round2(leg.stake * leg.odds));
  const worstCasePayout = Math.min(...payouts);
  const guaranteedProfit = round2(worstCasePayout - total);
  // Rounding is observable disclosure, not a reason to hide a mathematically
  // valid arb. Preserve the theoretical ROI and expose the rounded worst case.
  const theoreticalProfit = total * (1 / inverseSum - 1);

  return {
    legs: allocated.map((leg, index) => ({ ...leg, payout: payouts[index], profit: guaranteedProfit })),
    inverseSum,
    totalStake: total,
    worstCasePayout,
    guaranteedProfit,
    roiPercent: round2((theoreticalProfit / total) * 100),
    roundingRisk: guaranteedProfit < 0,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ===========================================================================
// Generic contract resolver — every arbitration-eligible market resolves to
// exactly one of these. Period and line are first-class so cross-book pairs
// always agree on the SAME settlement window and line before prices are
// combined. (engine.mjs buckets by the resulting family+period+line key.)
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
  /\bprima\s*repriz[aă](?![a-z0-9])/i, /\brepriz[aă]\s*[1i](?![a-z0-9])/i, /\b[1i]\.?\s*repriz[aă](?![a-z0-9])/i,
  /\b1st\s*half\b/i, /\bfirst\s*half\b/i,
];
const SECOND_HALF_WORDS = [
  /\ba\s*doua\s*repriz[aă](?![a-z0-9])/i, /\brepriz[aă]\s*[2ii](?![a-z0-9])/i, /\b[2ii]\.?\s*repriz[aă](?![a-z0-9])/i,
  /\b2nd\s*half\b/i, /\bsecond\s*half\b/i,
];

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
export function canonicalPeriod(market = {}) {
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
    const name = String(market.name || '').trim();
    if (name) {
      if (FIRST_HALF_WORDS.some((re) => re.test(name))) return 'half1';
      if (SECOND_HALF_WORDS.some((re) => re.test(name))) return 'half2';
    }
    return 'fulltime';
  }
  const p = String(market?.period || '').trim().toLowerCase();
  if (p === 'half1' || p === '1st_half' || p === 'first_half' || /prima\s*repriza|^repriza\s*1\b|[12](st|nd)?\s*half/.test(p)) return 'half1';
  if (p === 'half2' || p === '2nd_half' || p === 'second_half' || /a\s*doua\s*repriza|^repriza\s*2\b|^[2]\s*repriza/.test(p)) return 'half2';
  return 'fulltime'; // safe default: prefer the most common emission
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
export function resolveContract(market = {}) {
  const rawKey = String(market.key || '');
  const key = rawKey.toUpperCase();
  const period = canonicalPeriod(market);

  // ---- 1. MATCH_ODDS (3-way: home/draw/away) ----
  if (key === 'MATCH_ODDS' || key === '1X2' || key === 'MRES') {
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
  if (key === 'DOUBLE_CHANCE' || key === 'DBLC') {
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
  if (key === 'BOTH_TEAMS_SCORE' || key === 'BTTS' || key === 'BTSC' || key === 'UFO:MTYP:00-1C') {
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
  if (key === 'DRAW_NO_BET' || key === 'DNOB' || key === 'DRAW_NO_BET_2WAY' || key === 'UFO:MTYP:00-03') {
    const sides = market.selections || [];
    if (sides.length === 2) {
      return { family: 'DRAW_NO_BET', period, lineKey: '_', outcomes: ['home', 'away'], arbEligible: false };
    }
  }

  // ---- 4. OVER/UNDER and ASIAN_HANDICAP via provider whitelists ----
  // FEG routing table — sport-prefix in XX selects the family, market-suffix in
  // YY names the contract shape. This covers ALL FEG markets across football,
  // eSports (CS / Dota), handball, MMA, chess, American football, etc.
  const feg = fegRoute(rawKey, market);
  if (feg) return { ...feg, period };

  // betano whitelisted keys: keys the betano adapter exposes with provider-
  // specific abbreviations. Most common shapes are O/U and AH at a line, a few
  // are 2-way match winners.
  const betanoRoute = betanoKeyRoute(rawKey, market);
  if (betanoRoute) return { ...betanoRoute, period };

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
    return declared ? { family: 'ASIAN_HANDICAP', period, lineKey: declared.lineKey, outcomes: declared.outcomes } : null;
  }
  if (key === 'GAME_HANDICAP' || key === 'GOALS_HANDICAP' || key === 'HANDICAP' || key === 'TGHC' || key === 'FAHC' || key === 'HCAP' || key === 'AHCP' || key === 'FHOT') {
    const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
    if (inline) return { family: 'ASIAN_HANDICAP', period, lineKey: inline.lineKey, outcomes: inline.outcomes };
  }
  // Goal totals (favbet/netbet style bundled keys + betano *GOT keys + FEG
  // *-0U/-02 totals) — line in name. Non-goal totals (corners, cards, points,
  // games) are deliberately absent: they are withheld by the guard below,
  // because the OVER_UNDER contract cannot express WHAT the line counts.
  if (key === 'TOTAL_GOALS' || key === 'TOTAL' || key === 'TOTAL_180S' || /^H?CTG$/i.test(key) || /^T?GOT$/i.test(key) || /^OUH\d?$/i.test(key) || key === 'OVUN' || key === 'UFO:MTYP:00-0U' || key === 'UFO:MTYP:14-02' || key === 'UFO:MTYP:11-01' || key === 'UFO:MTYP:0C-03' || key === 'UFO:MTYP:35-01' || key === 'UFO:MTYP:02-06') {
    const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
    if (inline) return { family: 'OVER_UNDER', period, lineKey: inline.lineKey, outcomes: ['over', 'under'] };
  }

  // ---- 5b. Non-goal totals are WITHHELD: the engine has no "what is counted"
  // dimension, so a corners or cards line would bucket with a goals line ----
  //
  // The OVER_UNDER contract is (family, period, lineKey) and nothing says what
  // the line counts. Betano publishes several totals that are NOT goals, and
  // measured on the live feed they are named distinctly:
  //
  //   CNOU  "Cornere Peste/Sub"        corners      -> was OVER_UNDER/8.5
  //   TCOU  "Total cartonașe Peste/Sub" cards       -> was OVER_UNDER/3.5
  //   TSMF  "Total Hărți"              cards       -> was OVER_UNDER/x
  //   FTPO  "Total Puncte"             points      -> was OVER_UNDER/41.5
  //   FOUT  "Total Puncte"             points      -> was OVER_UNDER/x
  //   FTGO  "Game-uri"                 games       -> was OVER_UNDER/x
  //
  // A corners 8.5 landing in OVER_UNDER/8.5 is the same bucket as another book's
  // goals 8.5 — two markets that settle on entirely different events. The engine
  // would pair them and report an arbitrage that is arithmetic on one contract
  // and priced from another. There is no cross-book counterparty for a corners
  // line that the engine can prove, so the honest move is to withhold it: the
  // same call made for Altenar's first-goal market and Unibet's player props.
  //
  // This guard is placed before every fallback on purpose. Returning null from
  // the whitelist above is NOT enough: "Peste 8.5"/"Sub 8.5" is a valid
  // equal-magnitude O/U shape, so the generic line-in-name resolver below would
  // immediately re-classify the same market as OVER_UNDER/8.5 and the withholding
  // would be a no-op. These keys are therefore authoritative: if a market
  // declares itself a non-goal total, it resolves to nothing and to nothing else.
  if (/^(CNOU|TCOU|TSMF|FTPO|FOUT|FTGO|TOTP|TSCR|TCOR)$/.test(key)) {
    return null;
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
      return { family: inline.family, period, lineKey: inline.lineKey, outcomes: inline.outcomes };
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

/**
 * FEG routing table. Keys are ufo:mtyp:XX-YY where XX is a sportId (00 football,
 * 02 Counter-Strike, 04 Dota 2, 0c American football, 11 handball, 14 MMA,
 * 27 chess) and YY is the market type. The doc and prior audit do not give an
 * authoritative key’sport map, so this is built from observed data; if a new
 * FEG-shape key appears, fall through to the generic 2-way or line-in-name
 * path.
 */
function fegRoute(rawKey, market) {
  const m = /^ufo:mtyp:([0-9a-z]{2})-([0-9a-z]{2})$/i.exec(rawKey);
  if (!m) return null;
  const sport = m[1].toLowerCase();
  const mtype = m[2].toLowerCase();

  // Football 00-XX — already routed for the 1X2 / DC / totals / DNB cases via
  // the primary matchers above; only the sport-specific extras land here.
  if (sport === '00') {
    // 00-03 "Victorie fara egal" is draw-no-bet, handled in resolveContract as
    // DRAW_NO_BET (arbEligible:false). It must not resolve as a 2-way match
    // winner: its 1/2 sides are not exhaustive because a draw refunds.
    if (mtype === '03') return null;
    if (mtype === '10' || mtype === '13') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
      if (inline) return { family: 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: ['home', 'away'] };
    }
    if (mtype === '12') return twoWayFootball(); // To qualify
    return null;
  }

  // eSports + similar — match winner (team-vs-team) ’ MATCH_ODDS 2-way
  if (sport === '02' || sport === '03' || sport === '04' || sport === '09' || sport === '11' || sport === '14' || sport === '26' || sport === '27' || sport === '35') {
    if (mtype === '06') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
      if (inline) return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: ['over', 'under'] };
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
      if (inline) return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: ['over', 'under'] };
    }
    if (mtype === '03') {
      // handicap
      const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
      if (inline) return { family: 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: ['home', 'away'] };
    }
  }
  // 0c American Football
  if (sport === '0c') {
    if (mtype === '02') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'AH' });
      if (inline) return { family: 'ASIAN_HANDICAP', lineKey: inline.lineKey, outcomes: ['home', 'away'] };
    }
    if (mtype === '03') {
      const inline = classifyAndExtractLine(market.selections, { kind: 'OU' });
      if (inline) return { family: 'OVER_UNDER', lineKey: inline.lineKey, outcomes: ['over', 'under'] };
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
  const selNames = (market.selections || []).map((s) => String(s?.name || '').trim());
  if (selNames.length !== 2) return null;
  if (selNames.some((n) => !n)) return null;
  if (selNames[0] === selNames[1]) return null;
  const norm = selNames.map((s) => s.toLowerCase());
  // Literal "1" + "2" — clean 2-outcome match winner regardless of the market
  // key. Captures superbet 919/521/759, netbet default "Castigator Meci",
  // current_frame_winner "Frame 1 Castigator", and FEG ufo:mtyp:*-02-00/04-01/etc.
  if (norm[0] === '1' && norm[1] === '2') {
    return { family: 'MATCH_ODDS', lineKey: '_', outcomes: ['home', 'away'] };
  }
  if (norm[0] === '2' && norm[1] === '1') {
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
  const ouKeyword = /\b(peste|sub|over|under|total|ma(i|î)\s*mult|pu(t|ț)in)\b/;
  const ahKeyword = /^[12]\s*(\(|\.|-)?|^\s*[+-]\s*\d|\b(handicap|asiatic|asiatic[ăa]|spread)\b/;
  const isHalf = (x) => x % 1 !== 0 && x * 2 === Math.round(x * 2);
  // The one place an AH lineKey is built, so the two orderings below cannot
  // drift apart.
  const ah = () => ({ family: 'ASIAN_HANDICAP', lineKey: handicapLineKey(selections, a, b), outcomes: ['home', 'away'] });

  // Force the user's hint when present (used by tests / explicit routing).
  if (kind === 'OU') {
    if (aMag === bMag) return { family: 'OVER_UNDER', lineKey: normalizeLine(aMag), outcomes: ['over', 'under'] };
    // Even with opposite signs, a /b with magnitudes that differ is bogus.
    return null;
  }
  if (kind === 'AH') {
    if (a === -b && isHalf(aMag)) return ah();
    return null;
  }

  // Auto-detect. AH/O-U keywords win when present.
  if (ouKeyword.test(blob)) {
    if (aMag === bMag) return { family: 'OVER_UNDER', lineKey: normalizeLine(aMag), outcomes: ['over', 'under'] };
    return null;
  }
  if (ahKeyword.test(blob)) {
    if (a === -b && isHalf(aMag)) return ah();
    return null;
  }
  // Fallback heuristic: same magnitude → O/U; opposite sign → AH.
  if (aMag === bMag) return { family: 'OVER_UNDER', lineKey: normalizeLine(aMag), outcomes: ['over', 'under'] };
  if (a === -b) return ah();
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
    if (/^1\b/.test(s) || /^home\b/i.test(s) || /^h1\b/i.test(s)) return true;
    if (/^2\b/.test(s) || /^away\b/i.test(s) || /^h2\b/i.test(s)) return false;
    return null;
  };
  const first = isHome(selections[0]?.name);
  const second = isHome(selections[1]?.name);
  if (first === null || second === null || first === second) {
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
  return `${eventKey}::${contract.family}::${contract.period}::${contract.lineKey}`;
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
    if (lower === '1' || lower === 'home' || lower === 'h') return 'home';
    if (lower === 'x' || lower === 'draw' || lower === 'egalitate' || lower === 'remiza') return 'draw';
    if (lower === '2' || lower === 'away' || lower === 'a') return 'away';
    // 2-way match winner with team/player names: match against home/away from ctx.
    if (contract.outcomes.length === 2) {
      const home = normalizeTeamName(ctx.homeTeam || '');
      const away = normalizeTeamName(ctx.awayTeam || '');
      const stripped = raw.replace(/^\s*[12]\s*(?:[.)-]|\([^)]*\))?\s*/i, '');
      const normSel = normalizeTeamName(stripped);
      if (home && normSel && normSel === home) return 'home';
      if (away && normSel && normSel === away) return 'away';
    }
    return null;
  }

  if (contract.family === 'DOUBLE_CHANCE') {
    if (lower === '1x' || lower === '1 x') return 'home_or_draw';
    if (lower === 'x2' || lower === 'x 2') return 'draw_or_away';
    if (lower === '12' || lower === '1 2') return 'home_or_away';
    return null;
  }

  if (contract.family === 'BTTS') {
    if (['yes', 'da', 'gg', 'y', 'da (gg)', 'gg'].includes(lower)) return 'yes';
    if (['no', 'nu', 'ng', 'n', 'nu (ng)', 'ng'].includes(lower)) return 'no';
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
    if (/^(?:over|peste|mai mult)\b/.test(lower)) return 'over';
    if (/^(?:under|sub|putin)\b/.test(lower)) return 'under';
    // betano TGOT: P X.X = peste / over; S X.X = sub / under
    if (/^p\s/i.test(raw)) return 'over';
    if (/^s\s/i.test(raw)) return 'under';
    return null;
  }

  if (contract.family === 'ASIAN_HANDICAP') {
    // Selection is either "1 (-1.5)" / "2 (+1.5)" or a player prefix; the line
    // is in ctx — we just need to label home / away.
    if (/^[12]\b/.test(raw)) return raw.startsWith('1') ? 'home' : 'away';
    if (/^home\b/i.test(raw)) return 'home';
    if (/^away\b/i.test(raw)) return 'away';
    const home = normalizeTeamName(ctx.homeTeam || '');
    const away = normalizeTeamName(ctx.awayTeam || '');
    const stripped = raw.replace(/^[+-]\s*\d+(?:[.,]\d+)?\s*/, '').replace(/^\d+(?:[.,]\d+)?\s+/, '');
    const normSel = normalizeTeamName(stripped);
    if (home && normSel && normSel === home) return 'home';
    if (away && normSel && normSel === away) return 'away';
    // For FEG ufo:02-06 / 0c-02 / 14-02 signs +/- -X.X and +X.X: the routing
    // layer assigns sides by player / team prefix. The numeric sign doesn't
    // tell us; if the name itself doesn't carry a side token we trust the
    // outcome index assigned in the engine.
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
  const hasYes = norm.some((n) => /\b(yes|da|gg|y)\b/.test(n) || /^(yes|da|gg|y)$/.test(n) || /\b(da|gg)\b/i.test(n));
  const hasNo = norm.some((n) => /\b(no|nu|ng|n)\b/.test(n) || /^(no|nu|ng|n)$/.test(n) || /\b(nu|ng)\b/i.test(n));
  return hasYes && hasNo && new Set(norm).size === 2;
}


// ---- Public per-family predicates (used by base.mjs + README + UI) ----

export function isDoubleChanceMarket(market = {}) {
  return resolveContract(market)?.family === 'DOUBLE_CHANCE';
}

export function isBttsMarket(market = {}) {
  return resolveContract(market)?.family === 'BTTS';
}

export function isAsianHandicapMarket(market = {}) {
  return resolveContract(market)?.family === 'ASIAN_HANDICAP';
}

