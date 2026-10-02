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

import { sanitizeResult } from './shared/sanitize.mjs';

const HEARTBEAT_MS = 25_000;

/** The frame types whose payload carries one scraper result. */
const RESULT_FRAMES = new Set(['job-complete', 'verify-job-complete']);
/** The frame types whose payload carries a batch report, which carries many. */
const REPORT_FRAMES = new Set(['batch-end', 'verify-batch-end']);

/**
 * What a frame carries once it is on its way to a browser.
 *
 * A scraper result is handed to this class raw, and the raw form holds
 * `outputs[]` — an absolute path on the machine that ran the scrape, pushed to
 * every connected browser and read by no page. Reducing it here rather than at
 * the emitter is forced: the orchestrator reads `result.marketDiagnostics` off
 * the same event and the sanitizer does not carry that field, so an earlier
 * version of this fix, applied in the scraper batch, would have emptied the
 * diagnostics column of the job table.
 *
 * `scrape-update` carries the state document and is passed through untouched —
 * it is a document the field census rules on leaf by leaf, not a result.
 */
function wirePayload(type, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (RESULT_FRAMES.has(type)) {
    const result = payload.result;
    return result && typeof result === 'object' ? { ...payload, result: sanitizeResult(result) } : payload;
  }
  if (REPORT_FRAMES.has(type) && Array.isArray(payload.report?.jobs)) {
    const jobs = payload.report.jobs.map((job) => sanitizeResult(job) ?? job);
    return { ...payload, report: { ...payload.report, jobs } };
  }
  return payload;
}

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
    const frame = `event: ${type}\nid: ${id}\ndata: ${JSON.stringify(wirePayload(type, payload))}\n\n`;
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
