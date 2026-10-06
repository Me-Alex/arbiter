import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanWorkspace, DEFAULT_SCAN_OPTIONS } from '../src/scanner/scanner.mjs';
import { ScrapeOrchestrator, resolveScanRequest } from '../src/scrape-orchestrator.mjs';

/**
 * What a scan does when the caller names no settings was written out four
 * times: scanWorkspace's destructuring defaults, the orchestrator's call site,
 * resolveScanRequest, and verification's re-scan. They agreed by luck, not by
 * construction, so these assertions pin the agreed values and check the two
 * public entry points actually produce them.
 */

test('the default scan settings are the ones every call site agrees on', () => {
  assert.deepEqual(DEFAULT_SCAN_OPTIONS, {
    bankroll: 1000,
    minMarginPercent: 0,
    minEvPercent: 2,
    maxMiddleRiskPercent: 15,
    minMiddleRoiPercent: 20,
    includeLive: false,
    includePast: false,
  });
});

test('resolveScanRequest on an empty request returns the defaults', () => {
  // resolveScanRequest clamps every field, so this is the path an API request
  // with no body takes. It must not silently become stricter or looser.
  assert.deepEqual(resolveScanRequest({}), {
    bankroll: DEFAULT_SCAN_OPTIONS.bankroll,
    minMarginPercent: DEFAULT_SCAN_OPTIONS.minMarginPercent,
    minEvPercent: DEFAULT_SCAN_OPTIONS.minEvPercent,
    maxMiddleRiskPercent: DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
    minMiddleRoiPercent: DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
    includeLive: DEFAULT_SCAN_OPTIONS.includeLive,
    includePast: DEFAULT_SCAN_OPTIONS.includePast,
    maxEvents: undefined,
    sport: undefined,
    // The two optional caps arrive as keys holding undefined, the same honest
    // "asked, no cap" shape maxEvents and sport already use, so a consumer can
    // tell an absent cap from a field it never read.
    maxStake: undefined,
    maxAgeMinutes: undefined,
  });
  assert.deepEqual(resolveScanRequest(undefined), resolveScanRequest({}));
});

