/** Read-only, bounded capture audit. No workspace snapshots or config writes. */
import { readFile, writeFile } from 'node:fs/promises';
import { instantiate } from '../src/scrapers/index.mjs';
import { feedGroupOf } from '../src/scanner/feed-groups.mjs';

const { jobs } = JSON.parse(await readFile(new URL('../config/scrapers.json', import.meta.url)));
const additions = ['vipbet', 'mrplay', '888sport', 'bet7'];
const controls = ['winner', 'superbet', 'betmen', 'maxbet'];
const records = {};
const failures = {};
const startedAt = new Date().toISOString();

for (const id of [...controls, ...additions]) {
  const job = jobs.find((job) => job.id === id);
  const scraper = instantiate(id, { jobConfig: { ...job, enabled: true }, maxEvents: 'all' });
  try {
    const raw = await scraper.fetchRaw({ signal: AbortSignal.timeout(30000) });
    const events = scraper.validate(scraper.extractEvents(scraper.normalize(raw)));
    records[id] = events.flatMap((event) => {
      const market = event.markets.find((market) => market.period === 'fulltime'
        && market.selections.length === 3
        && ['1', 'X', '2'].every((name) => market.selections.some((s) => s.name === name)));
      if (!market) return [];
      return [{ key: event.eventKey, id: event.id, sourceUrl: event.sourceUrl,
        odds: ['1', 'X', '2'].map((name) => market.selections.find((s) => s.name === name).odds) }];
    });
    console.log(id, records[id].length, 'complete 1X2 events');
    if (additions.includes(id)) {
      // Keep actual rows verbatim, including their timestamps and prices.
      // Full cohorts are retained below for repeatable independence counting.
      const selected = new Set(records[id].slice(0, 8).map((event) => event.id));
      const subset = id === 'vipbet'
        ? { containers: raw.containers.map((container) => ({ ...container, body: { ...container.body,
          events: Object.fromEntries(Object.entries(container.body.events || {}).filter(([, event]) => selected.has(String(event.sportEventId)))),
        } })).filter((container) => Object.keys(container.body.events).length) }
        : { ...raw, data: { ...raw.data, events: raw.data.events.filter((event) => selected.has(String(event.idMatch))) } };
      const capture = { provenance: { book: id, sourceUrl: scraper.sourceUrl, capturedAt: scraper.observedAt,
        note: 'Actual public response subset: first eight accepted football events; event fields, prices and times unchanged.',
      }, raw: subset };
      await writeFile(new URL(`../data/endpoints/captures/${id}-odds-2026-10-08.json`, import.meta.url), JSON.stringify(capture, null, 2) + '\n');
    }
  } catch (error) {
    failures[id] = error.message;
    console.log(id, 'FAILED', error.message);
  }
}

function coverage(ids) {
  const groups = new Map();
  for (const id of ids) for (const event of records[id] || []) {
    if (!groups.has(event.key)) groups.set(event.key, new Set());
    groups.get(event.key).add(feedGroupOf(id) || id);
  }
  return { fixtures: groups.size, twoPlus: [...groups.values()].filter((set) => set.size >= 2).length,
    threePlus: [...groups.values()].filter((set) => set.size >= 3).length };
}
const pairs = [];
const ids = Object.keys(records);
for (let i = 0; i < ids.length; i++) for (const b of ids.slice(i + 1)) {
  const a = ids[i];
  const right = new Map(records[b].map((event) => [event.key, event]));
  const shared = records[a].filter((event) => right.has(event.key));
  pairs.push({ a, b, shared: shared.length,
    identical: shared.filter((event) => JSON.stringify(event.odds) === JSON.stringify(right.get(event.key).odds)).length,
    sameDeclaredFeed: (feedGroupOf(a) || a) === (feedGroupOf(b) || b) });
}
const report = { startedAt, finishedAt: new Date().toISOString(), controls, additions,
  method: 'Canonical team + exact kickoff identity, complete full-time 1X2 only. Sequential captures; price differences alone do not prove independence. Controls are a sample, not the whole registry.',
  before: coverage(controls), withVipbet: coverage([...controls, 'vipbet']),
  withDigitainAliases: coverage([...controls, 'mrplay', '888sport', 'bet7']),
  after: coverage(ids), pairs, failures, records };
await writeFile(new URL('../docs/new-source-measurement.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ before: report.before, after: report.after, pairs }, null, 2));
if (Object.keys(failures).length) process.exitCode = 1;
