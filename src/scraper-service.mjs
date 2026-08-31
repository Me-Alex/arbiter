import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { instantiate } from './scrapers/index.mjs';
import { ScrapeLock } from './shared/lock.mjs';
import { writeJsonAtomic, readJson } from './shared/atomic-write.mjs';
import { sanitizeReport, sanitizeResult } from './shared/sanitize.mjs';

/**
 * scraper-service — runs scraper batches with a hard parallelism cap and
 * emits per-job events back to the orchestrator via the `onEvent` callback.
 *
 * Single-flight lock is held for the entire batch (not per-job). The Altenar
 * job fans out into multiple tenant scrapers that share the same lock window.
 */

const DEFAULT_PARALLEL = 12;

export async function loadScraperJobs(configPath) {
  const cfg = await readJson(configPath, { jobs: [] });
  return Array.isArray(cfg.jobs) ? cfg.jobs : [];
}

/**
 * @param {object} args
 * @param {string[]} args.books         list of bookmaker ids (job ids)
 * @param {number} [args.parallel=12]
 * @param {string} [args.dataDir]
 * @param {string} [args.configPath]
 * @param {Function} [args.onEvent]     called with `{ type, … }` per job
 * @param {Function} [args.logger]
 * @param {string} [args.runId]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ runId, jobs, startedAt, finishedAt }>}
 */
export async function runScraperBatch({
  books,
  parallel = DEFAULT_PARALLEL,
  dataDir = join(process.cwd(), 'data'),
  configPath: _configPath,
  runId = new Date().toISOString(),
  signal,
  onEvent = () => {},
  logger = () => {},
} = {}) {
  if (!Array.isArray(books) || books.length === 0) {
    const err = new Error('at least one scraper is required');
    err.code = 'EBADINPUT';
    throw err;
  }
  const lockPath = join(dataDir, 'scrape.lock');
  const lock = new ScrapeLock(lockPath);
  let release;
  try {
    release = await lock.acquire(books);
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      throw err;
    }
    throw err;
  }

  const startedAt = new Date().toISOString();
  const jobs = [];
  for (const id of books) {
    jobs.push(toProgressJob(id));
  }

  const emit = (e) => {
    try { onEvent(e); } catch (err) { logger('warn', `onEvent threw: ${err.message}`); }
  };

  emit({ type: 'batch-start', runId, total: jobs.length, parallel, books });

  const queue = books.slice();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const idx = next++;
      if (idx >= queue.length) return;
      const jobId = queue[idx];
      const job = jobs[idx];
      emit({ type: 'job-start', runId, jobId, job });
      let result;
      try {
        const scraper = instantiate(jobId, { dataDir, logger, runId });
        if (!scraper) {
          result = envelopeForUnknown(jobId);
        } else {
          result = await scraper.run({ signal });
        }
      } catch (err) {
        result = errorEnvelope(jobId, err);
      }
      job.valid = result.valid;
      job.status = result.status;
      job.events = result.events;
      job.durationMs = result.durationMs;
      job.error = result.error;
      job.startedAt = result.startedAt;
      job.finishedAt = result.finishedAt;
      results.push(result);
      emit({ type: 'job-complete', runId, jobId, result });
    }
  };

  const parallelCount = Math.max(1, Math.min(parallel, queue.length || 1));
  await Promise.all(Array.from({ length: parallelCount }, () => worker()));

  try {
    const finishedAt = new Date().toISOString();
    const failed = results.filter((result) => !result.valid).length;
    const completed = results.length - failed;
    const report = {
      runId,
      startedAt,
      finishedAt,
      status: signal?.aborted ? 'cancelled' : failed === 0 ? 'ok' : completed === 0 ? 'failed' : 'partial',
      parallel: parallelCount,
      books,
      jobs: jobs.map((job, index) => ({ ...job, ...results[index] })),
    };

    emit({ type: 'batch-end', runId, report });
    return { runId, report, jobs: report.jobs };
  } finally {
    if (release) await release();
  }
}

function toProgressJob(id) {
  return {
    id,
    name: id,
    sourceIds: [],
    valid: false,
    status: 'pending',
    events: 0,
    durationMs: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function envelopeForUnknown(jobId) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    name: jobId,
    sourceIds: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    outputs: [],
    events: 0,
    rawSize: 0,
    valid: false,
    status: 'unknown',
    error: { name: 'NotFound', message: `no scraper registered for ${jobId}`, code: 'ENOENT' },
    reason: 'unknown',
  };
}

function errorEnvelope(jobId, err) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    name: jobId,
    sourceIds: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    outputs: [],
    events: 0,
    rawSize: 0,
    valid: false,
    status: 'failed',
    error: {
      name: err && err.name || 'Error',
      message: String(err && err.message || err).slice(0, 500),
      code: err && err.code || null,
    },
    reason: 'error',
  };
}

/**
 * Persist the report to data/scrape-run-<isoTimestamp>.json, rotate last 10
 * into data/backups/, and write the canonical pointer data/latest-scrape-run.json.
 */
export async function persistRunReport(report, { dataDir, rotate = 10 } = {}) {
  const safe = sanitizeReport(report);
  const ts = String(safe.runId || new Date().toISOString()).replace(/[:.]/g, '-');
  const path = join(dataDir, `scrape-run-${ts}.json`);
  await writeJsonAtomic(path, safe);
  await writeJsonAtomic(join(dataDir, 'latest-scrape-run.json'), safe);

  // rotation
  const list = await safeReadDir(dataDir, /^scrape-run-.*\.json$/);
  if (list.length > rotate) {
    const sorted = list.sort();
    const excess = sorted.slice(0, list.length - rotate);
    const backups = join(dataDir, 'backups');
    await fs.mkdir(backups, { recursive: true });
    for (const f of excess) {
      try {
        const data = await readJson(join(dataDir, f));
        await writeJsonAtomic(join(backups, f), data);
        await fs.unlink(join(dataDir, f));
      } catch { /* ignore */ }
    }
  }
  return path;
}

async function safeReadDir(dir, pattern) {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

export { sanitizeResult };
