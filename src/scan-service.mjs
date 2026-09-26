import { join } from 'node:path';
import { scanWorkspace } from './scanner/scanner.mjs';
import { readJson } from './shared/atomic-write.mjs';

/**
 * scan-service — thin wrappers around the scanner entry point so the router
 * doesn't have to know file paths.
 */

/**
 * Return an empty scan result with the correct schema shape.
 * @param {{ scrapeRunId?: string }} opts
 */
export function emptyScan({ scrapeRunId = null } = {}) {
  return {
    schemaVersion: 2,
    scrapeRunId,
    dataHealth: { status: 'empty', actionableSourceCount: 0, sources: {} },
    opportunities: [],
    middles: [],
    positiveEv: [],
    lowHold: [],
    sources: [],
    eventCount: 0,
  };
}

export async function runScan(args) {
  return await scanWorkspace(args);
}

export async function readLatestScan(dataDir) {
  const scan = await readJson(join(dataDir, 'latest-scan.json'), null);
  if (scan) return scan;
  return {
    schemaVersion: 2,
    dataHealth: { status: 'empty', actionableSourceCount: 0, sources: {} },
    opportunities: [],
    middles: [],
    positiveEv: [],
    lowHold: [],
    sources: [],
    eventCount: 0,
  };
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
 * @returns {string} CSV text.
 */
export function buildScanCsv(scan, types = []) {
  // Callers may pass a single comma-joined value ("?type=middles,lowHold") or
  // a list, so split here rather than relying on each route to do it.
  const wanted = new Set(
    (Array.isArray(types) ? types : [types])
      .flatMap((t) => String(t ?? '').split(','))
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const include = (family) => wanted.size === 0 || wanted.has(family.toLowerCase());

  // A signal family is exported one row per leg, not one row per opportunity:
  // the per-leg book/selection/odds/stake is what a trader actually places,
  // and opportunity-level totals are repeated so the file stays self-contained.
  const rows = [];

  if (include('opportunities')) {
    for (const o of asArray(scan?.opportunities)) {
      for (const leg of asArray(o.legs)) {
        rows.push([
          'opportunity',
          o.sport, o.league, o.kickoff, o.homeTeam, o.awayTeam,
          o.marketKey,
          leg.sourceId, leg.selection, leg.outcome, leg.odds, leg.handicap,
          leg.stake, leg.payout, leg.profit,
          o.inverseSum, o.roiPercent,
          o.totalStake, o.worstCasePayout, o.guaranteedProfit, o.roundingRisk,
          // riskPercent/gap belong to the middle family; an opportunity has
          // neither, and omitting them here shifted every later column left.
          '', '',
          o.verification?.status ?? '', o.verification?.reason ?? '',
        ]);
      }
    }
  }

  if (include('middles')) {
    for (const o of asArray(scan?.middles)) {
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
        ]);
      }
    }
  }

  if (include('positiveEv')) {
    for (const o of asArray(scan?.positiveEv)) {
      rows.push([
        'positiveEv',
        '', '', '', '', '',
        o.marketKey,
        o.sourceId, o.selection, '', o.odds, '',
        '', '', '',
        '', o.evPercent,
        o.totalStake ?? '', '', o.guaranteedProfit ?? '', '',
        '', o.consensusProbability,
        '', '',
      ]);
    }
  }

  if (include('lowHold')) {
    for (const o of asArray(scan?.lowHold)) {
      rows.push([
        'lowHold',
        '', '', '', '', '',
        o.marketKey,
        o.sourceId, '', '', '', '',
        '', '', '',
        '', '', '', '', '', '',
        o.holdPercent, o.selectionCount,
        '', '',
      ]);
    }
  }

  const header = [
    'type', 'sport', 'league', 'kickoff', 'homeTeam', 'awayTeam', 'marketKey',
    'sourceId', 'selection', 'outcome', 'odds', 'handicap',
    'stake', 'payout', 'profit',
    'inverseSum', 'roiPercent',
    'totalStake', 'worstCasePayout', 'guaranteedProfit', 'roundingRisk',
    'riskPercent', 'gap',
    'verificationStatus', 'verificationReason',
  ];
  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
