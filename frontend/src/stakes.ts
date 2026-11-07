import type { StakeCalculation } from './domain';

export type RoundingMode = 'raw' | 'five' | 'ten' | 'smart';
export type ProfitDistribution = 'equal' | 'target';
export type SurebetFormula = 'standard' | 'dnb_home_x_away' | 'home_x_dnb_away';
export type CurrencyCode = 'RON' | 'EUR' | 'PLN' | 'USD' | 'GBP';

export const CURRENCY_CODES: readonly CurrencyCode[] = ['RON', 'EUR', 'PLN', 'USD', 'GBP'];

export const DEFAULT_FX_RATES: Record<CurrencyCode, number> = {
  RON: 1,
  EUR: 4.98,
  PLN: 1.15,
  USD: 4.58,
  GBP: 5.82,
};

const PL_BOOK_IDS = new Set([
  'superbet-pl',
  'admiralbet-pl',
  'totalbet-pl',
  'lvbet',
  'betfan',
  'sts',
  'fortuna-pl',
  'etoto',
  'fuksiarz',
  '5gringos',
]);

const EUR_BOOK_IDS = new Set(['betfair']);

export function defaultCurrencyForBook(bookmakerId?: string): CurrencyCode {
  const cleaned = (bookmakerId ?? '').trim().toLowerCase();
  if (PL_BOOK_IDS.has(cleaned) || cleaned.endsWith('-pl')) return 'PLN';
  if (EUR_BOOK_IDS.has(cleaned)) return 'EUR';
  return 'RON';
}

export function convertCurrency(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: Record<CurrencyCode, number> = DEFAULT_FX_RATES,
): number {
  if (!Number.isFinite(amount)) return 0;
  if (from === to) return amount;
  const fromRate = Number.isFinite(rates[from]) && rates[from] > 0 ? rates[from] : DEFAULT_FX_RATES[from];
  const toRate = Number.isFinite(rates[to]) && rates[to] > 0 ? rates[to] : DEFAULT_FX_RATES[to];
  return (amount * fromRate) / toRate;
}

export interface LockedLegCap {
  index: number;
  stake: number;
}

export interface StakeOptions {
  /** 'equal' splits profit equally across all outcomes; 'target' puts 100% of profit on targetLegIndex while other legs break even (0.00). */
  distribution?: ProfitDistribution;
  targetLegIndex?: number;
  /** SureBet.com-style per-leg 'D' (Distribute profit) checkboxes. Checked legs share profit equally; unchecked legs break even (0.00). */
  distributeLegs?: boolean[];
  /** Uniform turnover tax percentage (e.g. 12 for 12% Polish turnover tax) when legTaxPercents is not provided. */
  taxPercent?: number;
  /** Optional per-leg turnover tax percentage (e.g. [0, 12] when hedging an untaxed book against a .pl book). */
  legTaxPercents?: number[];
  /** Optional per-leg exchange net-winnings commission percentage (e.g. [0, 5] for 5% Betfair commission on net profit). */
  legCommissions?: number[];
  /** 3-way surebet settlement formula ('standard', 'dnb_home_x_away' = 1(0)-X-2, 'home_x_dnb_away' = 1-X-2(0)). */
  formula?: SurebetFormula;
  /** Base currency of bankroll / total stake. */
  baseCurrency?: CurrencyCode;
  /** Per-leg currency codes when multi-currency sizing is active. */
  legCurrencies?: CurrencyCode[];
  /** FX rates expressed in RON per 1 unit of currency. */
  fxRates?: Record<CurrencyCode, number>;
}

export function roundStake(value: number, mode: RoundingMode): number {
  if (mode === 'raw') return Math.round(value * 100) / 100;
  const unit = mode === 'five' ? 5 : mode === 'ten' ? 10 : 1;
  return Math.round(value / unit) * unit;
}

export function resolveNetOdds(odds: readonly number[], options?: StakeOptions): number[] {
  return odds.map((odd, idx) => {
    const rawTax = options?.legTaxPercents?.[idx] ?? options?.taxPercent ?? 0;
    const taxRate = Number.isFinite(rawTax) ? Math.min(Math.max(rawTax, 0), 99) / 100 : 0;
    const afterTax = odd * (1 - taxRate);
    const rawComm = options?.legCommissions?.[idx] ?? 0;
    const commRate = Number.isFinite(rawComm) ? Math.min(Math.max(rawComm, 0), 99) / 100 : 0;
    if (commRate <= 0) return afterTax;
    return 1 + (afterTax - 1) * (1 - commRate);
  });
}

