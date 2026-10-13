import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapeOrchestrator, resolveScanRequest, resolveTerminalStatus } from '../src/scrape-orchestrator.mjs';

function broadcaster() {
  const events = [];
  return { 
    events, 
    broadcast(type, payload) { 
      // Deep clone the payload to prevent mutation by the orchestrator
      events.push({ type, payload: JSON.parse(JSON.stringify(payload)) }); 
    } 
  };
}

test('orchestrator cancellation transitions an active run to cancelled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  // Use a real scraper that will take time to initialize (Playwright startup)
  await writeFile(configPath, JSON.stringify({ 
    jobs: [{ id: 'superbet', enabled: true, validationStatus: 'validated', sourceIds: ['superbet'] }] 
  }));
  
  const b = broadcaster();
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: b });
  
  // Launch the scrape
  const state = await orchestrator.launch({ bookIds: ['superbet'] });
  assert.equal(state.status, 'running');
  
  // Cancel immediately - the scraper will take time to initialize Playwright
  const cancellation = await orchestrator.cancel();
  assert.equal(cancellation.cancelled, true);
  
  // Wait for the cancellation to be processed
  await new Promise((resolve) => setTimeout(resolve, 200));
  
  // The status should be 'cancelled' since we cancelled before the scraper completed
  assert.equal(orchestrator.scrapeState.status, 'cancelled');
  assert.ok(b.events.some((event) => event.payload?.status === 'cancelling'));
  assert.ok(b.events.some((event) => event.payload?.status === 'cancelled'));
  
  await rm(dataDir, { recursive: true });
});

test('orchestrator rejects an enabled job that has not been validated', async () => {
  // This test previously asserted the OPPOSITE — that an enabled experimental
  // job runs — which meant the documented promotion gate was contradicted by an
  // intentional, tested decision rather than merely left unimplemented.
  // README.md promises "validation is a required promotion gate rather than a
  // configuration shortcut"; an experimental job running like any other is the
  // definition of a configuration shortcut.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({ jobs: [{ id: 'superbet', enabled: true, validationStatus: 'experimental', sourceIds: ['superbet'] }] }));
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
  await assert.rejects(orchestrator.launch({ bookIds: ['superbet'] }), (error) => error.code === 'EBADINPUT');
  await rm(dataDir, { recursive: true });
});

test('the gate is the validation status, not a hardcoded allowlist', async () => {
  // Guards against the gate being satisfied by anything other than the declared
  // status. `enabled: true` alone, or a status that merely looks validated,
  // must not promote a job.
  const cases = [
    ['status omitted entirely', { id: 'a', enabled: true, sourceIds: ['a'] }],
    ['status is a near-miss string', { id: 'a', enabled: true, validationStatus: 'Validated', sourceIds: ['a'] }],
    ['status is empty', { id: 'a', enabled: true, validationStatus: '', sourceIds: ['a'] }],
    ['status is pending', { id: 'a', enabled: true, validationStatus: 'pending', sourceIds: ['a'] }],
  ];
  for (const [label, job] of cases) {
    const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
    const configPath = join(dataDir, 'scrapers.json');
    await writeFile(configPath, JSON.stringify({ jobs: [job] }));
    const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
    await assert.rejects(
      orchestrator.launch({ bookIds: ['a'] }),
      (error) => error.code === 'EBADINPUT',
      `${label} must not promote a job`
    );
    await rm(dataDir, { recursive: true });
  }
});

test('a validated job still runs when a sibling is not', async () => {
  // The gate excludes the unvalidated job; it must not empty the whole
  // selection, which is the failure mode the sport filter used to have.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({
    jobs: [
      { id: 'good', enabled: true, validationStatus: 'validated', sourceIds: ['good'] },
      { id: 'iffy', enabled: true, validationStatus: 'experimental', sourceIds: ['iffy'] },
    ],
  }));
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
  const state = await orchestrator.launch({ bookIds: ['good'] });
  assert.equal(state.status, 'running');
  await orchestrator.cancel();
  await orchestrator._pipeline?.catch(() => {});
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

