/**
 * sample.mjs — repeated live capture, reporting how close the market gets to a
 * cross-feed arbitrage on each round.
 *
 * This answers a question a single scrape cannot: whether the near-zero best
 * return seen in one capture is stable or an accident of that moment. Run it
 * over several hours (or leave the scheduler on) and read the distribution.
 *
 * It deliberately reports the *best* cross-feed combination per round, even
 * when negative. A negative best means every pairing of prices across
 * independent bookmakers still costs more than it returns, which is what a
 * well-arbitraged market looks like; a positive one would be a real finding.
 *
 * Usage:
 *   node scripts/sample.mjs                                  # default books, 3 rounds
 *   node scripts/sample.mjs superbet,netbet 5 120000          # books, rounds, gap ms
 *
 * Writes nothing outside temporary directories; never touches data/.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';
import { groupByEvent } from '../src/scanner/engine.mjs';
import { isMatchResultMarket, canonicalOutcome } from '../src/scanner/market-contracts.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';

const DEFAULT_BOOKS = 'superbet,netbet,betano,winner,fortuna,admiral,maxbet';

const books = (process.argv[2] || DEFAULT_BOOKS).split(',').map((b) => b.trim()).filter(Boolean);
const rounds = Number(process.argv[3] || 3);
const gapMs = Number(process.argv[4] || 120000);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { jobs } = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
const byId = new Map(jobs.map((j) => [j.id, j]));

/**
 * Best cross-feed return available in this set of events, and how many
 * cross-feed 1X2 buckets were examined to find it.
 */
function measure(events) {
  let best = null;
  let buckets = 0;
  for (const [, instances] of groupByEvent(events)) {
    if (instances.length < 2) continue;
    const legs = new Map();
    for (const ev of instances) {
      for (const m of ev.markets || []) {
        if (!isMatchResultMarket(m)) continue;
        for (const s of m.selections || []) {
          const outcome = canonicalOutcome(s.name, { marketKey: m.key, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam });
          const odds = Number(s.odds);
          if (!outcome || !Number.isFinite(odds) || odds <= 1) continue;
          if (!legs.has(outcome)) legs.set(outcome, new Map());
          const best_ = legs.get(outcome);
          if (!best_.has(ev.sourceId) || odds > best_.get(ev.sourceId)) best_.set(ev.sourceId, odds);
        }
      }
    }
    if (legs.size < 3) continue;
    const options = ['home', 'draw', 'away'].map((o) => [...legs.get(o).entries()]);
    let chosen = null;
    const walk = (i, acc) => {
      if (i === 3) {
        // An arbitrage needs legs that can disagree: two brands of one feed
        // resold by the same provider cannot provide an edge.
        for (let a = 0; a < 3; a += 1) {
          for (let b = a + 1; b < 3; b += 1) if (isSharedFeed(acc[a][0], acc[b][0])) return;
        }
        const inverseSum = acc.reduce((sum, x) => sum + 1 / x[1], 0);
        if (!chosen || inverseSum < chosen.inverseSum) chosen = { inverseSum, acc };
        return;
      }
      for (const c of options[i]) walk(i + 1, [...acc, c]);
    };
    walk(0, []);
    if (!chosen) continue;
    buckets += 1;
    const roiPercent = (1 / chosen.inverseSum - 1) * 100;
    if (!best || roiPercent > best.roiPercent) {
      best = {
        roiPercent,
        home: instances[0].homeTeam,
        away: instances[0].awayTeam,
        books: chosen.acc.map((x) => x[0]).join('+'),
      };
    }
  }
  return { best, buckets };
}

const results = [];

for (let round = 1; round <= rounds; round += 1) {
  const dataDir = await fs.mkdtemp(join(tmpdir(), `arb-sample-${round}-`));
  await fs.mkdir(join(dataDir, 'workspace'), { recursive: true });

  const events = [];
  for (const id of books) {
    const job = byId.get(id);
    if (!job || job.enabled === false) {
      console.log(`  ${id}: skipped (not an enabled job)`);
      continue;
    }
    const scraper = instantiate(id, { jobConfig: job, dataDir });
    const report = await scraper.run({});
    if (!report.valid) {
      console.log(`  ${id}: ${report.status} ${report.reason || ''}`);
      continue;
    }
    const [file] = (await fs.readdir(join(dataDir, 'workspace'))).filter((f) => f.startsWith(id));
    const snap = JSON.parse(await fs.readFile(join(dataDir, 'workspace', file), 'utf8'));
    for (const e of snap.events || []) events.push({ ...e, sourceId: snap.sourceId || id });
  }

  const { best, buckets } = measure(events);
  const at = new Date().toISOString().slice(11, 19);
  const line = `round ${round} ${at} | events ${String(events.length).padStart(4)} | cross-feed buckets ${String(buckets).padStart(4)} | best ROI ${best ? `${best.roiPercent.toFixed(2)}%` : 'n/a'}${best ? ` (${best.home} vs ${best.away}, ${best.books})` : ''}`;
  console.log(line);
  results.push(best ? best.roiPercent : null);

  await fs.rm(dataDir, { recursive: true, force: true });
  if (round < rounds) await new Promise((r) => setTimeout(r, gapMs));
}

const seen = results.filter((r) => r !== null);
if (seen.length > 0) {
  const positive = seen.filter((r) => r > 0);
  console.log('');
  console.log(`rounds measured: ${seen.length} | best ROI per round: ${seen.map((r) => `${r.toFixed(2)}%`).join(', ')}`);
  console.log(`rounds with a positive (real) arbitrage: ${positive.length}`);
  if (positive.length === 0) {
    console.log('=> no arbitrage on these feeds in this window; the market is well arbitraged.');
  }
}
