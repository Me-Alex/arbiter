/**
 * event-detail-payload.test.mjs — is every field /api/event-detail publishes read by someone?
 *
 * api-surface.test.mjs already proves something calls this route, including
 * the awkward `pathname === '/api/event-detail'` equality branch that a
 * prefix-shaped regex cannot see. That is a claim about the route, not about
 * the payload: a published field with no reader is invisible at route level, and
 * on this route it had already happened. The payload published `arbs` as a
 * flat array on top of the same arbitrage map it had already attached per
 * market as `m.arb`. Nothing read `arbs`, and it could not have been used:
 * `findDetailArbitrages` keys by market key, so spreading the values throws
 * away the only link between a plan and the market it belongs to.
 *
 * So the payload is checked field by field against the code that renders it,
 * and every unread field has to be named with a reason. One such reason is
 * already real: `selection.handicap` is never read, because the modal derives
 * the same line from the market key via `thresholdFromKey` and shows it in the
 * market heading. That is a reason, not a coincidence — but it is a reason
 * about today's capture, which is why the field is excused here rather than
 * dropped from the projection, which passes selection objects by reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('espree');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CONSUMERS = [
  ['event-detail-modal.js', read('public/js/pages/event-detail-modal.js')],
  ['event-detail.js', read('public/js/pages/event-detail.js')],
  ['dashboard.js', read('public/js/pages/dashboard.js')],
];

/**
 * Fields published with no reader, and why that is not a defect. Adding a key
 * here is a claim about the code and has to survive review like any other.
 */
const UNREAD_WITH_REASON = new Map([
  ['handicap', 'the modal renders the line itself from the market key (thresholdFromKey) in the market heading, so the numeric copy on the selection says nothing the heading has not said. The projection passes selection objects by reference, so the field is left on rather than narrowed on the strength of one capture.'],
  ['group', 'measured on data-market-run/workspace, 22 blobs / 24829 events / 93600 selections: every selection carries group, every one of them says "Main", and not one market in 31927 holds two selections that share a name in different groups, so the field separates nothing in any capture on disk. The modal keys its columns on name-or-id alone, so no screen is missing a distinction. Kept rather than stripped for the same reason as handicap: the projection passes selections by reference, and group is what a book would use to disambiguate same-named outcomes the day one emits them.'],
]);

/**
 * Blank out the byte ranges the tokenizer calls comments, then search what is
 * left. A hand-written stripper was tried first and got a backtick wrong: it
 * swallowed the rest of dashboard.js from line 742 on, so the comment at 560
 * survived the "stripping" and `selection.group` was credited with a reader it
 * does not have. espree is what ESLint already runs over these files, so it is
 * asked the only question it cannot get wrong — which ranges are comments.
 *
 * `onComment` is ignored by espree; the ranges come back on `ast.comments`.
 */
function codeOnly(src) {
  const { comments } = parse(src, { ecmaVersion: 2023, sourceType: 'script', comment: true, loc: false, range: true });
  let out = '';
  let at = 0;
  for (const c of comments) {
    out += src.slice(at, c.range[0]);
    at = c.range[1];
  }
  return out + src.slice(at);
}

/** Does any consumer read `name` off an object, or name it in an object literal? */
function readersOf(name) {
  const re = new RegExp(`\\.${name}\\b|(?<!\\.)\\b${name}\\s*:|\\['${name}'\\]`, 'g');
  const sites = [];
  for (const [file, src] of CONSUMERS) {
    const n = (codeOnly(src).match(re) || []).length;
    if (n) sites.push(`${file}×${n}`);
  }
  return sites;
}

/**
 * A workspace with two books quoting one event, priced so a cross-book
 * arbitrage really exists. The arb has to be present, or the test would pass
 * without ever proving the per-market channel works.
 */
function seedWorkspace(dir) {
  // loadEventDetailSnapshots reads `join(dataDir, 'workspace')`, not dataDir
  // itself. The first version of this fixture wrote the blobs one level too
  // high, so the route answered 200 with zero events and the failure read as
  // "the projection publishes nothing" rather than as a fixture that was in
  // the wrong place.
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const now = new Date().toISOString();
  const event = (sourceId) => ({
    id: `${sourceId}-1`,
    sourceId,
    sourceUrl: `https://example.invalid/${sourceId}`,
    observedAt: now,
    sport: 'Football',
    league: 'Liga',
    kickoff: '2026-10-01T18:00:00.000Z',
    homeTeam: 'Athletic Bilbao',
    awayTeam: 'Atletico Madrid',
    eventKey: 'football|2026-10-01|athletic-bilbao|atletico-madrid',
    markets: [
      {
        key: 'BOTH_TEAMS_SCORE',
        name: 'Both teams to score',
        selections: [
          { id: `${sourceId}-yes`, name: 'Yes', odds: sourceId === 'alpha' ? 2.84 : 1.9, group: 'Main' },
          { id: `${sourceId}-no`, name: 'No', odds: sourceId === 'alpha' ? 1.55 : 2.55, group: 'Main' },
        ],
      },
      {
        // A second market with no cross-book arbitrage, quoted by both books at
        // the same price. Without it the fixture had a single market, which is
        // the one market the route attaches an arb to — so "attaches the plan to
        // every market" and "attaches it where it found one" were the same
        // observation, and a mutation that fabricated plans for markets without
        // one could not be told apart from correct behaviour.
        key: 'OVER_UNDER_2_5',
        name: 'Total goluri Peste/Sub',
        selections: [
          { id: `${sourceId}-over`, name: 'Peste 2.5', odds: 1.9, group: 'Main', handicap: '2.5' },
          { id: `${sourceId}-under`, name: 'Sub 2.5', odds: 2.05, group: 'Main', handicap: '2.5' },
        ],
      },
    ],
  });
  for (const sourceId of ['alpha', 'beta']) {
    writeFileSync(join(workspace, `${sourceId}_events.json`), JSON.stringify({
      schemaVersion: 2, runId: `markets-1-${sourceId}`, sourceId, sourceUrl: `https://example.invalid/${sourceId}`,
      capturedAt: now, observedAt: now, dataStatus: 'ok', events: [event(sourceId)],
    }), 'utf8');
  }
}

