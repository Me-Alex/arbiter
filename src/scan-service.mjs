import { join } from 'node:path';
import { scanWorkspace, scanEnvelope, scanOptionsPayload } from './scanner/scanner.mjs';
import { readJson } from './shared/atomic-write.mjs';
import { csvRow } from './shared/csv.mjs';

/**
 * scan-service — thin wrappers around the scanner entry point so the router
 * doesn't have to know file paths.
 */

/**
 * The finding families and verification counters that sit on top of the
 * envelope. An empty scan is a real scan that found nothing, not a different
 * kind of object — it must carry every key a populated scan carries so a
 * consumer can read a field without first checking whether the scan ran.
 *
 * A factory, not a shared frozen literal: the orchestrator hands this scan on
 * to verification, which rewrites the families, and a frozen array shared
 * between every empty scan would make one caller's mutation land on the next
 * caller's object.
 */
const emptyFindings = () => ({
  opportunities: [],
  middles: [],
  positiveEv: [],
  lowHold: [],
  verificationSummary: { confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0 },
});

/**
 * A scan shaped exactly like a real one, with no findings in it.
 *
 * This used to be a hand-written 9-key object living beside a second
 * hand-written 8-key copy in readLatestScan, and neither matched the 14 keys
 * scanWorkspace actually writes: `id`, `options`, `scrapedAt`, `scanStartedAt`
 * and `verificationSummary` were missing, so a dashboard that hit a failed run
 * read `undefined` for the settings the scan was made under and for when the
 * data was captured. The orchestrator publishes this on every failed or
 * cancelled scrape, so that is the common case, not the rare one.
 *
 * @param {{ scrapeRunId?: string|null, options?: object|null }} [args]
 * @returns {object} A scan in the full published shape.
 */
export function emptyScan({ scrapeRunId = null, options = null } = {}) {
  return {
    ...scanEnvelope({ scrapeRunId, sources: [], eventCount: 0, options: options || scanOptionsPayload() }),
    ...emptyFindings(),
  };
}

export async function runScan(args) {
  return await scanWorkspace(args);
}

export async function readLatestScan(dataDir) {
  // Before this called emptyScan, the two disagreed with each other on
  // `scrapeRunId` and with a real scan on five more keys.
  return (await readPublishedScan(dataDir)).scan;
}

/**
 * The latest scan plus whether one has ever been published.
 *
 * The two questions have to be answered from a single read, and the second
 * one cannot be answered from the scan itself: `emptyScan()` still mints an
 * `id` of `scan-<timestamp>` and a `scrapedAt` of now, because it is handed
 * straight to the verification pass as a real target. So "no scan exists yet"
 * and "a scan ran and found nothing above the threshold" produce byte-identical
 * documents — a page that reads only the findings would sit on an honest empty
 * list forever and claim the market was quiet when it had simply never run.
 *
 * @param {string} dataDir
 * @returns {Promise<{scan: object, published: boolean}>}
 */
export async function readPublishedScan(dataDir) {
  const stored = await readJson(join(dataDir, 'latest-scan.json'), null);
  return { scan: stored || emptyScan(), published: stored !== null };
}

export async function readLatestCatalog(dataDir) {
  return await readJson(join(dataDir, 'latest-market-catalog.json'), null);
}

export async function readLatestScrapeRun(dataDir) {
  return await readJson(join(dataDir, 'latest-scrape-run.json'), null);
}

/**
 * Render the findings of a scan as CSV.
 *
 * The dashboard links directly to this (public/index.html), so the output has
 * to be a valid spreadsheet file with no dependency on the browser: CRLF line
 * endings, a header row, and quoting on any value containing a delimiter, a
 * quote or a newline.
 *
 * @param {object|null} scan  A scan as persisted in latest-scan.json.
 * @param {string[]} [types]  Signal families to include, e.g. ['opportunities',
 *                             'middles', 'positiveEv', 'lowHold']. Omit or pass
 *                             an empty list to export every family.
 * @param {string} [sport]    The sport selection to export, exactly as the page
 *                             applies it to its tables: empty exports every
 *                             record, otherwise only records whose own `sport`
 *                             matches. Omit to export every sport.
 * @returns {string} CSV text.
 */
