import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Single-flight lock backed by data/scrape.lock.
 *
 * acquire() writes a JSON envelope { acquiredAt, pid, books } and returns a
 * release() function. The lock file is removed on release or stale-lock
 * detection (> maxAgeMs old).
 */
export class ScrapeLock {
  constructor(path, { maxAgeMs = 60 * 60 * 1000 } = {}) {
    this.path = path;
    this.maxAgeMs = maxAgeMs;
    this._held = false;
    this._token = null;
  }

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
      const canRecover = holder && Number.isFinite(age) && age > this.maxAgeMs && !isPidAlive(holder.pid);
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

  async release() {
    if (!this._held) return;
    this._held = false;
    const token = this._token;
    this._token = null;
    const holder = await this.status();
    if (holder?.token === token) await fs.unlink(this.path).catch(() => {});
  }

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
