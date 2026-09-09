import { join } from 'node:path';
import { runScraperBatch, persistRunReport, loadScraperJobs, normalizeScrapeParallel, toProgressJob } from './scraper-service.mjs';
import { scanWorkspace } from './scanner/scanner.mjs';
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
   *     minRoiPercent?: number,
   *     maxMiddleRiskPercent?: number,
   *     minMiddleRoiPercent?: number,
   *     includeLive?: boolean,
   *     includePast?: boolean,
   *     maxEvents?: number|'all',
   *     sport?: string,
   *   },
   * }} args
   */
  async launch({ bookIds, scanOptions = {} } = {}) {
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
    const enabledIds = new Set();
    for (const job of jobs) {
      if (job.enabled !== false) {
        // If a sport filter is active, only include scrapers that explicitly support that sport
        if (sportFilter) {
          if (Array.isArray(job.supportedSports) && job.supportedSports.includes(sportFilter)) {
            // matches filter — include
          } else {
            continue; // no supportedSports or doesn't match — exclude
          }
        }
        enabledIds.add(job.id);
        if (Array.isArray(job.sourceIds)) job.sourceIds.forEach((sourceId) => enabledIds.add(sourceId));
      }
    }
    const requested = Array.isArray(bookIds) && bookIds.length > 0
      ? bookIds
      : jobs.filter((job) => {
          if (job.enabled === false) return false;
          if (sportFilter && Array.isArray(job.supportedSports) && job.supportedSports.length > 0) {
            return job.supportedSports.includes(sportFilter);
          }
          return true;
        }).map((job) => job.id);
    const selected = [...new Set(requested)].filter((id) => enabledIds.has(id));
    if (selected.length === 0) {
      const err = new Error('no enabled bookmaker jobs selected');
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
    this._pipeline = this._runPipeline(selected, scanOptions, runId, this._abortController.signal)
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

  async _runPipeline(books, scanOptions, runId, signal) {
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
        runId,
        signal,
        onEvent,
        logger: this.logger,
        maxEvents: scanOptions.maxEvents,
        sport: scanOptions.sport,
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
        bankroll: scanOptions.bankroll ?? 1000,
        minRoiPercent: scanOptions.minRoiPercent ?? 0,
        maxMiddleRiskPercent: scanOptions.maxMiddleRiskPercent ?? 15,
        minMiddleRoiPercent: scanOptions.minMiddleRoiPercent ?? 20,
        includeLive: scanOptions.includeLive ?? false,
        includePast: scanOptions.includePast ?? false,
        sport: scanOptions.sport,
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
    if (scan && scan.opportunities.length) {
      this._setStep('Verifying', 2);
      try {
        await runVerificationPass(
          scan.opportunities,
          scan,
          {
            dataDir: this.dataDir,
            parallel: 12,
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
    if (scan) {
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
    bankroll = 1000,
    minRoiPercent = 0,
    maxMiddleRiskPercent = 15,
    minMiddleRoiPercent = 20,
    includeLive = false,
    includePast = false,
    maxEvents,
    sport,
  } = input || {};
  return {
    bankroll: clampNumber(bankroll, 10, 1000000, 1000),
    minRoiPercent: clampNumber(minRoiPercent, -50, 100, 0),
    maxMiddleRiskPercent: clampNumber(maxMiddleRiskPercent, 0, 100, 15),
    minMiddleRoiPercent: clampNumber(minMiddleRoiPercent, 0, 100, 20),
    includeLive: Boolean(includeLive),
    includePast: Boolean(includePast),
    maxEvents: normalizeMaxEvents(maxEvents),
    sport: sport ? String(sport).trim().toLowerCase() : undefined,
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

export { loadScraperJobs };
