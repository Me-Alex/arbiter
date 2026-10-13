import { round2, round4 } from '../shared/math.mjs';
import {
  resolveContract,
  canonicalOutcomeFor,
} from './market-contracts.mjs';
import { isSharedFeed } from './feed-groups.mjs';

/**
 * Default commission rate for Betfair Romania exchange (5%).
 */
export const DEFAULT_EXCHANGE_COMMISSION = 0.05;

/**
 * Calculates Back-to-Lay arbitrage metrics with exchange commission and liquidity clamping.
 *
 * In a Back-to-Lay trade:
 * - Back bet placed at a soft bookmaker at backOdds with backStake.
 * - Lay bet placed at the exchange at layOdds with layStake.
 * - Exchange charges commission `c` on net winnings.
 *
 * Optimal lay sizing to equalize profit across outcomes:
 *   layStake = (backStake * backOdds) / (layOdds - commission)
 *
 * Break-even back odds:
 *   breakEvenBackOdds = (layOdds - commission) / (1 - commission)
 *
 * @param {object} params
 * @param {number} params.backOdds
 * @param {number} params.layOdds
 * @param {number} [params.bankroll=100] Target back stake budget
 * @param {number} [params.commission=0.05] Exchange net commission rate (0 <= c < 1)
 * @param {number|null} [params.layLiquidity=null] Top-of-book available lay stake
 * @param {Array<{ price: number, size: number }>|null} [params.depth=null] Order book lay rungs
 * @returns {object|null}
 */
export function calculateBackToLay({
  backOdds,
  layOdds,
  bankroll = 100,
  commission = DEFAULT_EXCHANGE_COMMISSION,
  layLiquidity = null,
  depth = null,
} = {}) {
  const oBack = Number(backOdds);
  const oLay = Number(layOdds);
  const comm = Number.isFinite(Number(commission)) && Number(commission) >= 0 && Number(commission) < 1
    ? Number(commission)
    : DEFAULT_EXCHANGE_COMMISSION;
  const budget = Math.max(0, Number(bankroll) || 0);

  if (!Number.isFinite(oBack) || oBack <= 1 || !Number.isFinite(oLay) || oLay <= 1 || budget <= 0) {
    return null;
  }

  const breakEvenBackOdds = round4((oLay - comm) / (1 - comm));
  const rating = round4((oBack * (1 - comm)) / (oLay - comm));
  const marginPercent = round2((rating - 1) * 100);
  const isArb = rating > 1;

  // Unconstrained optimal sizing
  const targetBackStake = budget;
  const targetLayStake = round2((targetBackStake * oBack) / (oLay - comm));
  const targetLiability = round2(targetLayStake * (oLay - 1));
  const targetTotalCapital = round2(targetBackStake + targetLiability);
  const targetProfit = round2(targetBackStake * (rating - 1));

  // Liquidity clamping against top-of-book available liquidity
  const availLiquidity = Number.isFinite(Number(layLiquidity)) && Number(layLiquidity) > 0
    ? Number(layLiquidity)
    : null;

  let backStake = targetBackStake;
  let layStake = targetLayStake;
  let isLiquidityConstrained = false;
  let fillRate = 1;

  if (availLiquidity !== null && targetLayStake > availLiquidity) {
    isLiquidityConstrained = true;
    layStake = round2(availLiquidity);
    backStake = round2((layStake * (oLay - comm)) / oBack);
    fillRate = targetLayStake > 0 ? round4(layStake / targetLayStake) : 0;
  }

  const liability = round2(layStake * (oLay - 1));
  const totalCapital = round2(backStake + liability);

  // Settlement calculations
  const winGrossReturn = round2(backStake * oBack);
  const winPayout = round2(winGrossReturn - liability);
  const winProfit = round2(winPayout - backStake);

  const losePayout = round2(layStake * (1 - comm));
  const loseProfit = round2(losePayout - backStake);

  const guaranteedProfit = round2(Math.min(winProfit, loseProfit));
  const roiPercent = totalCapital > 0 ? round2((guaranteedProfit / totalCapital) * 100) : 0;

  // Multi-tier order book execution if depth rungs are provided
  let depthExecution = null;
  if (Array.isArray(depth) && depth.length > 0) {
    depthExecution = executeDepthBackToLay({
      backOdds: oBack,
      bankroll: budget,
      commission: comm,
      depth,
    });
  }

  return {
    rating,
    marginPercent,
    roiPercent,
    isArb,
    commission: comm,
    breakEvenBackOdds,

    // Target (unconstrained) metrics
    targetBackStake,
    targetLayStake,
    targetLiability,
    targetTotalCapital,
    targetProfit,

    // Executable / Clamped metrics
    backStake,
    layStake,
    liability,
    totalCapital,
    guaranteedProfit,
    winPayout,
    winProfit,
    losePayout,
    loseProfit,

    // Liquidity indicators
    isLiquidityConstrained,
    fillRate,
    availableLiquidity: availLiquidity,
    depthExecution,
  };
}

