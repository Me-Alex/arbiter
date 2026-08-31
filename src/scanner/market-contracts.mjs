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

export function canonicalOutcome(selectionName, { homeTeam = '', awayTeam = '', marketKey = '' } = {}) {
  const contract = supportedContractForMarket(marketKey);
  if (!contract) return null;

  const raw = String(selectionName || '').trim();
  const normalized = normalizeTeamName(raw.replace(/^\s*[12x]\s*(?:[.)-]|\([^)]*\))?\s*/i, '')).replace(/\s+/g, ' ');
  const lower = raw.toLowerCase().trim();

  if (contract.key === 'MATCH_ODDS') {
    const home = normalizeTeamName(homeTeam);
    const away = normalizeTeamName(awayTeam);
    if (DRAW_NAMES.has(lower) || /^x\s*(?:\(|\.|$)/i.test(raw)) return 'draw';
    if (HOME_NAMES.has(lower) || /^1\s*(?:\(|\.|$)/i.test(raw) || (home && normalized === home)) return 'home';
    if (AWAY_NAMES.has(lower) || /^2\s*(?:\(|\.|$)/i.test(raw) || (away && normalized === away)) return 'away';
    return null;
  }

  if (contract.outcomes.includes('over') && /^(over|peste)\b/i.test(raw)) return 'over';
  if (contract.outcomes.includes('under') && /^(under|sub)\b/i.test(raw)) return 'under';
  return null;
}

export function isCompleteSupportedMarket({ marketKey, selections, homeTeam, awayTeam }) {
  const contract = supportedContractForMarket(marketKey);
  if (!contract || !Array.isArray(selections)) return null;

  const outcomes = new Map();
  for (const selection of selections) {
    const outcome = canonicalOutcome(selection?.name, { marketKey, homeTeam, awayTeam });
    if (!outcome || outcomes.has(outcome)) return null;
    outcomes.set(outcome, selection);
  }
  if (outcomes.size !== contract.outcomes.length || !contract.outcomes.every((outcome) => outcomes.has(outcome))) return null;
  return { contract, outcomes };
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
