/**
 * state-broadcaster.mjs — SSE clients + heartbeat.
 *
 * The dashboard subscribes to /api/events. We push:
 *   - heartbeat every 25 s (keeps the connection alive through proxies)
 *   - scrape-update events during a scrape (job-start / job-complete / etc.)
 *   - scan-update after every scan / verification pass
 *
 * Messages are JSON-encoded single-line events. We never send partial frames.
 */

const HEARTBEAT_MS = 25_000;

export class StateBroadcaster {
  constructor() {
    /** @type {Set<import('node:http').ServerResponse>} */
    this._clients = new Set();
    this._heartbeat = null;
    this._lastEmit = new Map();
  }

  start() {
    if (this._heartbeat) return;
    this._heartbeat = setInterval(() => {
      for (const c of this._clients) {
        try { c.write(`event: heartbeat\ndata: ${Date.now()}\n\n`); } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS);
    if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
  }

  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    for (const c of this._clients) {
      try { c.end(); } catch { /* ignore */ }
    }
    this._clients.clear();
  }

  add(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.writeHead(200);
    res.write('retry: 5000\n\n');
    this._clients.add(res);
    res.on('close', () => this._clients.delete(res));
  }

  broadcast(type, payload) {
    const id = ++this._seq;
    const frame = `event: ${type}\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this._clients) {
      try { c.write(frame); } catch { /* drop */ }
    }
  }

  /** De-dupe identical events within `windowMs`. */
  emitDebounced(type, payload, windowMs = 100) {
    const k = `${type}::${JSON.stringify(payload).slice(0, 256)}`;
    const now = Date.now();
    const last = this._lastEmit.get(k) || 0;
    if (now - last < windowMs) return;
    this._lastEmit.set(k, now);
    this.broadcast(type, payload);
  }
}
StateBroadcaster.prototype._seq = 0;
