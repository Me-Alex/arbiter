import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundedArbitrageAllocation } from '../src/scanner/market-contracts.mjs';

/**
 * These cover the bankroll maths the scanner actually uses.
 *
 * A second implementation used to live in src/scanner/bankroll-allocation.mjs
 * with no production caller. It disagreed on two things that matter: it set
 * `profit` per leg as `payout - totalBankroll` (profit is a portfolio quantity,
 * and the bankroll is not the leg's stake), and it skipped the rounding
 * correction, so the leg stakes did not sum back to the bankroll. It was
 * removed; these tests keep that coverage on the surviving implementation.
 */

test('roundedArbitrageAllocation splits inversely to odds', () => {
  const out = roundedArbitrageAllocation([
    { sourceId: 'a', selection: 'H', odds: 2.0 },
    { sourceId: 'b', selection: 'A', odds: 2.5 },
  ], 1000);
  // inv = 1/2 + 1/2.5 = 0.9; stake_a = 1000 * 0.5 / 0.9 = 555.56
  assert.equal(out.legs[0].stake, 555.56);
  // stake_b = 1000 * 0.4 / 0.9 = 444.44
  assert.equal(out.legs[1].stake, 444.44);
  assert.equal(out.totalStake, 1000);
  // The theoretical profit is 1000/0.9 - 1000 = 111.11, but the reported
  // figure is the realised worst case, which rounding costs 0.01 of.
  assert.equal(out.legs[0].payout, 1111.12);
  assert.equal(out.legs[1].payout, 1111.1);
  assert.equal(out.worstCasePayout, 1111.1);
  assert.equal(out.guaranteedProfit, 111.1);
  // The theoretical ROI is still reported at full precision.
  assert.equal(out.roiPercent, 11.11);
});

test('roundedArbitrageAllocation gives every leg the same profit', () => {
  const out = roundedArbitrageAllocation([{ odds: 2.0 }, { odds: 2.5 }], 1000);
  // Every leg pays out the same on an arb, so guaranteed profit is a
  // portfolio-level figure, not a per-leg one. The two payouts here differ by
  // a cent because each is its own stake rounded; the profit is the worst one.
  const profits = out.legs.map((l) => l.profit);
  assert.equal(new Set(profits).size, 1);
  assert.equal(profits[0], out.guaranteedProfit);
  assert.equal(Math.round((out.worstCasePayout - out.totalStake) * 100) / 100, out.guaranteedProfit);
});

test('roundedArbitrageAllocation makes the leg stakes sum to the bankroll', () => {
  // Three legs at awkward odds: the raw allocation does not sum to the bankroll
  // once rounded, so the residual is folded back into the first leg.
  const out = roundedArbitrageAllocation([
    { sourceId: 'a', odds: 2.1 },
    { sourceId: 'b', odds: 4.3 },
    { sourceId: 'c', odds: 4.6 },
  ], 1000);
  const sum = out.legs.reduce((acc, l) => acc + l.stake, 0);
  assert.equal(Math.round(sum * 100) / 100, 1000);
});

test('roundedArbitrageAllocation rejects a market that is not an arb', () => {
  // inverseSum >= 1 means the "arb" costs more than it returns, so there is
  // nothing to allocate.
  assert.equal(roundedArbitrageAllocation([{ odds: 2.0 }, { odds: 2.0 }], 1000), null);
  assert.equal(roundedArbitrageAllocation([{ odds: 2.0 }], 1000), null);
  assert.equal(roundedArbitrageAllocation([{ odds: 2.0 }, { odds: 2.5 }], 0), null);
  assert.equal(roundedArbitrageAllocation(null, 1000), null);
});

test('roundedArbitrageAllocation exposes the worst case and the rounding risk', () => {
  const out = roundedArbitrageAllocation([{ odds: 2.0 }, { odds: 2.5 }], 1000);
  assert.equal(out.worstCasePayout, Math.min(...out.legs.map((l) => l.payout)));
  assert.equal(out.guaranteedProfit, Math.round((out.worstCasePayout - 1000) * 100) / 100);
  // The theoretical ROI survives even when rounding eats into it.
  assert.ok(out.roundingRisk >= 0);
  assert.ok(out.roiPercent > 0);
});
