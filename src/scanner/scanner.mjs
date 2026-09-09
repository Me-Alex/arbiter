import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold } from './engine.mjs';
import { roundedArbitrageAllocation } from './market-contracts.mjs';
import { DATA_STATUS, isActionableKickoff, snapshotQuality, sourceHealthSummary } from '../shared/data-quality.mjs';
import { round2 } from '../shared/math.mjs';
import { tryReadJson, writeJsonAtomic } from '../shared/atomic-write.mjs';

/**
 * Scanner entry point. Reads every data/workspace/<book>_events.json into
 * memory, applies the engine, persists latest-scan.json.
 */

export async function loadWorkspace(dataDir, qualityOptions = {}) {
  const { expectedRunId, ...snapshotOptions } = qualityOptions;
  const dir = join(dataDir, 'workspace');
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Read + parse every snapshot with bounded parallelism — files are
  // independent, so a scan over many books shouldn't serialize on disk I/O,
  // but an unbounded Promise.all would load every payload into memory at once.
  // A corrupt snapshot is skipped rather than failing the whole scan.
  const filesToRead = files.filter((file) => file.endsWith('_events.json'));
  const snaps = new Array(filesToRead.length);
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= filesToRead.length) return;
      const file = filesToRead[idx];
      const blob = await tryReadJson(join(dir, file), null);
      if (blob) snaps[idx] = { file, blob };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filesToRead.length) }, worker));
  const snapshots = snaps.filter(Boolean);

  const events = [];
  const sources = [];
  for (const { file, blob } of snapshots) {
    if (!blob || !Array.isArray(blob.events)) continue;
    const quality = snapshotQuality(blob, snapshotOptions);
    const runMismatch = expectedRunId && blob.runId !== expectedRunId;
    const source = {
      sourceId: blob.sourceId || file.replace('_events.json', ''),
      file,
      runId: blob.runId || null,
      capturedAt: blob.capturedAt || null,
      observedAt: blob.observedAt || blob.capturedAt || null,
      sourceUrl: blob.sourceUrl || null,
      transport: blob.transport || null,
      count: blob.events.length,
      dataStatus: runMismatch ? DATA_STATUS.STALE : quality.status,
      dataReason: runMismatch ? `snapshot belongs to run ${blob.runId || 'unknown'}, not ${expectedRunId}` : quality.reason,
      ageMs: quality.ageMs,
    };
    sources.push(source);
    if (source.dataStatus !== DATA_STATUS.FRESH || !source.runId || !source.sourceUrl || !source.transport) {
      if (source.dataStatus === DATA_STATUS.FRESH) {
        source.dataStatus = DATA_STATUS.PARTIAL;
        source.dataReason = 'snapshot is missing runId, sourceUrl, or transport provenance';
      }
      continue;
    }
    for (const event of blob.events) {
      events.push({ ...event, sourceId: event.sourceId || blob.sourceId, observedAt: source.observedAt, runId: source.runId });
    }
  }
  return { events, sources };
}

/**
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string[]} [args.sourceIds]
 * @param {string} [args.scrapeRunId]
 * @param {string} [args.capturedAt]
 * @param {number} [args.bankroll]
 * @param {number} [args.minRoiPercent]
 * @param {number} [args.maxMiddleRiskPercent]
 * @param {number} [args.minMiddleRoiPercent]
 * @param {boolean} [args.includeLive]
 * @param {boolean} [args.includePast]
 * @param {boolean} [args.publish=true]
 * @param {number} [args.prematchMaxAgeMs]
 * @param {number} [args.liveMaxAgeMs]
 */
