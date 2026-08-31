import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapeOrchestrator } from '../src/scrape-orchestrator.mjs';

function broadcaster() {
  return { events: [], broadcast(type, payload) { this.events.push({ type, payload }); } };
}

test('orchestrator cancellation transitions an active run to cancelled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({ jobs: [{ id: 'missing', enabled: true, sourceIds: ['missing'] }] }));
  const events = broadcaster();
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: events });
  const state = await orchestrator.launch({ bookIds: ['missing'] });
  assert.equal(state.status, 'running');
  const cancellation = await orchestrator.cancel();
  assert.equal(cancellation.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(orchestrator.scrapeState.status, 'cancelled');
  assert.ok(events.events.some((event) => event.payload?.status === 'cancelling'));
  assert.ok(events.events.some((event) => event.payload?.status === 'cancelled'));
  await rm(dataDir, { recursive: true });
});

test('orchestrator rejects disabled bookmaker jobs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({ jobs: [{ id: 'disabled', enabled: false, sourceIds: ['disabled'] }] }));
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
  await assert.rejects(orchestrator.launch({ bookIds: ['disabled'] }), (error) => error.code === 'EBADINPUT');
  await rm(dataDir, { recursive: true });
});
