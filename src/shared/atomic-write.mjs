import { promises as fs, mkdirSync, renameSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Atomic JSON file utilities.
 *
 * Provides write-then-rename (atomic) and read helpers that keep the
 * dashboard from ever observing a half-written file. Concurrent writes
 * to the same path are serialised in-memory so a reader always sees a
 * complete JSON document.
 *
 * @module atomic-write
 */

/** @type {Map<string, Promise<void>>} Serialisation map — one pending write chain per path. */
const pendingWrites = new Map();

/**
 * Write JSON atomically. Writes to `<path>.tmp` first, fsyncs, then renames.
 * The dashboard never observes a half-written file.
 *
 * @param {string} path
 * @param {unknown} value
 */
export async function writeJsonAtomic(path, value, options = {}) {
  const previous = pendingWrites.get(path) || Promise.resolve();
  const write = previous.catch(() => {}).then(() => writeJsonAtomicOnce(path, value, options));
  pendingWrites.set(path, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(path) === write) pendingWrites.delete(path);
  }
}

async function writeJsonAtomicOnce(path, value, { retries = 5, retryDelay = 200 } = {}) {
  await fs.mkdir(dirname(path), { recursive: true });
  const json = JSON.stringify(value, null, 2);
  for (let attempt = 0; attempt < retries; attempt++) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, path);
      return;
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      if (attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }
}

/**
 * Synchronous variant — used inside scraper children right before exit so the
 * caller cannot race the next process.
 */
export function writeJsonAtomicSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const json = JSON.stringify(value, null, 2);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore cleanup */ }
    throw err;
  }
}

/**
 * Read and parse a JSON file. Returns `fallback` on ENOENT; throws on
 * other errors (corrupt JSON, EACCES, etc.).
 *
 * @param {string}      path     - Absolute path to the JSON file.
 * @param {*}           [fallback=null] - Value returned when the file does not exist.
 * @returns {Promise<*>} Parsed JSON content, or `fallback`.
 * @throws  {Error} On non-ENOENT filesystem or JSON parse errors.
 */
export async function readJson(path, fallback = null) {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * readJson that never throws: any read/parse failure (corrupt JSON, EACCES,
 * ...) returns `fallback` and the problem is reported through `onError` when
 * given. Service/bootstrap state loads use this so a corrupt state file can
 * never crash the server -- it degrades to defaults.
 *
 * @param {string}                      path     - Absolute path to the JSON file.
 * @param {*}                           [fallback=null] - Value returned on any error.
 * @param {((err: Error) => void) | null} [onError=null] - Optional error callback for logging.
 * @returns {Promise<*>} Parsed JSON content, or `fallback`.
 */
export async function tryReadJson(path, fallback = null, onError = null) {
  try {
    return await readJson(path, fallback);
  } catch (err) {
    if (onError) onError(err);
    return fallback;
  }
}
