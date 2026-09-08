/**
 * rate-limit.test.mjs — direct tests for the RateLimiter and middleware.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, rateLimitMiddleware, peerKey } from '../src/shared/rate-limit.mjs';

test('allows up to capacity then blocks', () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 0 });
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.take('/api/scrape', 'peer-a').ok, true);
  }
  const blocked = limiter.take('/api/scrape', 'peer-a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0);
});

test('separate peers have separate buckets', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, true);
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, false);
  assert.equal(limiter.take('/api/scrape', 'peer-b').ok, true);
});

test('separate routes have separate buckets for the same peer', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, true);
  assert.equal(limiter.take('/api/scan', 'peer-a').ok, true);
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, false);
});

test('reset clears a specific bucket', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  limiter.take('/api/scrape', 'peer-a');
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, false);
  limiter.reset('/api/scrape', 'peer-a');
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, true);
});

test('reports remaining tokens', () => {
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 0 });
  const r1 = limiter.take('/api/scrape', 'peer-a');
  assert.equal(r1.ok, true);
  assert.equal(r1.remaining, 4);
});

test('refills tokens over time', async () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1000 }); // 1 token per ms
  limiter.take('/api/scrape', 'peer-a');
  limiter.take('/api/scrape', 'peer-a');
  assert.equal(limiter.take('/api/scrape', 'peer-a').ok, false);
  // Wait comfortably past the 1ms/token refill so a slow/fork-loaded CI runner
  // can't starve the assertion (parity with the P1 micro-benchmark budget).
  await new Promise((r) => setTimeout(r, 50));
  const after = limiter.take('/api/scrape', 'peer-a');
  assert.equal(after.ok, true);
});

test('middleware lets GETs through', () => {
  const limiter = new RateLimiter({ capacity: 0, refillPerSec: 0 }); // would block anything
  const check = rateLimitMiddleware(limiter);
  const req = { method: 'GET', url: '/api/scrape/state', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(check(req).ok, true);
});

test('middleware skips non-api paths', () => {
  const limiter = new RateLimiter({ capacity: 0, refillPerSec: 0 });
  const check = rateLimitMiddleware(limiter);
  const req = { method: 'POST', url: '/index.html', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(check(req).ok, true);
});

test('middleware blocks POST once exhausted', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  const check = rateLimitMiddleware(limiter);
  const req = { method: 'POST', url: '/api/scrape', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(check(req).ok, true);
  assert.equal(check(req).ok, false);
});

test('peerKey ignores x-forwarded-for from loopback, honors it from proxies', () => {
  // loopback clients (including hostile web pages in the user's browser)
  // cannot mint new buckets via spoofed XFF
  assert.equal(peerKey({ headers: { 'x-forwarded-for': '10.0.0.5, 10.0.0.6' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(peerKey({ headers: { 'x-forwarded-for': '10.0.0.5' }, socket: { remoteAddress: '::1' } }), '::1');
  // non-loopback hop = a real reverse proxy is in front; trust its XFF
  assert.equal(peerKey({ headers: { 'x-forwarded-for': '10.0.0.5, 10.0.0.6' }, socket: { remoteAddress: '192.168.1.10' } }), '10.0.0.5');
  assert.equal(peerKey({ headers: {}, socket: { remoteAddress: '192.168.1.10' } }), '192.168.1.10');
  assert.equal(peerKey({ headers: {}, socket: {} }), 'unknown');
});

test('prune evicts idle buckets and caps total memory', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0, maxBuckets: 5 });
  const now = Date.now();
  for (let i = 0; i < 10; i++) limiter.take('/api/scrape', `peer-${i}`);
  assert.ok(limiter.buckets.size > 0);
  limiter.prune(now + 10 * 60 * 1000); // everything is idle now
  assert.equal(limiter.buckets.size, 0);
  // refilling past maxBuckets forces eviction of the oldest half
  for (let i = 0; i < 20; i++) limiter.take('/api/scrape', `peer-${i}`);
  assert.ok(limiter.buckets.size <= 5, `buckets ${limiter.buckets.size} should be capped at maxBuckets`);
});
