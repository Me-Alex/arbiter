import { runScraperBatch } from './scraper-service.mjs';
import { getSport } from './sports/registry.mjs';
import { canonicalSport } from './shared/text.mjs';
import { scanWorkspace, DEFAULT_SCAN_OPTIONS } from './scanner/scanner.mjs';
import { isSharedFeed } from './scanner/feed-groups.mjs';
import {
  canonicalOutcome,
  supportedContractForMarket,
  resolveContract,
  canonicalOutcomeFor,
  roundedArbitrageAllocation,
} from './scanner/market-contracts.mjs';

/**
 * Resolve the contract a given opportunity belongs to. The engine now emits
 * `family` + `period` + `line` on every opportunity, but verification must
 * also work on opportunities emitted by older scans that only carried
 * `marketKey`, so we resolve from marketKey as a fallback.
 *
 * Returns null only when the marketKey isn't recognised AND the engine didn't
 * tag the opportunity — fall through to the legacy 1X2 guard so a missing tag
 * never silently rejects a real arb.
 */
function resolveTargetContract(target) {
  if (target && target.family) {
    return {
      family: target.family,
      period: target.period || 'fulltime',
      lineKey: target.line || '_',
      // Whose count the target is about, and what it counts. findArbitrage
      // publishes `team` only when it names a side and never publishes
      // `match`, so absence means the match total - the same reading the
      // engine's bucket key takes, where the match total carries
      // `team: 'match'`. A re-quoted leg can now be checked against the
      // scope the target claims instead of being trusted to be in it.
      team: target.team || null,
      subject: target.subject || null,
      outcomes: outcomesForFamily(target),
    };
  }
  if (target?.marketKey) {
    return resolveContract({ key: target.marketKey, selections: (target.legs || []).map((l) => ({ name: l.selection })) });
  }
  return null;
}

function matchOddsForFamily(family) {
  switch (family) {
    case 'MATCH_ODDS': return ['home', 'draw', 'away'];
    case 'BTTS': return ['yes', 'no'];
    // The names the canonical router actually produces for each family.
    // They are not interchangeable: `canonicalOutcomeFor` routes "Peste 2.5"
    // to `over` and "1 (-1.5)" to `home`, so a totals target whose expected
    // outcomes were [home, away] could never match its own legs. Measured on
    // the 2026-10-22 board: every OVER_UNDER target - 9 of the 11 arbs - was
    // rejected with "incomplete or unsupported contract" while its legs were
    // priced perfectly well.
    case 'OVER_UNDER':
      return ['over', 'under'];
    case 'ASIAN_HANDICAP':
      return ['home', 'away'];
    default:
      // DC etc — not arb-eligible; verification rejects them upstream
      return null;
  }
}
/**
 * True when a market key the scanner recognises describes a settlement the
 * target's contract does not.
 *
 * The comparison used to be `known.key !== contract.family`, which is only a
 * settlement test for the one family whose key and family are the same word.
 * MATCH_ODDS passes it; `OVER_UNDER_2_5` against `OVER_UNDER` does not, so
 * every totals leg was pronounced foreign and every OVER_UNDER opportunity
 * was rejected as "settlement equivalence not established". That rejection
 * was load-bearing by accident: it is what kept nine fabricated arbs off the
 * guaranteed-profit rail on 2026-10-22, none of them on merit.
 *
 * What is compared instead is what the key actually claims, dimension by
 * dimension, and only where the key claims it:
 *
 *   family  always. A cards total is not a goals total.
 *   subject when the key names one. `CARDS_OVER_UNDER_4_5` inside a goals
 *           target is a different bet; `OVER_UNDER_4_5` names nothing and so
 *           contradicts nothing.
 *   line    when the key names one. Over 2.5 does not settle the 1.5 line.
 *
 * @param {{family: string, subject: (string|null), line: (string|null)}} known
 * @param {{family: string, lineKey: string}} contract the target's contract
 * @param {{subject?: string}} target
 * @returns {boolean}
 */
