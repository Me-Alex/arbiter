import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_STATUS, isActionableKickoff, snapshotQuality } from '../src/shared/data-quality.mjs';
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
