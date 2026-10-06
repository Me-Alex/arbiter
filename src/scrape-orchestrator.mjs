import { join } from 'node:path';
import { runScraperBatch, persistRunReport, loadScraperJobs, normalizeScrapeParallel, toProgressJob } from './scraper-service.mjs';
import { scanWorkspace, DEFAULT_SCAN_OPTIONS } from './scanner/scanner.mjs';
import { buildMarketCatalog } from './scanner/market-catalog.mjs';
import { runVerificationPass } from './verification.mjs';
import { writeJsonAtomic, tryReadJson } from './shared/atomic-write.mjs';
import { emptyScan } from './scan-service.mjs';

/**
 * scrape-orchestrator.mjs — owns the full lifecycle:
 *
 *   scraping → scanning → verifying → cataloging → (complete)
 *
 * Holds the in-memory `scrapeState` that the SSE clients consume. Every job
 * status change is mirrored as both a state mutation and a broadcast.
 */

const STATE_FILENAME = 'scrape-state.json';

export class ScrapeOrchestrator {
  constructor({ dataDir, configPath, broadcaster, logger = () => {} }) {
    this.dataDir = dataDir;
    this.configPath = configPath;
    this.broadcaster = broadcaster;
    this.logger = logger;
    /** @type {null | { runId, status, startedAt, finishedAt, jobs, options }} */
    this.scrapeState = null;
    this._abortController = null;
    this._pipeline = null;
  }

  isRunning() {
    return Boolean(this.scrapeState && ['running', 'cancelling'].includes(this.scrapeState.status));
  }

  async persistState() {
    await writeJsonAtomic(join(this.dataDir, STATE_FILENAME), this.scrapeState || {});
  }

  async restoreState() {
    const s = await tryReadJson(
      join(this.dataDir, STATE_FILENAME),
      null,
      (err) => this.logger('warn', `corrupt ${STATE_FILENAME}, starting fresh: ${err.message}`),
    );
    if (s && ['running', 'cancelling'].includes(s.status)) {
      // Previous process died mid-scrape; mark it terminal so the dashboard
      // never displays a phantom active run.
      s.status = 'completed-with-errors';
      s.finishedAt = new Date().toISOString();
      s.recovered = true;
      s.currentActivity = null;
      s.currentStep = null;
      this.scrapeState = s;
      await this.persistState();
    } else if (s) {
      this.scrapeState = s;
    }
  }

