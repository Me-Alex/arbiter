import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateCsrf, isLoopbackHost, buildPublicHostSet, assertLocalApiRequest, assertCsrf, buildCsp, isLoopbackAddress, isAdminRequestAllowed } from '../src/shared/security.mjs';

test('rotateCsrf issues a long random hex string', () => {
  assert.match(rotateCsrf(), /^[a-f0-9]{48}$/);
});

test('rotateCsrf returns a different token than the one it replaced', () => {
  const a = rotateCsrf();
  const b = rotateCsrf();
  assert.notEqual(a, b);
});

test('isLoopbackHost recognises localhost variants', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('127.0.0.1:3022'), true);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost(''), false);
});

test('buildPublicHostSet reads PUBLIC_HOSTS env', () => {
  process.env.PUBLIC_HOSTS = 'foo.test,bar.test';
  const s = buildPublicHostSet();
  assert.equal(s.has('foo.test'), true);
  assert.equal(s.has('bar.test'), true);
  delete process.env.PUBLIC_HOSTS;
});

test('assertLocalApiRequest allows loopback host', () => {
  assert.doesNotThrow(() => assertLocalApiRequest({ headers: { host: '127.0.0.1:3022' } }));
});

test('assertLocalApiRequest rejects external host', () => {
  assert.throws(() => assertLocalApiRequest({ headers: { host: 'evil.test' } }), /local-only/);
});

test('assertCsrf rejects wrong / missing token', () => {
  assert.throws(() => assertCsrf({ headers: {} }), /csrf/);
  assert.throws(() => assertCsrf({ headers: { 'x-arbiter-token': 'nope' } }), /csrf/);
  assert.doesNotThrow(() => assertCsrf({ headers: { 'x-arbiter-token': rotateCsrf() } }));
});

test('buildCsp locks executable code down to same-origin assets', () => {
  const csp = buildCsp();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /script-src[^;]*https?:/);
  assert.match(csp, /frame-ancestors 'none'/);
});

// ── the operator surface ─────────────────────────────────────────────────────
//
// `/admin/*` drives the scrape engine and rewrites settings, so the question
// these tests ask is the one a stranger asks: can a request from off this
// machine reach it? The Host header alone cannot answer that — a client that
// can reach the port can also type `Host: 127.0.0.1` — which is why the peer
// address is checked too, and why both halves have a test that fails if the
// other is removed.

test('isLoopbackAddress reads the shapes remoteAddress actually arrives in', () => {
  // A guard that knew only `127.0.0.1` would pass on one machine and refuse
  // every IPv6 or IPv4-mapped connection on the next.
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('[::1]'), true);
  // The whole 127/8 block, not just .0.1 — a host file may name another one.
  assert.equal(isLoopbackAddress('127.0.0.53'), true);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress('::2'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('a loopback console request from a loopback peer is allowed', () => {
  const req = { headers: { host: '127.0.0.1:3022' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(isAdminRequestAllowed(req), true);
  // The same caller over IPv6, which is how `localhost` usually resolves.
  assert.equal(isAdminRequestAllowed({ headers: { host: 'localhost:3022' }, socket: { remoteAddress: '::1' } }), true);
  assert.equal(isAdminRequestAllowed({ headers: { host: '[::1]:3022' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
});

test('PUBLIC_HOSTS does not open the operator console', () => {
  // This is the difference between the two guards and the reason they are not
  // one function. PUBLIC_HOSTS exists so a deployed site answers /api/* on its
  // own domain; an operator console on that domain is a different thing.
  process.env.PUBLIC_HOSTS = 'arbiter.example.com';
  try {
    // The API guard accepts it...
    assert.doesNotThrow(() => assertLocalApiRequest({ headers: { host: 'arbiter.example.com' } }));
    // ...and the console guard still refuses it.
    assert.equal(isAdminRequestAllowed({
      headers: { host: 'arbiter.example.com' },
      socket: { remoteAddress: '203.0.113.9' },
    }), false);
  } finally {
    delete process.env.PUBLIC_HOSTS;
  }
});

test('a loopback Host header from an off-machine peer is still refused', () => {
  // The spoof this guard exists for: bind the server to 0.0.0.0, reach it from
  // the LAN, and send the header the check reads. The socket address is the
  // half a client cannot write, so it has to decide the answer.
  assert.equal(isAdminRequestAllowed({
    headers: { host: '127.0.0.1:3022' },
    socket: { remoteAddress: '192.168.1.44' },
  }), false);
});

test('a foreign Origin is refused even from a loopback peer', () => {
  assert.equal(isAdminRequestAllowed({
    headers: { host: '127.0.0.1:3022', origin: 'https://evil.example.com' },
    socket: { remoteAddress: '127.0.0.1' },
  }), false);
  assert.equal(isAdminRequestAllowed({
    headers: { host: '127.0.0.1:3022', origin: 'http://127.0.0.1:3022' },
    socket: { remoteAddress: '127.0.0.1' },
  }), true);
  // A malformed Origin is not evidence of anything, so it fails closed.
  assert.equal(isAdminRequestAllowed({
    headers: { host: '127.0.0.1:3022', origin: 'not a url' },
    socket: { remoteAddress: '127.0.0.1' },
  }), false);
});

test('a request with no Host header cannot reach the console', () => {
  // HTTP/1.1 requires a Host. Its absence means a hand-built request, and a
  // guard that treated "no host" as "local" would be answering a different
  // question than the one it was asked.
  assert.equal(isAdminRequestAllowed({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false);
});
