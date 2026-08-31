import { join } from 'node:path';
import { writeJsonAtomic, readJson } from '../shared/atomic-write.mjs';

/**
 * Market catalog: every unique market offered by every bookmaker, grouped by
 * sport / league / eventKey. Browsable from /admin/analytics#catalog.
 *
 * The catalog is a denormalized view of the latest-scan.json sources — easier
 * to navigate than raw event lists because it surfaces (sourceId, marketKey)
 * pairs that show up in workspace data.
 */

export async function buildMarketCatalog(dataDir, scan) {
  const dir = join(dataDir, 'workspace');
  const sources = (scan && scan.sources) || [];
  const catalog = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    scrapeRunId: scan ? scan.scrapeRunId : null,
    sources,
    markets: [],
    events: [],
  };
  const marketKeyMap = new Map();
  const eventMap = new Map();

  for (const src of sources) {
    const blob = await readJson(join(dir, src.file), null);
    if (!blob || !Array.isArray(blob.events)) continue;
    for (const e of blob.events) {
      const eventKey = e.eventKey;
      if (eventKey) {
        let ev = eventMap.get(eventKey);
        if (!ev) {
          ev = {
            eventKey,
            sport: e.sport,
            league: e.league,
            kickoff: e.kickoff,
            homeTeam: e.homeTeam,
            awayTeam: e.awayTeam,
            sources: new Set(),
            marketKeys: new Set(),
            selectionCount: 0,
          };
          eventMap.set(eventKey, ev);
        }
        ev.sources.add(src.sourceId);
      }
      for (const m of e.markets || []) {
        const k = `${src.sourceId}::${m.key}`;
        let entry = marketKeyMap.get(k);
        if (!entry) {
          entry = {
            sourceId: src.sourceId,
            marketKey: m.key,
            marketName: m.name || m.key,
            eventCount: 0,
            selectionCount: 0,
          };
          marketKeyMap.set(k, entry);
        }
        entry.eventCount += 1;
        entry.selectionCount += (m.selections || []).length;
        if (eventKey) {
          const ev = eventMap.get(eventKey);
          if (ev) ev.marketKeys.add(m.key);
        }
        if (eventKey) {
          const ev = eventMap.get(eventKey);
          if (ev) ev.selectionCount += (m.selections || []).length;
        }
      }
    }
  }
  catalog.markets = [...marketKeyMap.values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) || a.marketKey.localeCompare(b.marketKey));
  catalog.events = [...eventMap.values()].map((e) => ({
    ...e,
    sources: [...e.sources],
    marketKeys: [...e.marketKeys],
  }));
  await writeJsonAtomic(join(dataDir, 'latest-market-catalog.json'), catalog);
  return catalog;
}