  /**
   * @param {{
   *   bookIds: string[],
   *   scanOptions: {
   *     bankroll?: number,
   *     minMarginPercent?: number,
   *     maxMiddleRiskPercent?: number,
   *     minMiddleRoiPercent?: number,
   *     includeLive?: boolean,
   *     includePast?: boolean,
   *     maxEvents?: number|'all',
   *     sport?: string,
   *   },
   *   pipeline?: {
   *     verify?: boolean,
   *     catalog?: boolean,
   *   },
   * }} args
   */
  async launch({ bookIds, scanOptions = {}, pipeline = {} } = {}) {
    if (this.isRunning()) {
      const err = new Error('scrape already in progress');
      err.code = 'EBUSY';
      throw err;
    }
    const jobs = await loadScraperJobs(this.configPath);
    const sportFilter = scanOptions?.sport ? String(scanOptions.sport).trim().toLowerCase() : null;
    if (sportFilter) {
      // Validate against the sport registry
      const { getSport } = await import('./sports/registry.mjs');
      if (!getSport(sportFilter)) {
        const err = new Error(`unknown sport "${scanOptions.sport}"`);
        err.code = 'EBADINPUT';
        throw err;
      }
    }
    // A job participates when it is enabled and, if a sport filter is active,
    // declares support for that sport.
    //
    // A job with no `supportedSports` is not excluded: absence means the job
    // never stated a capability, which is not the same as declaring it cannot
    // serve the sport. The old rule dropped every undeclared job the moment any
    // filter was active, and `resolveScanRequest` always supplies a sport, so a
    // single mislabelled entry could empty the whole selection. An explicit
    // declaration is still honoured: a job that lists sports but not this one
    // is excluded, which is what makes the filter meaningful.
    //
    // This is the single predicate both the id set and the default selection
    // use, so the two can no longer disagree.
    const jobMatchesSport = (job) => {
      if (!sportFilter) return true;
      if (!Array.isArray(job.supportedSports) || job.supportedSports.length === 0) return true;
      return job.supportedSports.includes(sportFilter);
    };

    // Validation is a promotion gate, not a label. `enabled` says the operator
    // switched the job on; `validationStatus` says its route, parser, provenance
    // and freshness were proven against a real upstream. Only a job that cleared
    // both is runnable, so editing the registry cannot put an unvalidated feed
    // in front of the engine.
    //
    // This was documented in README.md and not implemented: `validationStatus`
    // appeared in exactly one production line, a display filter in router.mjs,
    // so an `enabled: true, validationStatus: 'experimental'` job ran like any
    // other — and a test asserted that it should. The registry was therefore a
    // plain configuration shortcut, which is the thing the README says it is not.
    //
    // The gate is deliberately silent about the reason: a job that fails it is
    // simply not runnable, and the "no enabled bookmaker jobs selected" error
    // below already covers that case identically to a disabled job. Listing
    // every excluded job's status in that message would leak configuration into
    // an error string and help nothing; the reason is recorded in the job's own
    // `validationReason`, which is where a reader looks.
    const isValidated = (job) => job.validationStatus === 'validated';

    const runnable = jobs.filter((job) => job.enabled !== false && isValidated(job) && jobMatchesSport(job));

    const enabledIds = new Set();
    for (const job of runnable) {
      enabledIds.add(job.id);
      if (Array.isArray(job.sourceIds)) job.sourceIds.forEach((sourceId) => enabledIds.add(sourceId));
    }
    const requested = Array.isArray(bookIds) && bookIds.length > 0
      ? bookIds
      : runnable.map((job) => job.id);
    const selected = [...new Set(requested)].filter((id) => enabledIds.has(id));
    if (selected.length === 0) {
      // Name WHY each requested job was dropped. "no enabled bookmaker jobs
      // selected" is a lie for a job that is enabled but unvalidated, and the
      // scheduler re-runs this on every interval while persisting the message,
      // so a wrong reason here is re-asserted forever against an operator who
      // has no way to see which of the two conditions bit.
      const blockers = [];
      for (const id of new Set(requested)) {
        const job = jobs.find((j) => j.id === id);
        if (!job) blockers.push(`${id}: not in the registry`);
        else if (job.enabled === false) blockers.push(`${id}: disabled`);
        else if (!isValidated(job)) blockers.push(`${id}: validationStatus="${job.validationStatus ?? 'unset'}" (needs "validated")`);
        else blockers.push(`${id}: not runnable for this sport filter`);
      }
      const err = new Error(
        `no runnable bookmaker jobs selected${blockers.length ? ` — ${blockers.join('; ')}` : ''}`
      );
      err.code = 'EBADINPUT';
      throw err;
    }

    const runId = new Date().toISOString();
    scanOptions = resolveScanRequest(scanOptions);
    this.scrapeState = {
      runId,
      status: 'running',
      startedAt: runId,
      finishedAt: null,
      options: scanOptions,
      books: selected,
      jobs: selected.map(toProgressJob),
      currentActivity: null,
      summary: null,
    };
    await this.persistState();
    this._broadcast('scrape-update', this.scrapeState);

    this._abortController = new AbortController();
    // Run in background. Errors here are encoded into scrapeState.
    this._pipeline = this._runPipeline(selected, scanOptions, runId, this._abortController.signal, pipeline)
      .catch((err) => {
        if (this._abortController?.signal.aborted || err?.code === 'ECANCELLED') {
          return this._finishCancelled(runId);
        }
        this.logger('error', `pipeline failed: ${err.message}`);
        if (this.scrapeState && this.scrapeState.runId === runId) {
          this.scrapeState.status = 'completed-with-errors';
          this.scrapeState.finishedAt = new Date().toISOString();
          this.scrapeState.error = { name: err.name, message: String(err.message).slice(0, 500) };
          this.persistState().catch(() => {});
          this._broadcast('scrape-update', this.scrapeState);
        }
      })
      .finally(() => {
        if (this.scrapeState?.runId === runId) this._abortController = null;
        this._pipeline = null;
      });
    return this.scrapeState;
  }

  async _finishCancelled(runId) {
    if (!this.scrapeState || this.scrapeState.runId !== runId) return;
    this.scrapeState.status = 'cancelled';
    this.scrapeState.finishedAt = new Date().toISOString();
    this.scrapeState.currentActivity = 'scrape cancelled';
    await this.persistState();
    this._broadcast('scrape-update', this.scrapeState);
  }

