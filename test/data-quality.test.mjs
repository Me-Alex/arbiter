import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_STATUS, isActionableKickoff, snapshotQuality } from '../src/shared/data-quality.mjs';
import { loadWorkspace } from '../src/scanner/scanner.mjs';
import { canonicalOutcome, supportedContractForMarket } from '../src/scanner/market-contracts.mjs';

test('snapshotQuality rejects stale, failed, and timestamp-less data', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  assert.equal(snapshotQuality({ dataStatus: 'fresh', capturedAt: '2030-01-01T11:30:00Z', events: [] }, { now }).status, DATA_STATUS.STALE);
  assert.equal(snapshotQuality({ dataStatus: 'failed', events: [] }, { now }).status, DATA_STATUS.FAILED);
  assert.equal(snapshotQuality({ events: [{ id: 'legacy' }] }, { now }).status, DATA_STATUS.UNKNOWN);
});

test('only future prematch kickoff values are actionable', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  assert.equal(isActionableKickoff('2030-01-01T12:01:00Z', { now }), true);
  assert.equal(isActionableKickoff('2030-01-01T11:59:00Z', { now }), false);
  assert.equal(isActionableKickoff('not-a-date', { now }), false);
});

test('supported 1X2 outcomes include bookmaker display variants', () => {
  assert.deepEqual(supportedContractForMarket('MATCH_ODDS').outcomes, ['home', 'draw', 'away']);
  assert.equal(canonicalOutcome('1 (FCSB)', { marketKey: 'MATCH_ODDS', homeTeam: 'FCSB', awayTeam: 'CFR' }), 'home');
  assert.equal(canonicalOutcome('X (Egalitate)', { marketKey: 'MATCH_ODDS', homeTeam: 'FCSB', awayTeam: 'CFR' }), 'draw');
  assert.equal(canonicalOutcome('2 (CFR)', { marketKey: 'MATCH_ODDS', homeTeam: 'FCSB', awayTeam: 'CFR' }), 'away');
  assert.equal(supportedContractForMarket('PRICE_BOOST'), null);
});
/**
 * The verdict as it reaches a page, not only as a function returns it.
 *
 * The card translates `dataReasonCode`, so the contract that has to hold is
 * the one that survives the loader: a source judged stale must arrive carrying
 * the code that names the failure and the limit it was judged against. Asserting
 * `snapshotQuality` on its own passes happily while the loader drops the code
 * on the way out and every card falls back to an English sentence -- a mutation
 * that survived until this file existed.
 */
test('a stale snapshot reaches the page with the code and the limit it was judged against', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-verdict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const base = {
    sourceUrl: 'https://example.test/feed',
    transport: 'test-json',
    runId: 'run-1',
    events: [{ id: 'e1', startDate: kickoff }],
  };
  await writeFile(join(workspace, 'oldbook_events.json'), JSON.stringify({ ...base, sourceId: 'oldbook', capturedAt: hourAgo, observedAt: hourAgo }));
  await writeFile(join(workspace, 'newbook_events.json'), JSON.stringify({ ...base, sourceId: 'newbook', capturedAt: now, observedAt: now }));

  const { sources } = await loadWorkspace(dir, {});
  const byId = Object.fromEntries(sources.map((s) => [s.sourceId, s]));
  assert.equal(sources.length, 2, 'both books reached the scan');

  assert.equal(byId.oldbook.dataStatus, DATA_STATUS.STALE);
  assert.equal(byId.oldbook.dataReasonCode, 'tooOld');
  assert.equal(byId.oldbook.dataReasonParams.limit, 10 * 60 * 1000, 'the limit the verdict was reached with is not published');
  assert.ok(byId.oldbook.dataReason, 'the operator sentence still travels beside the code');

  // A healthy book says nothing and carries no numbers. Publishing the limit on
  // every record would put a threshold on a snapshot nothing was judged against.
  assert.equal(byId.newbook.dataStatus, DATA_STATUS.FRESH);
  assert.equal(byId.newbook.dataReasonCode, null);
  assert.equal(byId.newbook.dataReasonParams, undefined, 'params published on a book with no numbers to show');
});