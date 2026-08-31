import { promises as fs, mkdirSync, renameSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Write JSON atomically. Writes to `<path>.tmp` first, fsyncs, then renames.
 * The dashboard never observes a half-written file.
 *
 * @param {string} path
 * @param {unknown} value
 */
export async function writeJsonAtomic(path, value) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const json = JSON.stringify(value, null, 2);
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
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

export async function readJson(path, fallback = null) {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}
