/**
 * live-service.mjs — drives in-play collection on the clock a live price
 * actually lives on.
 *
 * Why this exists
 * ---------------
 * Live collection was already implemented end to end before this file: the
 * per-feed predicates in scrapers/live-status.mjs, the `includeLive` flag from
 * the router through the orchestrator into every adapter, the 90-second window
 * in shared/data-quality.mjs, the pairing scope in scanner/engine.mjs, and the
 * in-play badge and counter in the UI. Measured, none of it was broken — across
 * nine real scrape runs every book with a measured live field was FRESH at scan
 * time (fortuna 9/9, casa-pariurilor 9/9, unibet 9/9, winner 9/9, superbet 9/9).
 *
 * What was missing was anything that COLLECTED on a live cadence. The only
 * recurring driver was SchedulerService, and it is wrong for this in three
 * measurable ways:
 *
 *   1. `clampInterval` floors it at 1 minute and defaults to 15. A live price
 *      expires in 90 seconds, so a 15-minute cycle publishes a live signal that
 *      was already dead fourteen minutes before anyone read it.
 *   2. It is disabled by default and re-runs whatever bookIds it was given with
 *      whatever scanOptions were stored — `includeLive` defaults to false, so
 *      the one driver in the project actively produced pre-match data unless an
 *      operator had separately ticked a box.
 *   3. Nothing reported whether it was keeping up. A driver that silently falls
 *      behind looks exactly like a driver that is working.
 *
 * The design decision that is easy to get wrong
 * ---------------------------------------------
 * A poll scrapes a subset of books, so the snapshots it did NOT touch still
 * carry the previous run's runId. `scanWorkspace` passes its `scrapeRunId` to
 * `loadWorkspace` as `expectedRunId`, and any snapshot from a different run is
 * forced STALE and dropped (scanner.mjs:51,61,74-80). A partial poll that
 * demanded its own runId therefore prices only its own books: measured, a poll
 * covering 3 of 8 books dropped the other 5 (scratch/probe-live-poll-blocker.mjs).
 *
 * This service polls EVERY runnable book rather than a live-capable subset, for
 * two reasons that happen to agree. The runId of the poll is then the runId of
 * every snapshot, so the standard expectedRunId path is satisfied and the
 * fail-closed behaviour on a book that fails mid-poll is kept. And 19 of the 24
 * books have `scope: null` in LIVE_EVIDENCE — a measurement, not a verdict — so
 * polling all of them is what lets a book that starts publishing in-play
 * tomorrow be picked up without a code change. The cost is real and is recorded
 * in the constructor below rather than hidden: this runs the whole bookmaker set
 * continuously for as long as it is enabled.
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './shared/atomic-write.mjs';
import { DEFAULT_LIVE_MAX_AGE_MS } from './shared/data-quality.mjs';

const STATE_FILENAME = 'live-state.json';

/**
 * Default cadence, and the reason it is not smaller.
 *
 * A full 24-book batch does not finish faster than this: measured wall clock
 * over nine runs was 55.1s min, 63.9s median, 117.9s max, against a 90s live
 * window. Polling faster than the batch takes cannot produce more live data —
 * the tick finds a scrape already in flight and skips — so the floor is set at
 * the batch's measured median rather than at the window, and the service
 * REPORTS the measured duration of each completed poll so an operator can see
 * the real cadence instead of the configured one.
 */
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 600;

export const FAST_LIVE_BOOKS = Object.freeze([
  'excelbet', 'favbet', 'betfair', 'superbet', 'betano', 'unibet'
]);

