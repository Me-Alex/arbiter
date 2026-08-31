import ScraperBase from './base.mjs';

/**
 * ProviderContract — swappable parser for books that share an odds provider
 * (Altenar, BetGenius, SBTech, etc). Subclassing ScraperBase is still the
 * pattern for transport (HTTP, Playwright, signing), but `parse(raw)` is the
 * only piece that varies between tenants.
 */
export default class ProviderContract extends ScraperBase {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.locale]
   * @param {string} [opts.timezone]
   * @param {string} [opts.currency]
   */
  constructor(opts = {}) {
    super(opts);
    this.baseUrl = opts.baseUrl || '';
    this.locale = opts.locale || 'en-GB';
    this.timezone = opts.timezone || 'Europe/Bucharest';
    this.currency = opts.currency || 'RON';
  }

  /**
   * parse(raw) — raw tenant payload → RawEvent[].
   * Subclasses MUST implement. Throw ValidationError on shape drift.
   */
  parse(_raw) {
    throw new Error('ProviderContract.parse() must be implemented by subclass');
  }

  /** Override the ScraperBase hooks to lean on parse(). */
  normalize(raw) {
    return this.parse(raw);
  }

  /** Default no-op; tenant-specific extractors can override. */
  extractEvents(rawEvents) {
    return rawEvents;
  }

  /** Shared fetch helper used by every Altenar / BetGenius tenant. */
  async fetchJson(path, { headers = {}, timeoutMs = this.timeoutMs, signal } = {}) {
    const url = new URL(path, this.baseUrl).toString();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const combinedSignal = combineAbortSignals(signal, ac.signal);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ArbiterBot/0.1; +local)',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': `${this.locale},en;q=0.7`,
          ...headers,
        },
        signal: combinedSignal,
      });
      if (!res.ok) {
        const err = new Error(`${this.id}: HTTP ${res.status} on ${path}`);
        err.code = 'EUPSTREAM';
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
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
