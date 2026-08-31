import { impliedProbability } from '../shared/text.mjs';
import { canonicalOutcome, supportedContractForMarket } from './market-contracts.mjs';

/**
 * engine.mjs — pure functions over the in-memory workspace events.
 *
 * Inputs come in as NormalizedEvent[] per bookmaker. The engine matches them
 * by eventKey, walks four signal classes (arb / middle / positive EV / low
 * hold), and emits a flat list of opportunities + meta.
 *
 * Every function here is referentially transparent. Same inputs → same output.
 */

export const SIGNAL_TYPES = Object.freeze({
  ARB: 'arb',
  MIDDLE: 'middle',
  POSITIVE_EV: 'positive_ev',
  LOW_HOLD: 'low_hold',
});

/**
 * Group events by eventKey across all books.
 *
 * @param {Array<{ sourceId: string, eventKey: string, markets: object[] }>} events
 * @returns {Map<string, Array>}
 */
export function groupByEvent(events) {
  const out = new Map();
  for (const e of events) {
    if (!e || !e.eventKey) continue;
    if (!out.has(e.eventKey)) out.set(e.eventKey, []);
    out.get(e.eventKey).push(e);
  }
  return out;
}

/**
 * For a given event, group its markets by canonical market key across books
 * so the engine can find opposing/equivalent legs.
 *
 * The marketKey in workspace data is a free-form string ("MATCH_ODDS",
 * "OVER_UNDER_25", "AH_HOME_-1.5", etc.). We expose all of them and let the
 * caller filter by what they want to scan.
 */
export function collectMarkets(grouped, marketKey) {
  const result = [];
  for (const [, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (m.key !== marketKey) continue;
        result.push({ event: ev, market: m });
      }
    }
  }
  return result;
}

/**
 * Arbitrage scan across all 3-way (or N-way) markets in the matched set.
 *
 * @returns {Array<{
 *   type: 'arb',
 *   eventKey: string,
 *   sport, league, kickoff, homeTeam, awayTeam,
 *   marketKey,
 *   legs: Array<{ sourceId, selection, odds, stake, payout, profit }>,
 *   inverseSum, roiPercent, profit,
 * }>}
 */
export function findArbitrage(grouped, { minRoiPercent = 0 } = {}) {
  const out = [];
  // Only model contracts whose outcomes are known to be mutually exclusive and complete.
  const buckets = new Map();
  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        const contract = supportedContractForMarket(m.key);
        if (!contract) continue;
        const key = `${eventKey}::${m.key}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            eventKey,
            marketKey: m.key,
            contract,
            choices: new Map(contract.outcomes.map((outcome) => [outcome, new Map()])), // outcome → best leg per source
            meta: { event: ev, market: m },
          };
          buckets.set(key, bucket);
        }
        for (const s of m.selections) {
          const outcome = canonicalOutcome(s.name, {
            marketKey: m.key,
            homeTeam: ev.homeTeam,
            awayTeam: ev.awayTeam,
          });
          if (!outcome) continue;
          const odds = Number(s.odds);
          if (!Number.isFinite(odds) || odds <= 1) continue;
          const choices = bucket.choices.get(outcome);
          const cur = choices.get(ev.sourceId);
          if (!cur || odds > cur.odds) {
            choices.set(ev.sourceId, {
              sourceId: ev.sourceId,
              selection: s.name,
              outcome,
              odds,
              handicap: s.handicap ?? null,
              marketKey: m.key,
              eventKey,
            });
          }
        }
      }
    }
  }
  for (const b of buckets.values()) {
    if (!b.contract.outcomes.every((outcome) => b.choices.get(outcome)?.size)) continue;
    const combinations = buildLegCombinations(b.contract.outcomes.map((outcome) => [...b.choices.get(outcome).values()]));
    let best = null;
    for (const legs of combinations) {
      if (new Set(legs.map((leg) => leg.sourceId)).size < 2) continue;
      const inverseSum = legs.reduce((acc, leg) => acc + 1 / leg.odds, 0);
      if (inverseSum >= 1) continue;
      const roiPercent = (1 / inverseSum - 1) * 100;
      if (roiPercent < minRoiPercent || (best && roiPercent <= best.roiPercent)) continue;
      best = { legs, inverseSum, roiPercent };
    }
    if (!best) continue;
    const ev = b.meta.event;
    out.push({
      type: SIGNAL_TYPES.ARB,
      eventKey: b.eventKey,
      marketKey: b.marketKey,
      sport: ev.sport,
      league: ev.league,
      kickoff: ev.kickoff,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      legs: best.legs,
      inverseSum: best.inverseSum,
      roiPercent: round2(best.roiPercent),
    });
  }
  return out;
}

/**
 * Middle scan: two opposing lines (over/under, handicap +/-, etc.) where the
 * gap in points (or the line value) creates a window where BOTH can win.
 *
 * Only scans totals markets ("OVER_UNDER_*", "TOTAL_*") and Asian handicaps
 * ("AH_*"). Spreads (single handicap, no opposing side) are skipped — that's
 * already covered by arb on the 3-way.
 */
export function findMiddles(grouped, {
  maxMiddleRiskPercent = 15,
  minMiddleRoiPercent = 20,
} = {}) {
  const out = [];
  const buckets = new Map();

  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        if (!looksLikeTotalsOrHandicap(m.key)) continue;
        const key = `${eventKey}::${m.key.split('_').slice(0, 2).join('_')}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { eventKey, marketKey: m.key, legs: [], meta: { event: ev, market: m } };
          buckets.set(key, bucket);
        }
        for (const s of m.selections) {
          if (s.handicap === null || s.handicap === undefined) continue;
          bucket.legs.push({
            sourceId: ev.sourceId,
            selection: s.name,
            odds: s.odds,
            handicap: Number(s.handicap),
            marketKey: m.key,
            eventKey,
          });
        }
      }
    }
  }

  for (const b of buckets.values()) {
    if (b.legs.length < 2) continue;
    const sides = b.legs.filter((l) => l.handicap < 0);
    const others = b.legs.filter((l) => l.handicap > 0);
    for (const low of sides) {
      for (const high of others) {
        if (high.handicap <= low.handicap) continue;
        const gap = high.handicap - low.handicap; // e.g., 3.0 - 2.5 = 0.5
        // Worst-case (one side pushes) loss vs best-case (both win) profit.
        const stake = 100; // normalize, real allocation is in bankroll-allocation
        const lossIfPush = stake; // one stake lost
        const gainIfBothWin = stake * (high.odds - 1) + stake * (low.odds - 1);
        const roiPercent = (gainIfBothWin / (stake * 2)) * 100;
        const riskPercent = (lossIfPush / (stake * 2)) * 100;
        if (riskPercent > maxMiddleRiskPercent) continue;
        if (roiPercent < minMiddleRoiPercent) continue;
        const ev = b.meta.event;
        out.push({
          type: SIGNAL_TYPES.MIDDLE,
          eventKey: b.eventKey,
          marketKey: b.marketKey,
          sport: ev.sport,
          league: ev.league,
          kickoff: ev.kickoff,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          legs: [low, high],
          gap,
          roiPercent: round2(roiPercent),
          riskPercent: round2(riskPercent),
        });
      }
    }
  }
  return out;
}

