// test/scrape-run-wiring.test.mjs — the last unverified link of the scrape page:
// GET /api/scrape-run had a live consumer and no test that ever asked the route
// for anything. The page half was pinned against a stub (test/scrape-page.test.mjs
// stubs `arbiterApi.get`), the field half against the source (test/field-census.test.mjs
// reads both sides' code) — and the route's actual answer was read by neither.
//
// This file drives the real router over a real socket and makes that answer the
// oracle for what the page's reader expects, so the two halves meet on the
// response instead of on a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import { readLatestScrapeRun } from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const pageSource = readFileSync(new URL('../public/js/pages/scrape.js', import.meta.url), 'utf8');
const ROUTE = '/api/scrape-run';

/**
 * A persisted run report, in the shape `persistRunReport` writes: the sanitized
 * top level is runId, startedAt, finishedAt, status and jobs
 * (src/shared/sanitize.mjs:60), and the stored copy measured for the page tests
 * carries exactly those five keys. The two jobs are one success and one failure
 * because the table below the panel head renders both, and a report of only
 * good rows would let a reader of the error column pass by never being read.
 */
function storedReport(overrides = {}) {
  return {
    runId: '2026-09-30T10-36-13-440Z',
    startedAt: '2026-09-30T10:36:13.440Z',
    finishedAt: '2026-09-30T10:41:02.118Z',
    status: 'completed-with-errors',
    jobs: [
      { id: 'superbet', name: 'Superbet', status: 'ok', events: 412, durationMs: 8400 },
      {
        id: 'everymatrix-wamp', name: 'EveryMatrix', status: 'failed', events: 0, durationMs: 1500,
        error: { name: 'UpstreamError', message: 'ws error' },
      },
    ],
    ...overrides,
  };
}

/** The router with only the collaborator this route has: the scan service's reader. */
async function serve(dataDir, files = {}) {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dataDir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  const route = buildRouter({
    dataDir,
    publicDir: 'unused',
    configPath: 'unused',
    profilesPath: 'unused',
    // The route's one collaborator, real: a stub here would make the file-name
    // question below unanswerable, and the file name is half of what is being
    // wired.
    scanService: { readLatestScrapeRun },
    orchestrator: { scrapeState: { status: 'idle', jobs: [] } },
    scheduler: { async status() { return {}; } },
    tracker: {},
    broadcaster: { add() {}, stop() {} },
    rateLimiter: new RateLimiter({ capacity: 500, refillPerSec: 500 }),
    logger: () => {},
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    Promise.resolve(route(req, res, url)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    async get(path = ROUTE) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      return { status: res.status, text, json: text ? JSON.parse(text) : null };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'arb-scrape-run-'));
}

/**
 * The page's own read set, measured from its source rather than restated here.
 *
 * Comments are stripped first: the prose around this route names fields the
 * reader used to have (`run.opportunitiesCount`, `run.options`) and the
 * filename `latest-scrape-run.json` itself matches a `run.<field>` read, so an
 * unstripped measurement would demand fields that exist in no report and no
 * code. What survives is the live read set of the one consumer.
 */
function runFieldsReadByPage() {
  const start = pageSource.indexOf('async function refreshLastRun() {');
  assert.notEqual(start, -1, 'the page lost its refreshLastRun reader — this test pins it');
  const end = pageSource.indexOf('\n}', start);
  assert.notEqual(end, -1, 'refreshLastRun has no closing brace at column 0');
  const body = pageSource
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/latest-scrape-run\.json/g, '<report-file>');
  return [...new Set([...body.matchAll(/\brun\.(\w+)/g)].map((m) => m[1]))].sort();
}

test('the route answers the page with the stored report, whole', async () => {
  const dir = tempDir();
  const srv = await serve(dir, { 'latest-scrape-run.json': storedReport() });
  try {
    const { status, json } = await srv.get();
    assert.equal(status, 200, `the route answered ${status}`);
    // Whole, not selected: the reader below the panel head renders fields this
    // assertion never names, and an envelope (`{ run }`) would hand all of them
    // `undefined` — which renders as an empty panel, exactly the state a page
    // shows before the route existed.
    assert.deepEqual(json, storedReport(),
      'the answer is the persisted document itself, not a copy with parts held back');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every field the page reads off the run is on the answer the route gives it', async () => {
  const dir = tempDir();
  const srv = await serve(dir, { 'latest-scrape-run.json': storedReport() });
  try {
    const reads = runFieldsReadByPage();
    assert.ok(reads.length > 0, 'the measurement found no reads — the extractor is broken, not the page');
    const { json } = await srv.get();
    for (const field of reads) {
      assert.ok(Object.hasOwn(json, field),
        `the page reads run.${field} and the route's answer does not carry it: ${Object.keys(json).join(', ')}`);
    }
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing persisted, the answer is the empty panel and nothing else', async () => {
  const dir = tempDir();
  const srv = await serve(dir);
  try {
    const { status, json } = await srv.get();
    assert.equal(status, 200, `the route answered ${status}`);
    assert.deepEqual(json, { jobs: [] },
      'the fallback is the empty document the page already knows how to draw');

    // The field the fallback used to publish, pinned absent rather than left to
    // prose: `opportunitiesCount: 0` was written in exactly the one case where
    // there are no opportunities to count, and read by a panel that then
    // reported a measured zero forever (src/router.mjs:64-70). The counts are
    // read from the scan instead, so the route must not bring this field back
    // for the case it describes worst.
    assert.ok(!Object.hasOwn(json, 'opportunitiesCount'),
      'the dead fallback field is back on the answer');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the answer is the run report, not the scrape state that sits beside it', async () => {
  const dir = tempDir();
  // Both documents on disk, naming different runs, the way a machine mid-run
  // has them: the state is the run in flight and the report is the last one
  // that finished. A route that read the state file would answer with the run
  // that has not produced results yet.
  const srv = await serve(dir, {
    'latest-scrape-run.json': storedReport(),
    'scrape-state.json': { runId: '2026-09-30T11-02-00-000Z', status: 'running', jobs: [], options: { bankroll: 1000 } },
  });
  try {
    const { json } = await srv.get();
    assert.equal(json.runId, storedReport().runId,
      'the route answered with the state document, not the persisted report');
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page asks this route, and asks it from the reader that draws the panel', async () => {
  // The consumer pin, measured rather than trusted: the call exists, it is
  // inside refreshLastRun, and the page calls that reader — a page that stopped
  // asking would leave the route served and the panel empty, which is the
  // failure this test exists to make loud.
  //
  // The call is looked for inside the reader's own body, not anywhere in the
  // page: the page calls arbiterApi.get for several routes and the first match
  // in the file is /api/scrapers, so a page-wide search measures the wrong
  // consumer and passes while this panel asks for nothing.
  const start = pageSource.indexOf('async function refreshLastRun() {');
  assert.notEqual(start, -1, 'the page lost its refreshLastRun reader — this test pins it');
  const end = pageSource.indexOf('\n}', start);
  const reader = pageSource.slice(start, end);
  const call = /\barbiterApi\.get\(\s*'([^']+)'\s*\)/.exec(reader);
  assert.ok(call, 'the last-run reader no longer calls arbiterApi.get');
  assert.equal(call[1], ROUTE, `the reader asks for ${call[1]}, not ${ROUTE}`);

  const callSites = [...pageSource.matchAll(/\brefreshLastRun\(\)/g)].length;
  assert.ok(callSites >= 1,
    `the reader is defined and never called (${callSites} call sites)`);
});
