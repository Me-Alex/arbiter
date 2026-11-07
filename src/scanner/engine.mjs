import { eventIdentityKey, impliedProbability, teamsMatch, tokens } from '../shared/text.mjs';
import { round2, round4 } from '../shared/math.mjs';
import {
  canonicalOutcome,
  canonicalPeriod,
  supportedContractForMarket,
  isMatchResultMarket,
  isFullTimeMarket,
  resolveContract,
  canonicalOutcomeFor,
  bucketKeyForContract,
  subjectFor,
  teamFor,
  isTradablePeriod,
} from './market-contracts.mjs';
import { feedGroupOf, isSharedFeed } from './feed-groups.mjs';
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

/**
 * The team scope a row names, or null when it names none.
 *
 * A resolved contract reports `match` for the match total, and that is the
 * ABSENCE of a team scope rather than a scope of its own: `family` already says
 * the row is a total and `subject` says what it counts, so `team: 'match'` only
 * restates what the reader already has - and it would put the word "Match" in
 * front of every ordinary total in the frontend. Both builders publish the field
 * through here, so the arbitrage and middles families cannot come to mean
 * different things by the same name.
 *
 * Re-measured 2026-10-20 on the 105-snapshot capture (40,717 events): of
 * 109,044 OVER_UNDER contracts, 89,589 are match totals and 19,455 name a side
 * (9,963 home, 9,492 away), so the case this field exists for is real - though
 * no middle on that day's board carried one (all 33 published middles were
 * match totals). The "12 of the 51 middles name a side" figure this comment
 * used to quote predates the HCTG fix in market-contracts.mjs: HCTG resolved to
 * `home`, so the rows it counted were match totals wearing a team's name.
 *
 * @param {{team?: (string|null)}|null|undefined} contract
 * @returns {string|null}
 */
