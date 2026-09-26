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
 * 1X2 contract when its period is full-time AND (its key is a known contract
 * OR it is an opaque key that really denotes the match result).
 */
export function isMatchResultMarket(m = {}) {
  if (!isFullTimeMarket(m)) return false;
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
