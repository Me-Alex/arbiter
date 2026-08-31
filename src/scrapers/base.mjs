import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomicSync } from '../shared/atomic-write.mjs';
import { ValidationError, UpstreamError, TimeoutError, isRetryable, backoffMs } from '../shared/errors.mjs';

/**
 * ScraperBase — every bookmaker scraper inherits from this.
 *
 * Subclasses MUST set:
 *   id           — short id, used as workspace filename
 *   name         — human label
 *   sourceIds    — array of one or more source ids this scraper contributes
 *
 * Subclasses MUST implement (in this exact order):
 *   fetchRaw()        → any (HTTP response, JSON blob, HTML string, etc.)
 *   normalize(raw)    → RawEvent[]   (rawEvents, no engine knowledge yet)
 *   extractEvents(r)  → NormalizedEvent[] (final shape the engine consumes)
 *
 * Optional overrides:
 *   shouldRun()       → guard that returns false to skip (e.g. paused book)
 *   timeoutMs         → per-attempt timeout
 *   maxAttempts       → retry count
 *
 * The base class:
 *   - runs fetchRaw → normalize → extractEvents with exponential backoff
 *   - validates that every event has positive odds + a non-empty key
 *   - writes to <dataDir>/staging/<book>_<ts>.json then atomically promotes
 *     to <dataDir>/workspace/<book>_events.json
 *   - returns { valid, status, outputs, error, startedAt, finishedAt }
 *
 * NOTE: the single-flight lock (data/scrape.lock) is owned by the
 * orchestrator, not by individual scrapers — see src/scraper-service.mjs.
 */
export default class ScraperBase {
  id = 'base';
  name = 'Base';
  sourceIds = [];

  timeoutMs = 25_000;
  maxAttempts = 3;

