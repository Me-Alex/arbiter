import { eventIdentityKey, impliedProbability, teamsMatch, tokens } from '../shared/text.mjs';
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

/**
 * Which side of the book an in-play market belongs to.
 *
 * A live leg and a pre-match leg are different products, not two prices for the
 * same one: the live leg is a bet on the score as it stands, the pre-match leg is
 * a bet on the final result. Pairing them across books and dividing one by the
 * other produces an "arbitrage" that cannot be placed — the two bets do not
 * settle together. The FEG feed makes this concrete: it publishes LIVE and
 * PREMATCH markets side by side on the SAME fixture, so a single event object
 * carries both, and without this scope in the bucket key the engine would happily
 * pair the provider's own live 1X2 against another book's pre-match 1X2.
 *
 * Derived from `market.live`, which the adapters set from each provider's own
 * status field. An absent flag means pre-match, which is what every market was
 * before live collection existed, so the default cannot invent a live leg.
 */
function pairingScope(market) {
  return market?.live === true ? 'live' : 'prematch';
}

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
          // The pairing scope travels with the key for the same reason it travels
          // with the arbitrage bucket: a verification re-quote has to find the leg
          // it was priced against, and a live leg is not that leg.
          const key = `${eventKey}::${market.key}::${pairingScope(market)}::${String(selection.name).toLowerCase()}`;
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
 * True when two competition labels can stand for the same group.
 *
 * Both passes need this, and they must not disagree: if the loose pass were
 * allowed to treat two labels as compatible that the strict pass deliberately
 * separated, it would undo a decision that exists for a measured reason.
 *
 * The `a === b` arm is what makes two absent — or two identity-free, like "---"
 * — labels count as one label, and `leaguesMatch` alone returns false for those.
 * It is worth recording that no test can fail on it today: run the real capture
 * through groupByEvent with the arm removed and the output is identical, because
 * the loose pass reunites what the strict pass would have split. It is kept
 * because it is the strict pass's own contract, and relying on a later pass to
 * repair an earlier one is a coupling worth not having.
 */
function sameLeagueLabel(a, b) {
  return a === b || leaguesMatch(a, b);
}

/**
 * Coarse key for the loose pass: where to look, never a conclusion.
 *
 * It is a necessary condition and deliberately not a sufficient one. Two
 * tokens that are equal, or where a single letter prefixes the other, always
 * share their first letter and their position, so clubs that can match loosely
 * always land in the same bucket. That is what keeps the pass affordable —
 * 12 837 events would otherwise be compared pairwise. Insufficient on its own:
 * "Sporting L." and "Sporting Lisboa" share a bucket, and only the exact rule
 * below tells them apart.
 *
 * Both clubs go into the key, not just one, and no unit test can fail on the
 * away half: the exact rule compares both sides anyway, so a wider bucket cannot
 * produce a wrong merge, only more candidates. It is here because the candidates
 * are not free — on the capture kept in the repo, dropping the away mark takes
 * the exact rule from 81 598 comparisons to 1 038 118 and the largest bucket
 * from 67 clusters to 470.
 */
function looseBucket(identity) {
  const parts = identity.split('|');
  return [parts[0], parts[1], clubMark(parts[2]), clubMark(parts[3])].join('|');
}

function clubMark(club) {
  return tokens(club).map((token) => token[0]).join('');
}

/**
 * The loose comparison itself, on two identities already known to share a
 * bucket. Positions 0 and 1 are the sport and the day, equal by construction of
 * the bucket, so only the two clubs are left to compare.
 */
function sameLooseEvent(a, b) {
  const pa = a.split('|');
  const pb = b.split('|');
  return teamsMatch(pa[2], pb[2]) && teamsMatch(pa[3], pb[3]);
}

/**
 * Whether a set of competition labels is free of any pair the strict pass would
 * have kept apart.
 *
 * The check runs on the MERGED set, not on the two components being joined, and
 * that distinction is the whole point:
 *
 *  - compatibility is not transitive. A group is built by admitting an event
 *    whose label matches the first one, so it can already hold labels that do
 *    not match each other. Checking only across the join would inherit that.
 *  - merging is transitive too: A can join B on an initial and B can join C on
 *    another, so comparing only adjacent pairs lets a component end up holding
 *    "Cupa FA, Calificari" and "FA Cup" at once. The engine has no later stage
 *    that would catch that, so this pass does not get to create it.
 *
 * A consequence worth stating: a group that already carries a contradictory
 * pair of labels cannot be merged with anything, because every join would carry
 * the contradiction along. That is stricter than necessary, and deliberately so
 * — the cost is a merge, the alternative is a fixture that names two different
 * competitions in one row.
 *
 * This check is also what protects the competition split the strict pass made.
 * Two groups that share a base were split precisely because the first label of
 * one is not compatible with the first label of the other — the strict pass
 * opens no second group for a base until it has refused the label it was given —
 * so the union of their label sets always contains that refusing pair. No
 * separate "same base" guard is needed, and adding one would only restate it.
 *
 * @param {Iterable<string|null>} labels
 * @returns {boolean}
 */