function contradictsContract(known, contract, target) {
  if (known.family !== contract.family) return true;
  if (known.subject) {
    // A key that names a subject must name the target's. A target that names
    // none is one this pass cannot establish equivalence for, which is a
    // rejection rather than a pass: the two are being compared precisely
    // because the answer is not obvious.
    if (!target.subject || target.subject !== known.subject) return true;
  }
  if (known.line) {
    const keyLine = Number(String(known.line).replace(',', '.'));
    const targetLine = Number(String(contract.lineKey ?? '').replace(',', '.'));
    if (!Number.isFinite(keyLine) || !Number.isFinite(targetLine) || keyLine !== targetLine) return true;
  }
  return false;
}

/**
 * The two halves a synthetic equivalence pairs, keyed by the engine's synthetic
 * type. routeSyntheticDerivativeLegs records every leg against one of these
 * lists; the type reaches verification in "line" (the engine writes
 * contract.lineKey there), in "syntheticType" on current scans, and inside the
 * SYNTHETIC_<type> marketKey on older ones.
 */
const SYNTHETIC_OUTCOMES = {
  '1X_VS_AWAY': ['home_or_draw', 'away'],
  'X2_VS_HOME': ['draw_or_away', 'home'],
  '12_VS_DRAW': ['home_or_away', 'draw'],
  'DNB_AH0': ['home', 'away'],
  '1X2_AH05': ['home', 'draw', 'away'],
};

/**
 * The match outcomes each synthetic half covers when it pays. This is the only
 * thing a half can mean: an equivalence pairs two PAYOFFS, so the claim a leg
 * carries is a set of results, not the name of a market.
 */
const HALF_COVERS = {
  home: ['home'],
  draw: ['draw'],
  away: ['away'],
  home_or_draw: ['home', 'draw'],
  draw_or_away: ['draw', 'away'],
  home_or_away: ['home', 'away'],
};

/**
 * The synthetic type a target names, or null when it names none we model. The
 * engine writes the type into "line"; "syntheticType" and the marketKey are
 * read as well so this keeps working on scans written before "line" carried it.
 */
function syntheticTypeOf(target) {
  const fromKey = (/^SYNTHETIC_(.+)$/.exec(String(target?.marketKey || '')) || [])[1];
  for (const candidate of [target?.line, target?.syntheticType, fromKey]) {
    if (typeof candidate === 'string' && SYNTHETIC_OUTCOMES[candidate]) return candidate;
  }
  return null;
}

/**
 * The outcome set a target belongs to. A synthetic has no market contract to
 * ask: its two halves are named by its type, so the type is the contract. An
 * unknown type answers null, which the caller rejects - an equivalence this pass
 * cannot name is one it cannot check.
 */
function outcomesForFamily(target) {
  if (target.family === 'SYNTHETIC_EQUIVALENCE') {
    const type = syntheticTypeOf(target);
    return type ? [...SYNTHETIC_OUTCOMES[type]] : null;
  }
  if (target.family === 'MATCH_ODDS') {
    if (/^(?:set[1-5]|q[1-4])$/i.test(target.period || '')) return ['home', 'away'];
    if (target.sport && getSport(canonicalSport(target.sport))?.hasDraw === false) return ['home', 'away'];
    if (Array.isArray(target.outcomes) && target.outcomes.length === 2) return ['home', 'away'];
  }
  return matchOddsForFamily(target.family);
}

/**
 * The outcomes a leg can pay on, or null when this pass cannot say. The side
 * comes from the canonical router with the event's team context, which is the
 * same answer the bucket key is built from, so a leg cannot be filed under one
 * side and priced under another.
 *
 * A start is what lets a draw pay: +0.5 wins on a draw, -0.5 and level do not.
 * The line is read from the structured handicap first and the selection name
 * second, because a book may publish either. A leg with no line anywhere is
 * determinate only when its key names a result market; anything else could hold
 * a start this pass cannot see, and that is not evidence against it.
 */