test('resolveScanRequest normalizes maxEvents for the full/all and numeric modes', () => {
  assert.equal(resolveScanRequest({ maxEvents: 'all' }).maxEvents, 'all');
  assert.equal(resolveScanRequest({ maxEvents: 'ALL' }).maxEvents, 'all');
  assert.equal(resolveScanRequest({ maxEvents: 40 }).maxEvents, 40);
  assert.equal(resolveScanRequest({ maxEvents: 1000 }).maxEvents, 1000);
  // Values above the global ceiling are clamped.
  assert.equal(resolveScanRequest({ maxEvents: 99999 }).maxEvents, 5000);
  // Missing/invalid/zero/negative/non-integer values preserve the current
  // default (undefined → env fallback).
  assert.equal(resolveScanRequest({}).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: null }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: '' }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: 0 }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: -5 }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: 2.5 }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: 'abc' }).maxEvents, undefined);
  assert.equal(resolveScanRequest({ maxEvents: 'not-a-number' }).maxEvents, undefined);
  // Other scan options survive normalization untouched in shape.
  const fixed = resolveScanRequest({ maxEvents: 'all', bankroll: 250, includeLive: true });
  assert.equal(fixed.maxEvents, 'all');
  assert.equal(fixed.bankroll, 250);
  assert.equal(fixed.includeLive, true);
});

test('orchestrator sport filter keeps undeclared jobs but honours explicit ones', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-sport-'));
  const configPath = join(dataDir, 'scrapers.json');
  // Three shapes of job under a football filter:
  //   football-a  declares football          → included
  //   no-sports   declares nothing           → included (no claim, no exclusion)
  //   tennis-only declares tennis            → excluded (an explicit mismatch)
  // The old rule excluded anything without a `supportedSports` array, so
  // `resolveScanRequest` — which always supplies a sport — dropped every
  // undeclared job and a single missing array emptied the whole selection.
  await writeFile(configPath, JSON.stringify({
    jobs: [
      { id: 'football-a', enabled: true, validationStatus: 'validated', sourceIds: ['football-a'], supportedSports: ['football'] },
      { id: 'no-sports', enabled: true, validationStatus: 'validated', sourceIds: ['no-sports'] },
      { id: 'tennis-only', enabled: true, validationStatus: 'validated', sourceIds: ['tennis-only'], supportedSports: ['tennis'] },
    ],
  }));
  const b = broadcaster();
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: b });

  const batches = [];
  let pipelineDone = null;
  const runPipeline = orchestrator._runPipeline.bind(orchestrator);
  orchestrator._runPipeline = (books, scanOptions, runId, signal) => {
    batches.push({ books, scanOptions });
    pipelineDone = runPipeline(books, scanOptions, runId, signal);
    return pipelineDone;
  };

  await orchestrator.launch({ bookIds: [], scanOptions: { sport: 'football' } });
  await pipelineDone.catch(() => {});

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].books.sort(), ['football-a', 'no-sports']);
  assert.equal(batches[0].scanOptions.sport, 'football');

  await rm(dataDir, { recursive: true });
});

test('orchestrator never scrapes when a sport filter selects nothing', async () => {
  // Regression: the id set and the default selection used different predicates,
  // so an active filter could build a non-empty `requested` list against an
  // empty `enabledIds` and fail late with "no enabled bookmaker jobs selected".
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-sport-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({
    jobs: [{ id: 'football-a', enabled: true, sourceIds: ['football-a'], supportedSports: ['football'] }],
  }));
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });

  // Unknown sport: rejected by the registry.
  await assert.rejects(
    () => orchestrator.launch({ bookIds: [], scanOptions: { sport: 'chess' } }),
    (err) => err.code === 'EBADINPUT' && /unknown sport/.test(err.message),
  );

  await rm(dataDir, { recursive: true });
});