export async function scanWorkspace(args) {
  const {
    dataDir,
    sourceIds = null,
    scrapeRunId = null,
    capturedAt = new Date().toISOString(),
    bankroll = 1000,
    minRoiPercent = 0,
    maxMiddleRiskPercent = 15,
    minMiddleRoiPercent = 20,
    includeLive = false,
    includePast = false,
    publish = true,
    prematchMaxAgeMs,
    liveMaxAgeMs,
    sport = null,
  } = args;

  const qualityOptions = { prematchMaxAgeMs, liveMaxAgeMs, expectedRunId: scrapeRunId };
  const { events, sources } = await loadWorkspace(dataDir, qualityOptions);
  const filtered = events.filter((event) => {
    if (sourceIds && sourceIds.length && !sourceIds.includes(event.sourceId)) return false;
    if (sport && event.sport && event.sport.toLowerCase() !== sport.toLowerCase()) return false;
    if (!includeLive && event.live === true) return false;
    if (!includePast && event.live !== true && !isActionableKickoff(event.kickoff)) return false;
    return true;
  });

  const grouped = groupByEvent(filtered);
  // Past observations can be retained for an explicit historical view, but no
  // signal with money guidance may be produced from them.
  const actionableEvents = filtered.filter((event) => event.live === true || isActionableKickoff(event.kickoff));
  const actionableGrouped = groupByEvent(actionableEvents);

  const opportunities = findArbitrage(actionableGrouped, { minRoiPercent })
    .map((opportunity) => withBankroll(opportunity, bankroll))
    .filter(Boolean);
  // Middling and positive-EV calculations remain informational until each market
  // contract has a complete payoff model and a fresh verification pass.
  const middles = findMiddles(grouped, { maxMiddleRiskPercent, minMiddleRoiPercent }).map((opportunity) => withBankroll(opportunity, bankroll));
  const positiveEv = findPositiveEV(grouped, { minRoiPercent }).map((opportunity) => withBankroll(opportunity, bankroll));
  const lowHold = findLowHold(grouped);
  const quality = sourceHealthSummary(sources);

  const scan = {
    schemaVersion: 2,
    id: `scan-${Date.now()}`,
    scrapedAt: capturedAt,
    scanStartedAt: new Date().toISOString(),
    scrapeRunId: scrapeRunId || commonRunId(sources),
    /**
     * Top-level data health contract:
     * - `actionableSourceCount`: number of sources with status FRESH.
     * - `status`: derives the WORST per-source health (FRESH wins only when
     *   >=1 source is fresh, then STALE > PARTIAL > FAILED > EMPTY). This is
     *   what the frontend freshness banner consumes — it differs from
     *   per-source `dataStatus` (which lives on each snapshot source).
     *   CANCELLED/UNKNOWN sources intentionally degrade to EMPTY ("no usable
     *   data") rather than surfacing as a banner state.
     * - `sources`: per-source quality summary (see `quality` above).
     */
    dataHealth: {
      actionableSourceCount: sources.filter((source) => source.dataStatus === DATA_STATUS.FRESH).length,
      sources: quality,
      status: sources.some((source) => source.dataStatus === DATA_STATUS.FRESH)
        ? DATA_STATUS.FRESH
        : sources.some((source) => source.dataStatus === DATA_STATUS.STALE)
          ? DATA_STATUS.STALE
          : sources.some((source) => source.dataStatus === DATA_STATUS.PARTIAL)
            ? DATA_STATUS.PARTIAL
            : sources.some((source) => source.dataStatus === DATA_STATUS.FAILED)
              ? DATA_STATUS.FAILED
              : DATA_STATUS.EMPTY,
    },
    options: {
      bankroll,
      minRoiPercent,
      maxMiddleRiskPercent,
      minMiddleRoiPercent,
      includeLive,
      includePast,
      sourceIds: sourceIds || null,
    },
    sources,
    eventCount: filtered.length,
    opportunities,
    middles,
    positiveEv,
    lowHold,
    verificationSummary: { confirmed: 0, rejected: 0, expired: 0 },
  };

  if (publish) await writeJsonAtomic(join(dataDir, 'latest-scan.json'), scan);
  return scan;
}

function withBankroll(opp, bankroll) {
  const stake = Math.max(0, Number(bankroll) || 0);
  if (opp.type === 'arb') {
    const allocation = roundedArbitrageAllocation(opp.legs, stake);
    if (!allocation) return null;
    return {
      ...opp,
      legs: allocation.legs,
      inverseSum: allocation.inverseSum,
      totalStake: allocation.totalStake,
      worstCasePayout: allocation.worstCasePayout,
      guaranteedProfit: allocation.guaranteedProfit,
      roundingRisk: allocation.roundingRisk,
      roiPercent: allocation.roiPercent,
    };
  }
  if (opp.type === 'middle' && Array.isArray(opp.legs)) {
    const half = stake / 2;
    const legs = opp.legs.map((leg) => ({ ...leg, stake: round2(half), payout: round2(half * leg.odds) }));
    return { ...opp, legs, totalStake: round2(stake), guaranteedProfit: null, roiPercent: opp.roiPercent };
  }
  if (opp.type === 'positive_ev') {
    const ev = (opp.evPercent || 0) / 100;
    const kelly = ev / (opp.odds - 1);
    const capped = Math.max(0, Math.min(0.05, Math.max(0, kelly)));
    const s = round2(stake * capped);
    const leg = { ...opp, stake: s, payout: round2(s * opp.odds), profit: round2(s * (opp.odds - 1)) };
    return { ...opp, legs: [leg], totalStake: s, guaranteedProfit: null, roiPercent: opp.evPercent };
  }
  return opp;
}

function commonRunId(sources) {
  const runIds = new Set(sources.map((source) => source.runId).filter(Boolean));
  return runIds.size === 1 ? [...runIds][0] : null;
}