function legCoverage(leg, target) {
  const ctx = { homeTeam: target.homeTeam, awayTeam: target.awayTeam };
  const name = String(leg?.selection ?? '');
  // A double chance leg names its own half, so it is the one shape that needs no
  // side resolution.
  const doubleChance = canonicalOutcomeFor(name, { family: 'DOUBLE_CHANCE', outcomes: ['home_or_draw', 'home_or_away', 'draw_or_away'] }, ctx);
  if (doubleChance) return HALF_COVERS[doubleChance];
  const side = canonicalOutcomeFor(name, { family: 'ASIAN_HANDICAP', outcomes: ['home', 'away'] }, ctx)
    ?? canonicalOutcomeFor(name, { family: 'MATCH_ODDS', outcomes: ['home', 'draw', 'away'] }, ctx);
  if (!side) return null;
  if (side === 'draw') return ['draw'];
  const signed = /([+-])\s*(\d+(?:[.,]\d+)?)/.exec(name);
  const rawHandicap = leg?.handicap !== null && leg?.handicap !== undefined && leg?.handicap !== ''
    ? Number(String(leg.handicap).replace(',', '.'))
    : NaN;
  const line = Number.isFinite(rawHandicap)
    ? rawHandicap
    : (signed ? Number(signed[1] + signed[2].replace(',', '.')) : null);
  if (line === null) return supportedContractForMarket(leg?.marketKey) ? [side] : null;
  if (line < -0.5) return [];
  return line >= 0.5 ? [side, 'draw'] : [side];
}

/**
 * True when the half a leg claims is one the leg can actually pay. A leg with no
 * claimed half, or one no synthetic has, fits nothing. A leg this pass cannot
 * read is passed over for the reason the single-market path lets an opaque key
 * through: an unreadable leg is not evidence of a wrong claim.
 */
function syntheticLegFits(leg, target) {
  const claimed = HALF_COVERS[leg?.outcome];
  if (!claimed) return false;
  const coverage = legCoverage(leg, target);
  if (!coverage) return true;
  return claimed.every((outcome) => coverage.includes(outcome));
}

/**
 * verification.mjs — the second-opinion pass.
 *
 * Picks out the sourceIds backing every leg of every flagged opportunity /
 * middle, re-scrapes just those books, re-scans, and verifies each target
 * still has every leg at odds that meet the original ROI threshold.
 *
 * Verification outcomes are `confirmed`, `rejected`, `expired`, and
 * `unconfirmed`. `rejected` means the opportunity was re-priced and failed
 * (drift, ROI drop, wrong contract). `unconfirmed` means a leg could not be
 * located in the independent re-scrape at all — which is not evidence it is
 * false, only that it could not be re-confirmed this pass.
 */

const DEFAULT_PARALLEL = 12;
const RECHECK_TOLERANCE = 0.02; // 2 % odds move is fine

/**
 * @param {Array<object>} targets           opportunities + middles to verify
 * @param {object} baseScan
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {number} [opts.parallel=12]
 * @param {Function} [opts.onEvent]
 * @param {Function} [opts.logger]
 */