  async cancel() {
    if (!this.isRunning() || !this._abortController) {
      return { cancelled: false, state: this.scrapeState || null };
    }
    this.scrapeState.status = 'cancelling';
    this.scrapeState.currentActivity = 'cancelling active scrape';
    await this.persistState();
    this._broadcast('scrape-update', this.scrapeState);
    this._abortController.abort();
    return { cancelled: true, state: this.scrapeState };
  }

  /**
   * @param {string[]} books
   * @param {object} scanOptions
   * @param {string} runId
   * @param {AbortSignal} signal
   * @param {{ verify?: boolean, catalog?: boolean }} [pipeline]
   *
   * `verify` and `catalog` exist because the live poll runs this same pipeline
   * on a ~60s cadence (src/live-service.mjs), and both of these steps are
   * priced against the scrape itself, not against the clock:
   *
   *   - The verification pass re-quotes every leg by re-scraping the books the
   *     legs came from. Measured medians over nine real runs: unibet 53.9s,
   *     getsbet 34.4s, contibet 31.3s. Adding it to a poll roughly doubles the
   *     work per tick and pushes the pipeline past the 90s live window it was
   *     built to serve — the re-quote would be confirming a price that expired
   *     while it was being confirmed. On a poll the scrape that just ran IS the
   *     freshest statement of the price, so the pass is skipped by request.
   *
   *   - The catalog is a 1.2MB derived artifact rebuilt from the whole
   *     workspace. It is analysis of a capture, not part of pricing one, and
   *     rewriting it every 60s buys nothing a trader reads.
   *
   * Both default to true, so an ordinary scrape is unchanged.
   */
  async _runPipeline(books, scanOptions, runId, signal, pipeline = {}) {
    const verify = pipeline.verify !== false;
    const catalog = pipeline.catalog !== false;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        const err = new Error('scrape cancelled');
        err.code = 'ECANCELLED';
        throw err;
      }
    };
    const finishCancelled = async () => this._finishCancelled(runId);
    this._setStep('Scraping', 0);

    const onEvent = (e) => this._handleScrapeEvent(e);
    let batch;
    try {
      batch = await runScraperBatch({
        books,
        parallel: normalizeScrapeParallel(process.env.ARBITER_SCRAPE_PARALLEL || 4),
        dataDir: this.dataDir,
        configPath: this.configPath,
        runId,
        signal,
        onEvent,
        logger: this.logger,
        maxEvents: scanOptions.maxEvents,
        sport: scanOptions.sport,
        includePast: scanOptions.includePast,
        includeLive: scanOptions.includeLive,
      });
    } catch (err) {
      if (signal?.aborted || err?.code === 'ECANCELLED') {
        await finishCancelled();
        return;
      }
      if (err && err.code === 'ELOCKED') {
        this.scrapeState.status = 'locked';
        this.scrapeState.error = { name: 'LockError', message: err.message };
        this.scrapeState.finishedAt = new Date().toISOString();
        await this.persistState();
        this._broadcast('scrape-update', this.scrapeState);
        return;
      }
      throw err;
    }

    if (signal?.aborted || batch.report.status === 'cancelled') {
      await finishCancelled();
      return;
    }
    await persistRunReport(batch.report, { dataDir: this.dataDir });
    this.scrapeState.summary = {
      completed: batch.report.jobs.filter((j) => j.valid).length,
      failed: batch.report.jobs.filter((j) => !j.valid).length,
      events: batch.report.jobs.reduce((acc, j) => acc + (j.events || 0), 0),
      markets: mergeMarketDiagnostics(batch.report.jobs),
    };

    throwIfAborted();
    this._setStep('Scanning', 1);
    let scan;
    let scanFailed = false;
    try {
      scan = await scanWorkspace({
        dataDir: this.dataDir,
        sourceIds: books,
        scrapeRunId: runId,
        capturedAt: new Date().toISOString(),
        bankroll: scanOptions.bankroll ?? DEFAULT_SCAN_OPTIONS.bankroll,
        minMarginPercent: scanOptions.minMarginPercent ?? DEFAULT_SCAN_OPTIONS.minMarginPercent,
        minEvPercent: scanOptions.minEvPercent ?? DEFAULT_SCAN_OPTIONS.minEvPercent,
        maxMiddleRiskPercent: scanOptions.maxMiddleRiskPercent ?? DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
        minMiddleRoiPercent: scanOptions.minMiddleRoiPercent ?? DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
        includeLive: scanOptions.includeLive ?? DEFAULT_SCAN_OPTIONS.includeLive,
        includePast: scanOptions.includePast ?? DEFAULT_SCAN_OPTIONS.includePast,
        sport: scanOptions.sport,
        // The stake cap bounds every allocation and deliberately never joins
        // the published scan.options: it is a scan input like sourceIds, and
        // scan-fields-census pins that payload's key list.
        maxStake: scanOptions.maxStake,
        // The age cap is prematch-only, converted at the one call site that
        // owns the scan's windows; live observations keep their own window
        // (liveMaxAgeMs) untouched, per the design decision for this field.
        prematchMaxAgeMs: scanOptions.maxAgeMinutes === undefined || scanOptions.maxAgeMinutes === null
          ? undefined
          : scanOptions.maxAgeMinutes * 60000,
        publish: false,
      });
      this._broadcast('scan-update', {
        opportunities: scan.opportunities.length,
        middles: scan.middles.length,
        positiveEv: scan.positiveEv.length,
        lowHold: scan.lowHold.length,
      });
    } catch (err) {
      scanFailed = true;
      this.logger('error', `scan failed: ${err.message}`);
      this.scrapeState.error = { name: 'ScanError', message: String(err.message).slice(0, 500) };
    }

    throwIfAborted();
    let verifyFailed = false;
    if (verify && scan && scan.opportunities.length) {
      this._setStep('Verifying', 2);
      try {
        await runVerificationPass(
          scan.opportunities,
          scan,
          {
            dataDir: this.dataDir,
            configPath: this.configPath,
            parallel: 12,
            maxEvents: scanOptions.maxEvents,
            sport: scanOptions.sport,
            runId,
            signal,
            onEvent: (event) => onEvent({ ...event, phase: 'verification' }),
            logger: this.logger,
          },
        );
      } catch (err) {
        verifyFailed = true;
        this.logger('error', `verification failed: ${err.message}`);
      }
    }

    throwIfAborted();
    // Publish only after the scan and any verification pass have completed.
    await writeJsonAtomic(join(this.dataDir, 'latest-scan.json'), scan || emptyScan({ scrapeRunId: runId }));

    this._setStep('Cataloging', 3);
    if (catalog && scan) {
      try {
        throwIfAborted();
        await buildMarketCatalog(this.dataDir, scan);
      } catch (err) {
        this.logger('error', `catalog failed: ${err.message}`);
      }
    }

    throwIfAborted();
    this._setStep('Complete', 4);
    this.scrapeState.status = resolveTerminalStatus({ scanFailed, verifyFailed, jobs: this.scrapeState.jobs });
    this.scrapeState.finishedAt = new Date().toISOString();
    await this.persistState();
    this._broadcast('scrape-update', this.scrapeState);

  }

  _setStep(label, index) {
    if (!this.scrapeState) return;
    this.scrapeState.currentStep = { label, index };
    this.scrapeState.currentActivity = label;
    this._broadcast('scrape-update', this.scrapeState);
  }

  _handleScrapeEvent(event) {
    if (!this.scrapeState) return;
    if (event.phase === 'verification') {
      this._broadcast(event.type, event);
      return;
    }
    const state = this.scrapeState;
    if (event.type === 'job-start') {
      state.currentActivity = `scraping ${event.jobId}`;
      const j = state.jobs.find((x) => x.id === event.jobId);
      if (j) j.status = 'running';
      this._broadcast('scrape-update', state);
      return;
    }
    if (event.type === 'job-complete') {
      const j = state.jobs.find((x) => x.id === event.jobId);
      const result = event.result || {};
      if (j) {
        j.valid = result.valid;
        j.status = result.status;
        j.events = result.events;
        j.durationMs = result.durationMs;
        j.error = result.error || null;
        j.marketDiagnostics = result.marketDiagnostics || null;
        j.startedAt = result.startedAt;
        j.finishedAt = result.finishedAt;
      }
      state.summary = state.summary || { completed: 0, failed: 0, events: 0 };
      if (result.valid) {
        state.summary.completed = (state.summary.completed || 0) + 1;
        state.summary.events = (state.summary.events || 0) + (result.events || 0);
      } else {
        state.summary.failed = (state.summary.failed || 0) + 1;
      }
      this._broadcast('scrape-update', state);
      return;
    }
    if (event.type === 'batch-end') {
      const report = event.report;
      if (report && Array.isArray(report.jobs)) {
        for (const rj of report.jobs) {
          const j = state.jobs.find((x) => x.id === rj.id);
          if (j) {
            j.valid = rj.valid;
            j.status = rj.status;
            j.events = rj.events;
            j.durationMs = rj.durationMs;
            j.error = rj.error || null;
            j.marketDiagnostics = rj.marketDiagnostics || null;
          }
        }
      }
      this._broadcast('scrape-update', state);
    }
  }

  _broadcast(type, payload) {
    if (this.broadcaster) this.broadcaster.broadcast(type, payload);
  }
}