/**
 * Simulates multi-rung order book depth execution across multiple lay tiers.
 *
 * @param {object} params
 * @param {number} params.backOdds
 * @param {number} params.bankroll Target back stake budget
 * @param {number} [params.commission=0.05]
 * @param {Array<{ price: number, size: number }>} params.depth Lay rungs sorted ascending
 * @returns {object}
 */
export function executeDepthBackToLay({
  backOdds,
  bankroll,
  commission = DEFAULT_EXCHANGE_COMMISSION,
  depth = [],
} = {}) {
  const oBack = Number(backOdds);
  const comm = Number(commission);
  const targetBack = Math.max(0, Number(bankroll) || 0);

  if (!Number.isFinite(oBack) || oBack <= 1 || targetBack <= 0 || !Array.isArray(depth) || depth.length === 0) {
    return {
      filledBackStake: 0,
      filledLayStake: 0,
      effectiveLayOdds: 0,
      liability: 0,
      totalCapital: 0,
      guaranteedProfit: 0,
      roiPercent: 0,
      fillRate: 0,
      rungsUsed: [],
    };
  }

  let remainingBack = targetBack;
  let filledBackStake = 0;
  let filledLayStake = 0;
  let totalLiability = 0;
  let totalLosePayout = 0;
  const rungsUsed = [];

  for (const rung of depth) {
    if (remainingBack <= 0.005) break;
    const price = Number(rung.price);
    const size = Number(rung.size);
    if (!Number.isFinite(price) || price <= 1 || !Number.isFinite(size) || size <= 0) continue;

    // Check if this rung price is still profitable or break-even
    const maxBackForRung = (size * (price - comm)) / oBack;
    const backToTake = Math.min(remainingBack, maxBackForRung);
    const layToTake = (backToTake * oBack) / (price - comm);
    const rungLiability = layToTake * (price - 1);
    const rungLosePayout = layToTake * (1 - comm);

    filledBackStake += backToTake;
    filledLayStake += layToTake;
    totalLiability += rungLiability;
    totalLosePayout += rungLosePayout;
    remainingBack -= backToTake;

    rungsUsed.push({
      price,
      size,
      allocatedLayStake: round2(layToTake),
      allocatedBackStake: round2(backToTake),
      liability: round2(rungLiability),
    });
  }

  const backStake = round2(filledBackStake);
  const layStake = round2(filledLayStake);
  const liability = round2(totalLiability);
  const totalCapital = round2(backStake + liability);
  const effectiveLayOdds = layStake > 0 ? round4(liability / layStake + 1) : 0;

  const winGross = round2(backStake * oBack);
  const winPayout = round2(winGross - liability);
  const winProfit = round2(winPayout - backStake);

  const losePayout = round2(totalLosePayout);
  const loseProfit = round2(losePayout - backStake);

  const guaranteedProfit = round2(Math.min(winProfit, loseProfit));
  const roiPercent = totalCapital > 0 ? round2((guaranteedProfit / totalCapital) * 100) : 0;
  const fillRate = targetBack > 0 ? round4(backStake / targetBack) : 0;

  return {
    filledBackStake: backStake,
    filledLayStake: layStake,
    effectiveLayOdds,
    liability,
    totalCapital,
    guaranteedProfit,
    roiPercent,
    fillRate,
    rungsUsed,
  };
}

/**
 * Searches grouped event instances for Back-to-Lay arbitrage opportunities
 * pairing soft bookmaker back legs with exchange lay legs.
 *
 * @param {Map<string, object[]>} grouped Grouped event instances by eventKey
 * @param {object} [opts]
 * @param {number} [opts.commission=0.05]
 * @param {number} [opts.minMarginPercent=0]
 * @param {number} [opts.bankroll=100]
 * @returns {object[]} Array of Back-to-Lay opportunities
 */
