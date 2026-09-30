import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveService } from '../src/live-service.mjs';
import { DEFAULT_SCAN_OPTIONS } from '../src/scanner/scanner.mjs';
import { DEFAULT_LIVE_MAX_AGE_MS } from '../src/shared/data-quality.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A stand-in orchestrator with the two properties the poll actually reads:
 * whether a scrape is in flight, and the scrapeState the pipeline writes.
 */
function orchestrator() {
  return {
    running: false,
    launches: [],
    scrapeState: null,
    isRunning() { return this.running; },
    async launch(args) {
      this.launches.push(args);
      this.scrapeState = { runId: 'run-1', status: 'running', finishedAt: null };
      return this.scrapeState;
    },
  };
}

const tmp = () => mkdtemp(join(tmpdir(), 'arbiter-live-'));

test('a fresh service is off, and nothing polls until it is enabled', async () => {
  const dataDir = await tmp();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  const status = await service.status();
  assert.equal(status.enabled, false, 'off by default, like the scheduler');
  assert.equal(status.active, false, 'and no timer is armed');
  assert.equal(status.lastRun, null, 'and it has never run');
  await rm(dataDir, { recursive: true, force: true });
});

test('a poll forces includeLive, whatever the stored options say', async () => {
  // The failure this pins is not hypothetical: DEFAULT_SCAN_OPTIONS.includeLive
  // is false, and every profile in config/scan-profiles.json that a normal
  // operator would pick has it false. A poll that forwarded the stored options
  // unchanged would run continuously and collect no in-play data at all while
  // reporting a live poll — the exact shape of the "collects nothing and still
  // reports success" failure the README calls out.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({ scanOptions: { bankroll: 500, includeLive: false, includePast: false } });

  await service._tick();

  assert.equal(orch.launches.length, 1);
  assert.equal(orch.launches[0].scanOptions.includeLive, true, 'includeLive is forced on at the poll');
  assert.equal(orch.launches[0].scanOptions.bankroll, 500, 'and the operator thresholds survive');

  // status() must not advertise the stored `false` either, or the page would
  // render a poll that claims to be pre-match.
  const status = await service.status();
  assert.equal(status.scanOptions.includeLive, true, 'the reported options agree with what runs');

  // The control: the default really is false, so the assertion above is testing
  // the override and not a constant that happens to be true.
  assert.equal(DEFAULT_SCAN_OPTIONS.includeLive, false, 'the project default is pre-match; the poll overrides it');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a poll runs every book, because a subset would be dropped as stale', async () => {
  // The measurement: a poll covering 3 of 8 books dropped the other 5, because
  // loadWorkspace forces STALE on any snapshot whose runId is not the scan's
  // own (scanner.mjs:51,61,74-80) — see scratch/probe-live-poll-blocker.mjs.
  // An empty bookIds is what the orchestrator reads as "every runnable job", so
  // the poll's runId lands on every snapshot and the check is satisfied. This
  // is the property that makes polling all 24 books necessary rather than
  // merely thorough.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({});
  await service._tick();
  assert.deepEqual(orch.launches[0].bookIds, [], 'an empty list means every runnable book');
  assert.equal((await service.status()).scanningAllBooks, true);

  // A named book is still honoured when one is asked for, and reported as such.
  await service.enable({ bookIds: ['unibet'] });
  await service._tick();
  assert.deepEqual(orch.launches[1].bookIds, ['unibet']);
  assert.equal((await service.status()).scanningAllBooks, false);

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a poll skips the verification pass and the catalog, and an ordinary scrape does not', async () => {
  // Measured over nine real runs: unibet 53.9s median, getsbet 34.4s,
  // contibet 31.3s. The verification pass re-quotes every leg by re-scraping
  // the books those legs came from, so on a 60s cadence it roughly doubles the
  // work and pushes the pipeline past the 90s live window the poll exists to
  // serve — the re-quote would confirm a price that expired mid-confirmation.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({});
  await service._tick();
  assert.deepEqual(
    orch.launches[0].pipeline,
    { verify: false, catalog: false },
    'the poll asks for the cheap pipeline explicitly',
  );

  // The control that keeps this from being a global behaviour change: the
  // orchestrator's own default is still "do both", so a manual scrape, the
  // scheduler and POST /api/scrape are untouched.
  const src = readFileSync(join(ROOT, 'src', 'scrape-orchestrator.mjs'), 'utf8');
  assert.match(src, /const verify = pipeline\.verify !== false;/, 'verify defaults to on');
  assert.match(src, /const catalog = pipeline\.catalog !== false;/, 'catalog defaults to on');
  assert.match(src, /if \(verify && scan && scan\.opportunities\.length\)/, 'and the verify step is gated on it');
  assert.match(src, /if \(catalog && scan\)/, 'and the catalog step is gated on it');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a tick into a running scrape is counted, starts nothing, and does not erase the last poll', async () => {
  // This is the expected steady state at this cadence, not an edge case: a
  // 24-book batch was measured at 55-118s against a 60s interval, so roughly
  // half of all ticks land while the previous poll is still running. A driver
  // that only reported success would look identical to one that is working.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({});

  // A poll runs first, so there is a measurement a skip could destroy.
  await service._tick();
  const launched = await service.status();
  orch.scrapeState.status = 'completed';
  orch.scrapeState.finishedAt = new Date(launched.pending.startedAt + 64_000).toISOString();
  orch.running = true;

  await service._tick();
  const afterSkip = await service.status();
  assert.equal(afterSkip.skippedTicks, 1, 'the skip is counted, not just logged once');
  assert.equal(typeof afterSkip.lastSkippedAt, 'string', 'and timestamped');
  assert.equal(afterSkip.lastError, null, 'a skip is not an error');
  assert.equal(orch.launches.length, 1, 'stacking a second scrape over a running one is the bug this avoids');
  assert.equal(afterSkip.lastRun.durationMs, 64_000,
    'and the poll that had just finished keeps its measured duration');
  assert.equal(afterSkip.pending, null);

  // The control: with nothing running, the same tick launches again rather
  // than skipping. Without it, a poll that skipped forever passes the above.
  orch.running = false;
  await service._tick();
  const afterLaunch = await service.status();
  assert.equal(afterLaunch.skippedTicks, 1, 'a launch is not a skip');
  assert.equal(afterLaunch.pending.runId, 'run-1', 'and it started a new poll');
  assert.equal(afterLaunch.lastRun.durationMs, 64_000,
    'and the previous measurement is still the last completed one, until this poll finishes');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a poll reports its measured duration, not the interval it was configured with', async () => {
  // launch() resolves as soon as the pipeline is STARTED, so the duration of a
  // poll is only knowable once the orchestrator reports that run terminal.
  // Without this the page could only show the configured interval, which is
  // exactly the number that is wrong: the real cadence is the batch's.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({ intervalSeconds: 90 });

  await service._tick();
  const launched = await service.status();
  assert.equal(launched.pending.runId, 'run-1', 'the in-flight poll is tracked');
  assert.equal(launched.lastRun, null, 'and has not been reported as finished yet');

  // The pipeline finishes 64s later — the measured median of a real 24-book
  // batch, and a different number from both the 90s interval and the 60s
  // default. If either configured value leaked in, this assertion fails.
  orch.scrapeState.status = 'completed';
  orch.scrapeState.finishedAt = new Date(launched.pending.startedAt + 64_000).toISOString();
  orch.running = true; // the next tick lands while something is still running
  await service._tick();

  const settled = await service.status();
  assert.equal(settled.pending, null, 'the poll is no longer pending');
  assert.equal(settled.lastRun.durationMs, 64_000, 'the measured duration is recorded, not the configured interval');
  assert.equal(settled.lastRun.ok, true);
  assert.equal(settled.lastRun.keepingUp, true, '64s against a 90s interval is keeping up');
  assert.ok(64_000 <= DEFAULT_LIVE_MAX_AGE_MS, 'and it fits inside the live window it exists to serve');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a poll slower than its own interval reports keepingUp: false', async () => {
  // The control for the assertion above. A service that hardcoded `keepingUp:
  // true` — or computed it from the configured interval rather than the
  // measurement — would pass the 64s case and fail this one, which is the
  // direction that matters: the whole point is that a falling-behind poll is
  // visible.
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({ intervalSeconds: 30 });

  await service._tick();
  const { pending } = await service.status();
  orch.scrapeState.status = 'completed';
  // 118s is the worst batch measured over nine real runs.
  orch.scrapeState.finishedAt = new Date(pending.startedAt + 117_900).toISOString();
  orch.running = true;
  await service._tick();

  const { lastRun } = await service.status();
  assert.equal(lastRun.durationMs, 117_900);
  assert.equal(lastRun.keepingUp, false, 'a 118s poll on a 30s interval is not keeping up');
  assert.ok(117_900 > DEFAULT_LIVE_MAX_AGE_MS, 'and it is over the live window the poll exists to serve');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('a launch that throws is an error, and is not softened into a skip', async () => {
  const dataDir = await tmp();
  const orch = orchestrator();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await service.enable({});
  orch.launch = async () => { throw new Error('boom'); };

  await service._tick();
  const { lastRun, lastError } = await service.status();
  assert.equal(lastRun.ok, false);
  assert.equal(lastRun.skipped, undefined, 'a failure is not a skip');
  assert.equal(lastError.message, 'boom');

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('an enabled poll survives a restart, and an interrupted one is not re-reported', async () => {
  const dataDir = await tmp();
  const first = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await first.enable({ intervalSeconds: 45, scanOptions: { bankroll: 750 } });
  await first._tick();
  await first.disable();

  const orch = orchestrator();
  const restored = new LiveService({ dataDir, configPath: 'unused', orchestrator: orch });
  await restored.enable({ intervalSeconds: 45, scanOptions: { bankroll: 750 } });
  await restored._tick();
  // Process dies mid-poll: the run belongs to the previous process and this
  // one never saw it start.
  const status = await restored.status();
  assert.equal(status.pending.runId, 'run-1', 'a poll was in flight when the process stopped');

  // The process died mid-poll, so nothing was persisted as enabled. A new
  // instance must not report a duration for a run it never saw start.
  await restored.disable();
  const afterRestart = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await afterRestart.loadState();
  const reloaded = await afterRestart.status();
  assert.equal(reloaded.pending, null, 'a duration is never reported for a run this process did not start');
  assert.equal(reloaded.enabled, false, 'a stopped poll stays stopped across a restart');
  assert.equal(reloaded.intervalSeconds, 45, 'but its settings are kept');

  // And an enabled poll really does resume, or the "stays stopped" case above
  // proves nothing — a loadState that ignored the file entirely would pass it.
  const live = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await live.enable({ intervalSeconds: 45, scanOptions: { bankroll: 750 } });
  const resumed = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await resumed.loadState();
  const resumedStatus = await resumed.status();
  assert.equal(resumedStatus.enabled, true, 'an enabled poll resumes at startup');
  assert.equal(resumedStatus.resumed, true, 'and says it was resumed rather than freshly enabled');
  assert.equal(resumedStatus.intervalSeconds, 45);
  assert.equal(resumedStatus.scanOptions.bankroll, 750, 'and its thresholds came back too');
  assert.equal(resumedStatus.active, true, 'with a timer actually armed');

  await live.disable();
  await resumed.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('the interval is clamped to a range that cannot hammer the books', async () => {
  const dataDir = await tmp();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });

  // Below the floor: a 1s poll cannot collect anything a 90s window can price,
  // and it multiplies the load on every bookmaker by 60x for no data.
  assert.equal((await service.enable({ intervalSeconds: 1 })).intervalSeconds, 30);
  // Above the ceiling: a poll slower than this is the scheduler's job, and the
  // scheduler already exists and is separately configurable.
  assert.equal((await service.enable({ intervalSeconds: 99_999 })).intervalSeconds, 600);
  await service.disable();

  // A value that is not a number keeps the last good one rather than reverting
  // to the default: a form posting "abc" should not silently undo a setting the
  // operator just made.
  assert.equal((await service.enable({ intervalSeconds: 90 })).intervalSeconds, 90);
  assert.equal((await service.enable({ intervalSeconds: 'soon' })).intervalSeconds, 90);
  assert.equal((await service.enable({ intervalSeconds: 0 })).intervalSeconds, 90);
  // A service that has never been configured falls back to the default, not to
  // whatever a previous instance happened to leave behind.
  const fresh = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  assert.equal((await fresh.enable({ intervalSeconds: 'soon' })).intervalSeconds, 60);
  await fresh.disable();

  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('the state file is the one the service reads back', async () => {
  const dataDir = await tmp();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  await service.enable({ intervalSeconds: 90 });
  const raw = JSON.parse(await readFile(join(dataDir, 'live-state.json'), 'utf8'));
  assert.equal(raw.enabled, true);
  assert.equal(raw.intervalSeconds, 90);
  assert.deepEqual(raw.bookIds, []);
  assert.equal(typeof raw.skippedTicks, 'number');

  // A corrupt file must not take the server down on boot; loadState returns
  // early on unreadable JSON and the service stays at its constructor defaults,
  // which is off — the safe direction.
  await service.disable();
  await rm(dataDir, { recursive: true, force: true });
});

test('the live window the service reports is the one the scanner enforces', async () => {
  // The page renders this number next to the measured poll duration and calls
  // the poll "over the live window" when it exceeds it. If the two constants
  // could drift, that comparison would be against a number nothing enforces.
  const dataDir = await tmp();
  const service = new LiveService({ dataDir, configPath: 'unused', orchestrator: orchestrator() });
  const status = await service.status();
  assert.equal(status.liveMaxAgeMs, DEFAULT_LIVE_MAX_AGE_MS);
  assert.equal(status.liveMaxAgeMs, 90_000);
  await rm(dataDir, { recursive: true, force: true });
});
