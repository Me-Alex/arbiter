/**
 * measure.mjs — accumulate cross-feed measurements over time, using the same
 * code path the scanner uses.
 *
 * The question this answers is "is there an arbitrage right now", and the
 * honest answer needs repetition: a single capture is an anecdote. Eleven
 * ad-hoc rounds are written into a document and never revisited; a series is
 * something a person can look at and see a trend, or a book that quietly
 * stopped contributing.
 *
 * The difference from scripts/sample.mjs is that this one records. Each run
 * appends a row to a dated journal, and the summary it prints is the same
 * series the document will cite. That is the point: the numbers quoted in
 * docs/no-arbitrage-root-cause.md should be reproducible by running this, not
 * by re-deriving them by hand.
 *
 * It measures on the same footing the gate does — the same adapters, the same
 * normalisation, the same engine — so a regression in a scraper shows up here
 * as fewer buckets rather than as a mysteriously different number.
 *
 * Usage:
 *   npm run measure                       # default book set, one round
 *   npm run measure -- superbet,netbet 3  # named books, three rounds
 *   npm run measure -- --gap 90000        # milliseconds between rounds
 *
 * Writes data/measurements.jsonl (gitignored) and prints a summary.
 * Exits 0 regardless of the result: a negative return is a finding, not a
 * failure. Only a scraper error is reported, and it is still recorded.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';
import { groupByEvent } from '../src/scanner/engine.mjs';
import { isMatchResultMarket, canonicalOutcome } from '../src/scanner/market-contracts.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JOURNAL = join(ROOT, 'data', 'measurements.jsonl');

const DEFAULT_BOOKS = 'superbet,netbet,admiral,winner,fortuna,maxbet,don';

const args = process.argv.slice(2);
let gapMs = 60_000;
let books = DEFAULT_BOOKS;
let rounds = 1;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--gap') gapMs = Number(args[++i]);
  else if (args[i] === '--rounds') rounds = Number(args[++i]);
  else books = args[i];
}
const bookIds = books.split(',').map((b) => b.trim()).filter(Boolean);
rounds = Math.max(1, Math.min(Number(rounds) || 1, 10));

const { jobs } = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
const byId = new Map(jobs.map((j) => [j.id, j]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One round: collect from every book, then pair only feeds that can disagree.
 *
 * A bucket is an event seen by two or more books whose events share an
 * identity key; the legs must come from different upstream feeds, because two
 * brands resold from one provider are one price counted twice.
 */
async function round() {
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'arbiter-measure-'));
  const collected = [];
  const errors = [];

  await Promise.all(bookIds.map(async (id) => {
    const job = byId.get(id);
    if (!job || job.enabled === false) return;
    try {
      const scraper = instantiate(id, { jobConfig: job, dataDir, maxEvents: 200, timeoutMs: 60_000 });
      const events = scraper.extractEvents(scraper.normalize(await scraper.fetchRaw()));
      collected.push(...events.map((e) => ({ ...e, sourceId: id })));
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }));
  await fs.rm(dataDir, { recursive: true, force: true });

  let best = null;
  let buckets = 0;
  for (const [, instances] of groupByEvent(collected)) {
    for (const market of instances[0].markets || []) {
      if (!isMatchResultMarket(market)) continue;
      const priced = instances
        .filter((e) => (e.markets || []).some((m) => m.key === market.key))
        .map((e) => ({
          sourceId: e.sourceId,
          picks: e.markets.find((m) => m.key === market.key).selections
            .map((s) => ({
              outcome: canonicalOutcome(s.name, { marketKey: market.key, homeTeam: e.homeTeam, awayTeam: e.awayTeam }),
              odds: Number(s.odds),
            })),
        }))
        .filter((p) => p.picks.filter((x) => x.outcome).length === 3);
      if (priced.length < 2) continue;

      for (let a = 0; a < priced.length; a += 1) {
        for (let b = a + 1; b < priced.length; b += 1) {
          if (isSharedFeed(priced[a].sourceId, priced[b].sourceId)) continue;
          const legs = [];
          for (const outcome of ['home', 'draw', 'away']) {
            const pickA = priced[a].picks.find((p) => p.outcome === outcome);
            const pickB = priced[b].picks.find((p) => p.outcome === outcome);
            if (!pickA || !pickB) { legs.length = 0; break; }
            legs.push(pickA.odds > pickB.odds ? { ...pickA, sourceId: priced[a].sourceId } : { ...pickB, sourceId: priced[b].sourceId });
          }
          if (legs.length !== 3) continue;
          buckets += 1;
          const inverse = legs.reduce((s, l) => s + 1 / l.odds, 0);
          const roi = (1 / inverse - 1) * 100;
          if (!best || roi > best.roiPercent) {
            const e = instances[0];
            best = {
              roiPercent: Math.round(roi * 100) / 100,
              event: `${e.homeTeam} v ${e.awayTeam}`,
              books: legs.map((l) => l.sourceId).filter((v, i, a) => a.indexOf(v) === i),
            };
          }
        }
      }
    }
  }

  return {
    at: new Date().toISOString(),
    books: bookIds,
    events: collected.length,
    crossFeedPairs: buckets,
    best,
    errors,
  };
}

const rows = [];
for (let i = 0; i < rounds; i += 1) {
  if (i > 0) await sleep(gapMs);
  const r = await round();
  rows.push(r);
  const b = r.best
    ? `${r.best.roiPercent.toFixed(2)}% (${r.best.event}, ${r.best.books.join('+')})`
    : 'n/a';
  console.log(`round ${i + 1} ${r.at} | events ${String(r.events).padStart(4)} | cross-feed pairs ${String(r.crossFeedPairs).padStart(4)} | best ${b}`);
  for (const e of r.errors) console.log(`  ${e.id} failed: ${e.error.slice(0, 90)}`);
}

// Append, so the series grows rather than being overwritten. One JSON object
// per line keeps it greppable and append-safe without a rewrite.
await fs.mkdir(join(ROOT, 'data'), { recursive: true });
await fs.appendFile(JOURNAL, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const positive = rows.filter((r) => r.best && r.best.roiPercent > 0);
console.log(`\nrounds: ${rows.length} | with a positive cross-feed return: ${positive.length}`);
console.log(`appended to ${JOURNAL}`);
if (positive.length === 0) {
  console.log('A negative return is the expected shape of an arbitraged market — not a failure.');
}
