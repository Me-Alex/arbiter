import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Single-flight lock backed by a JSON file on disk.
 *
 * Prevents concurrent scrape cycles by writing an exclusive lock file
 * (`data/scrape.lock`). The envelope records the holder's PID, a unique
 * token, and the list of bookmakers being scraped. A second caller gets
 * `ELOCKED` unless the first holder has crashed or the scrape has exceeded
 * `maxAgeMs`, in which case the stale lock is recovered automatically.
 *
 * @module lock
 */
export class ScrapeLock {
  /**
   * Create a new ScrapeLock instance.
   *
   * @param {string} path - Absolute path to the lock file (e.g. `data/scrape.lock`).
   * @param {object}  [opts]
   * @param {number}  [opts.maxAgeMs=3600000] - Maximum lock age in ms before stale recovery. Default: 1 hour.
   */
  constructor(path, { maxAgeMs = 60 * 60 * 1000 } = {}) {
    this.path = path;
    this.maxAgeMs = maxAgeMs;
    /** @type {boolean} Whether this instance currently holds the lock. */
    this._held = false;
    /** @type {string|null} Unique token for this acquisition, used to verify release ownership. */
    this._token = null;
  }

  /**
   * Attempt to acquire the lock for the given bookmakers.
   *
   * Writes an exclusive lock file containing `{ acquiredAt, pid, token, books }`.
   * If the lock is already held, checks whether the holder is dead or hung
   * (age > maxAgeMs) and recovers automatically if so. Otherwise throws with
   * `code: 'ELOCKED'`.
   *
   * @param {string[]} [books=[]] - Bookmaker IDs being scraped in this cycle.
   * @returns {Promise<() => Promise<void>>} A release function. Call it when the scrape completes.
   * @throws {Error & { code: string, holder: object|null }} When the lock is held by a live process.
   */
  async acquire(books = []) {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const env = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token: randomUUID(),
      books: Array.isArray(books) ? books : [],
    };
    try {
      await fs.writeFile(this.path, JSON.stringify(env, null, 2), { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const holder = await this.status();
      const age = holder ? Date.now() - Date.parse(holder.acquiredAt || '') : 0;
      const holderAlive = Boolean(holder) && isPidAlive(holder.pid);
      // Recover when the holder process is gone (server crash mid-scrape) or
      // when it is still alive but the scrape has exceeded maxAge (hung).
      const canRecover = holder && (
        (holder.pid && !holderAlive) ||
        (Number.isFinite(age) && age > this.maxAgeMs)
      );
      if (canRecover) {
        await fs.unlink(this.path).catch(() => {});
        return await this.acquire(books);
      }
      const locked = new Error('another scrape is already running');
      locked.code = 'ELOCKED';
      locked.holder = holder;
      throw locked;
    }
    this._held = true;
    this._token = env.token;
    return async () => this.release();
  }

  /**
   * Release the lock if this instance still owns it.
   *
   * Verifies the token before unlinking to avoid releasing another
   * process's lock after a stale-recovery race.
   *
   * @returns {Promise<void>}
   */
  async release() {
    if (!this._held) return;
    this._held = false;
    const token = this._token;
    this._token = null;
    const holder = await this.status();
    if (holder?.token === token) await fs.unlink(this.path).catch(() => {});
  }

  /**
   * Read the current lock holder's envelope, if any.
   *
   * @returns {Promise<{ acquiredAt: string, pid: number, token: string, books: string[] } | null>}
   *   The parsed lock file contents, or `null` if no lock file exists.
   * @throws {Error} On unexpected filesystem or JSON parse errors.
   */
  async status() {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}
