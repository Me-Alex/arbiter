import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Thin wrapper around the `tinyfish` CLI. The user's Node process spawns the
 * CLI as a subprocess; we never hit TinyFish's HTTP API directly so that auth,
 * retries, and error handling stay the CLI's responsibility.
 *
 * For long-running / parallel agent work, prefer `submit()` + `getResult()` —
 *   - `submit()` returns a run_id immediately
 *   - `getResult()` polls until the run completes
 *
 * `runSync()` is a convenience for one-off single calls.
 */

const TINYFISH_COMMAND = locateTinyfish();
const DEFAULT_CONCURRENCY = 2;
let activeOperations = 0;
const operationQueue = [];

function locateTinyfish() {
  if (process.env.TINYFISH_BIN) {
    return process.env.TINYFISH_BIN.endsWith('.js')
      ? { command: process.execPath, prefix: [process.env.TINYFISH_BIN] }
      : { command: process.env.TINYFISH_BIN, prefix: [] };
  }

  // Execute the npm package's JS entrypoint directly on Windows. This avoids
  // cmd.exe quoting bugs for long goals containing JSON and punctuation.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['tinyfish.cmd'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const cmdShim = lines.find((l) => l.toLowerCase().endsWith('tinyfish.cmd'));
      if (cmdShim) {
        const entrypoint = join(dirname(cmdShim), 'node_modules', '@tiny-fish', 'cli', 'dist', 'index.js');
        if (existsSync(entrypoint)) {
          return { command: process.execPath, prefix: [entrypoint] };
        }
      }
    } catch { /* fall through */ }
  }
  return { command: 'tinyfish', prefix: [] };
}

export class TinyfishError extends Error {
  constructor(message, { code = 'ETINYFISH', cause = null, stderr = '' } = {}) {
    super(message);
    this.name = 'TinyfishError';
    this.code = code;
    this.cause = cause;
    this.stderr = stderr;
  }
}

function concurrencyLimit() {
  const configured = Number.parseInt(process.env.TINYFISH_CONCURRENCY || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CONCURRENCY;
}

async function acquireSlot(signal) {
  if (signal?.aborted) {
    throw new TinyfishError('TinyFish operation aborted', { code: 'ECANCELLED' });
  }
  if (activeOperations < concurrencyLimit()) {
    activeOperations++;
    return;
  }

  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = operationQueue.indexOf(waiter);
      if (index !== -1) operationQueue.splice(index, 1);
      reject(new TinyfishError('TinyFish operation aborted', { code: 'ECANCELLED' }));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    operationQueue.push(waiter);
  });
}

function releaseSlot() {
  const next = operationQueue.shift();
  if (next) {
    next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve();
    return;
  }
  activeOperations = Math.max(0, activeOperations - 1);
}

