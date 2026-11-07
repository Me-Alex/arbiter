import { randomBytes } from 'node:crypto';

const CSRF_HEADER = 'x-arbiter-token';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let csrf = randomBytes(24).toString('hex');

export function rotateCsrf() {
  csrf = randomBytes(24).toString('hex');
  return csrf;
}

export function isLoopbackHost(host) {
  if (!host) return false;
  let h = String(host).toLowerCase();
  // bracketed IPv6: [::1] or [::1]:3022
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return false;
    h = h.slice(1, end);
  } else if (h.includes(':')) {
    // could be `host:port` or unbracketed IPv6 (`::1`)
    if (h.lastIndexOf(':') === h.indexOf(':')) {
      // single colon → host:port
      h = h.split(':')[0];
    } // else: unbracketed IPv6, keep as-is
  }
  return LOOPBACK_HOSTS.has(h);
}

export function buildPublicHostSet() {
  const raw = (process.env.PUBLIC_HOSTS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertLocalApiRequest(req) {
  const host = req.headers.host || '';
  const hostName = host.split(':')[0].toLowerCase();
  const publicHosts = buildPublicHostSet();
  if (!isLoopbackHost(hostName) && !publicHosts.has(hostName)) {
    const err = new Error(`api is local-only; got host=${hostName}`);
    err.statusCode = 403;
    err.code = 'ENOTLOCAL';
    throw err;
  }
  // If Origin is set, it must be loopback too.
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (!isLoopbackHost(u.hostname) && !publicHosts.has(u.hostname.toLowerCase())) {
        const err = new Error(`origin ${origin} not allowed`);
        err.statusCode = 403;
        err.code = 'EBADORIGIN';
        throw err;
      }
    } catch (e) {
      if (e.statusCode) throw e;
      // malformed origin — refuse
      const err = new Error('malformed origin');
      err.statusCode = 403;
      throw err;
    }
  }
}

/**
 * Is a socket address on the loopback interface?
 *
 * `req.socket.remoteAddress` is not the Host header: it is what the kernel says
 * about the peer, so unlike a header it cannot be set by the caller. It arrives
 * in three shapes on this platform — `127.0.0.1`, `::1`, and the IPv4-mapped
 * `::ffff:127.0.0.1` — and a guard that knew only the first would refuse every
 * connection on a dual-stack listener while looking correct on one machine.
 *
 * The whole `127.0.0.0/8` block is loopback, not just `.0.1`: Linux resolves
 * `localhost` to 127.0.0.1 but a host file is allowed to name 127.0.0.53.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const host = address.startsWith('[') ? address.slice(1, address.indexOf(']')) : address;
  // Strip an IPv4-mapped IPv6 prefix (::ffff:127.0.0.1) before the checks.
  const bare = host.replace(/^::ffff:/i, '');
  if (bare === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * May this request reach `/admin/…`?
 *
 * The operator pages are not part of the product. They drive the scrape engine,
 * rewrite settings, and read the whole registry — so "which hostname did the
 * caller type" is not a strong enough question, and the answer this returns is
 * deliberately stricter than `assertLocalApiRequest`'s:
 *
 *   - `PUBLIC_HOSTS` does not widen this. That env var exists so a deployed
 *     site can answer `/api/hero` from its own domain; an operator console
 *     reachable from a public domain is a different thing entirely, and letting
 *     one list cover both is how a convenience setting turns into an open door.
 *   - The peer is checked as well as the Host header. A client that can reach
 *     the port can also send `Host: 127.0.0.1`, so the header alone proves
 *     nothing when the listener is bound off-loopback.
 *   - A present `Origin` must be loopback too, which is what stops a hostile
 *     page in the operator's own browser from driving the console by CSRF-less
 *     navigation.
 *
 * A missing Host header fails closed. HTTP/1.1 requires one, so its absence is
 * a hand-built request, not a browser.
 */
export function isAdminRequestAllowed(req) {
  const headers = req?.headers || {};
  if (!isLoopbackHost(headers.host || '')) return false;
  const remote = req?.socket?.remoteAddress;
  // No socket (a direct call in a unit test, a crafted object) is not evidence
  // of locality. It is only skipped when there is genuinely no peer to read,
  // and the Host check above has already had to pass.
  if (remote !== undefined && remote !== null && !isLoopbackAddress(remote)) return false;
  const origin = headers.origin;
  if (origin) {
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (!isLoopbackHost(hostname)) return false;
  }
  return true;
}

export function assertCsrf(req) {
  const provided = req.headers[CSRF_HEADER];
  if (!provided || provided !== csrf) {
    const err = new Error('csrf token missing or wrong');
    err.statusCode = 403;
    err.code = 'ECSRF';
    throw err;
  }
}

export function buildCsp() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

