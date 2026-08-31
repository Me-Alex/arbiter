import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCatalog } from '../src/scanner/market-catalog.mjs';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('buildMarketCatalog walks workspace files and writes latest-market-catalog.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-cat-'));
  await mkdir(join(dir, 'workspace'), { recursive: true });
  const e1 = {
    id: 'a1', sourceId: 'a', eventKey: 'football|liga 1|2030-01-01|fcsb|cfr',
    sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
    homeTeam: 'FCSB', awayTeam: 'CFR',
    markets: [
      { key: 'MATCH_ODDS', name: 'Match Odds', selections: [{ name: 'H', odds: 1.85 }] },
      { key: 'OVER_UNDER_25', name: 'O/U 2.5', selections: [{ name: 'Over', odds: 1.90 }] },
    ],
  };
  await writeFile(join(dir, 'workspace', 'a_events.json'), JSON.stringify({ sourceId: 'a', capturedAt: 'x', events: [e1] }));
  const scan = { sources: [{ sourceId: 'a', file: 'a_events.json', capturedAt: 'x', count: 1 }] };
  const cat = await buildMarketCatalog(dir, scan);
  assert.equal(cat.markets.length, 2);
  assert.equal(cat.events.length, 1);
  const persisted = JSON.parse(await readFile(join(dir, 'latest-market-catalog.json'), 'utf8'));
  assert.equal(persisted.markets.length, 2);
  await rm(dir, { recursive: true });
});