export function buildScanCsv(scan, types = [], sport = '') {
  // Callers may pass a single comma-joined value ("?type=middles,lowHold") or
  // a list, so split here rather than relying on each route to do it.
  const wanted = new Set(
    (Array.isArray(types) ? types : [types])
      .flatMap((t) => String(t ?? '').split(','))
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const include = (family) => wanted.size === 0 || wanted.has(family.toLowerCase());

  // The same rule the page applies to its tables (`filterBySport`), so the file
  // holds what the selection on screen shows. Two decisions mirrored on purpose.
  // Case, because the control offers the registry's lowercase id (`football`)
  // while the records carry the event's own spelling (`Football`), and a
  // case-sensitive match here would export a header-only file for the one sport
  // the page can select. And no default: a record the engine could not classify
  // belongs to no sport, so under a selection it is dropped — the same rows the
  // table drops, rather than a file claiming to be the view and holding more.
  const wantedSport = String(sport ?? '').trim().toLowerCase();
  const sameSport = (o) => !wantedSport || String(o.sport || '').toLowerCase() === wantedSport;

  // A signal family is exported one row per leg, not one row per opportunity:
  // the per-leg book/selection/odds/stake is what a trader actually places,
  // and opportunity-level totals are repeated so the file stays self-contained.
  const rows = [];

  if (include('opportunities')) {
    for (const o of asArray(scan?.opportunities)) {
      if (!sameSport(o)) continue;
      for (const leg of asArray(o.legs)) {
        rows.push([
          'opportunity',
          o.sport, o.league, o.kickoff, o.homeTeam, o.awayTeam,
          o.marketKey,
          leg.sourceId, leg.selection, leg.outcome, leg.odds, leg.handicap,
          leg.stake, leg.payout, leg.profit,
          o.inverseSum, o.marginPercent,
          o.totalStake, o.worstCasePayout, o.guaranteedProfit, o.roundingRisk,
          // riskPercent/gap belong to the middle family; an opportunity has
          // neither, and omitting them here shifted every later column left.
          '', '',
          o.verification?.status ?? '', o.verification?.reason ?? '',
          csvScope(o),
        ]);
      }
    }
  }

  if (include('middles')) {
    for (const o of asArray(scan?.middles)) {
      if (!sameSport(o)) continue;
      for (const leg of asArray(o.legs)) {
        rows.push([
          'middle',
          o.sport, o.league, o.kickoff, o.homeTeam, o.awayTeam,
          o.marketKey,
          leg.sourceId, leg.selection, leg.outcome, leg.odds, leg.handicap,
          leg.stake, leg.payout, leg.profit,
          '', o.roiPercent, '', '', '', '',
          o.riskPercent, o.gap ?? '',
          o.verification?.status ?? '', o.verification?.reason ?? '',
          csvScope(o),
        ]);
      }
    }
  }

  if (include('positiveEv')) {
    for (const o of asArray(scan?.positiveEv)) {
      if (!sameSport(o)) continue;
      rows.push([
        'positiveEv',
        // Only the sport is published on this family; the other four identity
        // columns stay empty because the engine does not emit them, and an
        // empty cell is a true statement about a field nobody reads.
        o.sport, '', '', '', '',
        o.marketKey,
        o.sourceId, o.selection, '', o.odds, '',
        '', '', '',
        '', o.evPercent,
        o.totalStake ?? '', '', o.guaranteedProfit ?? '', '',
        '', o.consensusProbability,
        '', '',
        csvScope(o),
      ]);
    }
  }

  if (include('lowHold')) {
    for (const o of asArray(scan?.lowHold)) {
      if (!sameSport(o)) continue;
      rows.push([
        'lowHold',
        o.sport, '', '', '', '',
        o.marketKey,
        o.sourceId, '', '', '', '',
        '', '', '',
        '', '', '', '', '', '',
        o.holdPercent, o.selectionCount,
        '', '',
        // findLowHold does not emit `live`, so this lands on the helper's
        // not-measured case. It goes through csvScope anyway, rather than
        // hardcoding '', so that if the engine ever starts recording the scope
        // here the export picks it up instead of quietly claiming 'prematch'.
        csvScope(o),
      ]);
    }
  }

  const header = [
    'type', 'sport', 'league', 'kickoff', 'homeTeam', 'awayTeam', 'marketKey',
    'sourceId', 'selection', 'outcome', 'odds', 'handicap',
    'stake', 'payout', 'profit',
    'inverseSum', 'marginPercent',
    'totalStake', 'worstCasePayout', 'guaranteedProfit', 'roundingRisk',
    'riskPercent', 'gap',
    'verificationStatus', 'verificationReason',
    // Appended last on purpose: a column inserted mid-row shifts every later
    // column and silently re-points an existing export at the wrong field.
    'scope',
  ];
  return [header, ...rows].map((cells) => csvRow(cells)).join('\r\n');
}

/**
 * The pairing scope a signal was built in, in the same vocabulary the engine
 * uses (`pairingScope`): a live price and a pre-match price are different
 * products, so the scope travels with the row rather than being inferred from
 * the kickoff. Signals that carry no `live` yield an empty cell, which is a
 * different statement from 'prematch'.
 */
function csvScope(o) {
  return o.live === true ? 'live' : o.live === false ? 'prematch' : '';
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}
