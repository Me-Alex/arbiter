import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateCsrf, isLoopbackHost, buildPublicHostSet, assertLocalApiRequest, assertCsrf, buildCsp } from '../src/shared/security.mjs';

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
