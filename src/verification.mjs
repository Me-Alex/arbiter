import { runScraperBatch } from './scraper-service.mjs';
import { scanWorkspace } from './scanner/scanner.mjs';
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
      outcomes: matchOddsForFamily(target.family),
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
    case 'OVER_UNDER':
    case 'ASIAN_HANDICAP':
      return ['home', 'away']; // treat 'over' and 'home' as the "first" leg; the canonical router routes actual names
    default:
      // DC etc — not arb-eligible; verification rejects them upstream
      return null;
  }
}

/**
 * verification.mjs — the second-opinion pass.
 *
 * Picks out the sourceIds backing every leg of every flagged opportunity /
 * middle, re-scrapes just those books, re-scans, and verifies each target
 * still has every leg at odds that meet the original ROI threshold.
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
      confirmed: 0, rejected: 0, expired: 0,
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
      confirmed: 0, rejected: 0, expired: targets.length,
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
    bankroll: baseScan.options?.bankroll ?? 1000,
    minRoiPercent: baseScan.options?.minRoiPercent ?? 0,
    minEvPercent: opts.minEvPercent ?? baseScan.options?.minEvPercent ?? 2,
    maxMiddleRiskPercent: baseScan.options?.maxMiddleRiskPercent ?? 15,
    minMiddleRoiPercent: baseScan.options?.minMiddleRoiPercent ?? 20,
    includeLive: baseScan.options?.includeLive ?? false,
    includePast: baseScan.options?.includePast ?? false,
    sport: opts.sport ?? baseScan.options?.sport,
    prematchMaxAgeMs: baseScan.options?.prematchMaxAgeMs,
    liveMaxAgeMs: baseScan.options?.liveMaxAgeMs,
    publish: false,
  });

  const verifications = targets.map((t) => verifySignal(t, newScan, { index, tolerance: RECHECK_TOLERANCE }));

  let confirmed = 0, rejected = 0, expired = 0;
  for (const v of verifications) {
    if (v.status === 'confirmed') confirmed++;
    else if (v.status === 'rejected') rejected++;
    else if (v.status === 'expired') expired++;
  }
  emit({ type: 'verify-end', confirmed, rejected, expired });

  // merge confirmed into baseScan so the dashboard shows the verified status.
  const verifyByKey = new Map(verifications.map((v) => [keyOf(v.target), v]));
  baseScan.opportunities = (baseScan.opportunities || []).map((o) => {
    const v = verifyByKey.get(keyOf(o));
    return v ? { ...o, ...(v.allocation || {}), verification: { status: v.status, reason: v.reason, legs: v.legs } } : o;
  });
  baseScan.middles = (baseScan.middles || []).map((m) => {
    const v = verifyByKey.get(keyOf(m));
    return v ? { ...m, verification: { status: v.status, reason: v.reason, legs: v.legs } } : m;
  });
  baseScan.verificationSummary = { confirmed, rejected, expired, at: new Date().toISOString() };

  return { confirmed, rejected, expired, verifications, newScan };
}

function keyOf(target) {
  if (!target) return '';
  return `${target.eventKey || ''}::${target.marketKey || ''}::${target.type}`;
}

export function verifySignal(target, confirmationScan, { index, tolerance = RECHECK_TOLERANCE } = {}) {
  const legs = target.legs || [];
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
      if (known) return known.key !== contract.family;
      // Unrecognised key on this leg — fall back to its own contract resolution.
      const own = resolveContract({ key: leg?.marketKey || target.marketKey, selections: [{ name: leg.selection }] });
      return Boolean(own) && own.family !== contract.family;
    };
    if (legs.some(isForeignContract)) {
      return { target, status: 'rejected', reason: 'unsupported contract: settlement equivalence not established', legs: [] };
    }
  }
  const reconfirmed = [];
  let rejectedReason = null;
  for (const leg of legs) {
    const k = `${leg.eventKey || target.eventKey}::${leg.marketKey || target.marketKey}::${String(leg.selection || '').toLowerCase()}`;
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
      rejectedReason = `${leg.sourceId} leg missing`;
      break;
    }
    if (Math.abs(m.odds - leg.odds) / leg.odds > tolerance) {
      rejectedReason = `${leg.sourceId} odds drift ${leg.odds} → ${m.odds}`;
      break;
    }
    reconfirmed.push({ ...leg, currentOdds: m.odds });
  }
  if (rejectedReason) {
    return { target, status: 'rejected', reason: rejectedReason, legs: reconfirmed };
  }
  if (target.type === 'arb' && contract) {
    // Family-aware outcome routing. The legacy canonicalOutcome only handled
    // 1X2; canonicalOutcomeFor routes BTTS (Yes/Da → yes), OVER_UNDER
    // (Peste 2.5 → over), and ASIAN_HANDICAP (1 (-1.5) → home) by family.
    const outcomes = reconfirmed.map((l) => canonicalOutcomeFor(l.selection, contract)
      ?? canonicalOutcome(l.selection, { marketKey: l.marketKey || target.marketKey, homeTeam: l.homeTeam ?? target.homeTeam, awayTeam: l.awayTeam ?? target.awayTeam }));
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
    const roi = (1 / inv - 1) * 100;
    if (!(inv < 1) || roi < Math.max(confirmationScan.options?.minRoiPercent ?? 0, (target.roiPercent || 0) - 1)) {
      return { target, status: 'rejected', reason: `roi dropped to ${roi.toFixed(2)}%`, legs: reconfirmed };
    }
    const allocation = roundedArbitrageAllocation(reconfirmed.map(l => ({ ...l, odds: l.currentOdds })), confirmationScan.options?.bankroll ?? target.totalStake ?? 1000);
    if (!allocation || allocation.guaranteedProfit <= 0) {
      return { target, status: 'rejected', reason: 'no positive rounded guaranteed profit', legs: reconfirmed };
    }
    return { target, status: 'confirmed', reason: 'all legs re-priced within tolerance', legs: allocation.legs, allocation };
  } else if (target.type === 'middle') {
    if (reconfirmed.length !== 2) {
      return { target, status: 'rejected', reason: 'middle lost a leg', legs: reconfirmed };
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
 * Demote previously-confirmed targets to nearMisses/middleReviews when their
 * confirmation has expired (event started, market closed, etc).
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