  /** @param {{ dataDir?: string, logger?: Function, runId?: string }} [opts] */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || join(process.cwd(), 'data');
    this.logger = opts.logger || (() => {});
    this.runId = opts.runId || null;
  }

  // ---- subclasses override these ----------------------------------------

  /** Pull raw payload from the upstream. No parsing. */
  async fetchRaw() {
    throw new Error(`${this.id}: fetchRaw() not implemented`);
  }

  /** raw → RawEvent[] (provider-native shape, no normalization). */
  normalize(_raw) {
    return [];
  }

  /** RawEvent[] → NormalizedEvent[] (engine-consumable). */
  extractEvents(_rawEvents) {
    return [];
  }

  /** Optional guard. False ⇒ skipped (valid: false, reason: 'skipped'). */
  shouldRun() {
    return true;
  }

  // ---- orchestration -----------------------------------------------------

  workspacePath() {
    return join(this.dataDir, 'workspace', `${this.id}_events.json`);
  }

  stagingPath(ts) {
    return join(this.dataDir, 'staging', `${this.id}_${ts}.json`);
  }

  /**
   * Run the full lifecycle. Never throws — all failures are encoded in the
   * envelope so the orchestrator can broadcast them over SSE.
   *
   * @returns {Promise<{
   *   id: string,
   *   name: string,
   *   sourceIds: string[],
   *   valid: boolean,
   *   status: string,
   *   outputs: string[],
   *   events: number,
   *   rawSize: number,
   *   durationMs: number,
   *   startedAt: string,
   *   finishedAt: string,
   *   error: object|null,
   *   reason: string|null
   * }>}
   */
  async run({ signal } = {}) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    if (signal?.aborted) {
      return this.envelope(startedAt, started, {
        valid: false,
        status: 'cancelled',
        reason: 'aborted-before-start',
        events: 0,
      });
    }
    if (this.shouldRun() === false) {
      return this.envelope(startedAt, started, {
        valid: false,
        status: 'skipped',
        reason: 'shouldRun=false',
        events: 0,
      });
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const combinedSignal = combineAbortSignals(signal, ac.signal);
        const raw = await this._withAbort(this.fetchRaw({ signal: combinedSignal }), combinedSignal);
        clearTimeout(to);
        if (signal?.aborted) {
          return this.envelope(startedAt, started, {
            valid: false,
            status: 'cancelled',
            reason: 'aborted',
            events: 0,
          });
        }
        const rawEvents = this.normalize(raw);
        let events = [];
        try {
          events = this.extractEvents(rawEvents);
        } catch (err) {
          throw new ValidationError(
            `${this.id}.extractEvents failed: ${err.message}`,
            { field: err.field || null, cause: err },
          );
        }
        const validated = this.validate(events);
        const rawSize = this._measure(raw);
        const ts = startedAt.replace(/[:.]/g, '-');
        const staging = this.stagingPath(ts);
        writeJsonAtomicSync(staging, this._serializable(validated, raw));
        await this._promote(staging, this.workspacePath());
        return this.envelope(startedAt, started, {
          valid: true,
          status: 'ok',
          events: validated.length,
          rawSize,
          outputs: [this.workspacePath()],
        });
      } catch (err) {
        clearTimeout(to);
        if (signal?.aborted) {
          return this.envelope(startedAt, started, {
            valid: false,
            status: 'cancelled',
            reason: 'aborted',
            events: 0,
          });
        }
        lastErr = err;
        this.logger('warn', `${this.id} attempt ${attempt} failed: ${err.message}`);
        if (!isRetryable(err) || attempt >= this.maxAttempts) break;
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      } finally {
        clearTimeout(to);
      }
    }

    return this.envelope(startedAt, started, {
      valid: false,
      status: lastErr && lastErr.code === 'ETIMEOUT' ? 'timeout' : 'failed',
      events: 0,
      outputs: [],
      error: this._shapeError(lastErr),
      reason: lastErr && lastErr.code === 'ETIMEOUT' ? 'timeout' : 'error',
    });
  }

  // ---- helpers -----------------------------------------------------------

  envelope(startedAt, startedMs, body) {
    const finishedAt = new Date().toISOString();
    return {
      id: this.id,
      name: this.name,
      sourceIds: Array.isArray(this.sourceIds) ? [...this.sourceIds] : [],
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      outputs: body.outputs || [],
      events: body.events || 0,
      rawSize: body.rawSize || 0,
      valid: Boolean(body.valid),
      status: body.status || (body.valid ? 'ok' : 'failed'),
      error: body.error || null,
      reason: body.reason || null,
    };
  }

  /** Reject events with missing/garbage odds or missing match key. */
  validate(events) {
    if (!Array.isArray(events)) {
      throw new ValidationError(`${this.id}: extractEvents must return an array`);
    }
    const out = [];
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (!e.id) {
        throw new ValidationError(`${this.id}: event missing id`, { field: 'id' });
      }
      if (!e.eventKey || typeof e.eventKey !== 'string') {
        throw new ValidationError(`${this.id}: event missing eventKey`, { field: 'eventKey' });
      }
      if (!Array.isArray(e.markets) || e.markets.length === 0) continue;
      let priced = false;
      for (const m of e.markets) {
        if (!m || !m.key) continue;
        if (!Array.isArray(m.selections)) continue;
        for (const s of m.selections) {
          const o = Number(s && s.odds);
          if (!Number.isFinite(o) || o <= 1) {
            throw new ValidationError(
              `${this.id}: selection has invalid odds (${s && s.odds})`,
              { field: 'markets.selections.odds' },
            );
          }
          priced = true;
          s.odds = Number(o.toFixed(3));
        }
      }
      if (priced) out.push(e);
    }
    return out;
  }

  _shapeError(err) {
    if (!err) return null;
    return {
      name: err.name || 'Error',
      message: String(err.message || err).slice(0, 500),
      code: err.code || null,
      field: err.field || null,
      status: err.status || null,
    };
  }

  _measure(raw) {
    if (!raw) return 0;
    if (typeof raw === 'string') return raw.length;
    if (Buffer.isBuffer(raw)) return raw.length;
    try {
      return JSON.stringify(raw).length;
    } catch {
      return 0;
    }
  }

  _serializable(events, raw) {
    const capturedAt = new Date().toISOString();
    const discovered = Number(raw?.discovery?.count || 0);
    const extracted = Number(raw?.extraction?.ok || 0);
    const extractionFailed = Number(raw?.extraction?.failed || 0);
    const dataStatus = discovered > 0 && extracted === 0 && extractionFailed > 0
      ? 'failed'
      : events.length === 0
        ? 'empty'
        : extractionFailed > 0
          ? 'partial'
          : 'fresh';
    return {
      schemaVersion: 2,
      runId: this.runId,
      sourceId: this.id,
      capturedAt,
      observedAt: capturedAt,
      dataStatus,
      discovery: raw?.discovery || null,
      extraction: raw?.extraction || null,
      events,
    };
  }

  async _promote(from, to) {
    const buf = await fs.readFile(from);
    await fs.mkdir(dirname(to), { recursive: true });
    const tmp = `${to}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, to);
    await fs.unlink(from).catch(() => {});
  }

  async _withAbort(promise, signal) {
    if (!signal) return promise;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new TimeoutError('aborted', { code: 'EABORTED' }));
        signal.addEventListener('abort', () => reject(new TimeoutError('aborted', { code: 'EABORTED' })), { once: true });
      }),
    ]);
  }
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export { ValidationError, UpstreamError, TimeoutError };