function namedTeam(contract) {
  const team = contract?.team;
  return team === 'home' || team === 'away' ? team : null;
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
        // The event's team context, because that is what findArbitrage
        // passes and this index has to resolve the market the SAME way or a
        // leg can be indexed in one scope and priced in another. Without it
        // `teamFor` cannot read a side off "Total individual Östers IF", and
        // since it now refuses a per-team total whose side it cannot name,
        // such a market would vanish from the index and every leg priced
        // from it would be reported as missing from the re-scrape.
        const contract = resolveContract(market, { homeTeam: event.homeTeam, awayTeam: event.awayTeam, sport: event.sport });
        if (!contract) continue;
        for (const selection of market.selections || []) {
          // The pairing scope travels with the key for the same reason it travels
          // with the arbitrage bucket: a verification re-quote has to find the leg
          // it was priced against, and a live leg is not that leg.
          const key = `${eventKey}::${market.key}::${pairingScope(market)}::${String(selection.name).toLowerCase()}`;
          const candidates = index.get(key) || [];
          candidates.push({ sourceId: event.sourceId, odds: Number(selection.odds), handicap: selection.handicap ?? null,
            kickoff: event.kickoff, providerEventId: event.providerEventId || event.id,
            marketId: market.id, selectionId: selection.id,
            // The scope this price belongs to, so verification can tell a
            // re-quote of the same bet from a re-quote of a different one.
            team: contract.team ?? null,
            subject: contract.subject ?? null,
            lineKey: contract.lineKey ?? null });
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

import {
  calculateBackToLay,
  executeDepthBackToLay,
  findBackToLayArbitrage,
  DEFAULT_EXCHANGE_COMMISSION,
} from './back-to-lay.mjs';

export {
  calculateBackToLay,
  executeDepthBackToLay,
  findBackToLayArbitrage,
  DEFAULT_EXCHANGE_COMMISSION,
};

export const SIGNAL_TYPES = Object.freeze({
  ARB: 'arb',
  MIDDLE: 'middle',
  POSITIVE_EV: 'positive_ev',
  LOW_HOLD: 'low_hold',
  BACK_TO_LAY: 'back_to_lay',
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
  return [parts[0], clubMark(parts[2]), clubMark(parts[3])].join('|');
}

// Measured three-hour offsets: Union Omaha/Charlotte across midnight in
// data-market-run, and FAS/Alianza in data/workspace. Do not widen to a day.
const KICKOFF_TOLERANCE_MS = 3 * 60 * 60 * 1000;
const knownCompetition = (label) => Boolean(label)
  && !/^(?:unknown|none|null|final|tournament\s*\d+|t?\s*\d+)$/i.test(String(label).trim());

function compatibleKickoffs(left, right, candidates) {
  const events = [...left, ...right];
  const times = events.map((e) => Date.parse(e.kickoff || e.startDate || ''));
  if (times.some((time) => !Number.isFinite(time))) return false;
  if (Math.max(...times) - Math.min(...times) > KICKOFF_TOLERANCE_MS) return false;
  if (new Set(times).size === 1) return true;
  // Time tolerance needs exact clubs AND an identified competition. Opaque
  // league ids can match at identical kickoff, but cannot justify a time shift.
  if (!events.every((e) => knownCompetition(e.league))) return false;
  const clubs = events.map((e) => eventIdentityKey(e).split('|').slice(2).join('|'));
  if (new Set(clubs).size !== 1) return false;
  // A book listing two separate fixtures is evidence of a rematch, not drift.
  const bySource = new Map();
  const nearby = candidates.filter((e) => {
    const time = Date.parse(e.kickoff || e.startDate || '');
    return times.some((t) => Math.abs(t - time) <= KICKOFF_TOLERANCE_MS)
      && eventIdentityKey(e).split('|').slice(2).join('|') === clubs[0]
      && events.every((other) => sameLeagueLabel(e.league, other.league));
  });
  for (const event of nearby) {
    if (!event.sourceId) continue;
    const id = event.providerEventId ?? event.id ?? event.eventKey;
    const previous = bySource.get(event.sourceId);
    if (previous !== undefined && previous !== id) return false;
    bySource.set(event.sourceId, id);
  }
  return true;
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
  const members = clusters.map((cluster) => cluster.events);
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
    const candidates = bucket.flatMap((i) => clusters[i].events);
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a];
        const j = bucket[b];
        const ri = find(i);
        const rj = find(j);
        if (ri === rj) continue;
        const keep = ri < rj ? ri : rj;
        const drop = ri < rj ? rj : ri;
        const labels = new Set([...clusters[keep].leagues, ...clusters[drop].leagues]);
        if (!labelSetConsistent(labels)) continue;
        if (!sameLooseEvent(clusters[i].identity, clusters[j].identity)) continue;
        if (!compatibleKickoffs(members[keep], members[drop], candidates)) continue;
        parent[drop] = keep;
        members[keep] = [...members[keep], ...members[drop]];
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
 *   inverseSum, marginPercent, profit,
 * }>}
 */
/**
 * Routes market selections to equivalent synthetic derivative buckets.
 * - Double Chance 1X <-> Asian Handicap +0.5 (Home) vs 3-Way Away / AH -0.5 (Away)
 * - Double Chance X2 <-> Asian Handicap +0.5 (Away) vs 3-Way Home / AH -0.5 (Home)
 * - Double Chance 12 vs 3-Way Draw
 * - Draw No Bet <-> Asian Handicap 0.0 (Home/Away, void on tie)
 */
function routeSyntheticDerivativeLegs(syntheticBuckets, eventKey, ev, m, contract, ah05Legs) {
  if (!contract || !m.selections || !Array.isArray(m.selections)) return;
  const subject = contract.subject || '_';
  if (subject !== '_' && subject !== 'goals') return;
  const period = contract.period || 'fulltime';
  if (period !== 'fulltime' && period !== 'half1' && period !== 'half2') return;
  const scope = pairingScope(m);

  const getLeg = (s, outcome, fromAh05 = false) => {
    const leg = {
      sourceId: ev.sourceId,
      selection: s.name,
      outcome,
      odds: Number(s.odds),
      handicap: s.handicap ?? null,
      marketKey: m.key,
      eventKey,
      live: m.live === true,
      eventUrl: ev.sourceUrl || null,
      kickoff: ev.kickoff,
      providerEventId: ev.providerEventId || ev.id,
      marketId: m.id,
      selectionId: s.id,
    };
    if (s.liquidity !== undefined && s.liquidity !== null) leg.liquidity = s.liquidity;
    if (s.depth) leg.depth = s.depth;
    if (s.isExchange) leg.isExchange = true;
    if (fromAh05 && ah05Legs) ah05Legs.add(leg);
    return leg;
  };

  const record = (synthType, outcomes, targetOutcome, s, fromAh05 = false) => {
    const odds = Number(s.odds);
    if (!Number.isFinite(odds) || odds <= 1) return;
    const bucketKey = `${eventKey}::SYNTHETIC::${synthType}::${period}::${scope}`;
    let b = syntheticBuckets.get(bucketKey);
    if (!b) {
      b = {
        eventKey,
        marketKey: `SYNTHETIC_${synthType}`,
        syntheticType: synthType,
        contract: {
          family: 'SYNTHETIC_EQUIVALENCE',
          period,
          lineKey: synthType,
          outcomes,
        },
        choices: new Map(outcomes.map((o) => [o, new Map()])),
        meta: { event: ev, market: m },
      };
      syntheticBuckets.set(bucketKey, b);
    }
    const choices = b.choices.get(targetOutcome);
    if (!choices) return;
    const cur = choices.get(ev.sourceId);
    const preferPlain1x2Tie = synthType === '1X2_AH05' && !fromAh05 && Boolean(cur && ah05Legs?.has(cur)) && odds === cur.odds;
    if (!cur || odds > cur.odds || preferPlain1x2Tie) {
      choices.set(ev.sourceId, getLeg(s, targetOutcome, fromAh05));
    }
  };

  // 1. DOUBLE_CHANCE: 1X, X2, 12
  if (contract.family === 'DOUBLE_CHANCE') {
    for (const s of m.selections) {
      const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
      if (oc === 'home_or_draw') {
        record('1X_VS_AWAY', ['home_or_draw', 'away'], 'home_or_draw', s);
      } else if (oc === 'draw_or_away') {
        record('X2_VS_HOME', ['draw_or_away', 'home'], 'draw_or_away', s);
      } else if (oc === 'home_or_away') {
        record('12_VS_DRAW', ['home_or_away', 'draw'], 'home_or_away', s);
      }
    }
  }

  // 2. MATCH_ODDS (3-way): home (1), draw (X), away (2)
  if (contract.family === 'MATCH_ODDS' && contract.outcomes?.length === 3) {
    for (const s of m.selections) {
      const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
      if (oc === 'away') {
        record('1X_VS_AWAY', ['home_or_draw', 'away'], 'away', s);
        record('1X2_AH05', ['home', 'draw', 'away'], 'away', s, false);
      } else if (oc === 'home') {
        record('X2_VS_HOME', ['draw_or_away', 'home'], 'home', s);
        record('1X2_AH05', ['home', 'draw', 'away'], 'home', s, false);
      } else if (oc === 'draw') {
        record('12_VS_DRAW', ['home_or_away', 'draw'], 'draw', s);
        record('1X2_AH05', ['home', 'draw', 'away'], 'draw', s, false);
      }
    }
  }

  // 3. ASIAN_HANDICAP
  if (contract.family === 'ASIAN_HANDICAP') {
    const lk = String(contract.lineKey || '').trim();
    if (lk === '0.5/-0.5') {
      for (const s of m.selections) {
        const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
        if (oc === 'home') {
          record('1X_VS_AWAY', ['home_or_draw', 'away'], 'home_or_draw', s);
        } else if (oc === 'away') {
          record('1X_VS_AWAY', ['home_or_draw', 'away'], 'away', s);
          record('1X2_AH05', ['home', 'draw', 'away'], 'away', s, true);
        }
      }
    } else if (lk === '-0.5/0.5') {
      // Home -0.5 / away +0.5, by the signature handicapLineKey builds. The
      // home side must win; the away side wins or draws. This branch reads SIDE
      // DIRECTION off the key, so the key has to know it. It did not while a
      // team-named pair was ordered by the numeric sign of its two lines: an
      // away -0.5 market sorted onto this key, so betano FAHC
      // ("CS Dinamo Bucuresti +0.5" / "Skanderborg Aarhus -0.5") booked the away
      // leg as `draw_or_away` - pricing a draw that leg loses. Paired against a
      // home moneyline it published a +69.74 "guaranteed" arbitrage whose two
      // legs BOTH lose on a draw. The resolver now places a named leg by team
      // identity, and the key this branch receives says which side holds the
      // line. Do not reintroduce a sign-ordered key here.
      for (const s of m.selections) {
        const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
        if (oc === 'home') {
          record('X2_VS_HOME', ['draw_or_away', 'home'], 'home', s);
          record('1X2_AH05', ['home', 'draw', 'away'], 'home', s, true);
        } else if (oc === 'away') {
          record('X2_VS_HOME', ['draw_or_away', 'home'], 'draw_or_away', s);
        }
      }
    } else if (lk === '0/0' || lk === '0' || lk === '0.0/0.0') {
      for (const s of m.selections) {
        const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
        if (oc === 'home') {
          record('DNB_AH0', ['home', 'away'], 'home', s);
        } else if (oc === 'away') {
          record('DNB_AH0', ['home', 'away'], 'away', s);
        }
      }
    }
  }

  // 4. DRAW_NO_BET
  if (contract.family === 'DRAW_NO_BET') {
    for (const s of m.selections) {
      const oc = canonicalOutcomeFor(s.name, contract, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
      if (oc === 'home') {
        record('DNB_AH0', ['home', 'away'], 'home', s);
      } else if (oc === 'away') {
        record('DNB_AH0', ['home', 'away'], 'away', s);
      }
    }
  }
}

export function findArbitrage(grouped, { minMarginPercent = 0, includeSynthetic = false } = {}) {
  const out = [];
  // Only model contracts whose outcomes are known to be mutually exclusive and complete.
  const buckets = new Map();
  const syntheticBuckets = new Map();
  const ah05Legs = new WeakSet();
  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        // Resolve to a structured contract. Falls back to the legacy MATCH_ODDS
        // guard for opaque provider keys whose selection set is literally
        // {1, X, 2}; those resolve through resolveContract as well, but kept
        // here as a defensive older path so a future contract family addition
        // can't silently drop 1X2 if its key isn't in the resolver.
        let contract = resolveContract(m, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, sport: ev.sport });
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
        if (!isTradablePeriod(contract.period)) continue;
        // Skip families whose outcomes aren't mutually exclusive — the inverse-
        // sum < 1 test on them would either silently miss or invent arbs.
        // DOUBLE_CHANCE (1X/12/X2) is recognized but excluded here.
        if (includeSynthetic && contract) {
          routeSyntheticDerivativeLegs(syntheticBuckets, eventKey, ev, m, contract, ah05Legs);
        }
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
            const leg = {
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
            };
            if (s.liquidity !== undefined && s.liquidity !== null) leg.liquidity = s.liquidity;
            if (s.depth) leg.depth = s.depth;
            if (s.isExchange) leg.isExchange = true;
            choices.set(ev.sourceId, leg);
          }
        }
      }
    }
  }
  const allBuckets = includeSynthetic ? [...buckets.values(), ...syntheticBuckets.values()] : [...buckets.values()];
  for (const b of allBuckets) {
    if (!b.contract.outcomes.every((outcome) => b.choices.get(outcome)?.size)) continue;
    const combinations = buildLegCombinations(b.contract.outcomes.map((outcome) => [...b.choices.get(outcome).values()]));
    let best = null;
    for (const legs of combinations) {
      if (new Set(legs.map((leg) => leg.sourceId)).size < 2) continue;
      if (b.syntheticType === '1X2_AH05' && !legs.some((leg) => ah05Legs.has(leg))) continue;
      // An arbitrage needs legs that can disagree. Two brands resold from one
      // provider cannot: their prices are one feed, and any gap between the two
      // captured responses is a timing artifact, not an edge. See feed-groups.mjs.
      if (legs.some((leg) => legs.some((other) => isSharedFeed(leg.sourceId, other.sourceId)))) continue;
      const inverseSum = legs.reduce((acc, leg) => acc + 1 / leg.odds, 0);
      if (inverseSum >= 1) continue;
      const marginPercent = (1 - inverseSum) * 100;
      if (marginPercent < minMarginPercent || (best && marginPercent <= best.marginPercent)) continue;
      best = { legs, inverseSum, marginPercent };
    }
    if (!best) continue;
    const ev = b.meta.event;
    const opp = {
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
      marginPercent: round2(best.marginPercent),
    };
    if (b.contract.subject && b.contract.subject !== '_') opp.subject = b.contract.subject;
    const named = namedTeam(b.contract);
    if (named) opp.team = named;
    if (b.syntheticType) {
      opp.synthetic = true;
      opp.syntheticType = b.syntheticType;
    }
    out.push(opp);
  }
  return out;
}

