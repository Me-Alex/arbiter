/**
 * verify-payload.test.mjs — what is `POST /api/verify` allowed to answer with?
 *
 * The route used to forward the entire return of `runVerificationPass`, which
 * carries two fields on top of the verdict counters: `verifications` (one entry
 * per target, each holding the whole target) and `newScan` (the full re-scan of
 * every book the pass touched). Nothing read either of them. The page formats
 * four integers and re-reads /api/scan, which is where the verdicts already
 * live — the route writes `verification` onto every opportunity and
 * `verificationSummary` onto the scan before answering.
 *
 * So this file does not check that the counters are right. That is
 * verification.test.mjs's job, and duplicating it here would only be a second
 * place to get it wrong. It checks the shape: the route answers with the
 * counters and nothing else, which is what the page's own comment above the
 * call has always claimed the route did.
 *
 * That comment is why this test exists. It reads:
 *
 *   "The response is the verdict counters, not the scan, so the page re-reads
 *    /api/scan afterwards rather than rendering what came back."
 *
 * Which was not true of the route it describes, and no test noticed, because
 * the page mock in scanner-reverify.test.mjs answers with whatever the test
 * hands it. The frontend half of this contract was never under test at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = join(ROOT_DIR, 'config', 'scrapers.json');
const COUNTERS = ['confirmed', 'rejected', 'expired', 'unconfirmed'];

/**
 * A published scan with one cross-book opportunity, and a workspace holding the
 * two books it names. The pass has to find the legs or the run short-circuits
 * before producing anything to measure.
 */
function seed(dir) {
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const now = new Date().toISOString();
  const kickoff = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
  const event = (sourceId, yes, no) => ({
    id: `${sourceId}-1`, sourceId, sourceUrl: `https://example.invalid/${sourceId}`,
    observedAt: now, sport: 'Football', league: 'Liga', kickoff,
    homeTeam: 'Athletic Bilbao', awayTeam: 'Atletico Madrid',
    eventKey: 'football|2026-10-01|athletic-bilbao|atletico-madrid',
    markets: [{
      key: 'BOTH_TEAMS_SCORE', name: 'Both teams to score',
      selections: [
        { id: `${sourceId}-yes`, name: 'Yes', odds: yes, group: 'Main' },
        { id: `${sourceId}-no`, name: 'No', odds: no, group: 'Main' },
      ],
    }],
  });
  for (const [id, yes, no] of [['alpha', 2.84, 1.55], ['beta', 1.9, 2.55]]) {
    writeFileSync(join(workspace, `${id}_events.json`), JSON.stringify({
      schemaVersion: 2, runId: `markets-1-${id}`, sourceId: id, sourceUrl: `https://example.invalid/${id}`,
      capturedAt: now, observedAt: now, dataStatus: 'ok', events: [event(id, yes, no)],
    }), 'utf8');
  }
  const scan = {
    scrapeRunId: 'r1', scannedAt: now, options: { minRoiPercent: 1, minEvPercent: 2, bankroll: 1000 },
    opportunities: [{
      type: 'arb', family: 'BTTS', period: 'fulltime', marketKey: 'BOTH_TEAMS_SCORE',
      eventKey: 'football|2026-10-01|athletic-bilbao|atletico-madrid',
      homeTeam: 'Athletic Bilbao', awayTeam: 'Atletico Madrid', kickoff, sport: 'Football', league: 'Liga',
      roiPercent: 34.4, totalStake: 1000,
      legs: [
        { sourceId: 'alpha', selection: 'Yes', odds: 2.84, marketKey: 'BOTH_TEAMS_SCORE' },
        { sourceId: 'beta', selection: 'No', odds: 2.55, marketKey: 'BOTH_TEAMS_SCORE' },
      ],
    }],
    middles: [],
  };
  writeFileSync(join(dir, 'latest-scan.json'), JSON.stringify(scan), 'utf8');
  return scan;
}

