/**
 * End-to-end smoke test of the TinyFish-backed pipeline.
 * Requires the `tinyfish` CLI to be installed and authenticated.
 * Run with: ARBITER_DATA_DIR=$(pwd)/data node scripts/tinyfish-smoke.mjs
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import TinyfishScraper from '../src/scrapers/tinyfish-scraper.mjs';
import { TINYFISH_BOOKS } from '../src/tinyfish/books.mjs';
import { scanWorkspace } from '../src/scanner/scanner.mjs';

const dataDir = process.env.ARBITER_DATA_DIR || './data-smoke';
const book = process.argv[2] || 'superbet';
const sourceConfig = TINYFISH_BOOKS[book];
if (!sourceConfig) {
  console.error(`Unknown book "${book}". Try one of: ${Object.keys(TINYFISH_BOOKS).join(', ')}`);
  process.exit(2);
}
const requestedMax = Number.parseInt(process.argv[3] || '2', 10);
if (!Number.isInteger(requestedMax) || requestedMax < 1) {
  console.error('maxMatches must be a positive integer');
  process.exit(2);
}
const cfg = {
  ...sourceConfig,
  maxMatches: requestedMax,
  maxDiscoveredMatches: Math.min(sourceConfig.maxDiscoveredMatches || 100, 20),
  maxLiveMatches: Math.min(sourceConfig.maxLiveMatches || 100, 20),
};

console.log(`▶ TinyFish smoke test for ${cfg.name}`);
console.log(`  baseUrl: ${cfg.baseUrl}`);
console.log(`  maxMatches: ${cfg.maxMatches}`);
console.log(`  dataDir: ${dataDir}`);

if (!process.env.ARBITER_DATA_DIR || process.env.ARBITER_SMOKE_RESET === '1') {
  await rm(dataDir, { recursive: true, force: true });
}
await mkdir(join(dataDir, 'workspace'), { recursive: true });

const t0 = Date.now();
const scraper = new TinyfishScraper({ dataDir, logger: console.log, bookConfig: cfg });
const env = await scraper.run();
const t1 = Date.now();
console.log(`\nScrape finished in ${((t1 - t0) / 1000).toFixed(1)}s`);
console.log(`  valid: ${env.valid}`);
console.log(`  status: ${env.status}`);
console.log(`  events: ${env.events}`);
console.log(`  error: ${env.error?.message || 'none'}`);

if (!env.valid || env.events === 0) {
  console.error('\n✖ no events captured — check TinyFish config and book connectivity');
  process.exit(1);
}

// Now scan
console.log('\n▶ Running engine scan…');
const scan = await scanWorkspace({ dataDir, bankroll: 1000, minRoiPercent: 0 });
console.log(`  opportunities: ${scan.opportunities.length}`);
console.log(`  middles: ${scan.middles.length}`);
console.log(`  positive EV: ${scan.positiveEv.length}`);
console.log(`  low hold: ${scan.lowHold.length}`);

if (scan.opportunities.length > 0) {
  console.log('\n▶ Top 3 arbs:');
  for (const o of scan.opportunities.slice(0, 3).sort((a, b) => b.roiPercent - a.roiPercent)) {
    console.log(`  ${o.roiPercent.toFixed(2)}%  ${o.homeTeam} vs ${o.awayTeam} (${o.marketKey})`);
    for (const leg of o.legs) {
      console.log(`           ${leg.sourceId} ${leg.selection} @ ${leg.odds}`);
    }
  }
}

console.log('\n✓ smoke test complete');