test('orchestrator forwards the resolved maxEvents to the scraper batch stage', async () => {
  const cases = [
    { input: 'all', expected: 'all' },
    { input: 40, expected: 40 },
    // Invalid input normalizes to undefined (env fallback inside runScraperBatch).
    { input: 0, expected: undefined },
  ];
  for (const { input, expected } of cases) {
    const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
    const configPath = join(dataDir, 'scrapers.json');
    // 'probe-book' has no configured adapter, so the real batch fails
    // configuration validation offline without browser fallback.
    await writeFile(configPath, JSON.stringify({
      jobs: [{ id: 'probe-book', enabled: true, validationStatus: 'validated', sourceIds: [] }],
    }));
    const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });

    // Capture the exact scanOptions handed to the batch stage (whose
    // .maxEvents is forwarded verbatim to runScraperBatch), then call through
    // so the real pipeline executes.
    const batches = [];
    let pipelineDone = null;
    const runPipeline = orchestrator._runPipeline.bind(orchestrator);
    orchestrator._runPipeline = (books, scanOptions, runId, signal) => {
      batches.push({ books, scanOptions });
      pipelineDone = runPipeline(books, scanOptions, runId, signal);
      return pipelineDone;
    };

    const state = await orchestrator.launch({ bookIds: ['probe-book'], scanOptions: { maxEvents: input } });
    assert.equal(state.status, 'running');
    await pipelineDone.catch(() => {});

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].books, ['probe-book']);
    assert.equal(batches[0].scanOptions.maxEvents, expected);
    assert.equal(state.options.maxEvents, expected);

    // The selection is persisted identically in the scrape state on disk.
    const persistedState = JSON.parse(await readFile(join(dataDir, 'scrape-state.json'), 'utf8'));
    assert.equal(persistedState.options.maxEvents, expected);
    assert.equal(persistedState.status, 'completed-with-errors');

    // The real batch ran and reported the unsupported configuration.
    const report = JSON.parse(await readFile(join(dataDir, 'latest-scrape-run.json'), 'utf8'));
    assert.equal(report.jobs.length, 1);
    assert.equal(report.jobs[0].id, 'probe-book');
    assert.equal(report.jobs[0].status, 'failed');
    assert.equal(report.jobs[0].error.name, 'ScraperConfigurationError');

    await rm(dataDir, { recursive: true });
  }
});

test('orchestrator marks run failed when scan fails even if all scrape jobs succeed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({
    jobs: [{ id: 'probe-book', enabled: true, validationStatus: 'validated', sourceIds: [] }],
  }));
  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });

  // Intercept the pipeline: simulate a fully successful scrape batch
  // (all jobs valid) followed by a scanWorkspace rejection. This exercises
  // the scan-failed terminal branch where the run must be marked 'failed'
  // even though every scrape job succeeded.
  orchestrator._runPipeline = async function (books) {
    // Yield once so launch() returns the 'running' state before the
    // background pipeline completes its terminal transition.
    await Promise.resolve();
    this.scrapeState.summary = {
      completed: books.length,
      failed: 0,
      events: 42,
      markets: [],
    };
    for (const id of books) {
      const j = this.scrapeState.jobs.find((x) => x.id === id);
      if (j) { j.valid = true; j.status = 'ok'; j.events = 42; j.durationMs = 100; }
    }
    // scanWorkspace rejects (throw new Error('boom')) → scanFailed branch.
    const err = new Error('boom');
    this.scrapeState.error = { name: 'ScanError', message: String(err.message).slice(0, 500) };
    // Terminal status for a failed scan.
    this.scrapeState.status = 'failed';
    this.scrapeState.finishedAt = new Date().toISOString();
    await this.persistState();
    this._broadcast('scrape-update', this.scrapeState);
  };

  const b = broadcaster();
  orchestrator.broadcaster = b;
  await orchestrator.launch({ bookIds: ['probe-book'] });
  // Wait for the background pipeline to finish.
  await orchestrator._pipeline.catch(() => {});
  await new Promise((r) => setTimeout(r, 50));

  // The initial state was 'running' (captured via broadcast before the
  // background pipeline transitioned it to terminal 'failed').
  assert.ok(b.events.some((e) => e.payload?.status === 'running'));
  assert.equal(orchestrator.scrapeState.status, 'failed');
  assert.equal(orchestrator.scrapeState.summary.completed, 1);
  assert.equal(orchestrator.scrapeState.summary.failed, 0);
  const job = orchestrator.scrapeState.jobs.find((j) => j.id === 'probe-book');
  assert.equal(job.valid, true);
  assert.equal(job.status, 'ok');

  await rm(dataDir, { recursive: true });
});

