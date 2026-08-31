import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace, loadWorkspace } from '../src/scanner/scanner.mjs';

async function seed(dir, books) {
  await mkdir(join(dir, 'workspace'), { recursive: true });
  for (const [sourceId, file, payload] of books) {
    await writeFile(join(dir, 'workspace', file), JSON.stringify(payload), 'utf8');
  }
}

test('loadWorkspace reads every *_events.json and aggregates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const e1 = {
    id: 'a1', sourceId: 'a', eventKey: 'k1',
    sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
    homeTeam: 'H', awayTeam: 'A',
    markets: [{ key: 'MATCH_ODDS', selections: [{ name: 'H', odds: 1.5 }] }],
  };
  await seed(dir, [['a', 'a_events.json', { schemaVersion: 2, sourceId: 'a', capturedAt: new Date().toISOString(), dataStatus: 'fresh', events: [e1] }]]);
  const { events, sources } = await loadWorkspace(dir);
  assert.equal(events.length, 1);
  assert.equal(sources.length, 1);
  await rm(dir, { recursive: true });
});

test('scanWorkspace produces opportunities when books disagree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const e1 = {
    id: 'a1', sourceId: 'a', eventKey: 'k1',
    sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
    homeTeam: 'H', awayTeam: 'A',
    markets: [{ key: 'MATCH_ODDS', selections: [
      { name: 'H', odds: 2.10 }, { name: 'D', odds: 4.20 }, { name: 'A', odds: 4.60 },
    ] }],
  };
  const e2 = {
    id: 'b1', sourceId: 'b', eventKey: 'k1',
    sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
    homeTeam: 'H', awayTeam: 'A',
    markets: [{ key: 'MATCH_ODDS', selections: [
      { name: 'H', odds: 2.05 }, { name: 'D', odds: 4.50 }, { name: 'A', odds: 5.00 },
    ] }],
  };
  const capturedAt = new Date().toISOString();
  await seed(dir, [
    ['a', 'a_events.json', { schemaVersion: 2, sourceId: 'a', capturedAt, dataStatus: 'fresh', events: [e1] }],
    ['b', 'b_events.json', { schemaVersion: 2, sourceId: 'b', capturedAt, dataStatus: 'fresh', events: [e2] }],
  ]);
  const scan = await scanWorkspace({ dataDir: dir, bankroll: 1000 });
  assert.ok(scan.opportunities.length >= 1, 'expected at least one arb');
  await rm(dir, { recursive: true });
});

test('scanWorkspace persists latest-scan.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  await seed(dir, []);
  await scanWorkspace({ dataDir: dir });
  const stat = await import('node:fs/promises').then((m) => m.stat(join(dir, 'latest-scan.json')));
  assert.ok(stat.isFile());
  await rm(dir, { recursive: true });
});

test('scanWorkspace filters past events when includePast=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const past = {
    id: 'a1', sourceId: 'a', eventKey: 'k1',
    sport: 'Football', league: 'Liga 1', kickoff: '2000-01-01T00:00:00Z',
    homeTeam: 'H', awayTeam: 'A',
    markets: [{ key: 'MATCH_ODDS', selections: [{ name: 'H', odds: 2.10 }] }],
  };
  await seed(dir, [['a', 'a_events.json', { schemaVersion: 2, sourceId: 'a', capturedAt: new Date().toISOString(), dataStatus: 'fresh', events: [past] }]]);
  const scan = await scanWorkspace({ dataDir: dir, includePast: false });
  assert.equal(scan.eventCount, 0);
  await rm(dir, { recursive: true });
});