export class LiveService {
  constructor({ dataDir, configPath, orchestrator, logger = () => {} }) {
    this.dataDir = dataDir;
    this.configPath = configPath;
    this.orchestrator = orchestrator;
    this.logger = logger;

    this.liveOnly = Boolean(process.env.ARBITER_LIVE_ONLY === '1');
    this.intervalSeconds = clampInterval(
      process.env.ARBITER_LIVE_INTERVAL_SECONDS,
      DEFAULT_INTERVAL_SECONDS,
      this.liveOnly ? 3 : MIN_INTERVAL_SECONDS,
    );
    this.enabled = false;
    /** Empty means every runnable book — see the runId note in the file header. */
    this.bookIds = [];
    /** Store only the operator's risk thresholds. includeLive is forced on below. */
    this.scanOptions = {};

    this._timer = null;
    this.resumed = false;
    this.lastRun = null;
    this.lastError = null;
    /** Ticks that found a scrape already in flight. */
    this.skippedTicks = 0;
    this.lastSkippedAt = null;
    /** The poll launched by the previous tick, awaiting its terminal state. */
    this._pending = null;
  }

  async loadState() {
    const state = await readJson(join(this.dataDir, STATE_FILENAME), null);
    if (!state) return;
    if (state.liveOnly !== undefined) this.liveOnly = Boolean(state.liveOnly);
    this.intervalSeconds = clampInterval(state.intervalSeconds, this.intervalSeconds, this.liveOnly ? 3 : MIN_INTERVAL_SECONDS);
    this.bookIds = Array.isArray(state.bookIds) ? state.bookIds.filter((id) => typeof id === 'string') : [];
    this.scanOptions = state.scanOptions && typeof state.scanOptions === 'object' ? state.scanOptions : {};
    this.lastRun = state.lastRun || null;
    this.lastError = state.lastError || null;
    this.skippedTicks = Number(state.skippedTicks) || 0;
    this.lastSkippedAt = state.lastSkippedAt || null;
    // An interrupted tick left a run in flight that this process is not
    // watching. Forget it rather than reporting a duration for a run whose
    // start time belongs to the previous process.
    this._pending = null;
    if (state.enabled) {
      this.enabled = true;
      this.resumed = true;
      this._startTimer();
    }
  }

  async persistState() {
    await writeJsonAtomic(join(this.dataDir, STATE_FILENAME), {
      enabled: this.enabled,
      liveOnly: this.liveOnly,
      intervalSeconds: this.intervalSeconds,
      bookIds: this.bookIds,
      scanOptions: this.scanOptions,
      lastRun: this.lastRun,
      lastError: this.lastError,
      skippedTicks: this.skippedTicks,
      lastSkippedAt: this.lastSkippedAt,
    });
  }

  async enable({ bookIds, scanOptions, intervalSeconds, liveOnly } = {}) {
    if (liveOnly !== undefined) this.liveOnly = Boolean(liveOnly);
    if (Array.isArray(bookIds)) this.bookIds = [...new Set(bookIds.map(String))];
    if (scanOptions && typeof scanOptions === 'object') this.scanOptions = { ...scanOptions };
    this.intervalSeconds = clampInterval(intervalSeconds, this.intervalSeconds, this.liveOnly ? 3 : MIN_INTERVAL_SECONDS);
    if (this._timer) {
      clearInterval(this._timer);
      // Same reason as SchedulerService.enable(): `_startTimer()` bails on a
      // truthy `_timer`, so a handle left behind by clearInterval turns this
      // re-arm into a no-op. The page posts `enabled` on every `live-save`,
      // so ticking the interval and saving again used to stop the poll for
      // good while the panel kept reading "enabled".
      this._timer = null;
    }
    this.enabled = true;
    this.resumed = false;
    this._startTimer();
    await this.persistState();
    return await this.status();
  }