test('a scan that names no settings records the defaults it used', async () => {
  // The published scan reports its own options. A caller that passed nothing
  // must see the documented defaults there, not undefined or a stale copy.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-opts-'));
  try {
    const scan = await scanWorkspace({ dataDir: dir });
    assert.equal(scan.options.bankroll, DEFAULT_SCAN_OPTIONS.bankroll);
    assert.equal(scan.options.minMarginPercent, DEFAULT_SCAN_OPTIONS.minMarginPercent);
    assert.equal(scan.options.minEvPercent, DEFAULT_SCAN_OPTIONS.minEvPercent);
    assert.equal(scan.options.maxMiddleRiskPercent, DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent);
    assert.equal(scan.options.minMiddleRoiPercent, DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent);
    assert.equal(scan.options.includeLive, DEFAULT_SCAN_OPTIONS.includeLive);
    assert.equal(scan.options.includePast, DEFAULT_SCAN_OPTIONS.includePast);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit setting still wins over the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-opts-'));
  try {
    const scan = await scanWorkspace({ dataDir: dir, bankroll: 5000, includePast: true });
    assert.equal(scan.options.bankroll, 5000);
    assert.equal(scan.options.includePast, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the optional stake cap and prematch age clamp instead of guessing, and stay absent when unasked', () => {
  // Absence is the meaning: no cap, and the snapshot-quality default window.
  // An empty or invalid value must say undefined rather than clamp to a
  // number — a guessed maxStake of 0 would drop every arbitrage (an
  // allocation of 0 is refused outright), and a guessed age would silently
  // change which observations count as fresh.
  assert.equal(resolveScanRequest({}).maxStake, undefined);
  assert.equal(resolveScanRequest({}).maxAgeMinutes, undefined);
  assert.equal(resolveScanRequest({ maxStake: null }).maxStake, undefined);
  assert.equal(resolveScanRequest({ maxStake: '' }).maxStake, undefined);
  assert.equal(resolveScanRequest({ maxStake: 'uncapped' }).maxStake, undefined);
  assert.equal(resolveScanRequest({ maxAgeMinutes: null }).maxAgeMinutes, undefined);
  assert.equal(resolveScanRequest({ maxAgeMinutes: 'soon' }).maxAgeMinutes, undefined);
  // Finite values clamp into the declared range, boundaries included. Form
  // inputs arrive as strings, so a numeric string is finite, not absent.
  assert.equal(resolveScanRequest({ maxStake: '100' }).maxStake, 100);
  assert.equal(resolveScanRequest({ maxStake: 0 }).maxStake, 0);
  assert.equal(resolveScanRequest({ maxStake: -25 }).maxStake, 0);
  assert.equal(resolveScanRequest({ maxStake: 1000000 }).maxStake, 1000000);
  assert.equal(resolveScanRequest({ maxStake: 1000001 }).maxStake, 1000000);
  assert.equal(resolveScanRequest({ maxStake: 125.5 }).maxStake, 125.5);
  assert.equal(resolveScanRequest({ maxAgeMinutes: 0 }).maxAgeMinutes, 1);
  assert.equal(resolveScanRequest({ maxAgeMinutes: 30 }).maxAgeMinutes, 30);
  assert.equal(resolveScanRequest({ maxAgeMinutes: 10081 }).maxAgeMinutes, 10080);
  // And the caps ride along in the exact object shape pinned above.
  assert.deepEqual(
    resolveScanRequest({ maxStake: 100, maxAgeMinutes: 5 }),
    { ...resolveScanRequest({}), maxStake: 100, maxAgeMinutes: 5 },
  );
});

// ---------------------------------------------------------------------------
// The stake cap, measured against a driven workspace.
//
// Fixture copied from test/scan-fields-census.test.mjs: every event carries
// the ids a real scrape supplies. groupByEvent collapses all four groups into
// one event (they share sport, kickoff and teams), so the engine sees one
// merged event: 1 arb, 2 middles, 8 positive-EV records, 5 low holds —
// measured by running the workspace, not by reading the engine.
// ---------------------------------------------------------------------------

const EVENT = (id, sourceId, eventKey, markets) => ({
  id, sourceId, eventKey, providerEventId: `p-${id}`,
  sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
  homeTeam: 'Home', awayTeam: 'Away', markets,
});
const sel = (name, odds, extra = {}) => ({ name, odds, id: `s-${extra.k || name}`, ...extra });
const mkt = (key, selections) => ({ key, selections, id: `m-${key}` });

const WORKSPACE = [
  // Arbitrage: two independent books, inverse sum under 1.
  EVENT('a1', 'alpha', 'k-arb', [mkt('MATCH_ODDS', [sel('H', 2.10), sel('D', 4.20), sel('A', 4.60)])]),
  EVENT('b1', 'bravo', 'k-arb', [mkt('MATCH_ODDS', [sel('H', 2.05), sel('D', 4.50), sel('A', 5.00)])]),
  // Middles: an over/under pair straddling a line.
  EVENT('a2', 'alpha', 'k-middle', [mkt('OVER_UNDER_25', [sel('Over', 2.00, { handicap: 2.5 }), sel('Under', 2.00, { handicap: 2.5 })])]),
  EVENT('b2', 'bravo', 'k-middle', [mkt('OVER_UNDER_25', [sel('Over', 1.95, { handicap: 2.25 }), sel('Under', 1.95, { handicap: 2.75 })])]),
  // Positive EV: one selection far above the other two books' consensus.
  EVENT('a3', 'alpha', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 5.20), sel('D', 3.60), sel('A', 3.40)])]),
  EVENT('b3', 'bravo', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 2.10), sel('D', 3.60), sel('A', 3.50)])]),
  EVENT('c3', 'charlie', 'k-ev', [mkt('MATCH_ODDS', [sel('H', 2.15), sel('D', 3.55), sel('A', 3.45)])]),
  // Low hold: a two-way market whose inverse sum sits just above 1.
  EVENT('a4', 'alpha', 'k-hold', [mkt('BOTH_TEAMS_TO_SCORE', [sel('Yes', 2.00), sel('No', 1.98)])]),
];

