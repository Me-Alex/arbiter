import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignal, expireAutomaticConfirmations } from '../src/verification.mjs';
import { buildSelectionIndex, groupByEvent } from '../src/scanner/engine.mjs';

/**
 * verifySignal re-prices a target against a fresh index of the eligible
 * selections the confirmation scrape produced. That index is built from
 * *events*, not from the previous run's results — indexing the old signals
 * would only ever confirm what was already known, which is the opposite of a
 * second opinion.
 */

const KICKOFF = '2030-01-01T12:00:00Z';

function event(sourceId, selections) {
  return {
    sourceId,
    eventKey: 'k1',
    kickoff: KICKOFF,
    homeTeam: 'A',
    awayTeam: 'B',
    markets: [{
      key: 'MATCH_ODDS',
      period: 'fulltime',
      selections: selections.map(([name, odds]) => ({ name, odds })),
    }],
  };
}

/** An index keyed the way verifySignal looks legs up. */
function indexFor(events) {
  const index = new Map();
  for (const [key, instances] of groupByEvent(events)) {
    for (const e of instances) {
      for (const m of e.markets || []) {
        for (const s of m.selections || []) {
          const k = `${key}::${m.key}::${String(s.name).toLowerCase()}`;
          const arr = index.get(k) || [];
          arr.push({ sourceId: e.sourceId, odds: s.odds, handicap: s.handicap ?? null, kickoff: e.kickoff });
          index.set(k, arr);
        }
      }
    }
  }
  return index;
}

function leg(sourceId, selection, odds, eventKey) {
  return { sourceId, selection, odds, marketKey: 'MATCH_ODDS', eventKey };
}

/** The canonical key the group builder produced, which legs must carry. */
function canonicalKey(events) {
  return [...groupByEvent(events).keys()][0];
}

test('verifySignal confirms when prices hold', () => {
  const events = [event('a', [['H', 2.10], ['D', 4.50]]), event('b', [['A', 5.00]])];
  const key = canonicalKey(events);
  const target = {
    type: 'arb',
    eventKey: key,
    marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10, key), leg('b', 'A', 5.00, key), leg('a', 'D', 4.50, key)],
    roiPercent: 5,
  };
  const v = verifySignal(target, { options: { bankroll: 1000 }, opportunities: [] }, {
    index: indexFor(events),
    tolerance: 0.05,
  });
  assert.equal(v.status, 'confirmed');
});

test('verifySignal rejects when odds drift beyond tolerance', () => {
  const events = [event('a', [['H', 2.10]]), event('b', [['A', 3.00]])];
  const key = canonicalKey(events);
  const target = {
    type: 'arb',
    eventKey: key,
    marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10, key), leg('b', 'A', 5.00, key)],
    roiPercent: 5,
  };
  const v = verifySignal(target, { options: { bankroll: 1000 }, opportunities: [] }, {
    index: indexFor(events),
    tolerance: 0.05,
  });
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /drift/);
});

test('verifySignal rejects when a leg is missing', () => {
  const events = [event('a', [['H', 2.10]])];
  const key = canonicalKey(events);
  const target = {
    type: 'arb',
    eventKey: key,
    marketKey: 'MATCH_ODDS',
    legs: [leg('a', 'H', 2.10, key), leg('b', 'A', 5.00, key)],
  };
  const v = verifySignal(target, { options: { bankroll: 1000 }, opportunities: [] }, {
    index: indexFor(events),
  });
  assert.equal(v.status, 'rejected');
  assert.match(v.reason, /missing/);
});

test('buildSelectionIndex is the index verification consumes', () => {
  // Guards the wiring, not the function: the two must produce the same keys,
  // or every confirmation would report its own legs missing.
  const events = [event('a', [['1', 2.10], ['X', 3.30]]), event('b', [['2', 4.60]])];
  const built = buildSelectionIndex(events);
  const manual = indexFor(events);
  assert.deepEqual([...built.keys()].sort(), [...manual.keys()].sort());
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