  async disable() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.enabled = false;
    this.resumed = false;
    this._pending = null;
    await this.persistState();
    return await this.status();
  }

  async status() {
    return {
      enabled: this.enabled,
      active: Boolean(this._timer),
      resumed: this.resumed,
      intervalSeconds: this.intervalSeconds,
      liveMaxAgeMs: DEFAULT_LIVE_MAX_AGE_MS,
      bookIds: this.bookIds,
      scanningAllBooks: this.bookIds.length === 0,
      scanOptions: { ...this.scanOptions, includeLive: true },
      pending: this._pending ? { runId: this._pending.runId, startedAt: this._pending.startedAt } : null,
      lastRun: this.lastRun,
      lastError: this.lastError,
      skippedTicks: this.skippedTicks,
      lastSkippedAt: this.lastSkippedAt,
    };
  }

  _startTimer() {
    if (this._timer || !this.enabled) return;
    this._timer = setInterval(() => {
      this._tick().catch((err) => {
        this.lastError = { message: err.message, at: new Date().toISOString() };
        this.persistState().catch(() => {});
      });
    }, this.intervalSeconds * 1000);
    // unref'd for the same reason SchedulerService does: a poll must never be
    // the reason the process stays alive.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * One poll. Records what actually happened, including the case where nothing
   * happened because the previous poll was still running — the most likely
   * steady state at this cadence, and the one a driver that only reported
   * success would hide.
   */
  async _tick() {
    // A launch() resolves as soon as the pipeline is STARTED (scrape-orchestrator
    // runs it detached), so the duration of a poll is only knowable once the
    // orchestrator reports that run terminal. That is what this call closes out.
    this._settlePending();

    if (this.orchestrator.isRunning()) {
      this.skippedTicks += 1;
      this.lastSkippedAt = new Date().toISOString();
      // Deliberately NOT written to `lastRun`.
      //
      // This tick settles the previous poll on its way in, so overwriting
      // `lastRun` here would throw away the measured duration of the run that
      // had just finished — and a tick that skips is the one that lands while a
      // poll is overrunning, which is the only moment the duration is worth
      // reading. The bug it caused was not cosmetic: the panel reported the
      // configured interval and nothing else, precisely when the real cadence
      // had drifted away from it. A skip is counted and timestamped instead.
      await this.persistState();
      return;
    }

    const startedAt = Date.now();
    try {
      const targetBooks = this.bookIds.length > 0
        ? this.bookIds
        : (this.liveOnly ? [...FAST_LIVE_BOOKS] : []);
      const state = await this.orchestrator.launch({
        bookIds: targetBooks,
        scanOptions: { ...this.scanOptions, includeLive: true, ...(this.liveOnly ? { liveOnly: true } : {}) },
        // See the _runPipeline doc: the verification pass re-scrapes the books
        // behind every leg, and on this cadence that re-scrape costs more than
        // the 90s window the poll exists to serve.
        pipeline: { verify: false, catalog: false },
      });
      this.lastError = null;
      this._pending = { runId: state?.runId ?? null, startedAt };
    } catch (err) {
      this.lastRun = { at: new Date().toISOString(), ok: false };
      this.lastError = { message: err.message, at: new Date().toISOString() };
      this.logger('warn', `live poll failed: ${err.message}`);
    }
    await this.persistState();
  }

  /**
   * Turn a finished pipeline into a measured poll result.
   *
   * `keepingUp` is computed from the measured duration, not asserted: a poll
   * that took longer than the interval is not keeping up, and the operator is
   * better served by that being visible than by a green tick.
   */
  _settlePending() {
    if (!this._pending) return;
    const { runId, startedAt } = this._pending;
    const state = this.orchestrator.scrapeState;
    if (!state || (runId && state.runId !== runId)) return;
    if (['running', 'cancelling'].includes(state.status)) return;

    const finishedAt = state.finishedAt ? Date.parse(state.finishedAt) : null;
    const durationMs = finishedAt && Number.isFinite(finishedAt) ? finishedAt - startedAt : null;
    this.lastRun = {
      at: state.finishedAt || new Date().toISOString(),
      runId: state.runId ?? null,
      status: state.status ?? null,
      ok: state.status === 'completed',
      ...(durationMs === null ? {} : { durationMs, keepingUp: durationMs <= this.intervalSeconds * 1000 }),
    };
    this._pending = null;
  }
}

function clampInterval(value, fallback, minSeconds = MIN_INTERVAL_SECONDS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(minSeconds, Math.min(MAX_INTERVAL_SECONDS, Number(fallback) || DEFAULT_INTERVAL_SECONDS));
  }
  return Math.max(minSeconds, Math.min(MAX_INTERVAL_SECONDS, Math.round(parsed)));
}
