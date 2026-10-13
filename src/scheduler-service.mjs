import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './shared/atomic-write.mjs';

/**
 * scheduler-service.mjs — kicks off a full scrape + verify cycle every N
 * minutes. Disabled by default (no cycle = no surprise CPU spikes).
 */

const STATE_FILENAME = 'scheduler-state.json';

export class SchedulerService {
  constructor({ dataDir, configPath, orchestrator, logger = () => {} }) {
    this.dataDir = dataDir;
    this.configPath = configPath;
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.intervalMinutes = clampInterval(process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES, 5);
    this._timer = null;
    this.lastRun = null;
    this.lastError = null;
    this.enabled = false;
    this.bookIds = [];
    this.scanOptions = {};
    this.resumed = false;
  }

  async loadState() {
    const state = await readJson(join(this.dataDir, STATE_FILENAME), null);
    if (!state) return;
    this.lastRun = state.lastRun || null;
    this.lastError = state.lastError || null;
    this.bookIds = Array.isArray(state.bookIds) ? state.bookIds : [];
    this.scanOptions = state.scanOptions && typeof state.scanOptions === 'object' ? state.scanOptions : {};
    this.intervalMinutes = clampInterval(state.intervalMinutes, this.intervalMinutes);
    if (state.enabled) {
      this.enabled = true;
      this.resumed = true;
      this._startTimer();
    }
  }

  async persistState() {
    await writeJsonAtomic(join(this.dataDir, STATE_FILENAME), {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      bookIds: this.bookIds,
      scanOptions: this.scanOptions,
      lastRun: this.lastRun,
      lastError: this.lastError,
    });
  }

  async enable({ bookIds, scanOptions, intervalMinutes } = {}) {
    if (!Array.isArray(bookIds) || bookIds.length === 0) {
      const err = new Error('scheduler requires at least one bookmaker');
      err.code = 'EBADINPUT';
      throw err;
    }
    if (this._timer) {
      clearInterval(this._timer);
      // Not cosmetic. `_startTimer()` opens with `if (this._timer || !this.enabled)
      // return`, so a handle left behind by clearInterval is truthy and the re-arm
      // below becomes a no-op: the interval is cleared, nothing replaces it, and
      // status() still reports `enabled: true` and `active: true` — a scheduler
      // that is not running and says it is.
      //
      // The page reaches that path on its own: `sched-save` posts `enabled`
      // again every time it is pressed, so enabling, changing the interval and
      // saving again used to stop the schedule permanently. disable() already
      // took this step; enable() did not.
      this._timer = null;
    }
    this.bookIds = [...new Set(bookIds.map(String))];
    this.scanOptions = scanOptions && typeof scanOptions === 'object' ? scanOptions : {};
    this.intervalMinutes = clampInterval(intervalMinutes, this.intervalMinutes);
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
    await this.persistState();
    return await this.status();
  }

  async status() {
    return {
      enabled: this.enabled,
      active: Boolean(this._timer),
      resumed: this.resumed,
      intervalMinutes: this.intervalMinutes,
      bookIds: this.bookIds,
      scanOptions: this.scanOptions,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }

  _startTimer() {
    if (this._timer || !this.enabled) return;
    this._timer = setInterval(() => {
      this._tick(this.bookIds, this.scanOptions).catch((err) => {
        this.lastError = { message: err.message, at: new Date().toISOString() };
        this.persistState().catch(() => {});
      });
    }, this.intervalMinutes * 60 * 1000);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _tick(bookIds, scanOptions) {
    if (this.orchestrator.isRunning()) {
      this.lastRun = { at: new Date().toISOString(), ok: false, skipped: true, reason: 'scrape already running' };
      await this.persistState();
      return;
    }
    try {
      await this.orchestrator.launch({ bookIds, scanOptions });
      this.lastRun = { at: new Date().toISOString(), ok: true, launched: true };
      this.lastError = null;
    } catch (err) {
      this.lastRun = { at: new Date().toISOString(), ok: false };
      this.lastError = { message: err.message, at: new Date().toISOString() };
      this.logger('warn', `scheduler tick failed: ${err.message}`);
    }
    await this.persistState();
  }
}

function clampInterval(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(1440, Number(fallback) || 5));
  return Math.max(1, Math.min(1440, Math.round(parsed)));
}
