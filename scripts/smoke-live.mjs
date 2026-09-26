/**
 * smoke-live.mjs — the gate that a scraper which collects nothing cannot pass.
 *
 * `scripts/live-check.mjs` reports what each adapter did; it never fails, so
 * nothing in this repository noticed when two bugs sat behind a clean report:
 *
 *   - `winner` read an epoch-in-milliseconds kickoff with `Date.parse`, which is
 *     NaN, so every event was skipped as malformed. The run reported
 *     `status: ok, events: 0`.
 *   - the NSoft adapter labelled MaxBet's football events "Basketball" (its
 *     sport ids are numbered per tenant). Every event was published under a
 *     sport no other book uses, so none of them could ever pair.
 *
 * Both are invisible to a report that only counts rows: a scraper that
 * collects nothing looks exactly like one that collected a quiet day. This
 * script is the missing half — it exits non-zero when an enabled job brings
 * back no usable events, or when it does not complete cleanly.
 *
 * It is a *smoke*, not an assertion about the market. A book with genuinely
 * nothing scheduled today is a legitimate outcome, so jobs may declare a
 * floor. There is no such floor in config/scrapers.json today, which is the
 * correct default: an unconfigured book is expected to return events, and a
 * book that stops is a change worth being told about rather than absorbed.
 *
 * Usage:
 *   npm run smoke:live                       # every enabled job
 *   npm run smoke:live -- superbet fortuna    # named jobs only
 *   npm run smoke:live -- --min-events 1     # a quieter gate
 *
 * Writes only to a temporary directory; never touches data/.
 * Exits 0 when every checked job passed, 1 otherwise.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { instantiate } from '../src/scrapers/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(ROOT, 'config', 'scrapers.json');

const args = process.argv.slice(2);
let minEvents = 1;
let timeoutMs = 60_000;
const requested = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--min-events') minEvents = Number(args[++i]);
  else if (args[i] === '--timeout') timeoutMs = Number(args[++i]);
  else requested.push(args[i]);
}

const { jobs } = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const targets = jobs
  .filter((j) => j.enabled !== false)
  .filter((j) => requested.length === 0 || requested.includes(j.id));

if (targets.length === 0) {
  console.error('no enabled job matches ' + (requested.join(', ') || '(any)'));
  process.exit(1);
}

const dataDir = await fs.mkdtemp(join(tmpdir(), 'arbiter-smoke-'));
const rows = [];

for (const job of targets) {
  const started = Date.now();
  let scraper;
  try {
    scraper = instantiate(job.id, {
      jobConfig: job,
      dataDir,
      // A small cap keeps the gate quick; it is a liveness check, not a harvest.
      maxEvents: 100,
    });
    // The gate's deadline is a ceiling, not a value to push into every
    // adapter. Several adapters reject a timeout above their own limit, and a
    // constructor error here would be the gate's fault rather than the job's.
    // Clamping afterwards still bounds the run, and an adapter that ignores its
    // own deadline is caught by the failure below rather than passing quietly.
    if (Number.isFinite(scraper.timeoutMs) && scraper.timeoutMs > timeoutMs) {
      scraper.timeoutMs = timeoutMs;
    }
  } catch (err) {
    rows.push({ id: job.id, verdict: 'FAIL', why: `instantiate: ${err.message}` });
    continue;
  }

  let report;
  try {
    report = await scraper.run({ signal: AbortSignal.timeout(timeoutMs * 2) });
  } catch (err) {
    rows.push({ id: job.id, verdict: 'FAIL', why: `threw: ${err.message}` });
    continue;
  }

  const ms = Date.now() - started;
  if (report.status !== 'ok') {
    rows.push({
      id: job.id,
      verdict: 'FAIL',
      why: `status ${report.status}${report.error ? ` (${report.error.name}: ${report.error.message})` : ''}`,
      ms,
    });
    continue;
  }
  if (report.events < minEvents) {
    rows.push({
      id: job.id,
      verdict: 'FAIL',
      why: `collected ${report.events} event(s), expected >= ${minEvents}`,
      hint: 'the feed answered but nothing was accepted — a parser or filter regression, or a feed that stopped publishing',
      ms,
    });
    continue;
  }
  rows.push({ id: job.id, verdict: 'ok', events: report.events, ms });
}

await fs.rm(dataDir, { recursive: true, force: true });

const failed = rows.filter((r) => r.verdict === 'FAIL');
console.log('\nsmoke:live — ' + new Date().toISOString());
for (const r of rows) {
  const line = [`  ${r.verdict.padEnd(4)} ${r.id.padEnd(16)}`];
  if (r.events !== undefined) line.push(`events=${String(r.events).padStart(4)}`);
  if (r.ms !== undefined) line.push(`${r.ms}ms`);
  if (r.why) line.push(`— ${r.why}`);
  console.log(line.join(' '));
  if (r.hint) console.log(`       ${r.hint}`);
}
console.log(`\n${rows.length - failed.length}/${rows.length} jobs passed the live smoke\n`);

if (failed.length > 0) {
  console.error('live smoke failed for: ' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
