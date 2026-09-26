/**
 * live-check.mjs — bounded live smoke for the public bookmaker adapters.
 *
 * Unlike scripts/smoke.mjs (which probes a running server's HTTP surface),
 * this instantiates the scrapers directly and reports what each one actually
 * did against the upstream: how long it took, how many bytes came back, how
 * many events were accepted, and which guard rejected the response.
 *
 * It exists to answer questions a fixture test cannot:
 *   - does a tenant redirect? (the adapters now set `redirect: 'error'`)
 *   - does a response exceed the configured body cap?
 *   - is the per-attempt deadline achievable against a real feed?
 *
 * The byte count is measured by wrapping fetchImpl, which is what the base
 * class already uses for injection, so the adapter's own parsing and limits
 * run completely unmodified.
 *
 * Usage:
 *   node scripts/live-check.mjs                  # default book set
 *   node scripts/live-check.mjs superbet fortuna # specific jobs
 *
 * Writes nothing outside a temporary directory; never touches data/.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(ROOT, 'config', 'scrapers.json');
const DEFAULT_BOOKS = ['superbet', 'don', 'casa-pariurilor'];

const requested = process.argv.slice(2);
const books = requested.length > 0 ? requested : DEFAULT_BOOKS;

const { jobs } = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const byId = new Map(jobs.map((j) => [j.id, j]));

const dataDir = await fs.mkdtemp(join(tmpdir(), 'arbiter-live-'));
const results = [];

for (const id of books) {
  const job = byId.get(id);
  if (!job) {
    results.push({ id, outcome: 'not-in-config' });
    continue;
  }
  if (job.enabled === false) {
    results.push({ id, outcome: 'disabled-in-config' });
    continue;
  }

  let scraper;
  try {
    scraper = instantiate(id, { jobConfig: job, dataDir });
  } catch (err) {
    results.push({ id, outcome: 'instantiate-failed', error: err.message });
    continue;
  }

  // Wrap fetchImpl so the response is inspected without being consumed: clone
  // the stream to count bytes, and hand the untouched original to the adapter.
  const baseFetch = (...args) => fetch(...args);
  let bytes = 0;
  let status = null;
  let contentType = null;
  // The adapters set `redirect: 'error'`, so a followed redirect would mean the
  // guard is not being applied to that job. Worth surfacing explicitly.
  let followedRedirect = null;
  scraper.fetchImpl = async (url, opts = {}) => {
    const res = await baseFetch(url, opts);
    status = res.status;
    contentType = res.headers.get('content-type');
    if (res.redirected) followedRedirect = res.url;
    if (res.body) {
      const reader = res.clone().body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      await reader.cancel();
    }
    return res;
  };

  const started = Date.now();
  try {
    const report = await scraper.run({});
    results.push({
      id,
      outcome: report.valid ? 'ok' : 'rejected',
      events: report.events,
      status,
      contentType,
      bytes,
      followedRedirect,
      ms: Date.now() - started,
      configuredTimeoutMs: scraper.timeoutMs,
      reason: report.reason || undefined,
      error: report.error || undefined,
    });
  } catch (err) {
    results.push({
      id,
      outcome: 'failed',
      error: err.message,
      code: err.code,
      status,
      contentType,
      bytes,
      followedRedirect,
      ms: Date.now() - started,
      configuredTimeoutMs: scraper.timeoutMs,
    });
  }
}

await fs.rm(dataDir, { recursive: true, force: true });

console.log('\nLive check — ' + new Date().toISOString());
for (const r of results) {
  const shown = { ...r };
  if (r.bytes) shown.bytes = (r.bytes / 1024).toFixed(1) + ' KB';
  if (r.configuredTimeoutMs) shown.configuredTimeoutMs = r.configuredTimeoutMs + 'ms';
  if (r.ms) shown.ms = r.ms + 'ms';
  console.log('  ' + JSON.stringify(shown));
}
console.log('');