async function fetchPayload() {
  const dir = mkdtempSync(join(tmpdir(), 'arb-detail-'));
  try {
    seedWorkspace(dir);
    const route = buildRouter({
      dataDir: dir,
      publicDir: dir,
      configPath: 'unused', profilesPath: 'unused',
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
      const { port } = server.address();
      const q = new URLSearchParams({ sport: 'Football', home: 'Athletic Bilbao', away: 'Atletico Madrid' });
      const res = await fetch(`http://127.0.0.1:${port}/api/event-detail?${q}`, { headers: { Host: '127.0.0.1' } });
      const body = await res.text();
      assert.equal(res.status, 200, `route answered ${res.status}: ${body.slice(0, 300)}`);
      return JSON.parse(body);
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the payload publishes no field without a reader, and every excuse is named', async () => {
  const payload = await fetchPayload();
  const events = payload.events || [];
  assert.ok(events.length >= 2, `the fixture must reach two books, got ${events.length}`);

  const levels = { payload: new Set(Object.keys(payload)) };
  for (const [level, of] of [
    ['event', (e) => e],
    ['market', (e) => e.markets?.[0]],
    ['selection', (e) => e.markets?.[0]?.selections?.[0]],
  ]) {
    levels[level] = new Set();
    for (const e of events) for (const o of [of(e)].filter(Boolean)) Object.keys(o).forEach((k) => levels[level].add(k));
  }

  const unread = [];
  for (const [level, keys] of Object.entries(levels)) {
    for (const key of keys) {
      if (readersOf(key).length === 0 && !UNREAD_WITH_REASON.has(key)) unread.push(`${level}.${key}`);
    }
  }
  assert.deepEqual(unread, [], `published with no reader and no recorded reason: ${unread.join(', ')}`);

  // The excuse is a claim about what the modal *renders*, so it has to be
  // checked there. Checking only that `thresholdFromKey` still exists was the
  // weaker version and it was wrong: a mutation that dropped the whole line
  // from the heading while leaving the function defined sails straight past
  // it. What matters is the line reaching the page, so that is what is
  // asserted — the derivation AND the span that shows it.
  const [modalName, modal] = CONSUMERS[0];
  const modalCode = codeOnly(modal);
  assert.match(modalCode, /thresholdFromKey\(\s*m\.key\s*\)/,
    `${modalName} no longer derives the market threshold from the market key; re-examine the handicap entry`);
  assert.match(modalCode, /market-threshold/,
    `${modalName} no longer renders the threshold in the market heading, so the handicap field is no longer a duplicate of anything on screen`);
});

test('the payload does not republish the arbitrage map it already attaches per market', async () => {
  const payload = await fetchPayload();
  assert.equal('arbs' in payload, false,
    'payload.arbs is a second copy of the per-market arb, and a lossy one: spreading the map values drops the market key that links a plan to its market');
  // And the channel that does work is still there. A test that only checked the
  // field is gone would pass on a route that had stopped finding arbitrages.
  const withArb = (payload.events || []).flatMap((e) => e.markets || []).filter((m) => m.arb);
  assert.ok(withArb.length >= 1, 'the priced fixture produces a real cross-book arbitrage, and m.arb carries it');
  assert.equal(typeof withArb[0].arb.roiPercent, 'number', 'and it carries the reconciled ROI the panel renders');
  // The plan is a claim about money, so it may only sit on a market that has
  // one. The modal renders `m.arb` as both a "live arbitrage" badge and a full
  // stake/payout panel, so a plan attached to a market with no arbitrage would
  // be a payout table for a bet that does not exist. The fixture's second
  // market is the control that makes this observable: it is quoted by both
  // books, so it reaches the payload, and it is priced with no arbitrage.
  const markets = (payload.events || []).flatMap((e) => e.markets || []);
  const byKey = new Map();
  for (const m of markets) {
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push(m);
  }
  const noArbKey = 'OVER_UNDER_2_5';
  assert.ok((byKey.get(noArbKey) || []).length >= 2, `the control market has to reach the payload from both books, got ${(byKey.get(noArbKey) || []).length}`);
  const claimed = (byKey.get(noArbKey) || []).filter((m) => m.arb);
  assert.deepEqual(claimed, [], `a market with no arbitrage was given a money plan: ${JSON.stringify(claimed[0]?.arb || null)}`);
});

test('the reader search is sensitive, so an unread field is not a naming accident', () => {
  assert.deepEqual(readersOf('sourceId').length > 0 ? 'found' : 'missed', 'found', 'a field the modal does read was missed');
  assert.deepEqual(readersOf('aFieldNoConsumerEverReads').length, 0, 'a name nothing reads was reported as read');
  // The negative control that matters: `group` is the one field that is named
  // in a consumer file and read by nobody. dashboard.js:560 writes "the whole
  // group:" in a comment, and a search that counted comments credited that
  // comment with a reader — which is how the first version of this census
  // passed while the real orphan walked straight through it. A word in a
  // comment is not a read, and this assertion is what says so.
  assert.deepEqual(readersOf('group'), [], 'a name that appears only inside a comment was counted as a reader');
});
