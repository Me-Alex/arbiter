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
 * @property {Array<{sourceId:string, selection:string, odds:number, stake:number, payout:number}>} legs
 * @property {number} inverseSum
 * @property {number} marginPercent
 * @property {number} totalStake
 * @property {number} worstCasePayout
 * @property {number} guaranteedProfit
 * @property {boolean} roundingRisk
 * @property {boolean} live       the scope every leg in this plan was priced in
 *
 * Deliberately absent: `marketKey` and `bankroll`. Both were published and
 * nothing read them, and both were copies of a fact already on the wire.
 *
 *   - `marketKey` is the Map key this plan is filed under, and the router
 *     attaches a plan to a market *by* that key
 *     (`arbs.get(String(market.key))`). So the only object that can hold a plan
 *     is a market whose own `key` is that same string — measured on
 *     data-market-run/workspace: 3 plans, plan.marketKey === market.key in 3/3.
 *     Publishing it inside the value means a payload carries the same string
 *     twice, and the one inside can disagree with the key it was reached by.
 *   - `bankroll` was written as `allocation.totalStake`, the identical
 *     expression already published as `totalStake` one line up — 3/3 equal on
 *     the same capture. The bankroll an operator configured is an input to the
 *     allocation; what comes out is the stake actually deployed, and that is
 *     what `totalStake` already says. Same class as the flat `arbs` array the
 *     route used to republish: a second copy of a fact the first copy keeps.
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
      if (existing && existing.marginPercent >= allocation.marginPercent) continue;
      out.set(arb.marketKey, {
        family: arb.family,
        period: arb.period,
        line: arb.line ?? null,
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
        marginPercent: allocation.marginPercent,
        totalStake: allocation.totalStake,
        worstCasePayout: allocation.worstCasePayout,
        guaranteedProfit: allocation.guaranteedProfit,
        roundingRisk: allocation.roundingRisk,
      });
    }
  }
  return out;
}
