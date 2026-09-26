import ScraperBase from './base.mjs';
import { combineAbortSignals } from '../shared/abort.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

/**
 * Hard cap on a tenant response body. The public adapters (nsoft, altenar)
 * bound their own reads; this helper has to as well, or a provider that streams
 * without a Content-Length can exhaust memory inside a single scrape.
 *
 * 16 MB, matching nsoft.mjs, and set from measurement rather than taste: the
 * largest live responses observed are superbet ~7.4 MB and favbet ~14.4 MB
 * (scripts/live-check.mjs). A 4 MB cap looked tidy and would have rejected
 * favbet outright, so the limit has to sit above the biggest real feed with
 * room for growth — while still bounding a hostile or runaway response.
 */
const MAX_BODY_BYTES = 16_000_000;

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
        // A redirect to a challenge or login page must fail loudly rather than
        // be followed into an unrelated body.
        redirect: 'error',
      });
      if (!res.ok) throw new UpstreamError(`${this.id}: HTTP ${res.status} on ${path}`, { status: res.status });
      if (!res.headers.get('content-type')?.includes('json')) {
        throw new ValidationError(`${this.id}: expected JSON from ${path}`);
      }
      return await readBoundedJson(res, this.id, combinedSignal);
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Read a JSON body, refusing anything over `MAX_BODY_BYTES`. Counting while
 * streaming means an oversized response is abandoned rather than buffered in
 * full first.
 */
async function readBoundedJson(res, id, signal) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ValidationError(`${id}: response exceeds ${MAX_BODY_BYTES / 1_000_000} MB`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  signal?.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
