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

test('expireAutomaticConfirmations also expires confirmed middles', () => {
  // runVerificationPass writes confirmations onto middles too, so expiring
  // only opportunities left confirmed middles in the persisted scan forever.
  const scan = {
    opportunities: [],
    middles: [
      { kickoff: '2000-01-01T00:00:00Z', verification: { status: 'confirmed' } },
    ],
  };
  expireAutomaticConfirmations(scan, { now: Date.now() });
  assert.equal(scan.middles[0].verification.status, 'expired');
  assert.equal(scan.middles[0].verification.reason, 'event past');
});

test('expireAutomaticConfirmations expires a confirmation with no usable kickoff', () => {
  // A missing kickoff used to yield new Date(0) -> 0, which read as falsy and
  // skipped the expiry, so the confirmation could never be retired.
  for (const kickoff of [undefined, null, '', 'not a date']) {
    const scan = { opportunities: [{ kickoff, verification: { status: 'confirmed' } }] };
    expireAutomaticConfirmations(scan, { now: Date.now() });
    assert.equal(scan.opportunities[0].verification.status, 'expired', `kickoff: ${JSON.stringify(kickoff)}`);
    assert.equal(scan.opportunities[0].verification.reason, 'event kickoff unknown');
  }
});

test('expireAutomaticConfirmations keeps a confirmation inside the settlement grace', () => {
  // An event that kicked off an hour ago has not necessarily been re-priced by
  // every feed yet; expiring it immediately would drop a still-live signal.
  const now = Date.parse('2030-01-01T12:00:00Z');
  const scan = {
    opportunities: [
      { kickoff: '2030-01-01T11:00:00Z', verification: { status: 'confirmed' } },
      { kickoff: '2030-01-01T05:00:00Z', verification: { status: 'confirmed' } },
    ],
  };
  expireAutomaticConfirmations(scan, { now });
  assert.equal(scan.opportunities[0].verification.status, 'confirmed', '1h after kickoff is inside the grace');
  assert.equal(scan.opportunities[1].verification.status, 'expired', '7h after kickoff is settled');
});

test('expireAutomaticConfirmations leaves other statuses and odd shapes alone', () => {
  const scan = { opportunities: [{ kickoff: '2000-01-01T00:00:00Z', verification: { status: 'rejected' } }] };
  expireAutomaticConfirmations(scan, { now: Date.now() });
  assert.equal(scan.opportunities[0].verification.status, 'rejected');
  assert.equal(expireAutomaticConfirmations(null), null);
  assert.doesNotThrow(() => expireAutomaticConfirmations({}));
  assert.doesNotThrow(() => expireAutomaticConfirmations({ opportunities: 'nope' }));
});
