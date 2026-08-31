import { runScraperBatch } from './scraper-service.mjs';
import { scanWorkspace, loadWorkspace } from './scanner/scanner.mjs';
import { buildSignalIndex } from './scanner/engine.mjs';
import { writeJsonAtomic } from './shared/atomic-write.mjs';
void loadWorkspace;
void writeJsonAtomic;

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
  const { dataDir, parallel = DEFAULT_PARALLEL, runId = new Date().toISOString(), signal, onEvent = () => {}, logger = () => {} } = opts;
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
    parallel,
    dataDir,
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

  const newScan = await scanWorkspace({
    dataDir,
    sourceIds: requiredSourceIds,
    scrapeRunId: batch.runId,
    capturedAt: new Date().toISOString(),
    bankroll: baseScan.options?.bankroll ?? 1000,
    minRoiPercent: baseScan.options?.minRoiPercent ?? 0,
    maxMiddleRiskPercent: baseScan.options?.maxMiddleRiskPercent ?? 15,
    minMiddleRoiPercent: baseScan.options?.minMiddleRoiPercent ?? 20,
    includeLive: baseScan.options?.includeLive ?? false,
    includePast: baseScan.options?.includePast ?? false,
    publish: false,
  });

  const index = buildSignalIndex(newScan);
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
    return v ? { ...o, verification: { status: v.status, reason: v.reason, legs: v.legs } } : o;
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
  const reconfirmed = [];
  let rejectedReason = null;
  for (const leg of legs) {
    const k = `${leg.eventKey || target.eventKey}::${leg.marketKey || target.marketKey}::${String(leg.selection || '').toLowerCase()}`;
    const candidates = index ? (index.get(k) || []) : [];
    const m = candidates.find((c) => c.sourceId === leg.sourceId);
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
  if (target.type === 'arb') {
    const inv = reconfirmed.reduce((acc, l) => acc + 1 / l.currentOdds, 0);
    const roi = (1 / inv - 1) * 100;
    if (roi < (target.roiPercent || 0) - 1) {
      return { target, status: 'rejected', reason: `roi dropped to ${roi.toFixed(2)}%`, legs: reconfirmed };
    }
  } else if (target.type === 'middle') {
    if (reconfirmed.length !== 2) {
      return { target, status: 'rejected', reason: 'middle lost a leg', legs: reconfirmed };
    }
  }
  return { target, status: 'confirmed', reason: 'all legs re-priced within tolerance', legs: reconfirmed };
}

/**
 * Demote previously-confirmed targets to nearMisses/middleReviews when their
 * confirmation has expired (event started, market closed, etc).
 */
export function expireAutomaticConfirmations(scan, { now = Date.now() } = {}) {
  if (!scan || !Array.isArray(scan.opportunities)) return scan;
  for (const o of scan.opportunities) {
    if (o.verification && o.verification.status === 'confirmed') {
      const kickoff = new Date(o.kickoff || 0).getTime();
      if (kickoff && kickoff < now - 1000 * 60 * 60 * 24) {
        o.verification = { ...o.verification, status: 'expired', reason: 'event past' };
      }
    }
  }
  return scan;
}