async function postVerify() {
  const dir = mkdtempSync(join(tmpdir(), 'arb-verify-'));
  try {
    const scan = seed(dir);
    const route = buildRouter({
      dataDir: dir, publicDir: dir, configPath: CONFIG, profilesPath: 'unused',
      rateLimiter: new RateLimiter({ capacity: 500, refillPerSec: 500 }),
      logger: () => {},
      scanService,
      orchestrator: { scrapeState: { status: 'idle', jobs: [] }, async launch() { return {}; }, async cancel() { return {}; } },
      scheduler: { async status() { return {}; }, async enable() {}, async disable() {} },
      tracker: { async loadAlerts() { return { preferences: {} }; }, async saveAlerts(p) { return p; } },
      broadcaster: { add() {}, stop() {} },
    });
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => route(req, res, new URL(req.url, 'http://127.0.0.1')).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      // The POST is CSRF-gated, so the measurement goes through the same
      // handshake the page does rather than around it.
      const { token } = await (await fetch(`${base}/api/csrf`, { headers: { host: '127.0.0.1' } })).json();
      const res = await fetch(`${base}/api/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '127.0.0.1', 'x-arbiter-token': token },
        body: JSON.stringify({ targets: scan.opportunities }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, `route answered ${res.status}: ${text.slice(0, 300)}`);
      return { body: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf8'), onDisk: JSON.parse(readFileSync(join(dir, 'latest-scan.json'), 'utf8')) };
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the verify route answers with the verdict counters and nothing else', async () => {
  const { body } = await postVerify();
  assert.deepEqual(Object.keys(body).sort(), [...COUNTERS].sort(),
    `the response carries ${Object.keys(body).filter((k) => !COUNTERS.includes(k)).join(', ') || 'nothing'} beyond the counters`);
  for (const k of COUNTERS) assert.equal(typeof body[k], 'number', `${k} is not a number: ${JSON.stringify(body[k])}`);
});

test('what the counters say is already on disk, so nothing is lost by not resending it', async () => {
  const { body, onDisk } = await postVerify();
  // This is the load-bearing claim behind the trim: the page re-reads
  // /api/scan after the call, so if the response were the only home of a
  // verdict, dropping it would have removed it from the screen. It is not —
  // the route writes the same four counters onto the scan it persists.
  assert.deepEqual(
    {
      confirmed: onDisk.verificationSummary.confirmed,
      rejected: onDisk.verificationSummary.rejected,
      expired: onDisk.verificationSummary.expired,
      unconfirmed: onDisk.verificationSummary.unconfirmed,
    },
    { confirmed: body.confirmed, rejected: body.rejected, expired: body.expired, unconfirmed: body.unconfirmed },
    'the response and the persisted scan disagree about the verdicts',
  );
  // And the per-opportunity detail the tables render is there too, so the
  // status column on the dashboard is not fed by the trimmed fields.
  assert.ok(onDisk.opportunities[0].verification, 'the opportunity lost its verification block');
  assert.equal(typeof onDisk.opportunities[0].verification.status, 'string');
});

test('the page still renders every counter the route sends it', () => {
  // The other half of the contract. A census test proved which payload fields
  // the page reads; this proves the four counters are read OFF THE RESPONSE, so
  // trimming the response can never quietly remove a number the UI was showing.
  //
  // Scoped to the toast inside reverifyPublished, and matching `result.<field>`
  // rather than the bare word. The first version searched the whole file for
  // the name, and mutation 6 sailed straight through it: `verificationMix`
  // reads `s.unconfirmed` off the scan at line 210, so the word was on screen
  // somewhere and the assertion was satisfied by a reader that has nothing to do
  // with the response. A census that cannot tell two readers of one name apart
  // is not evidence that the response is read.
  const src = readFileSync(join(ROOT_DIR, 'public', 'js', 'pages', 'scanner.js'), 'utf8');
  const fn = /async function reverifyPublished\(\)[\s\S]*?\n {4}\}/.exec(src)?.[0];
  assert.ok(fn, 'reverifyPublished is gone from scanner.js; re-examine how the response is consumed');
  const read = COUNTERS.filter((k) => new RegExp(`result\\.${k}\\b`).test(fn));
  assert.deepEqual(read.sort(), [...COUNTERS].sort(),
    `the toast does not read: ${COUNTERS.filter((k) => !read.includes(k)).join(', ')}`);
});
