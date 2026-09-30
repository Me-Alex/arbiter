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
  await rm(dataDir, { recursive: true, force: true });
});

test('a tick into a running scrape is recorded as skipped, and starts nothing', async () => {
  // The branch that had no test at all, and the one the scrape page was
  // reading wrong: it writes `ok: false` alongside `skipped: true`, so a
  // consumer that reads `ok` on its own calls a working scheduler broken.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-scheduler-'));
  const orch = orchestrator();
  orch.running = true;
  const service = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({ bookIds: ['a'], intervalMinutes: 15 });

  await service._tick(['a'], {});
  const { lastRun } = await service.status();

  assert.equal(lastRun.skipped, true, 'the tick is marked as skipped');
  assert.equal(lastRun.reason, 'scrape already running', 'and says what it found');
  assert.equal(typeof lastRun.at, 'string', 'and when');
  assert.deepEqual(orch.launches, [], 'starting a second scrape over a running one is the bug this avoids');

  // The control: with nothing running, the same tick does launch, and does not
  // claim to have been skipped. Without this, a tick that skipped everything
  // would pass the case above.
  orch.running = false;
  await service._tick(['a'], {});
  const after = await service.status();
  assert.equal(after.lastRun.skipped, undefined, 'a tick that launched is not marked skipped');
  assert.equal(after.lastRun.ok, true);
  assert.equal(after.lastRun.launched, true);
  assert.equal(orch.launches.length, 1, 'and it did start the scrape');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a skipped tick is not recorded as an error', async () => {
  // The scheduler's own `lastError` is what the page appends as "last error".
  // A skip has to stay out of it, or the page says both "skipped" and "error"
  // for the same tick.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-scheduler-'));
  const orch = orchestrator();
  const service = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({ bookIds: ['a'], intervalMinutes: 15 });

  orch.running = true;
  await service._tick(['a'], {});
  const skipped = await service.status();
  assert.equal(skipped.lastError, null, 'a skip is not an error');

  // And a tick that genuinely throws is, so the pair is distinguishable.
  orch.running = false;
  orch.launch = async () => { throw new Error('boom'); };
  await service._tick(['a'], {});
  const failed = await service.status();
  assert.equal(failed.lastRun.ok, false);
  assert.equal(failed.lastRun.skipped, undefined, 'a failure is not softened into a skip');
  assert.equal(failed.lastError.message, 'boom');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('`active` never differs from `enabled`, which is why the page does not show it', async () => {
  // status() returns both. The page renders `enabled` and ignores `active`,
  // which is only sound because the two are the same value on every path that
  // can change either — so this is the measurement behind that decision, and
  // it fails on the day a path grows that arms or disarms the timer without
  // flipping the flag. Until then it is a constant, and a constant rendered
  // twice on one panel is noise.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-scheduler-'));
  const agree = async (service) => {
    const s = await service.status();
    assert.equal(typeof s.active, 'boolean', 'active is a real boolean, never undefined');
    assert.equal(s.active, s.enabled, 'active and enabled agree');
    return s;
  };

  // Fresh instance: nothing enabled, nothing armed.
  const fresh = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  assert.equal((await agree(fresh)).enabled, false);

  // enable() arms and enables; a tick does not touch either.
  const service = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await service.enable({ bookIds: ['a'], intervalMinutes: 15 });
  await agree(service);
  await service._tick(['a'], {});
  await agree(service);

  // A restart re-reads the file: still both true, and flagged as resumed.
  const restarted = new SchedulerService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await restarted.loadState();
  assert.equal((await agree(restarted)).resumed, true, 'and the restore is still visible as its own flag');

  // disable() disarms and disables, from either instance.
  await service.disable();
  await agree(service);
  await agree(restarted);

  // The control for the whole invariant: without a tick that arms something,
  // every assertion above would also pass on a status() that returned a
  // hardcoded constant. This is the case that would break that.
  await service.enable({ bookIds: ['a'], intervalMinutes: 15 });
  const armed = await agree(service);
  assert.equal(armed.active, true, 'a scheduled scheduler really is armed');
  assert.notEqual(armed.lastRun, null, 'and the run above recorded a lastRun, so the instance was live');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});