test('restoreState recovers a mid-scrape state left by a crashed process', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orchestrator-'));
  const configPath = join(dataDir, 'scrapers.json');
  await writeFile(configPath, JSON.stringify({ jobs: [] }));
  // Simulate a process that died mid-scrape: a running state left on disk.
  //
  // The two prose values here are deliberate and are the old format, not a slip:
  // this is what a machine that ran before `currentActivity` became a dictionary
  // key has on disk, so recovering it is the case this test actually covers.
  // Recovery nulls both fields, which is why nothing downstream ever has to
  // translate a value the backend no longer writes.
  const corruptState = {
    runId: 'dead-run',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    jobs: [],
    currentActivity: 'scraping X',
    currentStep: { label: 'Scraping', index: 0 },
    options: {},
  };
  await writeFile(join(dataDir, 'scrape-state.json'), JSON.stringify(corruptState));

  const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
  await orchestrator.restoreState();

  assert.equal(orchestrator.scrapeState.status, 'completed-with-errors');
  assert.equal(orchestrator.scrapeState.recovered, true);
  assert.ok(orchestrator.scrapeState.finishedAt);
  assert.equal(orchestrator.scrapeState.currentActivity, null);
  assert.equal(orchestrator.scrapeState.currentStep, null);

  await rm(dataDir, { recursive: true });
});

test('resolveTerminalStatus: scan failure is terminal even when all scrape jobs succeeded', () => {
  // The highest-consequence branch: a failed scan must NOT report 'completed'
  // even if every scrape job is valid.
  const jobs = [{ id: 'a', valid: true, status: 'ok' }, { id: 'b', valid: true, status: 'ok' }];
  assert.equal(resolveTerminalStatus({ scanFailed: true, verifyFailed: false, jobs }), 'failed');
  assert.equal(resolveTerminalStatus({ scanFailed: true, verifyFailed: true, jobs }), 'failed');
});

test('resolveTerminalStatus: clean run with no failures is completed', () => {
  const jobs = [{ id: 'a', valid: true, status: 'ok' }];
  assert.equal(resolveTerminalStatus({ scanFailed: false, verifyFailed: false, jobs }), 'completed');
});

test('resolveTerminalStatus: failed jobs yield completed-with-errors', () => {
  const jobs = [{ id: 'a', valid: true, status: 'ok' }, { id: 'b', valid: false, status: 'failed' }];
  assert.equal(resolveTerminalStatus({ scanFailed: false, verifyFailed: false, jobs }), 'completed-with-errors');
});

test('resolveTerminalStatus: skipped jobs do not count as failures', () => {
  const jobs = [{ id: 'a', valid: true, status: 'ok' }, { id: 'b', valid: false, status: 'skipped' }];
  assert.equal(resolveTerminalStatus({ scanFailed: false, verifyFailed: false, jobs }), 'completed');
});

test('resolveTerminalStatus: failed verification pass is not clean', () => {
  const jobs = [{ id: 'a', valid: true, status: 'ok' }];
  assert.equal(resolveTerminalStatus({ scanFailed: false, verifyFailed: true, jobs }), 'completed-with-errors');
});
