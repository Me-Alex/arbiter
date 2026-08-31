import { join } from 'node:path';
import { scanWorkspace } from './scanner/scanner.mjs';
import { readJson } from './shared/atomic-write.mjs';

/**
 * scan-service — thin wrappers around the scanner entry point so the router
 * doesn't have to know file paths.
 */

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

export async function buildCatalog(dataDir, scan) {
  const { buildMarketCatalog } = await import('./scanner/market-catalog.mjs');
  return await buildMarketCatalog(dataDir, scan);
}
