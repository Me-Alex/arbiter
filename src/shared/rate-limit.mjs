/**
 * rate-limit.mjs — tiny in-memory token bucket per (route, peer) pair.
 *
 * Use for the `/api/*` mutation endpoints. Each bucket has a capacity
 * (the burst) and a refill rate. Returns the bucket snapshot so the
 * caller can emit `X-RateLimit-*` headers.
 *
 * No dependencies, no persistent state — a restart clears the buckets,
 * which is the desired behaviour for a local-only app.
 */

export class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=30]   max tokens in the bucket
   * @param {number} [opts.refillPerSec=10] tokens added per second
   * @param {number} [opts.maxBuckets=1000] hard cap on tracked buckets
   * @param {number} [opts.idleMs=600000]  evict buckets untouched this long
   */
  constructor({ capacity = 30, refillPerSec = 10, maxBuckets = 1000, idleMs = 600_000 } = {}) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.maxBuckets = maxBuckets;
    this.idleMs = idleMs;
    /** @type {Map<string, {tokens:number, updated:number}>} */
    this.buckets = new Map();
  }

  /**
   * Take one token from the bucket identified by (route, peer).
   * @returns {{ok: true, remaining: number, resetMs: number} | {ok: false, retryAfterMs: number, remaining: 0}}
   */
  take(route, peer) {
    const key = `${route}::${peer || 'unknown'}`;
    const now = Date.now();
    const bucket = this.buckets.get(key) || { tokens: this.capacity, updated: now };
    const elapsed = now - bucket.updated;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updated = now;
    // A brand-new bucket pushes us past the cap: evict the oldest entries so a
    // peer-id flood (spoofed XFF, bot traffic) can't grow this Map forever.
    if (!this.buckets.has(key)) this._evictOverflow();
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
      this.buckets.set(key, bucket);
      return { ok: false, retryAfterMs, remaining: 0 };
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    const resetMs = bucket.tokens >= this.capacity
      ? 0
      : Math.ceil((this.capacity - bucket.tokens) / this.refillPerMs);
    return { ok: true, remaining: Math.floor(bucket.tokens), resetMs };
  }

  /** Reset a specific bucket (used by tests and admin "trust" actions). */
  reset(route, peer) {
    this.buckets.delete(`${route}::${peer || 'unknown'}`);
  }

  /**
   * Drop buckets untouched for longer than `idleMs` (default 10 min), then
   * cap the survivors at `maxBuckets` by evicting the least-recently-used
   * half. Called on a timer by long-lived servers; safe to call directly.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} buckets removed
   */
  prune(now = Date.now()) {
    const before = this.buckets.size;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated >= this.idleMs) this.buckets.delete(key);
    }
    if (this.buckets.size > this.maxBuckets) {
      // Map preserves insertion order; re-insert the newest half so the
      // remaining entries are ordered oldest → newest.
      const survivors = [...this.buckets.entries()].sort(
        (a, b) => a[1].updated - b[1].updated,
      );
      const keep = survivors.slice(Math.floor(survivors.length / 2));
      this.buckets.clear();
      for (const [key, bucket] of keep) this.buckets.set(key, bucket);
    }
    return before - this.buckets.size;
  }

  /** @private */
  _evictOverflow() {
    if (this.buckets.size < this.maxBuckets) return;
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].updated - b[1].updated);
    const drop = Math.max(1, Math.floor(entries.length / 2));
    for (const [key] of entries.slice(0, drop)) this.buckets.delete(key);
  }
}

/**
 * Build a peer identifier for rate limiting.
 *
 * `x-forwarded-for` is only honoured when the immediate hop is NOT loopback.
 * A loopback socket means the request came from this machine, and any
 * `x-forwarded-for` on it was supplied by the client — a hostile page in the
 * user's own browser can set that header, so trusting it would let an attacker
 * mint a fresh bucket per request and bypass the limiter entirely. A
 * non-loopback hop is a real reverse proxy that rewrote the header for us.
 */
export function peerKey(req) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (isLoopbackAddress(remote)) return remote;
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    return xff.split(',')[0].trim() || remote;
  }
  return remote;
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const host = address.startsWith('[') ? address.slice(1, address.indexOf(']')) : address;
  // Strip an IPv4-mapped IPv6 prefix (::ffff:127.0.0.1) before the checks.
  const bare = host.replace(/^::ffff:/i, '');
  if (bare === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  return false;
}

/**
 * Wrap an HTTP request handler with a rate limit guard.
 * Only applies to mutating methods (anything that isn't GET/HEAD).
 *
 * @param {RateLimiter} limiter
 * @param {object} [opts]
 * @param {string} [opts.routePrefix='/api/'] apply only to these paths
 */
export function rateLimitMiddleware(limiter, { routePrefix = '/api/' } = {}) {
  return function check(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return { ok: true };
    if (!req.url?.startsWith(routePrefix)) return { ok: true };
    return limiter.take(req.url.split('?')[0], peerKey(req));
  };
}
