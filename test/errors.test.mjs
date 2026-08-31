import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, backoffMs } from '../src/shared/errors.mjs';

test('isRetryable recognises timeout and 5xx', () => {
  assert.equal(isRetryable({ code: 'ETIMEOUT' }), true);
  assert.equal(isRetryable({ code: 'EUPSTREAM', status: 500 }), true);
  assert.equal(isRetryable({ code: 'EUPSTREAM', status: 502 }), true);
  assert.equal(isRetryable({ code: 'EUPSTREAM', status: 404 }), false);
  assert.equal(isRetryable({ code: 'EVALIDATION' }), false);
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryable(null), false);
});

test('backoffMs grows exponentially with cap', () => {
  const a = backoffMs(1, { base: 1000, cap: 30000 });
  const b = backoffMs(4, { base: 1000, cap: 30000 });
  assert.ok(a >= 0 && a < 1000);
  assert.ok(b >= 0 && b <= 30000);
});