export function findBackToLayArbitrage(grouped, {
  commission = DEFAULT_EXCHANGE_COMMISSION,
  minMarginPercent = 0,
  bankroll = 100,
} = {}) {
  const out = [];

  for (const [eventKey, instances] of grouped) {
    if (!Array.isArray(instances) || instances.length < 2) continue;

    // Separate exchange instances from soft bookmaker instances
    const exchangeInstances = [];
    const softInstances = [];

    for (const inst of instances) {
      const isExchange = inst.sourceId === 'betfair' || (inst.markets || []).some(
        (m) => (m.selections || []).some((s) => s.isExchange === true || (s.layOdds && s.layOdds > 1)),
      );
      if (isExchange) {
        exchangeInstances.push(inst);
      } else {
        softInstances.push(inst);
      }
    }

    if (exchangeInstances.length === 0 || softInstances.length === 0) continue;

    for (const exInst of exchangeInstances) {
      for (const exMarket of exInst.markets || []) {
        if (!exMarket || !Array.isArray(exMarket.selections)) continue;
        const exContract = resolveContract(exMarket, {
          homeTeam: exInst.homeTeam,
          awayTeam: exInst.awayTeam,
        });
        if (!exContract || exContract.arbEligible === false) continue;

        // Map exchange lay runners by canonical outcome
        const exLayByOutcome = new Map();
        for (const s of exMarket.selections) {
          const outcome = canonicalOutcomeFor(s.name, exContract, {
            homeTeam: exInst.homeTeam,
            awayTeam: exInst.awayTeam,
          });
          const layOdds = Number(s.layOdds ?? s.depth?.lay?.[0]?.price);
          if (outcome && Number.isFinite(layOdds) && layOdds > 1) {
            const layLiquidity = Number(s.depth?.lay?.[0]?.size ?? s.layLiquidity);
            exLayByOutcome.set(outcome, {
              selection: s,
              layOdds,
              layLiquidity: Number.isFinite(layLiquidity) ? layLiquidity : null,
              depth: s.depth?.lay || null,
            });
          }
        }

        if (exLayByOutcome.size === 0) continue;

        // Compare each soft bookmaker's back selection
        for (const softInst of softInstances) {
          if (isSharedFeed(softInst.sourceId, exInst.sourceId)) continue;

          for (const softMarket of softInst.markets || []) {
            if (!softMarket || !Array.isArray(softMarket.selections)) continue;
            // Pairing scope guard: in-play with in-play, prematch with prematch
            const softLive = softMarket.live === true;
            const exLive = exMarket.live === true;
            if (softLive !== exLive) continue;

            const softContract = resolveContract(softMarket, {
              homeTeam: softInst.homeTeam,
              awayTeam: softInst.awayTeam,
            });
            if (!softContract || softContract.arbEligible === false) continue;

            // Ensure identical contract bucket identity
            if (
              softContract.family !== exContract.family ||
              softContract.period !== exContract.period ||
              softContract.lineKey !== exContract.lineKey ||
              softContract.subject !== exContract.subject ||
              softContract.team !== exContract.team
            ) {
              continue;
            }

            for (const softSel of softMarket.selections) {
              const outcome = canonicalOutcomeFor(softSel.name, softContract, {
                homeTeam: softInst.homeTeam,
                awayTeam: softInst.awayTeam,
              });
              if (!outcome) continue;

              const exLay = exLayByOutcome.get(outcome);
              if (!exLay) continue;

              const backOdds = Number(softSel.odds);
              if (!Number.isFinite(backOdds) || backOdds <= 1) continue;

              const calc = calculateBackToLay({
                backOdds,
                layOdds: exLay.layOdds,
                bankroll,
                commission,
                layLiquidity: exLay.layLiquidity,
                depth: exLay.depth,
              });

              if (!calc || !calc.isArb || calc.marginPercent < minMarginPercent) continue;

              const opp = {
                type: 'back_to_lay',
                family: softContract.family,
                period: softContract.period,
                line: softContract.lineKey === '_' ? null : softContract.lineKey,
                eventKey,
                marketKey: softMarket.key,
                selection: softSel.name,
                outcome,
                live: softLive,
                sport: softInst.sport,
                league: softInst.league,
                kickoff: softInst.kickoff,
                homeTeam: softInst.homeTeam,
                awayTeam: softInst.awayTeam,
                rating: calc.rating,
                marginPercent: calc.marginPercent,
                roiPercent: calc.roiPercent,
                breakEvenBackOdds: calc.breakEvenBackOdds,
                commission: calc.commission,
                totalCapital: calc.totalCapital,
                guaranteedProfit: calc.guaranteedProfit,
                backLeg: {
                  sourceId: softInst.sourceId,
                  selection: softSel.name,
                  odds: backOdds,
                  stake: calc.backStake,
                  payout: calc.winPayout,
                  eventUrl: softInst.sourceUrl || null,
                  marketId: softMarket.id,
                  selectionId: softSel.id,
                },
                layLeg: {
                  sourceId: exInst.sourceId,
                  selection: exLay.selection.name,
                  odds: exLay.layOdds,
                  stake: calc.layStake,
                  liability: calc.liability,
                  availableLiquidity: calc.availableLiquidity,
                  fillRate: calc.fillRate,
                  isLiquidityConstrained: calc.isLiquidityConstrained,
                  marketId: exMarket.id,
                  selectionId: exLay.selection.id,
                },
              };

              if (softContract.subject && softContract.subject !== '_') opp.subject = softContract.subject;
              if (softContract.team && softContract.team !== '_') opp.team = softContract.team;
              if (calc.depthExecution) opp.depthExecution = calc.depthExecution;

              out.push(opp);
            }
          }
        }
      }
    }
  }

  return out;
}