function activeFormula(oddsCount: number, options?: StakeOptions): SurebetFormula {
  if (
    oddsCount === 3 &&
    (options?.formula === 'dnb_home_x_away' || options?.formula === 'home_x_dnb_away')
  ) {
    return options.formula;
  }
  return 'standard';
}

function stakesForTargetPayouts(
  payouts: readonly number[],
  netOdds: readonly number[],
  formula: SurebetFormula,
): number[] {
  if (formula === 'dnb_home_x_away' && payouts.length === 3) {
    const s0 = payouts[0] / netOdds[0];
    const s1 = (payouts[1] - s0) / netOdds[1];
    const s2 = payouts[2] / netOdds[2];
    return [s0, s1, s2];
  }
  if (formula === 'home_x_dnb_away' && payouts.length === 3) {
    const s0 = payouts[0] / netOdds[0];
    const s2 = payouts[2] / netOdds[2];
    const s1 = (payouts[1] - s2) / netOdds[1];
    return [s0, s1, s2];
  }
  return payouts.map((p, idx) => p / netOdds[idx]);
}

function returnsForStakes(
  stakes: readonly number[],
  netOdds: readonly number[],
  formula: SurebetFormula,
): number[] {
  if (formula === 'dnb_home_x_away' && stakes.length === 3) {
    return [
      stakes[0] * netOdds[0],
      stakes[1] * netOdds[1] + stakes[0],
      stakes[2] * netOdds[2],
    ];
  }
  if (formula === 'home_x_dnb_away' && stakes.length === 3) {
    return [
      stakes[0] * netOdds[0],
      stakes[1] * netOdds[1] + stakes[2],
      stakes[2] * netOdds[2],
    ];
  }
  return stakes.map((stake, idx) => stake * netOdds[idx]);
}

function resolveDistributeMask(oddsCount: number, options?: StakeOptions): boolean[] {
  if (Array.isArray(options?.distributeLegs) && options.distributeLegs.length === oddsCount) {
    const mask = options.distributeLegs.map(Boolean);
    if (mask.some(Boolean)) return mask;
    return new Array(oddsCount).fill(true);
  }
  const targetIdx = options?.targetLegIndex ?? 0;
  if (
    options?.distribution === 'target' &&
    oddsCount >= 2 &&
    targetIdx >= 0 &&
    targetIdx < oddsCount
  ) {
    return Array.from({ length: oddsCount }, (_, i) => i === targetIdx);
  }
  return new Array(oddsCount).fill(true);
}

/**
 * Computes unit stake fractions sigma_k = s_k / B for B = 1, handling Equal Dutch,
 * single-leg target, arbitrary 'D' checkbox subsets, and 3-way DNB push formulas.
 */
function solveUnitStakeShares(
  netOdds: readonly number[],
  options?: StakeOptions,
  allowNegativeHoldTarget = false,
): { shares: number[]; mask: boolean[]; isSubset: boolean } {
  const n = netOdds.length;
  const formula = activeFormula(n, options);
  const equalUnit = stakesForTargetPayouts(new Array(n).fill(1), netOdds, formula);
  const equalInv = equalUnit.reduce((sum, v) => sum + v, 0);
  const equalShares = equalInv > 0 ? equalUnit.map((v) => v / equalInv) : new Array(n).fill(0);

  const mask = resolveDistributeMask(n, options);
  const checkedCount = mask.filter(Boolean).length;
  if (checkedCount === 0 || checkedCount === n) {
    return { shares: equalShares, mask: new Array(n).fill(true), isSubset: false };
  }

  // Only fall back on negative hold when legacy distribution === 'target' is used without explicit distributeLegs,
  // unless allowNegativeHoldTarget is requested (e.g. bankrollFromLockedLeg).
  const hasExplicitMask = Array.isArray(options?.distributeLegs) && options.distributeLegs.length === n;
  if (!hasExplicitMask && !allowNegativeHoldTarget && equalInv >= 1) {
    return { shares: equalShares, mask: new Array(n).fill(true), isSubset: false };
  }

  const hedgeVec = mask.map((d) => (d ? 0 : 1));
  const distVec = mask.map((d) => (d ? 1 : 0));
  const hedgeStakes = stakesForTargetPayouts(hedgeVec, netOdds, formula);
  const distStakes = stakesForTargetPayouts(distVec, netOdds, formula);
  const a = hedgeStakes.reduce((sum, v) => sum + v, 0);
  const c = distStakes.reduce((sum, v) => sum + v, 0);

  if (a >= 0.98 || c <= 0) {
    return { shares: equalShares, mask: new Array(n).fill(true), isSubset: false };
  }

  const rD = (1 - a) / c;
  const payouts = mask.map((d) => (d ? rD : 1));
  const shares = stakesForTargetPayouts(payouts, netOdds, formula);
  if (shares.some((s) => !Number.isFinite(s) || s <= 0)) {
    return { shares: equalShares, mask: new Array(n).fill(true), isSubset: false };
  }
  return { shares, mask, isSubset: true };
}

