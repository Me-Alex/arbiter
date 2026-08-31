import { randomBytes } from 'node:crypto';

const CSRF_HEADER = 'x-arbiter-token';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let csrf = randomBytes(24).toString('hex');

export function csrfToken() {
  return csrf;
}

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

