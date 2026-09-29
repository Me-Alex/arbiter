import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold, buildSelectionIndex } from './engine.mjs';
import { roundedArbitrageAllocation } from './market-contracts.mjs';
import { DATA_STATUS, isActionableKickoff, snapshotQuality, sourceHealthSummary } from '../shared/data-quality.mjs';
import { feedGroupOf, sharedFeedPeers } from './feed-groups.mjs';
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
  const altenarOffers = new Map();
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
    // Record the declared shared-feed group up front: an arbitrage needs legs
    // from feeds that can disagree, and a brand resold from one provider cannot
    // provide that. See feed-groups.mjs for the measured evidence.
    const groupId = feedGroupOf(source.sourceId);
    if (groupId) {
      source.feedGroup = groupId;
      source.sharedFeedWith = [...new Set([...(source.sharedFeedWith || []), ...sharedFeedPeers(source.sourceId)])];
    }
    if (source.dataStatus !== DATA_STATUS.FRESH || !source.runId || !source.sourceUrl || !source.transport) {
      if (source.dataStatus === DATA_STATUS.FRESH) {
        source.dataStatus = DATA_STATUS.PARTIAL;
        source.dataReason = 'snapshot is missing runId, sourceUrl, or transport provenance';
      }
      continue;
    }
    // A book that prices a market below its own break-even is not publishing a
    // real market: the inverse-odds sum of a three-way result market must
    // exceed 1, since that sum is the book's margin. Measured across the
    // capture, only contibet does this, at 9–22% depending on when it is read.
    //
    // The rate is reported for diagnosis, but it does not gate the events. A
    // source-level threshold is the wrong unit: at 9% the corrupt market is
    // let through and pairs with another book to fabricate a 6.6% opportunity,
    // while at 22% it would throw away the 78% of the feed that is sound. So the
    // individual markets are dropped instead, which keeps the good prices and
    // removes the fabricated ones.
    const margin = implausibleMarginRate(blob.events);
    if (margin.rate > 0) {
      source.implausibleMarginRate = margin.rate;
      source.implausibleMarginCount = margin.count;
      source.dataReason = `${margin.count} of ${margin.checked} 1X2 markets are priced below break-even (${(margin.rate * 100).toFixed(0)}%)`;
    }
    for (const rawEvent of blob.events) {
      // Drop only the market that is priced below its own break-even, keeping
      // the sound ones on the same event: one corrupt 1X2 inside an otherwise
      // good feed is enough to fabricate an opportunity, but discarding the
      // whole event throws away prices that are fine. The event is skipped only
      // when nothing usable is left.
      let event = rawEvent;
      if (hasImplausibleMarket(event)) {
        if (source.implausibleMarketCount === undefined) source.implausibleMarketCount = 0;
        source.implausibleMarketCount += 1;
        event = { ...rawEvent, markets: (rawEvent.markets || []).filter((m) => !isImplausible1x2(m)) };
        if (event.markets.length === 0) continue;
      }
      if (blob.transport === 'altenar-sb2-widget-json' && event.providerEventId) {
        // Identical provider event/outcome IDs and prices are shared-feed evidence,
        // not independently verified bookmaker offers. Keep provenance on sources.
        const fingerprint = JSON.stringify([event.providerEventId, event.kickoff,
          event.markets.map((m) => [m.id, m.key, m.period,
            m.selections.map((s) => [s.id, s.name, s.odds]).sort()]).sort()]);
        const original = altenarOffers.get(fingerprint);
        if (original && original !== source.sourceId) {
          source.duplicateFeedEvents = (source.duplicateFeedEvents || 0) + 1;
          source.sharedFeedWith = [...new Set([...(source.sharedFeedWith || []), original])];
          continue;
        }
        altenarOffers.set(fingerprint, source.sourceId);
      }
      events.push({ ...event, sourceId: event.sourceId || blob.sourceId, observedAt: source.observedAt, runId: source.runId });
    }
  }
  return { events, sources };
}

/**
 * Share of a source's complete 1X2 markets that are priced below break-even.
 *
 * The inverse-odds sum of a three-way result market must exceed 1: that is the
 * book's margin. A market under 1 pays out more than it takes in, which no real
 * book does. Used to flag a corrupt feed rather than to trust it — a small
 * share is noise, a large one means the prices cannot be arbitraged against.
 *
 * @param {Array} events
 * @returns {{ checked: number, count: number, rate: number }}
 */