function looksLikeTotalsOrHandicap(key) {
  if (!key) return false;
  const k = key.toUpperCase();
  return k.startsWith('OVER_UNDER')
      || k.startsWith('TOTAL')
      || k.startsWith('AH_')
      || k.includes('HANDICAP');
}

/**
 * Positive EV scan: per-leg, implied probability vs the consensus probability
 * (median of all books' implied probabilities for the same selection).
 *
 * @returns {Array<{
 *   type: 'positive_ev',
 *   eventKey, marketKey, selection, sourceId, odds,
 *   consensusProbability, evPercent,
 * }>}
 */
export function findPositiveEV(grouped, { minRoiPercent = 0 } = {}) {
  const out = [];
  // Step 1: collect (eventKey, marketKey, selectionKey) → all legs across books.
  const buckets = new Map();
  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        for (const s of m.selections) {
          const selKey = `${m.key}::${String(s.name || '').toLowerCase().trim()}`;
          const k = `${eventKey}::${selKey}`;
          let b = buckets.get(k);
          if (!b) {
            b = { eventKey, marketKey: m.key, selection: s.name, legs: [], meta: { event: ev, market: m } };
            buckets.set(k, b);
          }
          b.legs.push({ sourceId: ev.sourceId, odds: s.odds, handicap: s.handicap ?? null });
        }
      }
    }
  }
  for (const b of buckets.values()) {
    if (b.legs.length < 2) continue;
    const probs = b.legs.map((l) => impliedProbability(l.odds)).filter(Number.isFinite);
    if (probs.length < 2) continue;
    probs.sort((x, y) => x - y);
    const consensus = probs[Math.floor(probs.length / 2)];
    if (!Number.isFinite(consensus) || consensus <= 0) continue;
    for (const l of b.legs) {
      const p = impliedProbability(l.odds);
      if (!Number.isFinite(p) || p <= 0) continue;
      const evProb = (l.odds * consensus) - 1;
      const evPercent = evProb * 100;
      if (evPercent < minRoiPercent) continue;
      out.push({
        type: SIGNAL_TYPES.POSITIVE_EV,
        eventKey: b.eventKey,
        marketKey: b.marketKey,
        selection: b.selection,
        sourceId: l.sourceId,
        odds: l.odds,
        consensusProbability: round4(consensus),
        evPercent: round2(evPercent),
      });
    }
  }
  return out;
}

/**
 * Low hold scan: per-market, the sum of inverse odds. If < 1 + threshold, the
 * bookmaker is offering an unusually thin margin. Informational only.
 */
export function findLowHold(grouped, { maxHoldPercent = 4 } = {}) {
  const out = [];
  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections) || m.selections.length < 2) continue;
        const invSum = m.selections.reduce((acc, s) => acc + 1 / s.odds, 0);
        const holdPercent = (invSum - 1) * 100;
        if (holdPercent > maxHoldPercent || holdPercent < 0) continue;
        out.push({
          type: SIGNAL_TYPES.LOW_HOLD,
          eventKey,
          marketKey: m.key,
          sourceId: ev.sourceId,
          selectionCount: m.selections.length,
          holdPercent: round2(holdPercent),
        });
      }
    }
  }
  return out;
}

function buildLegCombinations(optionGroups) {
  return optionGroups.reduce((combinations, options) =>
    combinations.flatMap((combination) => options.map((option) => [...combination, option])), [[]]);
}

export function buildSignalIndex(scan) {
  // Map (eventKey, marketKey, selection) → array of { sourceId, odds } legs
  // for verification lookups.
  const index = new Map();
  const consider = (opp) => {
    for (const leg of opp.legs || []) {
      const k = `${leg.eventKey || opp.eventKey}::${leg.marketKey || opp.marketKey}::${String(leg.selection || '').toLowerCase()}`;
      let arr = index.get(k);
      if (!arr) {
        arr = [];
        index.set(k, arr);
      }
      arr.push({ sourceId: leg.sourceId, odds: leg.odds });
    }
  };
  for (const o of scan.opportunities || []) for (const l of o.legs || []) consider({ ...o, legs: [l] });
  for (const m of scan.middles || []) for (const l of m.legs || []) consider({ ...m, legs: [l] });
  return index;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
