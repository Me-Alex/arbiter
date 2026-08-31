/**
 * Allocate a bankroll across the legs of an opportunity.
 *
 * For arbitrage: stake_i = bankroll * (1/odds_i) / inverseSum (full-cover).
 * For middles: split 50/50 by default (refine when LLM-derived weights exist).
 *
 * Returns { legs: [{...leg, stake, payout, profit }], totalStake, guaranteedProfit, roiPercent }
 */
export function allocateBankroll(opportunity, bankroll) {
  const stake = Math.max(0, Number(bankroll) || 0);

  if (opportunity.type === 'arb' && Array.isArray(opportunity.legs)) {
    // Always recompute invSum from legs — it's safer than trusting a stored value.
    const inv = opportunity.legs.reduce((acc, l) => acc + 1 / l.odds, 0);
    if (!(inv > 0 && inv < 1)) {
      return {
        legs: opportunity.legs.map((l) => ({ ...l, stake: 0, payout: 0, profit: 0 })),
        totalStake: 0,
        guaranteedProfit: 0,
        roiPercent: 0,
      };
    }
    let totalStake = 0;
    const legs = opportunity.legs.map((leg) => {
      const s = stake * (1 / leg.odds) / inv;
      const payout = s * leg.odds;
      totalStake += s;
      return {
        ...leg,
        stake: round2(s),
        payout: round2(payout),
        profit: round2(payout - stake),
      };
    });
    return {
      legs,
      totalStake: round2(totalStake),
      guaranteedProfit: round2(stake * (1 / inv - 1)),
      roiPercent: round2((1 / inv - 1) * 100),
    };
  }

  if (opportunity.type === 'middle' && Array.isArray(opportunity.legs)) {
    const half = stake / 2;
    let totalStake = 0;
    const legs = opportunity.legs.map((leg) => {
      const payout = half * leg.odds;
      totalStake += half;
      return {
        ...leg,
        stake: round2(half),
        payout: round2(payout),
      };
    });
    return {
      legs,
      totalStake: round2(totalStake),
      guaranteedProfit: null,
      roiPercent: round2(opportunity.roiPercent || 0),
    };
  }

  if (opportunity.type === 'positive_ev') {
    // Kelly-style: stake = bankroll * (ev / (odds - 1)) capped at 5% bankroll.
    const ev = (opportunity.evPercent || 0) / 100;
    const o = opportunity.odds;
    const kelly = ev / (o - 1);
    const capped = Math.max(0, Math.min(0.05, Math.max(0, kelly)));
    const s = round2(stake * capped);
    return {
      legs: [{ ...opportunity, stake: s, payout: round2(s * o), profit: round2(s * (o - 1)) }],
      totalStake: s,
      guaranteedProfit: null,
      roiPercent: round2(opportunity.evPercent || 0),
    };
  }

  return {
    legs: (opportunity.legs || []).map((l) => ({ ...l, stake: 0, payout: 0 })),
    totalStake: 0,
    guaranteedProfit: 0,
    roiPercent: opportunity.roiPercent || 0,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
