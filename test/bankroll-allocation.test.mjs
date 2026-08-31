import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateBankroll } from '../src/scanner/bankroll-allocation.mjs';

test('allocateBankroll on arb splits inversely to odds', () => {
  const opp = {
    type: 'arb',
    legs: [
      { sourceId: 'a', selection: 'H', odds: 2.0 },
      { sourceId: 'b', selection: 'A', odds: 2.5 },
    ],
  };
  const out = allocateBankroll(opp, 1000);
  // totalStake should be 1000 (full bankroll deployed).
  assert.equal(out.totalStake, 1000);
  // inv = 1/2 + 1/2.5 = 0.9; stake_a = 1000 * 0.5 / 0.9 = 555.56
  assert.equal(out.legs[0].stake, 555.56);
  // stake_b = 1000 * 0.4 / 0.9 = 444.44
  assert.equal(out.legs[1].stake, 444.44);
  // payout equal on every leg
  assert.equal(out.legs[0].payout, out.legs[1].payout);
  // guaranteed profit ≈ 1000/0.9 - 1000 = 111.11
  assert.equal(out.guaranteedProfit, 111.11);
});

test('allocateBankroll on middle splits 50/50', () => {
  const opp = {
    type: 'middle',
    legs: [
      { sourceId: 'a', selection: 'H -2.5', odds: 1.95 },
      { sourceId: 'b', selection: 'H +3.0', odds: 1.91 },
    ],
  };
  const out = allocateBankroll(opp, 1000);
  assert.equal(out.totalStake, 1000);
  assert.equal(out.legs[0].stake, 500);
  assert.equal(out.legs[1].stake, 500);
});

test('allocateBankroll on positive EV uses capped kelly', () => {
  const opp = {
    type: 'positive_ev',
    odds: 2.5,
    evPercent: 20,
  };
  const out = allocateBankroll(opp, 1000);
  // ev = 0.20, (odds-1) = 1.5, kelly = 0.133. Capped at 0.05.
  assert.equal(out.legs[0].stake, 50); // 1000 * 0.05
});

test('allocateBankroll on unknown type returns zero stake', () => {
  const out = allocateBankroll({ type: 'foo' }, 1000);
  assert.equal(out.totalStake, 0);
});
