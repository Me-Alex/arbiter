import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bankrollFromLockedLeg,
  calculateStakes,
  impliedMarginPercent,
  kellyStake,
} from '../frontend/src/stakes.ts';
import { buildScanExportUrl, canonicalizeRawMarketLabel } from '../frontend/src/api.ts';
import { localizeMarketLabel } from '../frontend/src/labels.ts';

test('calculateStakes supports asymmetric target-biased distribution with break-even hedge legs', () => {
  const equal = calculateStakes([2.1, 2.05], 1000, 'raw');
  assert.ok(equal.worstCaseProfit > 37 && equal.worstCaseProfit < 38);

  const target0 = calculateStakes([2.1, 2.05], 1000, 'raw', null, {
    distribution: 'target',
    targetLegIndex: 0,
  });
  const totalStaked = target0.roundedStakes[0] + target0.roundedStakes[1];
  assert.equal(Math.round(totalStaked * 100) / 100, 1000);
  // Target leg 0 captures ~2x the Dutch profit while hedge leg 1 never loses money (>= 0.00)
  assert.ok((target0.legProfits?.[0] ?? 0) > 74);
  assert.ok((target0.legProfits?.[1] ?? -1) >= 0);
  assert.ok(target0.worstCaseProfit >= 0);
});

test('calculateStakes and impliedMarginPercent model uniform and per-leg Polish 12% turnover tax', () => {
  // Gross surebet: 2.15 vs 2.15 (+7.5% gross), but if leg 1 has 12% PL tax -> net odd = 1.892
  const grossMargin = impliedMarginPercent([2.15, 2.15]);
  assert.ok(grossMargin !== null && grossMargin > 7);

  const crossBorderMargin = impliedMarginPercent([2.15, 2.15], { legTaxPercents: [0, 12] });
  assert.ok(crossBorderMargin !== null && crossBorderMargin > 0.5 && crossBorderMargin < 1.5);

  const bothPlMargin = impliedMarginPercent([2.15, 2.15], { taxPercent: 12 });
  assert.ok(bothPlMargin !== null && bothPlMargin < 0, '12% tax on both legs flips a 7.5% arb negative');

  const taxedStakes = calculateStakes([2.15, 2.15], 1000, 'raw', null, {
    legTaxPercents: [0, 12],
  });
  assert.equal(taxedStakes.effectiveNetOdds?.[0], 2.15);
  assert.equal(taxedStakes.effectiveNetOdds?.[1], 1.892);
  assert.ok(taxedStakes.worstCaseProfit > 5, 'cross-border hedge remains net profitable after 12% tax on leg 2');
});

test('bankrollFromLockedLeg scales total stake accurately under target distribution and tax', () => {
  const opts = { distribution: 'target', targetLegIndex: 0, legTaxPercents: [0, 12] };
  const total = bankrollFromLockedLeg([2.25, 2.15], 1, 500, opts);
  // Leg 1 net odd = 2.15 * 0.88 = 1.892; break-even return on leg 1 requires B = 500 * 1.892 = 946
  assert.equal(total, 946);
  const calc = calculateStakes([2.25, 2.15], total, 'raw', { index: 1, stake: 500 }, opts);
  assert.equal(calc.roundedStakes[1], 500);
  assert.ok(calc.worstCaseProfit >= 0);
});

test('kellyStake computes fractional Kelly stakes and clamps negative edges to zero', () => {
  // Odds 2.20, winProb 0.50 -> b = 1.20, edge = 0.10, Full Kelly = 0.10 / 1.20 = 8.3333% -> 83.33 on 1000
  assert.equal(kellyStake(2.2, 0.5, 1000, 1), 83.33);
  assert.equal(kellyStake(2.2, 0.5, 1000, 0.5), 41.67);
  assert.equal(kellyStake(2.2, 0.5, 1000, 0.25), 20.83);
  assert.equal(kellyStake(1.9, 0.5, 1000, 0.25), 0, 'negative EV yields zero stake');
});

test('buildScanExportUrl maps React signal types to backend CSV family names', () => {
  assert.equal(buildScanExportUrl({ type: 'surebet' }), '/api/scan/export.csv?type=opportunities');
  assert.equal(buildScanExportUrl({ type: 'middle' }), '/api/scan/export.csv?type=middles');
  assert.equal(buildScanExportUrl({ type: 'positive_ev' }), '/api/scan/export.csv?type=positiveEv');
  assert.equal(buildScanExportUrl({ type: 'low_hold' }), '/api/scan/export.csv?type=lowHold');
  assert.equal(buildScanExportUrl({ type: 'all' }), '/api/scan/export.csv');
});