export async function runVerificationPass(targets, baseScan, opts = {}) {
  const { dataDir, configPath, parallel = DEFAULT_PARALLEL, runId = new Date().toISOString(), signal, onEvent = () => {}, logger = () => {} } = opts;
  if (!Array.isArray(targets) || targets.length === 0) {
    return {
      confirmed: 0,
      rejected: 0,
      expired: 0,
      unconfirmed: 0,
      verifications: [],
      newScan: null,
    };
  }

  const required = new Set();
  for (const t of targets) {
    for (const leg of t.legs || []) {
      if (leg && leg.sourceId) required.add(leg.sourceId);
    }
  }
  const requiredSourceIds = [...required];
  const emit = (e) => { try { onEvent(e); } catch (err) { logger('warn', `onEvent threw: ${err.message}`); } };
  emit({ type: 'verify-start', targets: targets.length, books: requiredSourceIds });

  if (requiredSourceIds.length === 0) {
    return {
      confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0,
      verifications: targets.map((t) => ({ target: t, status: 'expired', reason: 'no sourceIds' })),
      newScan: null,
    };
  }

  const batch = await runScraperBatch({
    books: requiredSourceIds,
    maxEvents: opts.maxEvents ?? baseScan.options?.maxEvents,
    sport: opts.sport ?? baseScan.options?.sport,
    includeLive: baseScan.options?.includeLive ?? false,
    includePast: baseScan.options?.includePast ?? false,
    parallel,
    dataDir,
    configPath,
    runId: `${runId}:verify`,
    signal,
    onEvent: (event) => emit({ ...event, type: `verify-${event.type}` }),
    logger,
  });
  if (signal?.aborted || batch.report.status === 'cancelled') {
    return {
      confirmed: 0, rejected: 0, expired: targets.length, unconfirmed: 0,
      verifications: targets.map((target) => ({ target, status: 'expired', reason: 'verification cancelled' })),
      newScan: null,
    };
  }

  let index;
  const newScan = await scanWorkspace({
    onEligibleSelections: (selections) => { index = selections; },
    dataDir,
    sourceIds: requiredSourceIds,
    scrapeRunId: batch.runId,
    capturedAt: new Date().toISOString(),
    bankroll: baseScan.options?.bankroll ?? DEFAULT_SCAN_OPTIONS.bankroll,
    minMarginPercent: baseScan.options?.minMarginPercent ?? DEFAULT_SCAN_OPTIONS.minMarginPercent,
    minEvPercent: opts.minEvPercent ?? baseScan.options?.minEvPercent ?? DEFAULT_SCAN_OPTIONS.minEvPercent,
    maxMiddleRiskPercent: baseScan.options?.maxMiddleRiskPercent ?? DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
    minMiddleRoiPercent: baseScan.options?.minMiddleRoiPercent ?? DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
    includeLive: baseScan.options?.includeLive ?? DEFAULT_SCAN_OPTIONS.includeLive,
    includePast: baseScan.options?.includePast ?? DEFAULT_SCAN_OPTIONS.includePast,
    sport: opts.sport ?? baseScan.options?.sport,
    prematchMaxAgeMs: baseScan.options?.prematchMaxAgeMs,
    liveMaxAgeMs: baseScan.options?.liveMaxAgeMs,
    publish: false,
  });

  const verifications = targets.map((t) => verifySignal(t, newScan, { index, tolerance: RECHECK_TOLERANCE }));

  let confirmed = 0, rejected = 0, expired = 0, unconfirmed = 0;
  for (const v of verifications) {
    if (v.status === 'confirmed') confirmed++;
    else if (v.status === 'rejected') rejected++;
    else if (v.status === 'expired') expired++;
    else if (v.status === 'unconfirmed') unconfirmed++;
  }
  emit({ type: 'verify-end', confirmed, rejected, expired, unconfirmed });

  // merge confirmed into baseScan so the dashboard shows the verified status.
  const verifyByKey = new Map(verifications.map((v) => [keyOf(v.target), v]));
  baseScan.opportunities = (baseScan.opportunities || []).map((o) => {
    const v = verifyByKey.get(keyOf(o));
    return v ? { ...o, ...(v.allocation || {}), verification: { status: v.status, reason: v.reason, legs: v.legs } } : o;
  });
  baseScan.middles = (baseScan.middles || []).map((m) => {
    const v = verifyByKey.get(keyOf(m));
    return v ? { ...m, ...(v.allocation || {}), verification: { status: v.status, reason: v.reason, legs: v.legs } } : m;
  });
  baseScan.verificationSummary = { confirmed, rejected, expired, unconfirmed, at: new Date().toISOString() };

  return { confirmed, rejected, expired, unconfirmed, verifications, newScan };
}