/**
 * The identity every over/under market is bucketed by, resolved rather than
 * spelled.
 *
 * `resolveContract` is the same call `findArbitrage` makes, so the two scans
 * now agree on which markets exist. A market that resolves contributes its own
 * family, period, subject and team; a market that resolves to another family -
 * an Asian handicap, a match result - is refused, which is what keeps a
 * push-capable spread out of a partition test that cannot see a push.
 *
 * A market the resolver refuses is admitted only when it is a clean two-sided
 * total whose line the resolver could not name. Most feeds carry the line in
 * the key or the selection name and the resolver reads both; a handful - betway,
 * betinia, campobet on a `TOTAL_GOALS` key - put it in `selection.handicap`
 * alone behind bare "Peste"/"Sub" labels. Those markets are real and this scan
 * priced them before the identity changed, so they keep their place, on the one
 * condition the resolver applies to an encoded key: every declared line must be
 * present and on the half. A whole or quarter line is push-capable - betinia's
 * `TOTAL_GOALS` at 2.25 is one - and the band a middle is priced from does not
 * survive a push, so those are refused rather than handed a family the engine
 * would then pair as if they could not push.
 *
 * @param {object} market
 * @param {object} event
 * @returns {{family:string,period:string,subject:(string|null),team:(string|null)}|null}
 */
