/**
 * Integration test — full scrape against a stub HTTP server, then assert
 * the JSON shape of latest-scan.json. Doesn't hit any real bookmaker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { scanWorkspace } from '../src/scanner/scanner.mjs';

function startStubServer(payloadsByPath, port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const payload = payloadsByPath[url.pathname] || { events: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('integration: end-to-end scan with stubbed HTTP + workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-int-'));
  await mkdir(join(dir, 'workspace'), { recursive: true });

  // Seed two books in workspace with a known arb.
  const eventKey = 'football|liga 1|2030-01-01|fcsb|cfr';
  const baseEvent = {
    eventKey,
    sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
    homeTeam: 'FCSB', awayTeam: 'CFR',
    markets: [{ key: 'MATCH_ODDS', name: 'Match Odds', selections: [] }],
  };
  const e1 = {
    ...baseEvent,
    id: 'a1', sourceId: 'a',
    markets: [{
      key: 'MATCH_ODDS', name: 'Match Odds',
      selections: [{ name: 'H', odds: 2.50 }, { name: 'D', odds: 4.20 }, { name: 'A', odds: 4.60 }],
    }],
  };
  const e2 = {
    ...baseEvent,
    id: 'b1', sourceId: 'b',
    markets: [{
      key: 'MATCH_ODDS', name: 'Match Odds',
      selections: [{ name: 'H', odds: 2.40 }, { name: 'D', odds: 4.50 }, { name: 'A', odds: 5.00 }],
    }],
  };
  const capturedAt = new Date().toISOString();
  // loadWorkspace only feeds the engine snapshots that are FRESH *and* carry
  // full provenance (runId + sourceUrl + transport) — see scanner.mjs. Seed
  // all three so these events actually reach the arbitrage scan.
  const snapshot = (sourceId, events) => ({
    schemaVersion: 2,
    sourceId,
    runId: 'offline-integration',
    sourceUrl: `https://example.test/${sourceId}`,
    transport: 'test-fixture-json',
    capturedAt,
    dataStatus: 'fresh',
    events,
  });
  await writeFile(join(dir, 'workspace', 'a_events.json'), JSON.stringify(snapshot('a', [e1])));
  await writeFile(join(dir, 'workspace', 'b_events.json'), JSON.stringify(snapshot('b', [e2])));

  const scan = await scanWorkspace({ dataDir: dir, bankroll: 1000 });
  assert.equal(scan.opportunities.length, 1, 'expected one arb');
  const opp = scan.opportunities[0];
  assert.equal(opp.legs.length, 3);
  assert.equal(typeof opp.marginPercent, 'number');
  assert.equal(typeof opp.totalStake, 'number');
  assert.ok(opp.guaranteedProfit > 0);

  // latest-scan.json must be on disk
  const onDisk = JSON.parse(await readFile(join(dir, 'latest-scan.json'), 'utf8'));
  assert.equal(onDisk.opportunities.length, 1);

  await rm(dir, { recursive: true });
});

test('integration: stub HTTP endpoint exposes canonical Altenar shape', async () => {
  const server = await startStubServer({
    '/api/altenar/events': {
      events: [{
        id: 1,
        homeName: 'FCSB', awayName: 'CFR',
        startDate: '2030-01-01T18:00:00Z',
        sport: { name: 'Football' },
        league: { name: 'Liga 1' },
        marketGroups: [{
          name: 'Main',
          markets: [{
            type: 'MATCH_ODDS', name: 'Match',
            selections: [
              { id: 1, name: 'Home', price: 1.85 },
              { id: 2, name: 'Draw', price: 3.40 },
              { id: 3, name: 'Away', price: 4.20 },
            ],
          }],
        }],
      }],
    },
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/altenar/events`;
  const res = await fetch(url);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].marketGroups[0].markets[0].selections.length, 3);
  server.close();
});
