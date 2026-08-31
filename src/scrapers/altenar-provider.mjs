import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, TimeoutError, isRetryable, backoffMs } from '../shared/errors.mjs';
import { writeJsonAtomicSync } from '../shared/atomic-write.mjs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Shared Altenar parser. Every Altenar-powered Romanian book (Don, TopBet,
 * Million, Baumbet, Winbet) goes through this — only the tenant config
 * (baseUrl / locale / timezone / sourceIds) varies.
 *
 * Altenar's standard payload shape (subject to versioning):
 *   {
 *     events: [{
 *       id: number,
 *       name: 'Home vs Away',
 *       startDate: '2026-01-01T18:00:00',
 *       sport: { id: 1, name: 'Football' },
 *       league: { id: 11, name: 'Liga 1' },
 *       marketGroups: [{
 *         id: 1,
 *         name: 'Main',
 *         markets: [{
 *           id: 11, type: 'MATCH_ODDS', name: 'Match Winner',
 *           selections: [{ id: 1, name: 'Home', price: 1.85 }, ...]
 *         }, ...]
 *       }, ...]
 *     }, ...]
 *   }
 *
 * If a real Altenar response uses a different shape, swap `parse()` with a
 * versioned override (`AltenarProviderV2`) instead of duplicating scrapers.
 */