function middleIdentity(market, event) {
  const ctx = { homeTeam: event.homeTeam, awayTeam: event.awayTeam, sport: event.sport };
  const contract = resolveContract(market, ctx);
  if (contract) {
    if (contract.family !== 'OVER_UNDER') return null;
    return {
      family: contract.family,
      period: contract.period,
      subject: contract.subject || null,
      team: contract.team || null,
      lineKey: contract.lineKey || null,
    };
  }
  let seen = 0;
  for (const s of market.selections) {
    const { side, line } = parseSelection(s?.name, s?.handicap);
    if (side !== 'over' && side !== 'under') return null;
    if (line === null || !isHalfLine(line)) return null;
    seen++;
  }
  if (!seen) return null;
  return {
    family: 'OVER_UNDER',
    period: canonicalPeriod(market),
    subject: subjectFor(market) || null,
    team: teamFor(market, ctx) || null,
  };
}

/**
 * A line a two-sided total can be quoted on without a push. Whole lines push on
 * the number and quarter lines half-push on it; either breaks the over/under
 * partition the middle scan prices from.
 */
function isHalfLine(n) {
  return Number.isFinite(n) && n % 1 !== 0 && Math.round(n * 2) === n * 2;
}

/**
 * Middle scan: two opposing lines where the gap between them opens a band of
 * results in which BOTH legs pay.
 *
 * Only the over/under shape is reported. Over L pays when the total clears L,
 * Under L' pays when it stays under L', so with L' > L the two conditions
 * partition the goal count: exactly one leg pays on every score outside the
 * band and both pay inside it. That partition is what makes the pair
 * priceable - at least one leg always returns, so a Dutch split is a genuine
 * guaranteed profit whenever 1/o1 + 1/o2 < 1.
 *
 * Asian handicaps are deliberately excluded, and the reason is a payoff one
 * rather than a naming one. "Home -1.5" and "Home -2.5" do have a both-win
 * band, but they are the same side of the same bet: both lose on a goalless
 * draw, so the pair is not a partition and the inverse-sum test does not
 * apply to it. An earlier version paired them anyway and, because the test
 * came out below 1 on 1,890 of them, stamped a guaranteed profit on rows where
 * both legs could lose. A middle that can lose everything is not an arb.
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
        // The bucket is the resolved contract, not the provider's key. The key
        // was the identity until now, as a two-word prefix, and it does not
        // survive a real capture: OVER_UNDER_2_5, TOTAL_GOALS, total_goals and
        // TOTAL are one bet under four spellings, and each spelling was its own
        // bucket, so a book writing one could only ever be paired with a book
        // writing the same one. Measured on a 105-book capture, canonicalising
        // that prefix took this scan from 2,050 rows to 10,628 and brought
        // unibet, netbet, superbet, betano, fortuna and casa-pariurilor onto a
        // board they had never appeared on. The contract also supplies the
        // period, which the prefix never carried: 9,099 half1 and 3,813 half2
        // totals shared buckets with the 73,703 full-time ones, so a first-half
        // total could be paired against a full-time total on the same line.
        const identity = middleIdentity(m, ev);
        if (!identity) continue;
        const key = `${eventKey}::${identity.family}::${identity.period}::${identity.subject || '_'}::${identity.team || '_'}::${pairingScope(m)}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { eventKey, marketKey: m.key, identity, legs: [], meta: { event: ev, market: m } };
          buckets.set(key, bucket);
        }
        for (const s of m.selections) {
          // The line does not reliably arrive in the `handicap` field. In a
          // full 28-book capture, 56,222 of the 76,130 selections in these
          // markets carry no handicap at all, because "Over 2.5" and "Sub 2.5"
          // keep the line in the name. Reading only the field discarded every
          // one of them and the totals branch produced nothing at all. The
          // name is read first and the field is the fallback, so an adapter
          // that does fill it in is still honoured.
          const fallbackLine = s.handicap ?? s.line ?? m.line ?? (identity.lineKey ? Number(identity.lineKey) : null);
          const { side, line } = parseSelection(s.name, fallbackLine);
          if (side !== 'over' && side !== 'under') continue;
          if (line === null || !isHalfLine(line)) continue;
          const odds = Number(s.odds);
          if (!Number.isFinite(odds) || odds <= 1) continue;
          bucket.legs.push({
            sourceId: ev.sourceId,
            selection: s.name,
            side,
            odds,
            handicap: line,
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

    // Collapse clone-feed resellers at the same (feedGroup, side, handicap) to
    // the single best-priced leg so a multi-brand Altenar/Digitain/Exalogic
    // cluster cannot multiply identical middle windows across clone brands.
    const dedupedByFeed = new Map();
    for (const leg of b.legs) {
      const feedKey = `${feedGroupOf(leg.sourceId) || leg.sourceId}::${leg.side}::${leg.handicap}`;
      const prev = dedupedByFeed.get(feedKey);
      if (!prev || leg.odds > prev.odds) {
        dedupedByFeed.set(feedKey, leg);
      }
    }
    const uniqueLegs = [...dedupedByFeed.values()];

    // Over line X against Under line Y where Y > X: the band between them is
    // the window in which both pay.
    const overLegs = uniqueLegs.filter((l) => l.side === 'over');
    const underLegs = uniqueLegs.filter((l) => l.side === 'under');
    for (const low of overLegs) {
      for (const high of underLegs) {
        // A middle needs two lines that can disagree. The two sides of one
        // bookmaker's own market are a single market, and two brands resold
        // from one provider are one feed - for getsbet/contibet the prices
        // differ, so a gap between them is a capture-timing artifact, not a
        // window. Same guard as findArbitrage and the +EV consensus.
        if (high.handicap <= low.handicap
            || high.sourceId === low.sourceId
            || isSharedFeed(high.sourceId, low.sourceId)) continue;
        const ev = b.meta.event;
        const signal = buildMiddleSignal(b, low, high, high.handicap - low.handicap, ev,
          { maxMiddleRiskPercent, minMiddleRoiPercent });
        if (!signal) continue;
        out.push(signal);
      }
    }
  }
  return out;
}

/**
 * Read a totals selection as the proposition it is about: which side, and the
 * line it is quoted at.
 *
 * Adapters spell the same two bets four ways - "Over 2.5", "Peste 2.5",
 * "Under 3.5", "Sub 3.5" - and the Romanian books use the second pair for
 * exactly the first pair's meaning. Grouping on the raw string therefore kept
 * an over leg and an under leg apart across books that were quoting the same
 * market, which is why the totals branch used to find so little.
 *
 * A name that is only a side ("1") keeps that side and takes its line from the
 * fallback, because stripping the number would leave nothing to pair on.
 *
 * @param {unknown} name selection name as the adapter published it
 * @param {number|null|undefined} fallbackLine the `handicap` field, if any
 * @returns {{ side: string, line: number|null }}
 */
