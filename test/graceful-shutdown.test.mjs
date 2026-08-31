/**
 * graceful-shutdown.test.mjs — exercises the shutdown coordinator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { installShutdown } from '../src/shared/graceful-shutdown.mjs';

function makeServer() {
  return http.createServer((_req, res) => { res.end('ok'); });
}

test('runs shutdown tasks in order, then closes server', async () => {
  const server = makeServer();
  const calls = [];
  installShutdown({
    server,
    logger: () => {},
    tasks: [
      async () => { calls.push('task-a'); },
      async () => { calls.push('task-b'); },
    ],
    timeoutMs: 1000,
  });
  // Reach into the registered listener set is private; instead invoke shutdown
  // by emitting SIGTERM and verifying tasks ran before exit. We patch
  // process.exit to inspect the call.
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.emit('SIGTERM');
    // wait a tick for tasks
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['task-a', 'task-b']);
    assert.equal(exitCode, 0);
  } finally {
    process.exit = originalExit;
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('catches task errors and still exits', async () => {
  const server = makeServer();
  const calls = [];
  installShutdown({
    server,
    logger: (lvl, msg) => calls.push(`${lvl}:${msg}`),
    tasks: [
      () => { throw new Error('boom'); },
    ],
    timeoutMs: 1000,
  });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.emit('SIGTERM');
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.some((c) => c.startsWith('warn:')), 'should log warning');
    assert.equal(exitCode, 0);
  } finally {
    process.exit = originalExit;
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('registers only one set of listeners per server', () => {
  const server = makeServer();
  const originalCount = process.listenerCount('SIGTERM');
  installShutdown({ server, logger: () => {}, tasks: [] });
  installShutdown({ server, logger: () => {}, tasks: [] });
  installShutdown({ server, logger: () => {}, tasks: [] });
  assert.equal(process.listenerCount('SIGTERM'), originalCount + 1);
});
