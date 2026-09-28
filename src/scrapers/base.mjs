import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomicSync } from '../shared/atomic-write.mjs';
import { ValidationError, UpstreamError, TimeoutError, isRetryable, backoffMs } from '../shared/errors.mjs';
import { eventIdentityKey } from '../shared/text.mjs';
import { isDeclaredFullTimeMarket, isLiteral1x2SelectionSet } from '../scanner/market-contracts.mjs';

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
        // Applied before validate() so the odds check and the settlement check
        // both see the same set of markets, and before anything is written, so
        // a non-full-time lookalike never reaches the workspace.
        this._dropNonFullTimeLookalikes(events);
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

    // The per-attempt deadline aborts the controller, which surfaces as
    // EABORTED (see _withAbort) or as the fetch implementation's own AbortError
    // — never as ETIMEOUT, which nothing in this file throws. So the old
    // `code === 'ETIMEOUT'` test never matched and every expired run was
    // reported as `failed`, losing the distinction the UI and the run report
    // draw between a timeout and a hard error.
    const timedOut = Boolean(lastErr) && isTimeoutError(lastErr);
    return this.envelope(startedAt, started, {
      valid: false,
      status: timedOut ? 'timeout' : 'failed',
      events: 0,
      outputs: [],
      error: this._shapeError(lastErr),
      reason: timedOut ? 'timeout' : 'error',
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
      // Normalise the identity to the single canonical form used by
      // eventIdentityKey, which is what the scanner, the catalog and
      // /api/odds all group by. Every adapter previously built its own key
      // string, and those included the league — which books name differently
      // ("Nations League" vs "UEFA Liga Natiunilor"), so two brands of one feed
      // never matched and a cross-book lookup by key returned nothing.
      //
      // The adapter's own key is kept as `providerEventKey` for provenance: it
      // is the only record of how the provider labelled the competition, and
      // it is what a human needs when reconciling against a screenshot.
      const canonical = eventIdentityKey(e);
      if (canonical) {
        e.providerEventKey = e.eventKey;
        e.eventKey = canonical;
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
          // Publish the price the bookmaker actually serves.
          //
          // This used to be `Number(o.toFixed(3))`, which silently re-priced
          // every selection to three decimals. Books that quote four (the
          // Altenar tenants serve 2.3334, 1.1765, 2.4546) were then reported at
          // a price that was not on their board. That is not cosmetic: the
          // engine derives ROI from 1/odds, so rounding a price DOWN raises
          // 1/odds, lowers inverseSum and inflates the reported ROI — a
          // fabricated edge on an opportunity whose whole value is that it is
          // real. Rounding UP destroys edge the same way. The published number
          // has to be the number the book will honour.
          //
          // `o` is already Number(s.odds); assigning it back normalises a
          // string price from a provider without changing its value, and
          // leaves any precision the feed sent intact.
          s.odds = o;
        }
      }
      if (priced) out.push(e);
    }
    return out;
  }

  /**
   * Drop markets that *look* like a result market but do not settle at full
   * time.
   *
   * The engine recognises a three-way market as the match-result contract when
   * its selections are literally {1, X, 2}, regardless of the provider's opaque
   * market key. That is what lets superbet's `547`, betano's `MRES` or the FEG
   * family's `ufo:mtyp:00-00` be compared across books — and it is exactly how
   * a first-half result, a half-time-or-full-time window or a double chance
   * market got paired against another book's full-time leg and reported as a
   * fabricated arbitrage.
   *
   * Enforcing this here rather than in each adapter is the point: a per-book
   * check is one forgotten `period` away from the bug returning, and the
   * adapter has no way to know the engine's inference rule. The predicate is
   * the engine's own (`isMatchResultMarket`), so the two can never disagree
   * about what may be compared.
   *
   * A market that does not settle at full time is dropped, never rejected, so
   * a feed that mixes both still contributes the sound half.
   *
   * @param {object[]} events
   * @returns {object[]} the same events, with non-full-time lookalikes removed
   */
  _dropNonFullTimeLookalikes(events) {
    for (const e of events) {
      if (!Array.isArray(e?.markets)) continue;
      e.markets = e.markets.filter((m) => {
        if (!m) return false;
        if (isDeclaredFullTimeMarket(m)) return true;
        // Only the result-market shape is at risk. A totals or handicap market
        // that settles at half time is still a real market of its own.
        return !isLiteral1x2SelectionSet(m.selections);
      });
    }
    return events;
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

  /**
   * Raw fetch wrapper shared by ProviderContract and JSON-RPC scrapers.
   * Surfaces HTTP 429 as a rate-limit error; otherwise returns the Response.
   */
  async _httpFetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('retry-after');
      let retryAfterMs = null;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) {
          retryAfterMs = seconds * 1000;
        } else {
          const date = Date.parse(retryAfter);
          if (!Number.isNaN(date)) retryAfterMs = Math.max(0, date - Date.now());
        }
      }
      const err = new UpstreamError(`${this.id}: rate limited (429)`, { status: 429 });
      err.retryAfterMs = retryAfterMs ?? null;
      throw err;
    }
    return resp;
  }
}

/**
 * True when an error means the per-attempt deadline expired, rather than a
 * genuine failure of the adapter.
 *
 * The deadline is enforced by aborting the attempt's AbortController, so what
 * propagates is either this file's `TimeoutError` with code EABORTED or the
 * fetch implementation's own AbortError. Older ETIMEOUT values from a
 * pre-controller implementation are still accepted.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'ETIMEOUT' || err.code === 'EABORTED') return true;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
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