function parseSelection(name, fallbackLine) {
  const raw = String(name ?? '').trim();
  if (!raw) return { side: '', line: null };

  // A parenthesised line is unambiguous: "2 (-1.5)" is the side 2 at -1.5.
  let m = /^(.*?)[\s(]*\(\s*([+-]?\d+(?:[.,]\d+)?)\s*\)\s*$/u.exec(raw);
  if (m && m[1].trim()) return { side: canonicalSide(m[1]), line: toLine(m[2]) };

  // The same idea without brackets: "Over 2.5" is over at 2.5. The side has
  // to survive the match or the branch would be lost for bare names.
  m = /^(.*?)\s+([+-]?\d+(?:[.,]\d+)?)\s*$/u.exec(raw);
  if (m && m[1].trim()) return { side: canonicalSide(m[1]), line: toLine(m[2]) };

  const fallback = Number(fallbackLine);
  return {
    side: canonicalSide(raw),
    line: Number.isFinite(fallback) ? fallback : null,
  };
}

/**
 * The two sides a totals market can be written with, collapsed onto one name
 * each. Anything that is not a totals side is returned lowercased and
 * unchanged, so an unfamiliar label still pairs with itself.
 *
 * @param {unknown} text
 * @returns {string}
 */
function canonicalSide(text) {
  const t = String(text).trim().toLowerCase().replace(/[\s.:,_-]+$/u, '').trim();
  if (/^(?:over|peste)$/u.test(t)) return 'over';
  if (/^(?:under|sub)$/u.test(t)) return 'under';
  return t;
}

/**
 * @param {unknown} text
 * @returns {number|null} the line, or null when it is not a number
 */
function toLine(text) {
  const n = Number(String(text).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
/**
 * Build one middle signal, deciding on the way whether the pair is also a
 * guaranteed arbitrage.
 *
 * A middle's two legs are an Over on the LOWER line and an Under on the HIGHER
 * line (or the mirror spread), so the result always lands in at least one of
 * them — below the low line only the Under wins, above the high line only the
 * Over wins, in between BOTH win. Because at least one leg is guaranteed to
 * pay, the pair is a true arbitrage whenever `1/oddsLow + 1/oddsHigh < 1`: split
 * the stake proportionally to 1/odds and every outcome returns more than it
 * cost, exactly as findArbitrage does for a same-line book.
 *
 * Measured on the 2026-10-05 capture: 1939 of 2486 middles satisfy that, so
 * the arbitrage was real and simply unreported. When it holds we stamp
 * `arb: true` alongside the market's own `inverseSum`, `marginPercent` and a
 * bankroll-independent `guaranteedProfit` (per 100 staked), and the pair is
 * admitted regardless of the speculative middle thresholds — a guaranteed
 * profit does not need to clear a middle ROI floor to be worth reporting.
 *
 * When the inverse sum is >= 1 the pair is NOT an arbitrage: outside the gap
 * window exactly one leg wins and the stake does not come back, so it stays a
 * plain middle with its speculative both-win ROI and even-stake risk, still
 * gated by the caller's thresholds.
 *
 * @param {object} b      the bucket (eventKey, marketKey, identity, meta.event)
 * @param {object} low    the lower-line leg (Over / negative spread)
 * @param {object} high   the higher-line leg (Under / positive spread)
 * @param {number} gap    high.handicap - low.handicap
 * @param {object} ev     b.meta.event
 * @param {{maxMiddleRiskPercent:number,minMiddleRoiPercent:number}} opts
 * @returns {object|null} the middle signal, or null when it clears neither gate
 */
function buildMiddleSignal(b, low, high, gap, ev, opts) {
  const { maxMiddleRiskPercent = 15, minMiddleRoiPercent = 20 } = opts || {};
  const stake = 100;
  const inverseSum = 1 / low.odds + 1 / high.odds;
  const isArb = inverseSum < 1;

  // Speculative middle economics (even stakes): the ROI if BOTH legs win, and
  // the worst-case loss if only one does. These describe the middle itself and
  // are reported whether or not the pair is also an arbitrage.
  const minPayout = Math.min(stake * low.odds, stake * high.odds);
  const worstCaseLoss = Math.max(0, (stake * 2) - minPayout);
  const gainIfBothWin = stake * (high.odds - 1) + stake * (low.odds - 1);
  const roiPercent = (gainIfBothWin / (stake * 2)) * 100;
  const riskPercent = (worstCaseLoss / (stake * 2)) * 100;

  // A guaranteed arbitrage bypasses the speculative middle gates: its profit
  // does not depend on the result landing inside the gap, so refusing it for
  // falling short of a middle ROI floor would be discarding a real surebet.
  if (!isArb) {
    if (riskPercent > maxMiddleRiskPercent) return null;
    if (roiPercent < minMiddleRoiPercent) return null;
  }

  const base = {
    type: SIGNAL_TYPES.MIDDLE,
    eventKey: b.eventKey,
    // The bucket's own resolved contract. The bucket spans every line of a
    // family (Over 2.5 and Over 3.5 share one), so `b.marketKey` is whichever
    // market happened to open it - reading a family off a provider key is how a
    // totals pair came to be filed under ASIAN_HANDICAP. Every market in a
    // bucket resolves to the same contract, so the row and its legs cannot
    // disagree about what was priced.
    family: b.identity.family,
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
  };

  // Subject and team travel with the row, exactly as the arbitrage builder
  // publishes them. The middles builder carried neither, so a team's own total
  // was titled as the match total and a home total could not be told from an
  // away one - each of those names the wrong bet to a trader. Re-measured
  // 2026-10-20: 19,455 of the 109,044 OVER_UNDER contracts on the capture name a
  // side (9,963 home, 9,492 away) and 89,589 are match totals, so this is the
  // case the field exists for - while the 33 middles published that day were
  // all match totals and publish no team at all.
  if (b.identity.subject && b.identity.subject !== '_') base.subject = b.identity.subject;
  const named = namedTeam(b.identity);
  if (named) base.team = named;

  if (isArb) {
    // Proportional (Dutch) allocation over 100 staked: each leg returns the
    // same payout, so the worst outcome still clears the total stake.
    const inverseSumR = inverseSum;
    const marginPercent = (1 - inverseSumR) * 100;
    const guaranteedProfit = round2(stake * (1 / inverseSumR - 1));
    const allocated = [low, high].map((l) => ({
      ...l,
      stake: round2(stake * (1 / l.odds) / inverseSumR),
    }));
    return {
      ...base,
      arb: true,
      inverseSum: round4(inverseSumR),
      marginPercent: round2(marginPercent),
      totalStake: stake,
      guaranteedProfit,
      legs: allocated,
    };
  }
  return base;
}

/**
 * Positive EV scan: per-leg, implied probability vs the consensus probability
 * (median of the *other* books' implied probabilities for the same selection).
 *
 * The threshold is deliberately separate from the arbitrage `minMarginPercent`:
 * arbitrage at 0% is still worth reporting, but a leg priced exactly at the
 * consensus carries no edge, and with a 0% default every two-book market would
 * be reported back to the caller.
 *
 * @param {Map} grouped
 * @param {{ minEvPercent?: number }} [options]
 * @returns {Array<{
 *   type: 'positive_ev',
 *   eventKey, sport, marketKey, live, selection, sourceId, odds,
 *   consensusProbability, evPercent,
 * }>}
 */
/**
 * A complete 2- or 3-way market whose inverse-odds sum is far above any real
 * book's hold is not a price, it is an empty ladder.
 *
 * Measured on the live capture: Betfair published Tatung v Taipei
 * "Over 0.5 @ 1.08 / Under 0.5 @ 1.15" — an inverse sum of 1.79, i.e. a 79%
 * hold. Both sides are the exchange's floor quote on an unmatched ladder, not a
 * market. As a counterparty vote it moved the Under 0.5 consensus to 0.48, and
 * every Digitain brand quoting the real 6.60 was published at +219% EV (197
 * such rows across the capture). The worst genuine retail holds sit near 12%
 * on a two-way line and near 20% on a three-way one, so the ceilings below
 * leave a wide margin above every real price and cut only the empty ladders.
 *
 * Only complete markets are judged: a partial or multi-outcome market (correct
 * score, outrights) legitimately sums higher and is left alone.
 */
const MAX_PLAUSIBLE_INVERSE_SUM = { 2: 1.25, 3: 1.35 };

function hasImplausibleOverround(market, contract) {
  if (contract?.degraded) return true;
  const n = Array.isArray(contract?.outcomes) ? contract.outcomes.length : 0;
  const ceiling = contract?.family === 'DOUBLE_CHANCE' ? 2.45 : MAX_PLAUSIBLE_INVERSE_SUM[n];
  if (!ceiling || !Array.isArray(market?.selections) || market.selections.length !== n) return false;
  let inverse = 0;
  for (const s of market.selections) {
    const o = Number(s?.odds);
    if (!Number.isFinite(o) || o <= 1) return false;
    inverse += 1 / o;
  }
  return inverse > ceiling;
}

/**
 * Power-method devigging exponent k >= 1 such that sum_i (q_i ^ k) = 1.
 *
 * Proportional devigging (`q_i / sum(q)`) divides a 1.01 heavy favorite and a
 * capped 14.00 longshot by the same factor, hallucinating a ~93% favorite and a
 * ~6.7% longshot (+236% false EV against Betfair 50.0). Raising implied
 * probabilities to a common power k > 1 concentrates vig removal on longshots
 * (favorite-longshot bias) while remaining identical to 0.50/0.50 on even lines.
 */
function solvePowerDevigExponent(rawProbs) {
  let hi = 2;
  const sumAt = (k) => rawProbs.reduce((acc, q) => acc + (q ** k), 0);
  while (hi < 64 && sumAt(hi) > 1) hi *= 2;
  if (sumAt(hi) > 1) return null;
  let lo = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function findPositiveEV(grouped, { minEvPercent = 2, devig = false } = {}) {
  const out = [];
  // Step 1: collect (eventKey, marketKey, selectionKey) → all legs across books.
  const buckets = new Map();
  for (const [eventKey, instances] of grouped) {
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        const ctx = { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, sport: ev.sport };
        const contract = resolveContract(m, ctx);
        if (contract && !isTradablePeriod(contract.period)) continue;
        if (contract && hasImplausibleOverround(m, contract)) continue;
        // When devig is requested, compute fair probabilities across valid selections
        // using Power Devigging (or 2.0-partition scaling for Double Chance).
        let marketOverround = 0;
        const validImplied = [];
        if (devig) {
          for (const sel of m.selections) {
            const o = Number(sel?.odds);
            if (Number.isFinite(o) && o > 1 && o !== Infinity) {
              const q = 1 / o;
              marketOverround += q;
              validImplied.push(q);
            }
          }
        }
        const isDoubleChance = contract?.family === 'DOUBLE_CHANCE';
        const powerExponent = devig && !isDoubleChance && validImplied.length >= 2 && marketOverround > 1
          ? solvePowerDevigExponent(validImplied)
          : null;
        for (const s of m.selections) {
          const odds = Number(s.odds);
          if (!Number.isFinite(odds) || odds <= 1) continue;
          let k;
          if (contract) {
            const outcome = canonicalOutcomeFor(s.name, contract, ctx)
              ?? canonicalOutcome(s.name, { marketKey: m.key, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
            if (!outcome) continue;
            k = `${bucketKeyForContract(eventKey, contract)}::${pairingScope(m)}::${outcome}`;
          } else {
            const period = canonicalPeriod(m);
            if (!isTradablePeriod(period)) continue;
            const evTeam = teamFor(m, ctx);
            if (evTeam === null) continue;
            const selKey = `${m.key}::${period}::${evTeam}::${pairingScope(m)}::${String(s.name || '').toLowerCase().trim()}`;
            k = `${eventKey}::${selKey}`;
          }
          let b = buckets.get(k);
          if (!b) {
            b = { eventKey, marketKey: m.key, selection: s.name, legsBySource: new Map(), meta: { event: ev, market: m } };
            buckets.set(k, b);
          }
          const rawImplied = 1 / odds;
          let deviggedProb = rawImplied;
          if (devig && validImplied.length >= 2) {
            if (isDoubleChance && validImplied.length === 3 && marketOverround > 2) {
              deviggedProb = (rawImplied / marketOverround) * 2;
            } else if (!isDoubleChance && marketOverround > 1) {
              deviggedProb = powerExponent !== null ? (rawImplied ** powerExponent) : (rawImplied / marketOverround);
            }
          }
          const prev = b.legsBySource.get(ev.sourceId);
          if (!prev || odds > Number(prev.odds)) {
            b.legsBySource.set(ev.sourceId, {
              sourceId: ev.sourceId,
              selection: s.name,
              marketKey: m.key,
              odds: s.odds,
              handicap: s.handicap ?? null,
              eventUrl: ev.sourceUrl || null,
              deviggedProb,
            });
          }
        }
      }
    }
  }
  for (const b of buckets.values()) {
    const legs = [...b.legsBySource.values()];
    if (legs.length < 2) continue;
    for (const l of legs) {
      // Consensus must be built strictly from *other* independent feeds:
      // 1. Exclude same sourceId (prevents self-comparison across duplicate keys).
      // 2. Exclude shared-feed peers of `l.sourceId`.
      // 3. Collapse remaining counterparties to one vote per independent feed
      //    group so an 8-brand clone cluster cannot outvote independent books.
      const probsByFeed = new Map();
      for (const other of legs) {
        if (other.sourceId === l.sourceId || isSharedFeed(l.sourceId, other.sourceId)) continue;
        const prob = devig ? other.deviggedProb : impliedProbability(other.odds);
        if (!Number.isFinite(prob)) continue;
        const feedKey = feedGroupOf(other.sourceId) || other.sourceId;
        const list = probsByFeed.get(feedKey);
        if (list) list.push(prob);
        else probsByFeed.set(feedKey, [prob]);
      }
      if (probsByFeed.size < 1) continue;
      const probs = [];
      for (const list of probsByFeed.values()) {
        list.sort((x, y) => x - y);
        probs.push(list[Math.floor(list.length / 2)]);
      }
      probs.sort((x, y) => x - y);
      const consensus = probs[Math.floor(probs.length / 2)];
      if (!Number.isFinite(consensus) || consensus <= 0) continue;
      const p = devig ? l.deviggedProb : impliedProbability(l.odds);
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
        sport: b.meta.event.sport,
        homeTeam: b.meta.event.homeTeam,
        awayTeam: b.meta.event.awayTeam,
        marketKey: l.marketKey || b.marketKey,
        live: b.meta.market.live === true,
        selection: l.selection || b.selection,
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
        const contract = resolveContract(m, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, sport: ev.sport });
        if (contract && (contract.degraded || contract.family === 'DOUBLE_CHANCE'
          || (Array.isArray(contract.outcomes) && m.selections.length !== contract.outcomes.length))) {
          continue;
        }
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
          // Same reason as the positive-EV signal above: the market belongs to
          // one event, so the record names the competition it came from.
          sport: ev.sport,
          // And the same fixture reason: this row draws the names above the
          // key too, and it had none to draw.
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
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