/** @returns {Promise<object>} a scan driven through the real scanWorkspace. */
async function driveFixture(args = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-opts-cap-'));
  try {
    const capturedAtUsed = new Date().toISOString();
    await mkdir(join(dir, 'workspace'), { recursive: true });
    for (const sourceId of ['alpha', 'bravo', 'charlie']) {
      await writeFile(join(dir, 'workspace', `${sourceId}_events.json`), JSON.stringify({
        runId: 'run-census', sourceUrl: `https://${sourceId}.example/offer`, transport: 'test-public-feed',
        schemaVersion: 2, sourceId, capturedAt: capturedAtUsed, dataStatus: 'fresh',
        events: WORKSPACE.filter((e) => e.sourceId === sourceId),
      }), 'utf8');
    }
    return await scanWorkspace({ dataDir: dir, bankroll: 1000, publish: false, ...args });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a stake cap lowers every family allocation and stays out of the published options', async () => {
  const baseline = await driveFixture();
  const capped = await driveFixture({ maxStake: 100 });

  // Measured baseline against bankroll 1000: the flat families stake the
  // whole budget, the Kelly family caps at 5% of it per record.
  assert.equal(baseline.opportunities.length, 1);
  assert.equal(baseline.opportunities[0].totalStake, 1000);
  assert.equal(baseline.middles.length, 2);
  for (const middle of baseline.middles) assert.equal(middle.totalStake, 1000);
  assert.deepEqual(
    baseline.positiveEv.map((o) => o.totalStake),
    [50, 20.7, 50, 50, 50, 50, 25.6, 25.6],
  );

  // With the cap, every allocator sees min(bankroll, maxStake): the flat
  // families drop to the cap, and the Kelly ceiling (5% of that budget)
  // lands on 5 instead of 50. Same signals, smaller money — which is the
  // whole point of a stake cap: the shape of the scan does not change.
  assert.equal(capped.opportunities.length, 1);
  assert.equal(capped.opportunities[0].totalStake, 100);
  assert.equal(capped.middles.length, 2);
  for (const middle of capped.middles) assert.equal(middle.totalStake, 100);
  assert.equal(Math.max(...capped.positiveEv.map((o) => o.totalStake)), 5);
  for (const record of capped.positiveEv) {
    assert.ok(record.totalStake <= 5, `EV stake ${record.totalStake} exceeds the capped Kelly ceiling of 5`);
  }

  // The cap is a scanning input, not a published setting: the options
  // payload keeps exactly the keys it had without it (scan-fields-census
  // pins the payload at 11 keys, and this file's first test pins resolve's
  // own output separately).
  assert.equal('maxStake' in capped.options, false);
  assert.deepEqual(Object.keys(capped.options).sort(), Object.keys(baseline.options).sort());
});

function broadcaster() {
  return { broadcast() {} };
}

test('the orchestrator stores the caps and converts maxAgeMinutes into the prematch window', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-orch-caps-'));
  try {
    const configPath = join(dataDir, 'scrapers.json');
    // probe-book has no configured adapter, so the real batch fails
    // configuration validation offline without browser fallback — and the
    // scan still runs and publishes, which is what this test reads.
    await writeFile(configPath, JSON.stringify({
      jobs: [{ id: 'probe-book', enabled: true, validationStatus: 'validated', sourceIds: [] }],
    }));
    const orchestrator = new ScrapeOrchestrator({ dataDir, configPath, broadcaster: broadcaster() });
    let pipelineDone = null;
    const runPipeline = orchestrator._runPipeline.bind(orchestrator);
    orchestrator._runPipeline = (books, scanOptions, runId, signal) => {
      pipelineDone = runPipeline(books, scanOptions, runId, signal);
      return pipelineDone;
    };

    const state = await orchestrator.launch({
      bookIds: ['probe-book'],
      scanOptions: { maxStake: 100, maxAgeMinutes: 5 },
    });
    assert.equal(state.status, 'running');
    await pipelineDone.catch(() => {});

    // Stored resolved, exactly where the scheduler and settings page read back.
    assert.equal(state.options.maxStake, 100);
    assert.equal(state.options.maxAgeMinutes, 5);
    const persistedState = JSON.parse(await readFile(join(dataDir, 'scrape-state.json'), 'utf8'));
    assert.equal(persistedState.options.maxStake, 100);
    assert.equal(persistedState.options.maxAgeMinutes, 5);

    // The scan records the window the cap produced, in milliseconds, and
    // leaves the live window at its own default: the cap is prematch only.
    const scan = JSON.parse(await readFile(join(dataDir, 'latest-scan.json'), 'utf8'));
    assert.equal(scan.options.prematchMaxAgeMs, 5 * 60000);
    assert.equal(scan.options.liveMaxAgeMs, 90000);
    // But not the settings themselves: the published payload stays the
    // pinned 11 keys, none of the two caps among them.
    assert.equal('maxStake' in scan.options, false);
    assert.equal('maxAgeMinutes' in scan.options, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
