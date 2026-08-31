import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignal, expireAutomaticConfirmations } from '../src/verification.mjs';
import { buildSignalIndex } from '../src/scanner/engine.mjs';

function leg(sourceId, selection, odds) {
  return { sourceId, selection, odds, marketKey: 'MATCH_ODDS', eventKey: 'k1' };
}

test('verifySignal confirms when prices hold', () => {
  const target = {
    type: 'arb',
    eventKey: 'k1',
    marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10), leg('b', 'A', 5.00), leg('a', 'D', 4.50)],
    roiPercent: 5,
  };
  const confirmationScan = {
    opportunities: [
      {
        eventKey: 'k1', marketKey: 'MATCH_ODDS', inverseSum: 0.95,
        legs: [leg('a', 'H', 2.10), leg('b', 'A', 5.00), leg('a', 'D', 4.50)],
      },
    ],
  };
  const index = buildSignalIndex(confirmationScan);
  const v = verifySignal(target, confirmationScan, { index, tolerance: 0.05 });
  assert.equal(v.status, 'confirmed');
});

test('verifySignal rejects when odds drift beyond tolerance', () => {
  const target = {
    type: 'arb',
    eventKey: 'k1', marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10), leg('b', 'A', 5.00)],
    roiPercent: 5,
  };
  const confirmationScan = {
    opportunities: [
      {
        eventKey: 'k1', marketKey: 'MATCH_ODDS', inverseSum: 0.95,
        legs: [leg('a', 'H', 2.10), leg('b', 'A', 3.00)], // big drift
      },
    ],
  };
  const index = buildSignalIndex(confirmationScan);
  const v = verifySignal(target, confirmationScan, { index, tolerance: 0.05 });
  assert.equal(v.status, 'rejected');
});

test('verifySignal rejects when a leg is missing', () => {
  const target = {
    type: 'arb',
    eventKey: 'k1', marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10), leg('b', 'A', 5.00)],
  };
  const confirmationScan = {
    opportunities: [
      {
        eventKey: 'k1', marketKey: 'MATCH_ODDS', inverseSum: 0.95,
        legs: [leg('a', 'H', 2.10)],
      },
    ],
  };
  const index = buildSignalIndex(confirmationScan);
  const v = verifySignal(target, confirmationScan, { index });
  assert.equal(v.status, 'rejected');
});

test('expireAutomaticConfirmations demotes past kickoffs', () => {
  const scan = {
    opportunities: [
      {
        kickoff: '2000-01-01T00:00:00Z',
        verification: { status: 'confirmed' },
      },
    ],
  };
  expireAutomaticConfirmations(scan, { now: Date.now() });
  assert.equal(scan.opportunities[0].verification.status, 'expired');
});
