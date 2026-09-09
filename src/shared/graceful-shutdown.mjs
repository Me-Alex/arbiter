/**
 * graceful-shutdown.mjs — single source of truth for SIGTERM/SIGINT handling.
 *
 * Wires up listeners exactly once per process, drains in-flight HTTP
 * requests, then closes the server socket. `onShutdown` callbacks
 * (e.g. stopping the scheduler, closing the broadcaster) run in
 * registration order before `process.exit`.
 *
 * @module graceful-shutdown
 */

const registered = new Set();

/**
 * Register signal handlers for the current process.
 *
 * @param {object} args
 * @param {import('node:http').Server} args.server       HTTP server to close.
 * @param {(signal: string) => void} [args.logger]       optional logger.
 * @param {Array<() => Promise<void> | void>} [args.tasks] shutdown tasks (e.g. stop scheduler).
 * @param {number} [args.timeoutMs=10000]                 hard-exit if drain takes longer.
 */
export function installShutdown({ server, logger = () => {}, tasks = [], timeoutMs = 10000 }) {
  if (registered.has(server)) return;
  registered.add(server);

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger('info', `received ${signal}, shutting down`);

    // A fatal crash must not look like a clean exit to a supervisor.
    const exitCode = signal === 'uncaughtException' ? 1 : 0;

    const hardExit = setTimeout(() => {
      logger('error', `shutdown timed out after ${timeoutMs}ms, exiting`);
      process.exit(1);
    }, timeoutMs);
    hardExit.unref();

    try {
      for (const task of tasks) {
        try { await task(); } catch (err) { logger('warn', `shutdown task failed: ${err.message}`); }
      }
      await new Promise((resolve) => server.close(() => resolve()));
      logger('info', 'shutdown complete');
      clearTimeout(hardExit);
      process.exit(exitCode);
    } catch (err) {
      logger('error', `shutdown error: ${err.message}`);
      clearTimeout(hardExit);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger('error', `uncaughtException: ${err.stack || err.message}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger('error', `unhandledRejection: ${reason?.stack || reason}`);
  });
}