function labelSetConsistent(labels) {
  const list = [...labels];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (!sameLeagueLabel(list[i], list[j])) return false;
    }
  }
  return true;
}

/**
 * Second pass: reunite groups that the exact key kept apart because one book
 * published an initial.
 *
 * It still has to agree on the competition, and it has to agree across the WHOLE
 * component rather than across the pair being joined — see labelSetConsistent,
 * which is also what keeps the competition split the strict pass made intact.
 * Merging "Liga Natiunilor A" with "Liga Natiunilor C" would invent an arbitrage
 * between two fixtures that are never played against each other, which is the
 * exact failure the league-free identity key is documented to risk.
 *
 * The surviving key is the earliest base in the component, so the bare key still
 * belongs to the group that was seen first and `#N` still numbers the splits
 * that hang below it.
 *
 * @param {Map<string, {identity: string, groups: Array}>} byBase
 * @returns {Array<{base: string, identity: string, events: Array}>}
 */
function mergeOnInitials(byBase) {
  const clusters = [];
  for (const [base, entry] of byBase) {
    for (const group of entry.groups) {
      clusters.push({
        base,
        identity: entry.identity,
        events: group.events,
        // The labels are the events' own, so a group that mixes two aliases of
        // one competition starts with both and is judged on both.
        leagues: new Set(group.events.map((e) => e.league ?? null)),
      });
    }
  }

  const parent = clusters.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const buckets = new Map();
  clusters.forEach((cluster, i) => {
    const key = looseBucket(cluster.identity);
    const bucket = buckets.get(key) || [];
    bucket.push(i);
    buckets.set(key, bucket);
  });

  for (const bucket of buckets.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a];
        const j = bucket[b];
        const ri = find(i);
        const rj = find(j);
        const keep = ri < rj ? ri : rj;
        const drop = ri < rj ? rj : ri;
        const labels = new Set([...clusters[keep].leagues, ...clusters[drop].leagues]);
        if (!labelSetConsistent(labels)) continue;
        if (!sameLooseEvent(clusters[i].identity, clusters[j].identity)) continue;
        parent[drop] = keep;
        clusters[keep].leagues = labels;
      }
    }
  }

  const out = [];
  for (let i = 0; i < clusters.length; i++) {
    if (find(i) !== i) continue;
    const head = clusters[i];
    for (let j = i + 1; j < clusters.length; j++) {
      if (find(j) === i) head.events = head.events.concat(clusters[j].events);
    }
    out.push(head);
  }
  return out;
}

/**
 * Group events by eventKey across all books.
 *
 * Two passes. The first is exact: events whose canonical identity is identical
 * land together, and are then split back apart by competition. The second is
 * loose, and only runs over what the first produced: groups whose club names
 * differ by an initial are reunited, so a book that publishes "Bayern M." is
 * not left describing a fixture no other book has. See teamsMatch for what a
 * single letter is allowed to stand for, and mergeOnInitials for what the merge
 * still has to agree on.
 *
 * @param {Array<{ sourceId: string, eventKey: string, markets: object[] }>} events
 * @returns {Map<string, Array>}
 */