export function implausibleMarginRate(events) {
  let checked = 0;
  let count = 0;
  for (const event of events || []) {
    for (const market of event?.markets || []) {
      if (!isComplete1x2(market)) continue;
      checked += 1;
      if (inverseSum(market) < 1) count += 1;
      break;
    }
  }
  return { checked, count, rate: checked === 0 ? 0 : count / checked };
}

/**
 * True when this event carries a three-way result market priced below its own
 * break-even, which no real book publishes.
 *
 * Checked per market rather than per source: one corrupt market inside an
 * otherwise sound feed is enough to fabricate an opportunity when it pairs with
 * another book, while the surrounding markets are still worth using.
 *
 * @param {object} event
 * @returns {boolean}
 */
export function hasImplausibleMarket(event) {
  return (event?.markets || []).some(isImplausible1x2);
}

/** True when this one market is a complete 1X2 priced below its own break-even. */
export function isImplausible1x2(market) {
  return isComplete1x2(market) && inverseSum(market) < 1;
}

function isComplete1x2(market) {
  const names = (market?.selections || []).map((s) => String(s.name || '').trim().toLowerCase());
  if (!(names.includes('1') && names.includes('x') && names.includes('2'))) return false;
  return (market.selections || []).filter((s) => {
    const o = Number(s.odds);
    return Number.isFinite(o) && o > 1;
  }).length >= 3;
}

function inverseSum(market) {
  return (market.selections || []).reduce((sum, s) => {
    const o = Number(s.odds);
    return Number.isFinite(o) && o > 1 ? sum + 1 / o : sum;
  }, 0);
}

/**
 * The scan settings a caller gets when it does not choose them.
 *
 * These were written out three times — as scanWorkspace's destructuring
 * defaults, again as `scanOptions.x ?? value` at the orchestrator's call site,
 * and a third time in resolveScanRequest — so a change to any one of them left
 * the other two disagreeing about what a default scan is. The orchestrator
 * imports this instead.
 *
 * @type {Readonly<{bankroll: number, minRoiPercent: number, minEvPercent: number,
 *   maxMiddleRiskPercent: number, minMiddleRoiPercent: number,
 *   includeLive: boolean, includePast: boolean}>}
 */
export const DEFAULT_SCAN_OPTIONS = Object.freeze({
  bankroll: 1000,
  minRoiPercent: 0,
  minEvPercent: 2,
  maxMiddleRiskPercent: 15,
  minMiddleRoiPercent: 20,
  includeLive: false,
  includePast: false,
});

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
    bankroll = DEFAULT_SCAN_OPTIONS.bankroll,
    minRoiPercent = DEFAULT_SCAN_OPTIONS.minRoiPercent,
    minEvPercent = DEFAULT_SCAN_OPTIONS.minEvPercent,
    maxMiddleRiskPercent = DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
    minMiddleRoiPercent = DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
    includeLive = DEFAULT_SCAN_OPTIONS.includeLive,
    includePast = DEFAULT_SCAN_OPTIONS.includePast,
    publish = true,
    prematchMaxAgeMs,
    liveMaxAgeMs,
    sport = null,
  } = args;

  const qualityOptions = { prematchMaxAgeMs, liveMaxAgeMs, expectedRunId: scrapeRunId };
  const { events, sources } = await loadWorkspace(dataDir, qualityOptions);
  // Markets priced below break-even were already dropped, per market, in
  // loadWorkspace. A source-level exclusion is deliberately NOT applied here:
  // contibet measures 9% on the current capture and 22% on an older one, so any
  // threshold either lets a corrupt market through or discards a mostly sound
  // feed depending on when the scrape happened.
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
  const positiveEv = findPositiveEV(grouped, { minEvPercent }).map((opportunity) => withBankroll(opportunity, bankroll));
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
      minEvPercent,
      maxMiddleRiskPercent,
      minMiddleRoiPercent,
      includeLive,
      includePast,
      sourceIds: sourceIds || null,
      sport,
      prematchMaxAgeMs,
      liveMaxAgeMs,
    },
    sources,
    eventCount: filtered.length,
    opportunities,
    middles,
    positiveEv,
    lowHold,
    verificationSummary: { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0 },
  };

  // Verification consumes the very same eligible observations, never signal winners.
  if (args.onEligibleSelections) args.onEligibleSelections(buildSelectionIndex(actionableEvents));
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