function keyOf(target) {
  if (!target) return '';
  const liveScope = Array.isArray(target.legs) && target.legs.some((l) => l?.live === true) ? 'live' : 'prematch';
  return `${target.eventKey || ''}::${target.marketKey || ''}::${target.type}::${target.family || ''}::${target.period || ''}::${target.line ?? ''}::${target.subject || ''}::${target.team || ''}::${liveScope}`;
}

export function verifySignal(target, confirmationScan, { index, tolerance = RECHECK_TOLERANCE } = {}) {
  const legs = target.legs || [];
  if (legs.some((leg) => legs.some((other) => isSharedFeed(leg?.sourceId, other?.sourceId)))) {
    return { target, status: 'rejected', reason: 'legs share upstream feed', legs: [] };
  }
  // Resolve the family for this opportunity once. Older scans that only carry
  // marketKey fall through to a per-key resolution. Doubling up the resolver
  // is intentional — verification must keep working on historical scan.json
  // files written before today.
  const contract = resolveTargetContract(target);
  if (target.type === 'arb') {
    if (!contract || !contract.outcomes || contract.family === 'DOUBLE_CHANCE') {
      // DC has overlapping outcomes (1X/12/X2) — it cannot be arbitraged
      // because backing all three is not a surebet. Any opportunity that
      // claims a DC family is malformed; reject it explicitly.
      return { target, status: 'rejected', reason: 'unsupported contract: settlement equivalence not established', legs: [] };
    }
    // Reject legs that name a *different, recognised* contract. An unrecognised
    // marketKey is not evidence either way: a provider-opaque 1X2 (superbet 547,
    // winner 1, netbet `default`, betano MRES, FEG ufo:mtyp:00-00) flows through
    // findArbitrage untouched, and we judge it by outcome shape below, which
    // requires exactly the right set of canonical outcomes.
    const isForeignContract = (leg) => {
      const known = supportedContractForMarket(leg?.marketKey || target.marketKey);
      if (known) return contradictsContract(known, contract, target);
      // Unrecognised key on this leg — fall back to its own contract resolution.
      const own = resolveContract({ key: leg?.marketKey || target.marketKey, selections: [{ name: leg.selection }] });
      return Boolean(own) && own.family !== contract.family;
    };

    // A synthetic pairs two DIFFERENT markets on purpose, so the comparison
    // below cannot apply to it: every leg's own family is foreign by
    // construction. What is still knowable is whether the half the engine said
    // this leg represents is a payoff its declared market can actually produce.
    if (contract.family === 'SYNTHETIC_EQUIVALENCE') {
      if (legs.some((leg) => !syntheticLegFits(leg, target))) {
        return { target, status: 'rejected', reason: 'unsupported contract: settlement equivalence not established', legs: [] };
      }
    } else if (legs.some(isForeignContract)) {
      return { target, status: 'rejected', reason: 'unsupported contract: settlement equivalence not established', legs: [] };
    }
  }
  const reconfirmed = [];
  let rejectedReason = null;
  let missingLegReason = null;
  for (const leg of legs) {
    // The scope travels in the key for the same reason it travels in the engine's
    // bucket key: a live leg and a pre-match leg settle differently, so a
    // re-quote of a live signal must be matched against a live price. Both sides
    // of this key are built by `buildSelectionIndex`; changing one without the
    // other turns every confirmation into "leg missing".
    const scope = leg.live === true ? 'live' : 'prematch';
    const k = `${leg.eventKey || target.eventKey}::${leg.marketKey || target.marketKey}::${scope}::${String(leg.selection || '').toLowerCase()}`;
    const candidates = index ? (index.get(k) || []) : [];
    const matches = candidates.filter((c) => c.sourceId === leg.sourceId
      && (c.handicap ?? null) === (leg.handicap ?? null)
      && (!leg.kickoff || c.kickoff === leg.kickoff)
      && (!leg.providerEventId || c.providerEventId === leg.providerEventId)
      && (!leg.marketId || c.marketId === leg.marketId)
      && (!leg.selectionId || c.selectionId === leg.selectionId));
    if (matches.length > 1) {
      rejectedReason = `${leg.sourceId} ambiguous selection`;
      break;
    }
    const m = matches[0];
    if (!m) {
      // Distinguish a genuine mismatch from a re-scrape coverage gap.
      //
      // If the book's event appears in the index at all for this eventKey, the
      // re-scrape reached the event, so a selection that is not there is a real
      // difference (the line moved, the market changed) and the opportunity is
      // rejected. If the event is absent from the index entirely, the re-scrape
      // simply did not reach it — an independent, bounded crawl — and the price
      // may be alive on the book. That is not evidence it is false.
      //
      // Proven live on 2026-09-28: 37 "unibet leg missing" rejections, of which
      // Unibet's own contest-page feed served the exact quoted BTTS price for
      // 37/37. Treating a coverage gap as `rejected` asserted the opportunity
      // was invalid and discarded real arbitrage.
      // "Reached" must be judged per source: the same eventKey can be present
      // because a DIFFERENT book's event was indexed under it, which proves
      // nothing about whether this leg's own book was re-scraped for it. So we
      // look for any indexed candidate for this eventKey from this leg's own
      // sourceId.
      const eventKey = leg.eventKey || target.eventKey;
      const eventSeen = Boolean(index) && [...index.entries()].some(
        ([ik, cands]) => ik.startsWith(`${eventKey}::`) && cands.some((c) => c.sourceId === leg.sourceId),
      );
      if (eventSeen) {
        rejectedReason = `${leg.sourceId} selection missing from re-scrape (event present)`;
      } else {
        missingLegReason = `${leg.sourceId} leg missing from re-scrape (event not reached)`;
      }
      break;
    }
    // The scope check, and why it belongs here rather than at the bucket key.
    // The key separates a match total from a one-team total, but verification
    // is a second opinion on that separation, not a reliance on it: the price
    // that comes back is a price for a MARKET, and the index says which one.
    // One team's goals and the match's goals are different numbers on the
    // same line, so a leg re-quoted from the wrong scope settles against a
    // total the target never claimed. Measured on the published artefacts:
    // the 2026-10-22 fabrication paired "Total individual Östers IF / Over
    // @2.06" with a match "Under 1.5 @4.9".
    //
    // An index entry that names no scope is passed over, for the reason an
    // unreadable marketKey is passed over below: it is not evidence either
    // way. Only a leg that positively names a DIFFERENT scope is foreign.
    // Spelled as one token each (`away-scope`) because the interface matches
    // substituted data as a single word and would otherwise fall through to
    // this English sentence. See frontend/src/reasons.ts.
    const targetScope = contract?.team || 'match';
    if (contract?.family === 'OVER_UNDER' && m.team && m.team !== targetScope) {
      rejectedReason = `${leg.sourceId} leg re-quoted from ${m.team}-scope, not ${targetScope}-scope`;
      break;
    }
    if (contract?.family === 'OVER_UNDER' && target.subject && m.subject && m.subject !== target.subject) {
      rejectedReason = `${leg.sourceId} leg re-quoted from ${m.subject}-subject, not ${target.subject}-subject`;
      break;
    }
    if (Math.abs(m.odds - leg.odds) / leg.odds > tolerance) {
      rejectedReason = `${leg.sourceId} odds drift ${leg.odds} → ${m.odds}`;
      break;
    }
    reconfirmed.push({ ...leg, currentOdds: m.odds });
  }
  if (missingLegReason) {
    return { target, status: 'unconfirmed', reason: missingLegReason, legs: reconfirmed };
  }
  if (rejectedReason) {
    return { target, status: 'rejected', reason: rejectedReason, legs: reconfirmed };
  }
  if (target.type === 'arb' && contract) {
    // Family-aware outcome routing. The legacy canonicalOutcome only handled
    // 1X2; canonicalOutcomeFor routes BTTS (Yes/Da → yes), OVER_UNDER
    // (Peste 2.5 → over), and ASIAN_HANDICAP (1 (-1.5) → home) by family.
    // A synthetic leg is half of a DIFFERENT market, so re-deriving its outcome
    // through this target's contract would ask a question that has no answer.
    // The engine already recorded which half the leg was selected for, and
    // syntheticLegFits has checked that claim against the leg's own family.
    // Re-deriving would replace a checked claim with a guess.
    const outcomes = reconfirmed.map((l) => (contract.family === 'SYNTHETIC_EQUIVALENCE'
      ? l.outcome || null
      : canonicalOutcomeFor(l.selection, contract, { homeTeam: l.homeTeam ?? target.homeTeam, awayTeam: l.awayTeam ?? target.awayTeam })
        ?? canonicalOutcome(l.selection, { marketKey: l.marketKey || target.marketKey, homeTeam: l.homeTeam ?? target.homeTeam, awayTeam: l.awayTeam ?? target.awayTeam })));
    const expected = contract.outcomes;
    if (outcomes.some((o) => !o)
      || outcomes.length !== expected.length
      || new Set(outcomes).size !== outcomes.length
      || !expected.every((o) => outcomes.includes(o))
      || new Set(reconfirmed.map((l) => l.sourceId)).size < 2
      || reconfirmed.some((l) => !Number.isFinite(l.currentOdds) || l.currentOdds <= 1)) {
      return { target, status: 'rejected', reason: 'incomplete or unsupported contract', legs: reconfirmed };
    }
    const inv = reconfirmed.reduce((acc, l) => acc + 1 / l.currentOdds, 0);
    const margin = (1 - inv) * 100;
    if (!(inv < 1) || margin < Math.max(confirmationScan?.options?.minMarginPercent ?? 0, (target.marginPercent || 0) - 1)) {
      return { target, status: 'rejected', reason: `margin dropped to ${margin.toFixed(2)}%`, legs: reconfirmed };
    }
    // Re-allocation must respect the money the scan actually committed: a
    // capped scan published totalStake at the cap, and verification may not
    // silently re-stake at the full bankroll. With no cap in play (totalStake
    // absent, or equal to the budget) this is the same budget as before.
    const budget = confirmationScan?.options?.bankroll ?? 1000;
    const allocation = roundedArbitrageAllocation(reconfirmed.map(l => ({ ...l, odds: l.currentOdds })), Math.min(budget, target.totalStake ?? budget));
    if (!allocation || allocation.guaranteedProfit <= 0) {
      return { target, status: 'rejected', reason: 'no positive rounded guaranteed profit', legs: reconfirmed };
    }
    return { target, status: 'confirmed', reason: 'all legs re-priced within tolerance', legs: allocation.legs, allocation };
  } else if (target.type === 'middle') {
    if (reconfirmed.length !== 2) {
      return { target, status: 'rejected', reason: 'middle lost a leg', legs: reconfirmed };
    }
    if (reconfirmed[0].sourceId === reconfirmed[1].sourceId
      || isSharedFeed(reconfirmed[0].sourceId, reconfirmed[1].sourceId)) {
      return { target, status: 'rejected', reason: 'legs share upstream feed', legs: reconfirmed };
    }
    if (reconfirmed.some((l) => !Number.isFinite(l.currentOdds) || l.currentOdds <= 1)) {
      return { target, status: 'rejected', reason: 'incomplete or unsupported contract', legs: reconfirmed };
    }
    if (target.arb === true) {
      const inv = 1 / reconfirmed[0].currentOdds + 1 / reconfirmed[1].currentOdds;
      const margin = (1 - inv) * 100;
      if (!(inv < 1) || margin < Math.max(confirmationScan?.options?.minMarginPercent ?? 0, (target.marginPercent || 0) - 1)) {
        return { target, status: 'rejected', reason: `margin dropped to ${margin.toFixed(2)}%`, legs: reconfirmed };
      }
      const budget = confirmationScan?.options?.bankroll ?? 1000;
      const allocation = roundedArbitrageAllocation(
        reconfirmed.map((l) => ({ ...l, odds: l.currentOdds })),
        Math.min(budget, target.totalStake ?? budget),
      );
      if (!allocation || allocation.guaranteedProfit <= 0) {
        return { target, status: 'rejected', reason: 'no positive rounded guaranteed profit', legs: reconfirmed };
      }
      return { target, status: 'confirmed', reason: 'all legs re-priced within tolerance', legs: allocation.legs, allocation };
    }
    const stake = 100;
    const o0 = reconfirmed[0].currentOdds;
    const o1 = reconfirmed[1].currentOdds;
    const minPayout = Math.min(stake * o0, stake * o1);
    const worstCaseLoss = Math.max(0, (stake * 2) - minPayout);
    const gainIfBothWin = stake * (o0 - 1) + stake * (o1 - 1);
    const roiPercent = (gainIfBothWin / (stake * 2)) * 100;
    const riskPercent = (worstCaseLoss / (stake * 2)) * 100;
    const maxRisk = confirmationScan?.options?.maxMiddleRiskPercent ?? DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent;
    const minRoi = confirmationScan?.options?.minMiddleRoiPercent ?? DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent;
    if (riskPercent > maxRisk + 1 || roiPercent < minRoi - 1) {
      return { target, status: 'rejected', reason: 'middle window exceeded risk or ROI threshold', legs: reconfirmed };
    }
  }
  return { target, status: 'confirmed', reason: 'all legs re-priced within tolerance', legs: reconfirmed };
}