/**
 * Guaranteed ROI margin in percent for a multi-way set of decimal odds.
 * Positive means a surebet (effective inverse sum < 1); negative is bookmaker hold.
 */
export function impliedMarginPercent(odds: readonly number[], options?: StakeOptions): number | null {
  if (odds.length < 2 || odds.some((odd) => !Number.isFinite(odd) || odd <= 1)) return null;
  const netOdds = resolveNetOdds(odds, options);
  if (netOdds.some((odd) => !Number.isFinite(odd) || odd <= 1)) return null;
  const formula = activeFormula(netOdds.length, options);
  const unit = stakesForTargetPayouts(new Array(netOdds.length).fill(1), netOdds, formula);
  if (unit.some((s) => !Number.isFinite(s) || s <= 0)) return null;
  const inverse = unit.reduce((sum, s) => sum + s, 0);
  if (inverse <= 0) return null;
  return (1 / inverse - 1) * 100;
}

/**
 * Fractional Kelly stake for a single +EV leg given decimal odds and consensus win probability.
 * Full Kelly fraction f* = (b*p - q) / b, scaled by `fraction` (e.g. 0.25, 0.5, 1).
 */
export function kellyStake(
  odds: number,
  winProbability: number,
  bankroll: number,
  fraction = 0.25,
): number {
  if (
    !Number.isFinite(odds) ||
    odds <= 1 ||
    !Number.isFinite(winProbability) ||
    winProbability <= 0 ||
    winProbability >= 1 ||
    !Number.isFinite(bankroll) ||
    bankroll <= 0 ||
    !Number.isFinite(fraction) ||
    fraction <= 0
  ) {
    return 0;
  }
  const b = odds - 1;
  const edge = b * winProbability - (1 - winProbability);
  if (edge <= 0) return 0;
  const fullKelly = Math.min(1, edge / b);
  return Math.max(0, Math.round(bankroll * fullKelly * fraction * 100) / 100);
}

/**
 * Total balanced bankroll (in baseCurrency) required when one leg is capped/locked to a specific stake
 * (expressed in that leg's local currency if legCurrencies is provided, otherwise baseCurrency).
 */
export function bankrollFromLockedLeg(
  odds: readonly number[],
  legIndex: number,
  legStake: number,
  options?: StakeOptions,
): number {
  if (
    !odds.length ||
    legIndex < 0 ||
    legIndex >= odds.length ||
    !Number.isFinite(legStake) ||
    legStake <= 0 ||
    odds.some((odd) => !Number.isFinite(odd) || odd <= 1)
  ) {
    return 0;
  }
  const netOdds = resolveNetOdds(odds, options);
  if (netOdds.some((odd) => !Number.isFinite(odd) || odd <= 1)) return 0;

  const baseCurr = options?.baseCurrency ?? 'RON';
  const legCurr = options?.legCurrencies?.[legIndex] ?? baseCurr;
  const rates = options?.fxRates ?? DEFAULT_FX_RATES;
  const legStakeBase = convertCurrency(legStake, legCurr, baseCurr, rates);

  const { shares } = solveUnitStakeShares(netOdds, options, true);
  const share = shares[legIndex] ?? 0;
  if (share <= 0) return 0;
  return Math.round((legStakeBase / share) * 100) / 100;
}

