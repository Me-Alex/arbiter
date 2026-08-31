import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerService } from '../src/scheduler-service.mjs';

function orchestrator() {
  return {
    running: false,
    launches: [],
    isRunning() { return this.running; },
    async launch(args) { this.launches.push(args); return { runId: 'run-1' }; },
  };
}

test('scheduler persists and restores an active schedule with its real inputs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-scheduler-'));
  const firstOrchestrator = orchestrator();
  const first = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: firstOrchestrator });
  const enabled = await first.enable({
    bookIds: ['a', 'b'],
    scanOptions: { bankroll: 250, includeLive: false },
    intervalMinutes: 23,
  });
  assert.equal(enabled.active, true);
  assert.equal(enabled.intervalMinutes, 23);
  assert.deepEqual(enabled.bookIds, ['a', 'b']);

  const secondOrchestrator = orchestrator();
  const restored = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: secondOrchestrator });
  await restored.loadState();
  const status = await restored.status();
  assert.equal(status.enabled, true);
  assert.equal(status.active, true);
  assert.equal(status.resumed, true);
  assert.equal(status.intervalMinutes, 23);
  assert.deepEqual(status.bookIds, ['a', 'b']);
  await restored._tick(status.bookIds, status.scanOptions);
  assert.deepEqual(secondOrchestrator.launches[0], { bookIds: ['a', 'b'], scanOptions: { bankroll: 250, includeLive: false } });

  await first.disable();
  await restored.disable();
  await rm(dataDir, { recursive: true });
});

test('scheduler clamps invalid persisted and requested intervals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-scheduler-'));
  const service = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  const status = await service.enable({ bookIds: ['a'], intervalMinutes: -20 });
  assert.equal(status.intervalMinutes, 1);
  await service.disable();
  await rm(dataDir, { recursive: true });
});
