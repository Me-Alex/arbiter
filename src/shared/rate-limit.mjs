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
   */
  constructor({ capacity = 30, refillPerSec = 10 } = {}) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
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
}

/**
 * Build a peer identifier for rate limiting.
 * Prefers `x-forwarded-for` (first hop) when behind a reverse proxy,
 * falls back to the raw socket address.
 */
export function peerKey(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
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