test('localizeMarketLabel and canonicalizeRawMarketLabel unify provider market codes and sub-periods', () => {
  const tr = (k) => `<${k}>`;
  assert.equal(localizeMarketLabel('Corners 3.5 · HALF1', tr), '<marketTotalCorners> 3.5 · <appPeriodFirstHalf>');
  assert.equal(localizeMarketLabel('Total Goals 1.5 · HALF2', tr), '<marketTotalGoals> 1.5 · <appPeriodSecondHalf>');
  assert.equal(localizeMarketLabel('Match Result · FULLTIME_OT', tr), '<marketMatchResult> · <appPeriodFullTimeOt>');
  assert.equal(localizeMarketLabel('Set Winner · SET1', tr), '<marketSetWinner> · <appPeriodSet1>');
  assert.equal(localizeMarketLabel('Total Points 54.5 · Q1', tr), '<marketTotalPoints> 54.5 · Q1');

  assert.equal(canonicalizeRawMarketLabel('MRES', 'MRES'), 'Match Result');
  assert.equal(canonicalizeRawMarketLabel('547', 'Final'), 'Match Result');
  assert.equal(canonicalizeRawMarketLabel('ufo:mtyp:00-00', 'ufo:mtyp:00-00'), 'Match Result');
});

test('calculateStakes supports SureBet.com per-leg D checkboxes, exchange commissions, multi-currency FX, and 3-way DNB formulas', () => {
  // 1. 3-way with D checked on Home & Away, Draw unchecked (Draw breaks even at ~0.00, profit split equally on 1 & 2)
  const multiD = calculateStakes([2.6, 3.6, 3.1], 1000, 'raw', null, {
    distributeLegs: [true, false, true],
  });
  assert.ok(Math.abs((multiD.legProfits?.[1] ?? 99) - 0) <= 0.05, 'Draw breaks even');
  assert.ok((multiD.legProfits?.[0] ?? 0) > 15 && (multiD.legProfits?.[2] ?? 0) > 15);
  assert.ok(Math.abs((multiD.legProfits?.[0] ?? 0) - (multiD.legProfits?.[2] ?? 0)) <= 0.05);

  // 2. Exchange commission (5% on net winnings, NOT gross turnover)
  const comm = calculateStakes([2.1, 3.0], 1000, 'raw', null, {
    legCommissions: [0, 5],
  });
  // Net odd on 3.00 with 5% commission = 1 + 2.00 * 0.95 = 2.90
  assert.equal(comm.effectiveNetOdds?.[1], 2.9);

  // 3. 3-way push-hedged formula 1(0) - X - 2: Home DNB @ 1.80, Draw @ 3.60, Away @ 3.50
  const dnbMargin = impliedMarginPercent([1.8, 3.6, 3.5], { formula: 'dnb_home_x_away' });
  assert.ok(dnbMargin !== null && dnbMargin > 3.5, '1(0)-X-2 captures push refund on Draw as +3.65% surebet');
  const dnbStakes = calculateStakes([1.8, 3.6, 3.5], 1000, 'raw', null, {
    formula: 'dnb_home_x_away',
  });
  assert.ok(dnbStakes.worstCaseProfit > 36);
  assert.ok((dnbStakes.legProfits ?? []).every((p) => p > 36));

  // 4. Multi-currency FX conversion + 4-way support
  const multiCurr = calculateStakes([2.2, 2.2], 1000, 'smart', null, {
    baseCurrency: 'RON',
    legCurrencies: ['RON', 'EUR'],
    fxRates: { RON: 1, EUR: 5.0, PLN: 1.15, USD: 4.5, GBP: 5.8 },
  });
  // ~500 RON on leg 0, ~500 RON = 100 EUR on leg 1
  assert.equal(multiCurr.localStakes?.[0], 500);
  assert.equal(multiCurr.localStakes?.[1], 100);
  assert.ok(multiCurr.worstCaseProfit > 95);

  const fourWay = calculateStakes([4.2, 4.2, 4.2, 4.2], 1000, 'raw');
  assert.equal(fourWay.roundedStakes.length, 4);
  assert.ok(fourWay.worstCaseProfit > 49);
});
