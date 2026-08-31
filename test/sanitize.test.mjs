import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogLine, sanitizeResult, sanitizeReport } from '../src/shared/sanitize.mjs';

test('sanitizeLogLine strips control chars and trims', () => {
  assert.equal(sanitizeLogLine('hello\nworld\r\n'), 'hello world');
  assert.equal(sanitizeLogLine('\u0001\u0002foo\u0007'), 'foo');
  assert.equal(sanitizeLogLine(null), '');
  assert.equal(sanitizeLogLine(undefined), '');
});

test('sanitizeLogLine caps at MAX_LEN', () => {
  const s = 'x'.repeat(5000);
  const out = sanitizeLogLine(s);
  assert.ok(out.length <= 4096);
});

test('sanitizeLogLine stringifies objects', () => {
  const out = sanitizeLogLine({ a: 1 });
  assert.match(out, /"a":\s*1/);
});

test('sanitizeResult returns null on garbage', () => {
  assert.equal(sanitizeResult(null), null);
  assert.equal(sanitizeResult(undefined), null);
  assert.equal(sanitizeResult('string'), null);
});

test('sanitizeResult flattens a valid result', () => {
  const r = sanitizeResult({
    valid: true,
    status: 'ok',
    events: [{ a: 1 }, { b: 2 }],
    rawSize: 1234,
    durationMs: 567,
    startedAt: 'x',
    finishedAt: 'y',
  });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.events, 2);
  assert.equal(r.rawSize, 1234);
});

test('sanitizeResult includes sanitized error', () => {
  const r = sanitizeResult({
    valid: false,
    status: 'failed',
    error: { name: 'Err', message: 'oh\nno', code: 'EBOOM' },
  });
  assert.equal(r.error.message, 'oh no');
  assert.equal(r.error.code, 'EBOOM');
});

test('sanitizeReport summarizes jobs', () => {
  const r = sanitizeReport({
    runId: 'r1',
    startedAt: 'x',
    finishedAt: 'y',
    status: 'partial',
    jobs: [
      { id: 'a', name: 'A', sourceIds: ['a'], valid: true, status: 'ok', events: 5, durationMs: 100 },
      { id: 'b', name: 'B', sourceIds: ['b'], valid: false, status: 'failed', durationMs: 200, error: { name: 'E', message: 'bad' } },
    ],
  });
  assert.equal(r.jobs.length, 2);
  assert.equal(r.jobs[1].error.message, 'bad');
});