export class AltenarProvider extends ProviderContract {
  /**
   * Convert Altenar tenant payload to our RawEvent[] intermediate shape.
   *
   * @param {object} raw
   * @returns {Array<object>}
   */
  parse(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError(`${this.id}: Altenar payload not an object`, { field: 'root' });
    }
    // The real-world Altenar responses come in a few flavours. We accept any
    // iterable of events; the field name varies between tenants/configs.
    const events = raw.events || raw.Event || raw.Events || raw.data?.events;
    if (!Array.isArray(events)) {
      throw new ValidationError(`${this.id}: Altenar payload missing events array`, { field: 'events' });
    }
    return events.map((e) => this._toRawEvent(e));
  }

  _toRawEvent(e) {
    const home = e.homeName || e.home?.name || e.Competitors?.[0]?.Name || '';
    const away = e.awayName || e.away?.name || e.Competitors?.[1]?.Name || '';
    if (!home || !away) {
      throw new ValidationError(`${this.id}: event missing teams`, { field: 'competitors' });
    }
    const kickoff = new Date(e.startDate || e.StartDate || e.startTime || Date.now());
    const groups = e.marketGroups || e.MarketGroups || e.markets || [];
    return {
      id: String(e.id ?? e.Id ?? e.EventId ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff.toISOString()}`),
      sport: String(e.sport?.name || e.SportName || e.Sport?.Name || 'Unknown'),
      league: String(e.league?.name || e.LeagueName || e.League?.Name || 'Unknown'),
      kickoff: kickoff.toISOString(),
      homeTeam: home,
      awayTeam: away,
      groups: Array.isArray(groups) ? groups : [],
    };
  }

  /**
   * RawEvent → NormalizedEvent. Identical across Altenar tenants.
   */
  extractEvents(rawEvents) {
    const out = [];
    for (const r of rawEvents) {
      const eventKey = [
        normalizeTeamName(r.sport),
        normalizeTeamName(r.league),
        new Date(r.kickoff).toISOString(),
        normalizeTeamName(r.homeTeam),
        normalizeTeamName(r.awayTeam),
      ].join('|');
      const markets = [];
      for (const g of r.groups) {
        const groupName = (g && (g.name || g.Name)) || 'Main';
        const ms = g && (g.markets || g.Markets || g.Market) || [];
        if (!Array.isArray(ms)) continue;
        for (const m of ms) {
          if (!m) continue;
          const marketKey = String(m.type || m.Type || m.key || m.Name || '').trim();
          if (!marketKey) continue;
          const selections = [];
          const sels = m.selections || m.Selections || m.Outcomes || [];
          if (!Array.isArray(sels)) continue;
          for (const s of sels) {
            const odds = Number(
              (s && (s.price ?? s.Price ?? s.odds ?? s.Odds)) ?? NaN,
            );
            if (!Number.isFinite(odds) || odds <= 1) continue;
            selections.push({
              id: String(s.id ?? s.Id ?? s.SelectionId ?? ''),
              name: String(s.name ?? s.Name ?? s.SelectionName ?? '').trim(),
              odds,
              handicap: s.handicap ?? s.Handicap ?? s.Point ?? null,
              group: groupName,
            });
          }
          if (selections.length === 0) continue;
          markets.push({ key: marketKey, name: String(m.name || m.Name || marketKey), selections });
        }
      }
      if (markets.length === 0) continue;
      out.push({
        id: String(r.id),
        sourceId: this.sourceIds[0] || this.id,
        sport: r.sport,
        league: r.league,
        kickoff: r.kickoff,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        eventKey,
        markets,
      });
    }
    return out;
  }
}

/**
 * Multi-tenant Altenar runner. The orchestrator instantiates one of these per
 * book under the same Altenar job, with per-tenant overrides for baseUrl,
 * locale, timezone, sourceIds, name.
 */
export class AltenarTenant {
  /**
   * @param {{
   *   id: string,
   *   name: string,
   *   baseUrl: string,
   *   locale?: string,
   *   timezone?: string,
   *   currency?: string,
   *   path?: string,
   *   dataDir?: string,
   *   logger?: Function,
   * }} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.name = cfg.name;
    this.sourceIds = [cfg.id];
    this.provider = new AltenarProvider({
      id: cfg.id,
      name: cfg.name,
      baseUrl: cfg.baseUrl,
      locale: cfg.locale,
      timezone: cfg.timezone,
      currency: cfg.currency,
      dataDir: cfg.dataDir,
      logger: cfg.logger,
      runId: cfg.runId,
    });
  }

  get dataDir() {
    return this.provider.dataDir;
  }

  workspacePath() {
    return join(this.provider.dataDir, 'workspace', `${this.id}_events.json`);
  }

  stagingPath(ts) {
    return join(this.provider.dataDir, 'staging', `${this.id}_${ts}.json`);
  }

  get logger() {
    return this.provider.logger;
  }

  set logger(fn) {
    this.provider.logger = fn;
  }

  shouldRun() {
    return true;
  }

  async fetchRaw({ signal } = {}) {
    const path = this.cfg.path || '/api/events';
    return await this.provider.fetchJson(path, { signal });
  }

  normalize(raw) {
    return this.provider.normalize(raw);
  }

  extractEvents(rawEvents) {
    return this.provider.extractEvents(rawEvents);
  }

  validate(events) {
    return this.provider.validate(events);
  }

  /** Same envelope as ScraperBase.run() — invoked via runScraperJob(). */
  async run({ signal } = {}) {
    return await runScraperLifecycle(this, this.logger, signal);
  }
}

export default AltenarProvider;

/**
 * Reuse ScraperBase's pipeline logic against an arbitrary hook object.
 * Extracted so AltenarTenant can override fetchRaw without subclassing.
 */
async function runScraperLifecycle(self, logger = () => {}, signal) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  if (signal?.aborted) {
    return envelope(self, startedAt, started, {
      valid: false, status: 'cancelled', reason: 'aborted-before-start', events: 0,
    });
  }
  if (self.shouldRun && self.shouldRun() === false) {
    return envelope(self, startedAt, started, {
      valid: false, status: 'skipped', reason: 'shouldRun=false', events: 0,
    });
  }
  let lastErr = null;
  const maxAttempts = self.maxAttempts || 3;
  const timeoutMs = self.timeoutMs || 25_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const combinedSignal = combineAbortSignals(signal, ac.signal);
      const raw = await withAbort(self.fetchRaw({ signal: combinedSignal }), combinedSignal);
      clearTimeout(to);
      if (signal?.aborted) {
        return envelope(self, startedAt, started, {
          valid: false, status: 'cancelled', reason: 'aborted', events: 0,
        });
      }
      const rawEvents = self.normalize(raw);
      let events = [];
      try { events = self.extractEvents(rawEvents); }
      catch (err) {
        throw new ValidationError(
          `${self.id}.extractEvents failed: ${err.message}`,
          { field: err.field || null, cause: err },
        );
      }
      const validated = self.validate(events);
      const rawSize = measure(raw);
      const ts = startedAt.replace(/[:.]/g, '-');
      const staging = self.stagingPath(ts);
      const capturedAt = new Date().toISOString();
      writeJsonAtomicSync(staging, {
        schemaVersion: 2,
        runId: self.provider.runId || null,
        sourceId: self.sourceIds?.[0] || self.id,
        capturedAt,
        observedAt: capturedAt,
        dataStatus: validated.length > 0 ? 'fresh' : 'empty',
        events: validated,
      });
      await promote(staging, self.workspacePath());
      return envelope(self, startedAt, started, {
        valid: true, status: 'ok', events: validated.length,
        rawSize, outputs: [self.workspacePath()],
      });
    } catch (err) {
      clearTimeout(to);
      if (signal?.aborted) {
        return envelope(self, startedAt, started, {
          valid: false, status: 'cancelled', reason: 'aborted', events: 0,
        });
      }
      lastErr = err;
      logger('warn', `${self.id} attempt ${attempt} failed: ${err.message}`);
      if (!isRetryable(err) || attempt >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    } finally {
      clearTimeout(to);
    }
  }
  return envelope(self, startedAt, started, {
    valid: false,
    status: lastErr && lastErr.code === 'ETIMEOUT' ? 'timeout' : 'failed',
    events: 0, outputs: [],
    error: shapeError(lastErr),
    reason: lastErr && lastErr.code === 'ETIMEOUT' ? 'timeout' : 'error',
  });
}

function envelope(self, startedAt, startedMs, body) {
  return {
    id: self.id,
    name: self.name || self.id,
    sourceIds: Array.isArray(self.sourceIds) ? [...self.sourceIds] : [],
    startedAt,
    finishedAt: new Date().toISOString(),
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

function shapeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: String(err.message || err).slice(0, 500),
    code: err.code || null,
    field: err.field || null,
    status: err.status || null,
  };
}

function measure(raw) {
  if (!raw) return 0;
  if (typeof raw === 'string') return raw.length;
  if (Buffer.isBuffer(raw)) return raw.length;
  try { return JSON.stringify(raw).length; } catch { return 0; }
}

async function promote(from, to) {
  const buf = await fs.readFile(from);
  await fs.mkdir(dirname(to), { recursive: true });
  const tmp = `${to}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, to);
  await fs.unlink(from).catch(() => {});
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(new TimeoutError('aborted', { code: 'EABORTED' }));
      signal.addEventListener('abort', () => reject(new TimeoutError('aborted', { code: 'EABORTED' })), { once: true });
    }),
  ]);
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