/**
 * Grace period after kickoff during which a confirmation is still considered
 * live. A result market settles at full time, but a feed can keep serving
 * pre-match prices for a short while afterwards; a small window avoids
 * expiring a confirmation that is merely waiting on a lagging feed, while a
 * multi-day-old "confirmed" is definitely stale.
 */
const SETTLEMENT_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Demote previously-confirmed targets to 'expired' when their confirmation
 * has run out (event started, market closed, etc).
 *
 * It used to say "nearMisses/middleReviews" here, which is not a status this
 * function has ever written — the dictionaries still carried a key for each,
 * translated into two languages, read by nothing. A comment that names a
 * value the code does not produce is how those keys got into the dictionary
 * in the first place.
 *
 * Covers both signal families: `runVerificationPass` writes confirmations
 * onto opportunities and middles, so expiring only opportunities left confirmed
 * middles in the persisted scan forever.
 */
export function expireAutomaticConfirmations(scan, { now = Date.now() } = {}) {
  if (!scan) return scan;
  for (const family of ['opportunities', 'middles']) {
    const signals = scan[family];
    if (!Array.isArray(signals)) continue;
    for (const signal of signals) {
      if (!signal.verification || signal.verification.status !== 'confirmed') continue;
      const kickoff = signal.kickoff ? new Date(signal.kickoff).getTime() : NaN;
      // A missing or malformed kickoff is itself a reason to stop trusting the
      // confirmation: we cannot prove the event has not been superseded. The
      // previous `new Date(0).getTime()` produced 0, which read as falsy and
      // skipped the expiry entirely.
      const settled = !Number.isFinite(kickoff) || kickoff < now - SETTLEMENT_GRACE_MS;
      if (settled) {
        signal.verification = {
          ...signal.verification,
          status: 'expired',
          reason: Number.isFinite(kickoff) ? 'event past' : 'event kickoff unknown',
        };
      }
    }
  }
  return scan;
}
