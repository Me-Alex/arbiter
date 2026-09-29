// event-arbs.mjs — cross-book arbitrage for the event-detail view.
//
// The detail view used to show a per-book overround column labelled "Edge",
// which is NOT the arbitrage: an arbitrage comes from pairing complementary
// selections across two books, so the headline ROI on the dashboard could never
// be derived from anything the page displayed. This module produces the actual
// cross-book combination together with a fully reconciled money plan so the
// view can show stake / payout / guaranteed profit that genuinely add up.
//
// Detection deliberately reuses the scanner's own engine and contract
// machinery instead of re-deriving it here:
//   - findArbitrage()            cross-book pairing, inverse-sum test, and the
//                                shared-feed guard that stops two brands off one
//                                provider being sold as independent legs
//   - roundedArbitrageAllocation()  cent-rounded stakes/payouts and the global
//                                guaranteed profit, identical to the scanner
// Re-implementing either here would reopen the exact contract/line/feed-group
// bugs the scanner was hardened against, so this file only adapts output shape.

import { findArbitrage } from './engine.mjs';
import { roundedArbitrageAllocation } from './market-contracts.mjs';

/** Bankroll used to express the reconciled plan when the caller has no better idea. */
export const DETAIL_BANKROLL = 100;

/**
 * @typedef {object} DetailArb
 * @property {string} family     canonical contract family (BTTS, OVER_UNDER, …)
 * @property {string} period     settlement window the legs agree on
 * @property {string|null} line  canonical line, null for markets without one
 * @property {string} marketKey  the market key the combination was found in
 * @property {Array<{sourceId:string, selection:string, odds:number, stake:number, payout:number}>} legs
 * @property {number} inverseSum
 * @property {number} roiPercent
 * @property {number} totalStake
 * @property {number} worstCasePayout
 * @property {number} guaranteedProfit
 * @property {boolean} roundingRisk
 * @property {boolean} live       the scope every leg in this plan was priced in
 */

/**
 * Group one fixture's per-book instances and return the best arbitrage in each
 * market, keyed by market key.
 *
 * @param {Array<{sourceId:string, eventKey?:string, homeTeam?:string, awayTeam?:string,
 *   kickoff?:string, league?:string, markets:object[]}>} instances
 *   All books' copies of the SAME fixture. Each entry must carry `sourceId` and
 *   its own `markets`.
 * @param {{ bankroll?: number }} [opts]
 * @returns {Map<string, DetailArb>} market key -> reconciled arbitrage
 */
export function findDetailArbitrages(instances, opts = {}) {
  const out = new Map();
  if (!Array.isArray(instances) || instances.length < 2) return out;

  const bankroll = Number(opts.bankroll) > 0 ? Number(opts.bankroll) : DETAIL_BANKROLL;

  // findArbitrage buckets by eventKey, so the single fixture must be presented
  // under one stable key. Real eventKeys already are per fixture; synthesize a
  // deterministic one when a book omitted it.
  const grouped = new Map();
  for (const ev of instances) {
    if (!ev || !Array.isArray(ev.markets)) continue;
    const key = ev.eventKey
      || `${ev.homeTeam || ''}|${ev.awayTeam || ''}|${ev.kickoff || ''}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ev);
  }

  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    let found;
    try {
      found = findArbitrage(new Map([[group[0].eventKey || 'detail', group]]));
    } catch {
      // A malformed snapshot must not take the whole detail view down; the
      // live odds matrix below is still useful without a reconciled plan.
      continue;
    }

    // One best plan per market key: keep the highest ROI when a market somehow
    // yields several (different periods/lines) so the view stays unambiguous.
    for (const arb of found) {
      const allocation = roundedArbitrageAllocation(arb.legs, bankroll);
      if (!allocation) continue;
      const existing = out.get(arb.marketKey);
      if (existing && existing.roiPercent >= allocation.roiPercent) continue;
      out.set(arb.marketKey, {
        family: arb.family,
        period: arb.period,
        line: arb.line ?? null,
        marketKey: arb.marketKey,
        // Carried from the engine's own scope. findArbitrage already refuses to
        // pair a live leg with a pre-match one, so this is a single coherent
        // statement about every leg in the plan — and the view has to be able
        // to say out loud that a plan expires in 90 seconds.
        live: arb.live === true,
        legs: allocation.legs.map((leg) => ({
          sourceId: leg.sourceId,
          selection: leg.selection,
          odds: leg.odds,
          stake: leg.stake,
          payout: leg.payout,
          eventUrl: leg.eventUrl ?? null,
        })),
        inverseSum: allocation.inverseSum,
        roiPercent: allocation.roiPercent,
        totalStake: allocation.totalStake,
        worstCasePayout: allocation.worstCasePayout,
        guaranteedProfit: allocation.guaranteedProfit,
        roundingRisk: allocation.roundingRisk,
        bankroll: allocation.totalStake,
      });
    }
  }
  return out;
}
