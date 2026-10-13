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
  // The theoretical margin is still reported at full precision:
  // (1 - 0.9) * 100 = 10.00%, not the 11.11% ROI of the same inverse sum.
  assert.equal(out.marginPercent, 10);
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
  // The theoretical margin survives even when rounding eats into it.
  //
  // This line used to read `assert.ok(out.roundingRisk >= 0)`, which passed for
  // `false`, for `0`, for `true` and for `'abc'` alike: the flag is a boolean
  // (`roundingRisk: guaranteedProfit < 0`), and `false >= 0` is true, so the
  // assertion verified nothing at all while reading as if it did. It now states
  // what the allocator actually writes — the type, and the predicate it is.
  assert.equal(typeof out.roundingRisk, 'boolean', 'the rounding risk is a flag, not a magnitude');
  assert.equal(out.roundingRisk, out.guaranteedProfit < 0);
  assert.ok(out.marginPercent > 0);
});

test('the rounding risk is reachable, so a page has something to disclose', () => {
  // The allocator refuses anything with an inverse sum of 1 or more, so a fat
  // arbitrage cannot lose money to rounding and the flag above is always false
  // there. That is the whole reason to measure the thin tail separately: the
  // flag is the engine's disclosure for an edge smaller than its own rounding
  // grid, and scanner.js marks those rows on screen because of it. If this stops
  // firing, that badge is a lie and the page test will have been asserting a
  // state the engine cannot produce.
  const pair = (deficit, a) => [
    { sourceId: 'a', selection: 'H', odds: a },
    { sourceId: 'b', selection: 'A', odds: 1 / (1 - deficit - 1 / a) },
  ];

  // Fat: a 1% edge is 10 units on 1000 and rounding cannot touch it.
  assert.equal(roundedArbitrageAllocation(pair(1e-2, 2.5), 1000).roundingRisk, false);

  // Thin: the margin rounds to 0.00% while the cent-level split comes out under the
  // bankroll. Swept over the tail and five price pairs, at a 1000 bankroll.
  let fired = 0;
  let total = 0;
  for (let k = 1; k <= 40; k += 1) {
    for (const a of [2.02, 2.5, 3.0, 4.0, 1.6]) {
      const out = roundedArbitrageAllocation(pair(k * 1e-11, a), 1000);
      if (!out) continue;
      total += 1;
      if (out.roundingRisk === true) fired += 1;
    }
  }
  assert.ok(fired > 0, `no allocation set the flag in ${total} tries, so the engine cannot produce the state the page marks`);
  assert.equal(total, 200, 'the sweep shrank, so the count above would mean less');

  // And when it fires, the two numbers a trader reads contradict each other:
  // the margin prints as zero while the profit is negative.
  const thin = roundedArbitrageAllocation(pair(1e-7, 3.0), 1000);
  assert.equal(thin.roundingRisk, true);
  assert.equal(thin.marginPercent, 0, 'the theoretical edge rounds to nothing');
  assert.equal(thin.guaranteedProfit, -0.01, 'while the rounded split loses a cent');
});

test('roundedArbitrageAllocation folds residual cent into the largest stake (lowest odds), not index 0', () => {
  const out = roundedArbitrageAllocation([
    { sourceId: 'underdog_1', odds: 4.6 },
    { sourceId: 'underdog_2', odds: 4.3 },
    { sourceId: 'favorite', odds: 2.1 },
  ], 1000);
  const sum = out.legs.reduce((acc, l) => acc + l.stake, 0);
  assert.equal(Math.round(sum * 100) / 100, 1000);
  const maxStakeLeg = out.legs.reduce((max, l) => (l.stake > max.stake ? l : max), out.legs[0]);
  assert.equal(maxStakeLeg.sourceId, 'favorite');
});