export async function withTinyfishSlot(task, { signal } = {}) {
  await acquireSlot(signal);
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

/**
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.goal
 * @param {object} [args.outputSchema]
 * @param {number} [args.maxSteps]            optional — only sent if explicitly set;
 *                                            some accounts are not enrolled in the
 *                                            custom-max-steps beta and the CLI rejects.
 * @param {number} [args.maxDurationSeconds=180]
 * @param {'lite'|'stealth'} [args.browserProfile='lite']
 * @param {string} [args.sessionId]
 */
export async function submit(args) {
  if (args.signal?.aborted) {
    throw new TinyfishError('TinyFish operation aborted', { code: 'ECANCELLED' });
  }
  const sessionId = args.sessionId || randomUUID();
  const argv = [
    'agent', 'run', '--async',
    '--session-id', sessionId,
    '--url', args.url,
    '--max-duration-seconds', String(args.maxDurationSeconds ?? 180),
  ];
  if (args.maxSteps !== null && args.maxSteps !== undefined) {
    argv.push('--max-steps', String(args.maxSteps));
  }
  if (args.outputSchema) argv.push('--output-schema', JSON.stringify(args.outputSchema));
  if (args.browserProfile) argv.push('--browser-profile', args.browserProfile);
  // Collapse newlines and excess whitespace in the goal — Windows' cmd.exe
  // sees raw newlines as command separators when invoked through argv, which
  // breaks the shell parsing on the receiving end.
  argv.push(String(args.goal).replace(/\s+/g, ' ').trim());
  const stdout = await runTinyfish(argv, { timeoutMs: 30_000 });
  const parsed = parseSubmitOutput(stdout);
  return { runId: parsed.runId, sessionId };
}

export async function getResult(runId, { timeoutMs = 240_000, pollMs = 4_000, signal } = {}) {
  const started = Date.now();
  let cancelPromise = null;
  const cancelOnce = () => {
    cancelPromise ||= cancelRun(runId).catch(() => null);
    return cancelPromise;
  };
  const onAbort = () => void cancelOnce();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        await cancelOnce();
        throw new TinyfishError(`tinyfish run ${runId} aborted`, { code: 'ECANCELLED' });
      }
      const stdout = await runTinyfish(['agent', 'run', 'get', runId], { timeoutMs: 30_000 });
      const parsed = parseResultOutput(stdout);
      if (parsed.status === 'COMPLETED') return parsed;
      if (parsed.status === 'FAILED' || parsed.status === 'CANCELLED') {
        throw new TinyfishError(`tinyfish run ${parsed.status}: ${parsed.error || ''}`, { cause: parsed });
      }
      if (Date.now() - started > timeoutMs) {
        await cancelOnce();
        throw new TinyfishError(`tinyfish run ${runId} timed out after ${timeoutMs}ms`, { code: 'ETIMEOUT' });
      }
      await sleep(pollMs);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function cancelRun(runId) {
  if (!runId) return null;
  const stdout = await runTinyfish(['agent', 'run', 'cancel', runId], { timeoutMs: 30_000 });
  try { return JSON.parse(stdout); } catch { return { runId, status: 'CANCELLED' }; }
}

/**
 * Convenience: submit + wait.
 */
export async function runSync(args) {
  return await withTinyfishSlot(async () => {
    const { runId } = await submit(args);
    const timeoutMs = (args.maxDurationSeconds ?? 180) * 1000 + 60_000;
    return await getResult(runId, { timeoutMs, signal: args.signal });
  }, { signal: args.signal });
}

export async function createBrowserSession({ url, browserProfile } = {}) {
  const argv = ['browser', 'session', 'create'];
  if (url) argv.push('--url', url);
  if (browserProfile) argv.push('--browser-profile', browserProfile);
  const stdout = await runTinyfish(argv, { timeoutMs: 30_000 });
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.cdp_url || !parsed.session_id) {
      throw new Error('missing cdp_url or session_id');
    }
    return {
      sessionId: parsed.session_id,
      cdpUrl: parsed.cdp_url,
      baseUrl: parsed.base_url,
    };
  } catch (err) {
    throw new TinyfishError(`cannot parse browser-session output: ${stdout.slice(0, 200)}`, {
      cause: err,
      stderr: stdout,
    });
  }
}

function runTinyfish(argv, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(TINYFISH_COMMAND.command, [...TINYFISH_COMMAND.prefix, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new TinyfishError(`tinyfish CLI timeout (${timeoutMs}ms)`, { code: 'ETIMEOUT', stderr }));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(new TinyfishError(`tinyfish CLI failed to start: ${err.message}`, { code: 'ENOENT', cause: err, stderr }));
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        reject(new TinyfishError(`tinyfish CLI exited ${code}`, { code: 'ECLIENT', stderr, cause: { stdout, stderr } }));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseSubmitOutput(stdout) {
  try {
    const j = JSON.parse(stdout);
    return { runId: j.run_id || j.runId };
  } catch {
    const m = stdout.match(/run[_-]id["']?\s*[:=]\s*["']?([a-z0-9-]+)/i);
    if (m) return { runId: m[1] };
    throw new TinyfishError(`cannot parse submit output: ${stdout.slice(0, 200)}`, { stderr: stdout });
  }
}

function parseResultOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new TinyfishError(`cannot parse get output: ${stdout.slice(0, 200)}`, { stderr: stdout });
  }
  if (parsed && parsed.data) parsed = parsed.data;
  const status = parsed.status || (parsed.result ? 'COMPLETED' : 'PENDING');
  const resultJson = parsed.result || parsed.resultJson || null;
  return {
    runId: parsed.run_id || parsed.runId,
    status,
    result: resultJson,
    error: parsed.error || null,
    steps: parsed.num_of_steps || parsed.steps || 0,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
