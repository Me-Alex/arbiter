import { eventIdentityKey, impliedProbability } from '../shared/text.mjs';
import { round2, round4 } from '../shared/math.mjs';
import {
  canonicalOutcome,
  supportedContractForMarket,
  isMatchResultMarket,
  isFullTimeMarket,
  resolveContract,
  canonicalOutcomeFor,
  bucketKeyForContract,
} from './market-contracts.mjs';
import { isSharedFeed } from './feed-groups.mjs';
import { leaguesMatch } from './league-aliases.mjs';

export function buildSelectionIndex(events) {
  const index = new Map();
  for (const [eventKey, instances] of groupByEvent(events)) {
    for (const event of instances) {
      for (const market of event.markets || []) {
        // The same guard findArbitrage uses, so a market that can produce a
        // candidate can also be re-priced during verification. Now family-
        // aware: BTTS / OVER_UNDER / ASIAN_HANDICAP legs index too, so a
        // verification re-quote can match a freshly scraped selection against
        // the original opportunity's leg. Restricting this to 1X2 in the past
        // caused every non-MATCH_ODDS opportunity (including all four BTTS
        // arbs found on 2026-09-28) to be rejected as "leg missing" even
        // though the price was alive on the book.
        const contract = resolveContract(market);
        if (!contract) continue;
        for (const selection of market.selections || []) {
          const key = `${eventKey}::${market.key}::${String(selection.name).toLowerCase()}`;
          const candidates = index.get(key) || [];
          candidates.push({ sourceId: event.sourceId, odds: Number(selection.odds), handicap: selection.handicap ?? null,
            kickoff: event.kickoff, providerEventId: event.providerEventId || event.id,
            marketId: market.id, selectionId: selection.id });
          index.set(key, candidates);
        }
      }
    }
  }
  return index;
}

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
  // base key → array of leagues seen for it → events
  const byBase = new Map();
  for (const e of events) {
    if (!e || !e.eventKey) continue;
    // The base key omits the league, so events differing only in competition
    // label land in the same bucket first. They are then split back apart
    // unless the two labels name the same competition, which keeps the two
    // failure modes apart: differently-named competitions still pair (so
    // cross-book arbitrage is detectable at all), and same-named competitions
    // in different groups never merge (so a fictional arbitrage cannot be
    // invented between two different fixtures).
    const base = eventIdentityKey(e) || e.eventKey;
    let groups = byBase.get(base);
    if (!groups) {
      groups = [];
      byBase.set(base, groups);
    }
    const group = groups.find((g) => g.league === e.league || leaguesMatch(g.league, e.league));
    if (group) group.events.push(e);
    else groups.push({ league: e.league, events: [e] });
  }

  const out = new Map();
  for (const [base, groups] of byBase) {
    groups.forEach((g, i) => {
      // The first group keeps the bare base key, which is the value the
      // scrapers wrote into eventKey, so a leg can still be located in a
      // snapshot by that key. Only the additional splits get a suffix.
      out.set(i === 0 ? base : `${base}#${i}`, g.events);
    });
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
        // Resolve to a structured contract. Falls back to the legacy MATCH_ODDS
        // guard for opaque provider keys whose selection set is literally
        // {1, X, 2}; those resolve through resolveContract as well, but kept
        // here as a defensive older path so a future contract family addition
        // can't silently drop 1X2 if its key isn't in the resolver.
        let contract = resolveContract(m);
        if (!contract) {
          const legacy = supportedContractForMarket(m.key, ev.sport);
          if (legacy && isMatchResultMarket(m)) {
            contract = { family: 'MATCH_ODDS', period: 'fulltime', lineKey: '_', outcomes: legacy.outcomes };
          }
        }
        if (!contract || !isFullTimeMarket(m)) continue;
        // Skip families whose outcomes aren't mutually exclusive — the inverse-
        // sum < 1 test on them would either silently miss or invent arbs.
        // DOUBLE_CHANCE (1X/12/X2) is recognized but excluded here.
        if (contract.arbEligible === false) continue;
        // Bucket by (event × family × period × line) so a half-time BTTS can
        // never pair with a full-time BTTS, and an OVER 2.5 with an OVER 3.5.
        // Both collisions were real prior bugs in ufo:mtyp:00-0u and any
        // multi-line bundled totals market.
        const bucketKey = bucketKeyForContract(eventKey, contract);
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
          bucket = {
            eventKey,
            marketKey: m.key,
            contract,
            choices: new Map(contract.outcomes.map((outcome) => [outcome, new Map()])), // outcome → best leg per source
            meta: { event: ev, market: m },
          };
          buckets.set(bucketKey, bucket);
        }
        for (const s of m.selections) {
          // Family-aware outcome routing with team context for 2-way markets
          // that name selections by player / team (superbet numerics, FEG
          // esports, betano H2HT/HTOH/HHTT). Falls back to legacy
          // canonicalOutcome for any shape the family router doesn't know.
          const outcome = canonicalOutcomeFor(s.name, contract, {
            homeTeam: ev.homeTeam,
            awayTeam: ev.awayTeam,
          }) ?? canonicalOutcome(s.name, {
            marketKey: m.key,
            homeTeam: ev.homeTeam,
            awayTeam: ev.awayTeam,
            handicap: s.handicap ?? null,
            sport: ev.sport,
          });
          if (!outcome || !contract.outcomes.includes(outcome)) continue;
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
              eventUrl: ev.sourceUrl || null,
              kickoff: ev.kickoff,
              providerEventId: ev.providerEventId || ev.id,
              marketId: m.id,
              selectionId: s.id,
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
      // An arbitrage needs legs that can disagree. Two brands resold from one
      // provider cannot: their prices are one feed, and any gap between the two
      // captured responses is a timing artifact, not an edge. See feed-groups.mjs.
      if (legs.some((leg) => legs.some((other) => isSharedFeed(leg.sourceId, other.sourceId)))) continue;
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
      family: b.contract.family,
      period: b.contract.period,
      line: b.contract.lineKey === '_' ? null : b.contract.lineKey,
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
            eventUrl: ev.sourceUrl || null,
          });
        }
      }
    }
  }

  for (const b of buckets.values()) {
    if (b.legs.length < 2) continue;

    // 1) Totals middles: Over line X vs Under line Y where Y > X
    const overLegs = b.legs.filter((l) => /^(?:over|peste)\b/i.test(l.selection));
    const underLegs = b.legs.filter((l) => /^(?:under|sub)\b/i.test(l.selection));
    for (const low of overLegs) {
      for (const high of underLegs) {
        // A middle needs two lines that can disagree. The two sides of one
        // bookmaker's own market are a single market, and two brands resold
        // from one provider are one feed — for getsbet/contibet the prices
        // differ, so a gap between them is a capture-timing artifact, not a
        // window. Same guard as findArbitrage and the +EV consensus.
        if (high.handicap <= low.handicap
            || high.sourceId === low.sourceId
            || isSharedFeed(high.sourceId, low.sourceId)) continue;
        const gap = high.handicap - low.handicap; // e.g., 3.5 - 2.5 = 1.0
        const stake = 100;
        const minPayout = Math.min(stake * low.odds, stake * high.odds);
        const worstCaseLoss = Math.max(0, (stake * 2) - minPayout);
        const gainIfBothWin = stake * (high.odds - 1) + stake * (low.odds - 1);
        const roiPercent = (gainIfBothWin / (stake * 2)) * 100;
        const riskPercent = (worstCaseLoss / (stake * 2)) * 100;
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

    // 2) Handicap point spread middles: negative vs positive handicap
    const sides = b.legs.filter((l) => l.handicap < 0);
    const others = b.legs.filter((l) => l.handicap > 0);
    for (const low of sides) {
      for (const high of others) {
        // Same guard as the totals branch: the two sides of one bookmaker's own
        // handicap market are not a middle, they are a single market, and two
        // brands off one shared feed cannot disagree.
        if (high.handicap <= low.handicap
            || high.sourceId === low.sourceId
            || isSharedFeed(high.sourceId, low.sourceId)) continue;
        const gap = high.handicap - low.handicap; // e.g., 3.0 - 2.5 = 0.5
        const stake = 100;
        const minPayout = Math.min(stake * low.odds, stake * high.odds);
        const worstCaseLoss = Math.max(0, (stake * 2) - minPayout);
        const gainIfBothWin = stake * (high.odds - 1) + stake * (low.odds - 1);
        const roiPercent = (gainIfBothWin / (stake * 2)) * 100;
        const riskPercent = (worstCaseLoss / (stake * 2)) * 100;
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
 * (median of the *other* books' implied probabilities for the same selection).
 *
 * The threshold is deliberately separate from the arbitrage `minRoiPercent`:
 * arbitrage at 0% is still worth reporting, but a leg priced exactly at the
 * consensus carries no edge, and with a 0% default every two-book market would
 * be reported back to the caller.
 *
 * @param {Map} grouped
 * @param {{ minEvPercent?: number }} [options]
 * @returns {Array<{
 *   type: 'positive_ev',
 *   eventKey, marketKey, selection, sourceId, odds,
 *   consensusProbability, evPercent,
 * }>}
 */
export function findPositiveEV(grouped, { minEvPercent = 2 } = {}) {
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
          b.legs.push({ sourceId: ev.sourceId, odds: s.odds, handicap: s.handicap ?? null, eventUrl: ev.sourceUrl || null });
        }
      }
    }
  }
  for (const b of buckets.values()) {
    if (b.legs.length < 2) continue;
    for (const l of b.legs) {
      // The consensus must be built from the *other* books. Including the leg
      // under test makes every leg at least as likely as the median that
      // contains it, so with the default minRoiPercent of 0 each market would
      // report its own legs back as non-negative EV. Brands sharing a feed are
      // excluded too: a consensus drawn from one provider's resold copies is not
      // an independent market view. See feed-groups.mjs.
      const probs = b.legs
        .filter((other) => other !== l && !isSharedFeed(l.sourceId, other.sourceId))
        .map((other) => impliedProbability(other.odds))
        .filter(Number.isFinite);
      if (probs.length < 1) continue;
      probs.sort((x, y) => x - y);
      const consensus = probs[Math.floor(probs.length / 2)];
      if (!Number.isFinite(consensus) || consensus <= 0) continue;
      const p = impliedProbability(l.odds);
      if (!Number.isFinite(p) || p <= 0) continue;
      const evProb = (l.odds * consensus) - 1;
      const evPercent = evProb * 100;
      // Strictly greater than the threshold: a leg priced exactly at the
      // consensus carries no edge, so it is not a positive-EV signal even
      // when the caller asks for a 0% threshold.
      if (evPercent <= minEvPercent) continue;
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
        // A missing or malformed odds makes the sum NaN, and NaN fails both
        // comparisons below — which would publish a low-hold signal with a
        // null hold. Drop the market instead of reporting garbage.
        if (m.selections.some((s) => !Number.isFinite(s && s.odds) || s.odds <= 1)) continue;
        const invSum = m.selections.reduce((acc, s) => acc + 1 / s.odds, 0);
        const holdPercent = (invSum - 1) * 100;
        if (!Number.isFinite(holdPercent)) continue;
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