export function groupByEvent(events) {
  // base key → the identity it was built from → groups split by competition
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
    const identity = eventIdentityKey(e);
    const base = identity || e.eventKey;
    let entry = byBase.get(base);
    if (!entry) {
      entry = { identity, groups: [] };
      byBase.set(base, entry);
    }
    const group = entry.groups.find((g) => sameLeagueLabel(g.league, e.league));
    if (group) group.events.push(e);
    else entry.groups.push({ league: e.league, events: [e] });
  }

  const bySurvivor = new Map();
  for (const cluster of mergeOnInitials(byBase)) {
    const siblings = bySurvivor.get(cluster.base);
    if (siblings) siblings.push(cluster);
    else bySurvivor.set(cluster.base, [cluster]);
  }

  const out = new Map();
  for (const [base, clusters] of bySurvivor) {
    clusters.forEach((cluster, i) => {
      // The first group keeps the bare base key, which is the value the
      // scrapers wrote into eventKey, so a leg can still be located in a
      // snapshot by that key. Only the additional splits get a suffix.
      out.set(i === 0 ? base : `${base}#${i}`, cluster.events);
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
        // Whether the contract came from the legacy opaque-key fallback below,
        // which is the ONE path that hardcodes period 'fulltime' instead of
        // deriving it. See the period gate a few lines down.
        //
        // Measured 2026-10-02: that branch is currently unreachable. Over every
        // key `supportedContractForMarket` can match, crossed with a three-way and
        // a two-way selection set and every declared period, it is never taken,
        // because `resolveContract` has already answered by then — MATCH_ODDS and
        // 1X2 resolve in section 1, and an OVER_UNDER_n key fails
        // `isLiteral1x2SelectionSet` for want of three legs. The gate below is
        // therefore insurance on a documented future risk rather than on a live
        // path, and `test/engine.test.mjs` pins the unreachability so that a
        // contract family added to `supportedContractForMarket` without being
        // added to `resolveContract` fails loudly instead of quietly re-opening
        // the one branch that cannot derive a period.
        let viaLegacyFallback = false;
        if (!contract) {
          const legacy = supportedContractForMarket(m.key, ev.sport);
          if (legacy && isMatchResultMarket(m)) {
            contract = { family: 'MATCH_ODDS', period: 'fulltime', lineKey: '_', outcomes: legacy.outcomes };
            viaLegacyFallback = true;
          }
        }
        if (!contract) continue;
        // The declared-period gate, and why it now applies to one path only.
        // Settlement-period gate. A RESOLVED contract already carries the period
        // `canonicalPeriod` derived for it, and that period is part of
        // `bucketKeyForContract`, so a first-half total is already isolated from
        // the full-time total of the same line by the key itself. Gating those
        // contracts on `market.period` as well threw away a priced market on the
        // strength of a field this codebase already documents as untrustworthy:
        // "A declared `fulltime` period is only as trustworthy as the adapter
        // that wrote it", and betano hardcodes `period: 'fulltime'` on every
        // market it emits.
        //
        // That made the gate discriminate on the one signal it should not have
        // used. Measured 2026-10-02 over all 24 books, 4746 grouped events and
        // 51737 football markets: betano declares fulltime on its first-half
        // goals totals, so those reached the engine as half1 contracts, while
        // unibet and the everymatrix pair declare `half1` and were dropped — the
        // same contract line, priced by three independent feeds, reachable from
        // one of them. market-coverage.mjs then reported
        // OVER_UNDER::half1::0.5/1.5/2.5 as betano-only while a gate-free count
        // of the same lines found betano, unibet and getsbet+contibet.
        //
        // Admitting them is safe by measurement, not by argument: of the 2051
        // markets this gate currently drops, every one resolves to half1 or
        // half2 and NONE resolves to fulltime, so nothing that disagrees with
        // its own declared period can be re-labelled as a full-time contract.
        // The declared values behind that count are 43757 fulltime, 4163
        // unknown, 2129 half1, 1047 half2 and 673 absent — the last two
        // categories are the ones that change, and both are self-describing.
        //
        // The legacy fallback is why the gate survives at all: it hardcodes
        // `period: 'fulltime'`, so a first-half 1/X/2 market that resolved
        // through it would be bucketed with a genuine full-time result. That
        // path keeps the declared-period check, and `isMatchResultMarket`
        // applies the name-based half check on top of it.
        if (viaLegacyFallback && !isFullTimeMarket(m)) continue;
        // A resolved contract whose period is not one this engine trades is
        // refused rather than bucketed. `canonicalPeriod` returns 'unknown' for a
        // declared period that is explicitly not full-time and that it cannot
        // name — 'firsthalf', 'ht', any future spelling — and the honest reading
        // of that is "a settlement window exists and I cannot identify it", not
        // "full-time, because that is the common case". Bucketing it as
        // full-time would pair it with a genuine full-time market on the same
        // line, which is the false arbitrage two tests exist to prevent; refusing
        // it costs nothing, because such a market has no counterparty this
        // engine could name.
        if (contract.period !== 'fulltime' && contract.period !== 'half1' && contract.period !== 'half2') continue;
        // Skip families whose outcomes aren't mutually exclusive — the inverse-
        // sum < 1 test on them would either silently miss or invent arbs.
        // DOUBLE_CHANCE (1X/12/X2) is recognized but excluded here.
        if (contract.arbEligible === false) continue;
        // Bucket by (event × family × period × line) so a half-time BTTS can
        // never pair with a full-time BTTS, and an OVER 2.5 with an OVER 3.5.
        // Both collisions were real prior bugs in ufo:mtyp:00-0u and any
        // multi-line bundled totals market.
        const bucketKey = `${bucketKeyForContract(eventKey, contract)}::${pairingScope(m)}`;
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
          // The bucket key now carries the outcome set, so this map is always
          // present. It is still checked: the cost of being wrong here is the
          // whole capture, because the exception propagates out of findArbitrage
          // and the scan publishes zero opportunities instead of a partial one.
          // One unrecognised market shape must cost one market, never the scan.
          if (!choices) continue;
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
              // Travels with the leg so a verification re-quote looks up the same
              // scope the price came from, and so the UI can mark a live signal.
              live: m.live === true,
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
      live: b.meta.market.live === true,
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
        const key = `${eventKey}::${m.key.split('_').slice(0, 2).join('_')}::${pairingScope(m)}`;
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
            live: m.live === true,
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
          // The bucket is scoped, so every leg is the same kind of bet and the
          // market that opened it names the scope honestly. Without this the UI
          // could show a live middle with no way to tell it from a pre-match one.
          live: b.meta.market.live === true,
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
          live: b.meta.market.live === true,
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
          const selKey = `${m.key}::${pairingScope(m)}::${String(s.name || '').toLowerCase().trim()}`;
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
        // The consensus is drawn from one scope only, so the signal inherits it.
        // An EV computed on in-play prices against other in-play prices is a
        // different claim from one computed on a pre-match consensus, and the
        // caller cannot tell them apart if this is left off.
        live: b.meta.market.live === true,
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