function mergeMarketDiagnostics(jobs) {
  const map = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    for (const market of job.marketDiagnostics?.markets || []) {
      const entry = map.get(market.marketKey) || {
        marketKey: market.marketKey,
        eventCount: 0,
        selectionCount: 0,
        completeCount: 0,
        incompleteCount: 0,
      };
      entry.eventCount += market.eventCount || 0;
      entry.selectionCount += market.selectionCount || 0;
      entry.completeCount += market.completeCount || 0;
      entry.incompleteCount += market.incompleteCount || 0;
      map.set(market.marketKey, entry);
    }
  }
  return [...map.values()].sort((a, b) => a.marketKey.localeCompare(b.marketKey));
}

export function resolveTerminalStatus({ scanFailed, verifyFailed, jobs = [] }) {
  // A scan failure is terminal even if every scrape job succeeded — don't
  // report a clean "completed" for a run whose findings were never produced.
  // A failed scan is terminal; a failed verification pass is not clean.
  const failed = jobs.filter((job) => job.valid === false && job.status !== 'skipped').length;
  return scanFailed ? 'failed' : failed === 0 && !verifyFailed ? 'completed' : 'completed-with-errors';
}

export function resolveScanRequest(input) {
  const {
    bankroll = DEFAULT_SCAN_OPTIONS.bankroll,
    minMarginPercent = DEFAULT_SCAN_OPTIONS.minMarginPercent,
    minEvPercent = DEFAULT_SCAN_OPTIONS.minEvPercent,
    maxMiddleRiskPercent = DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
    minMiddleRoiPercent = DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
    includeLive = DEFAULT_SCAN_OPTIONS.includeLive,
    includePast = DEFAULT_SCAN_OPTIONS.includePast,
    maxEvents,
    sport,
    maxStake,
    maxAgeMinutes,
  } = input || {};
  return {
    bankroll: clampNumber(bankroll, 10, 1000000, DEFAULT_SCAN_OPTIONS.bankroll),
    minMarginPercent: clampNumber(minMarginPercent, -50, 100, DEFAULT_SCAN_OPTIONS.minMarginPercent),
    minEvPercent: clampNumber(minEvPercent, 0, 100, DEFAULT_SCAN_OPTIONS.minEvPercent),
    maxMiddleRiskPercent: clampNumber(maxMiddleRiskPercent, 0, 100, DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent),
    minMiddleRoiPercent: clampNumber(minMiddleRoiPercent, 0, 100, DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent),
    includeLive: Boolean(includeLive),
    includePast: Boolean(includePast),
    maxEvents: normalizeMaxEvents(maxEvents),
    sport: sport ? String(sport).trim().toLowerCase() : undefined,
    // The two optional caps. Absence stays absence — "no stake cap", and "the
    // snapshot-quality default window" — so clampOptional returns undefined
    // for anything it cannot read instead of inventing a number: a guessed
    // maxStake of 0 would drop every arbitrage, and a guessed age would
    // silently change which observations count as fresh.
    maxStake: clampOptional(maxStake, 0, 1000000),
    maxAgeMinutes: clampOptional(maxAgeMinutes, 1, 10080),
  };
}

function normalizeMaxEvents(value) {
  if (String(value ?? '').trim().toLowerCase() === 'all') return 'all';
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 5000) : undefined;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Clamp an optional cap whose absence is meaningful. Unlike clampNumber —
 * which answers an unreadable value with a documented default — an unreadable
 * cap answers undefined: no cap was asked for, and the consumer falls back to
 * its own unbounded behaviour. `maxStake: 0` is still a finite value and
 * clamps to 0; only null, '' and non-numeric text read as "not expressed".
 */
function clampOptional(value, lo, hi) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, n));
}

export { loadScraperJobs };