export function calculateStakes(
  odds: number[],
  bankroll: number,
  mode: RoundingMode,
  lockedLeg?: LockedLegCap | null,
  options?: StakeOptions,
): StakeCalculation {
  const hasValidLock =
    lockedLeg != null &&
    lockedLeg.index >= 0 &&
    lockedLeg.index < odds.length &&
    Number.isFinite(lockedLeg.stake) &&
    lockedLeg.stake > 0;

  const effectiveBankroll = hasValidLock
    ? bankrollFromLockedLeg(odds, lockedLeg.index, lockedLeg.stake, options)
    : bankroll;

  const netOdds = resolveNetOdds(odds, options);
  if (
    !odds.length ||
    effectiveBankroll <= 0 ||
    odds.some((odd) => !Number.isFinite(odd) || odd <= 1) ||
    netOdds.some((odd) => !Number.isFinite(odd) || odd <= 1)
  ) {
    return {
      legStakes: odds.map(() => 0),
      roundedStakes: odds.map(() => 0),
      localStakes: odds.map(() => 0),
      totalStakedBase: 0,
      individualReturns: odds.map(() => 0),
      legProfits: odds.map(() => 0),
      effectiveNetOdds: odds.map(() => 0),
      worstCaseProfit: 0,
      worstCaseRoi: 0,
      isRounded: mode !== 'raw',
    };
  }

  const formula = activeFormula(netOdds.length, options);
  const baseCurr = options?.baseCurrency ?? 'RON';
  const rates = options?.fxRates ?? DEFAULT_FX_RATES;
  const hasMultiCurrency = Boolean(
    options?.legCurrencies &&
      options.legCurrencies.length === odds.length &&
      options.legCurrencies.some((c) => c !== baseCurr),
  );

  const { shares, mask, isSubset } = solveUnitStakeShares(netOdds, options, false);
  const legStakes = shares.map((share) => effectiveBankroll * share);

  let roundedStakes: number[];
  let localStakes: number[];

  if (!hasMultiCurrency) {
    const checkedIndices = mask.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
    if (isSubset && checkedIndices.length === 1 && formula === 'standard' && mode === 'raw' && !hasValidLock) {
      // Round hedge legs up to the nearest cent so break-even legs never dip to -0.01
      const targetIdx = checkedIndices[0];
      const preliminary = legStakes.map((stake, idx) =>
        idx === targetIdx ? 0 : Math.ceil((stake - 1e-9) * 100) / 100,
      );
      const otherSum = preliminary.reduce((sum, s) => sum + s, 0);
      preliminary[targetIdx] = Math.max(0, Math.round((effectiveBankroll - otherSum) * 100) / 100);
      roundedStakes = preliminary;
    } else {
      roundedStakes = legStakes.map((stake, idx) =>
        hasValidLock && idx === lockedLeg.index
          ? Math.round(lockedLeg.stake * 100) / 100
          : roundStake(stake, mode),
      );
    }
    localStakes = [...roundedStakes];
  } else {
    localStakes = legStakes.map((baseStake, idx) => {
      const curr = options?.legCurrencies?.[idx] ?? baseCurr;
      if (hasValidLock && idx === lockedLeg.index) {
        return Math.round(lockedLeg.stake * 100) / 100;
      }
      const rawLocal = convertCurrency(baseStake, baseCurr, curr, rates);
      return roundStake(rawLocal, mode);
    });
    roundedStakes = localStakes.map((localStake, idx) => {
      const curr = options?.legCurrencies?.[idx] ?? baseCurr;
      return Math.round(convertCurrency(localStake, curr, baseCurr, rates) * 100) / 100;
    });
  }

  const rawReturns = returnsForStakes(roundedStakes, netOdds, formula);
  const individualReturns = rawReturns.map((ret) => Math.round(ret * 100) / 100);
  const totalStaked = Math.round(roundedStakes.reduce((sum, stake) => sum + stake, 0) * 100) / 100;
  const legProfits = individualReturns.map(
    (ret) => Math.round((ret - totalStaked) * 100) / 100,
  );
  const worstCaseReturn = Math.min(...individualReturns);
  const worstCaseProfit = Math.round((worstCaseReturn - totalStaked) * 100) / 100;
  const roiDenominator =
    hasValidLock || mode !== 'raw' || hasMultiCurrency
      ? totalStaked > 0
        ? totalStaked
        : effectiveBankroll
      : effectiveBankroll;

  return {
    legStakes,
    roundedStakes,
    localStakes,
    totalStakedBase: totalStaked,
    individualReturns,
    legProfits,
    effectiveNetOdds: netOdds.map((odd) => Math.round(odd * 10000) / 10000),
    worstCaseProfit,
    worstCaseRoi: roiDenominator > 0 ? (worstCaseProfit / roiDenominator) * 100 : 0,
    isRounded: mode !== 'raw',
  };
}
