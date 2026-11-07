import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  BookmarkPlus,
  Calculator,
  Check,
  CheckSquare,
  ChevronRight,
  Copy,
  ExternalLink,
  Layers,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Unlock,
  X,
} from 'lucide-react';
import type { ArbitrageOpportunity } from './domain';
import { bookmakerColor } from './domain';
import { addTrackedBet, runVerification } from './api';
import { slipSummary } from './claims';
import {
  copyTextWithFeedback,
  formatMoney,
  formatNum,
  formatPercent,
  formatTime,
  useNavigableUrlGate,
} from './format';
import { t, tf } from './i18n';
import { localizeMarketLabel } from './labels';
import {
  convertFromSide,
  parseToDecimal,
  type ConvertedOddsSide,
  type OddsFormat,
} from './odds-format';
import { localizeRuleReason } from './reasons';
import {
  CURRENCY_CODES,
  bankrollFromLockedLeg,
  calculateStakes,
  defaultCurrencyForBook,
  impliedMarginPercent,
  kellyStake,
  type CurrencyCode,
  type LockedLegCap,
  type RoundingMode,
  type StakeOptions,
  type SurebetFormula,
} from './stakes';
import { useFeedStore, usePreferencesStore, type SlipTab } from './stores';
import { calculateStakesAsync } from './worker-client';

const POLISH_TAX_BOOKS = new Set([
  'superbet-pl',
  'admiralbet-pl',
  'lvbet',
  'betfan',
  'totalbet-pl',
  'sts',
  'fortuna-pl',
  'etoto',
  'fuksiarz',
  'forbet',
  'betclic-pl',
  'pzbuk',
  'goplusbet',
  'betcris-pl',
  'comeon-pl',
]);

type TaxPreset = '0' | '2' | '5' | '12_pl';
type ConverterField = keyof ConvertedOddsSide;

const CONVERTER_ROWS: [ConverterField, string][] = [
  ['decimal', 'appOddsDecimal'],
  ['american', 'appOddsAmerican'],
  ['fractional', 'appOddsFractional'],
  ['hongkong', 'appOddsHongKong'],
  ['malay', 'appOddsMalay'],
  ['probability', 'appOddsProbability'],
];

function extractLegLine(text: string): number | null {
  const m = text.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function describeMiddleWindow(opp: ArbitrageOpportunity): string | null {
  if (opp.type !== 'middle' || opp.legs.length < 2) return null;
  const l0 = extractLegLine(opp.legs[0].selection) ?? extractLegLine(opp.legs[0].marketName);
  const l1 = extractLegLine(opp.legs[1].selection) ?? extractLegLine(opp.legs[1].marketName);
  if (l0 == null || l1 == null) {
    return opp.gap != null ? `Δ ${opp.gap}` : null;
  }
  const low = Math.min(Math.abs(l0), Math.abs(l1));
  const high = Math.max(Math.abs(l0), Math.abs(l1));
  if (high <= low) return `${low}`;
  const minInt = Math.floor(low) + 1;
  const maxInt = Math.ceil(high) - 1;
  if (minInt <= maxInt) {
    return minInt === maxInt ? `${minInt}` : `${minInt}–${maxInt}`;
  }
  return `${low} – ${high}`;
}

function isDnbOrLevelMarket(opp: ArbitrageOpportunity): boolean {
  const mk = (opp.marketKey ?? '').toUpperCase();
  const mn = opp.marketName.toUpperCase();
  if (mk === 'DNB' || mk === 'DRAW_NO_BET' || mk === 'SYNTHETIC_DNB_AH0') return true;
  if (mn.includes('DRAW NO BET')) return true;
  if (mn.includes('ASIAN HANDICAP 0') && !mn.includes('0.5') && !mn.includes('0.25') && !mn.includes('0.75')) {
    return true;
  }
  return false;
}

function familyWord(type: string) {
  return t(type === 'positive_ev' ? 'positiveEv' : type === 'middle' ? 'middleChip' : 'surebet');
}

function formatWithCurr(amount: number, curr: CurrencyCode): string {
  if (curr === 'RON') return formatMoney(amount);
  return `${formatNum(amount, 2)} ${curr}`;
}

export function ExecutionSlip({
  opportunity,
  onClose,
  onCompareOdds,
  onOpenTracker,
}: {
  opportunity: ArbitrageOpportunity | null;
  onClose: () => void;
  onCompareOdds: (opp: ArbitrageOpportunity) => void;
  onOpenTracker: () => void;
}) {
  const defaultBankroll = usePreferencesStore((s) => s.defaultBankroll);
  const defaultRounding = usePreferencesStore((s) => s.defaultRounding);
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  const fxRates = usePreferencesStore((s) => s.fxRates);
  const slipTabRequest = usePreferencesStore((s) => s.slipTabRequest);
  const notify = useFeedStore((s) => s.notify);
  const refresh = useFeedStore((s) => s.refresh);
  const verifyingGlobal = useFeedStore((s) => s.verifying);
  const setVerifyingGlobal = useFeedStore((s) => s.setVerifying);

  const [calcTab, setCalcTab] = useState<SlipTab>('signal');
  const [calcLegsCount, setCalcLegsCount] = useState<2 | 3 | 4>(2);
  const [calcOdds, setCalcOdds] = useState<[string, string, string, string]>(['2.10', '2.05', '3.40', '4.20']);
  const [calcFormula, setCalcFormula] = useState<SurebetFormula>('standard');
  const [calcDistMask, setCalcDistMask] = useState<[boolean, boolean, boolean, boolean]>([true, true, true, true]);
  const [calcLockedLeg, setCalcLockedLeg] = useState<LockedLegCap | null>(null);
  const [calcCommissions, setCalcCommissions] = useState<[number, number, number, number]>([0, 0, 0, 0]);
  const [calcCurrencies, setCalcCurrencies] = useState<[CurrencyCode, CurrencyCode, CurrencyCode, CurrencyCode]>([
    'RON',
    'RON',
    'RON',
    'RON',
  ]);

  const [bankroll, setBankroll] = useState(defaultBankroll);
  const [mode, setMode] = useState<RoundingMode>(defaultRounding);
  const [customOdds, setCustomOdds] = useState<Record<number, number>>({});
  const [lockedLeg, setLockedLeg] = useState<LockedLegCap | null>(null);
  const [placedLegs, setPlacedLegs] = useState<Set<number>>(new Set());
  const [distributeMask, setDistributeMask] = useState<boolean[]>([true, true, true]);
  const [taxPreset, setTaxPreset] = useState<TaxPreset>('0');
  const [showCommissions, setShowCommissions] = useState(false);
  const [legCommissions, setLegCommissions] = useState<number[]>([0, 0, 0]);
  const [showMultiCurrency, setShowMultiCurrency] = useState(false);
  const [legCurrencies, setLegCurrencies] = useState<CurrencyCode[]>(['RON', 'RON', 'RON']);

  // Converter state
  const [convBaseBackDecimal, setConvBaseBackDecimal] = useState<number>(2.1);
  const [convEditing, setConvEditing] = useState<{
    side: 'back' | 'lay';
    field: ConverterField;
    raw: string;
  } | null>(null);

  const [result, setResult] = useState<Awaited<ReturnType<typeof calculateStakesAsync>> | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [savingBet, setSavingBet] = useState(false);
  const [savedPositionId, setSavedPositionId] = useState<string | null>(null);
  const isNavigable = useNavigableUrlGate();

  useEffect(() => {
    setBankroll(defaultBankroll);
  }, [defaultBankroll]);

  useEffect(() => {
    setMode(defaultRounding);
  }, [defaultRounding]);

  useEffect(() => {
    if (slipTabRequest) {
      setCalcTab(slipTabRequest.tab);
    }
  }, [slipTabRequest]);

  useEffect(() => {
    setCustomOdds({});
    setLockedLeg(null);
    setPlacedLegs(new Set());
    const legCount = opportunity?.legs.length ?? 2;
    setDistributeMask(new Array(legCount).fill(true));
    setTaxPreset('0');
    setLegCommissions(
      opportunity
        ? opportunity.legs.map((leg) => (leg.bookmakerId.toLowerCase() === 'betfair' ? 5 : 0))
        : [0, 0, 0],
    );
    setLegCurrencies(
      opportunity
        ? opportunity.legs.map((leg) => defaultCurrencyForBook(leg.bookmakerId))
        : [baseCurrency, baseCurrency, baseCurrency],
    );
    if (opportunity) {
      setCalcTab('signal');
      const firstOdd = opportunity.legs[0]?.rawOdds;
      if (firstOdd && firstOdd > 1.01) {
        setConvBaseBackDecimal(firstOdd);
        setConvEditing(null);
      }
    }
  }, [opportunity?.id, baseCurrency]);

  const hasPlBook = useMemo(
    () => Boolean(opportunity?.legs.some((leg) => POLISH_TAX_BOOKS.has(leg.bookmakerId.toLowerCase()))),
    [opportunity],
  );

  const targetSummary = useMemo<'equal' | number | 'custom'>(() => {
    if (!distributeMask.length || distributeMask.every(Boolean) || !distributeMask.some(Boolean)) {
      return 'equal';
    }
    const checked = distributeMask.map((v, idx) => (v ? idx : -1)).filter((i) => i >= 0);
    if (checked.length === 1) return checked[0];
    return 'custom';
  }, [distributeMask]);

  const stakeOptions = useMemo<StakeOptions>(() => {
    const opts: StakeOptions = {
      distributeLegs: distributeMask,
      baseCurrency,
      fxRates,
    };
    if (targetSummary === 'equal') {
      opts.distribution = 'equal';
    } else if (typeof targetSummary === 'number') {
      opts.distribution = 'target';
      opts.targetLegIndex = targetSummary;
    }
    if (taxPreset === '2') {
      opts.taxPercent = 2;
    } else if (taxPreset === '5') {
      opts.taxPercent = 5;
    } else if (taxPreset === '12_pl') {
      if (opportunity && hasPlBook) {
        opts.legTaxPercents = opportunity.legs.map((leg) =>
          POLISH_TAX_BOOKS.has(leg.bookmakerId.toLowerCase()) ? 12 : 0,
        );
      } else {
        opts.taxPercent = 12;
      }
    }
    if (showCommissions) {
      opts.legCommissions = legCommissions;
    }
    if (showMultiCurrency) {
      opts.legCurrencies = legCurrencies;
    }
    return opts;
  }, [
    distributeMask,
    targetSummary,
    taxPreset,
    opportunity,
    hasPlBook,
    showCommissions,
    legCommissions,
    showMultiCurrency,
    legCurrencies,
    baseCurrency,
    fxRates,
  ]);

  const effectiveLegOdds = useMemo(
    () =>
      opportunity
        ? opportunity.legs.map((leg, idx) => customOdds[idx] ?? leg.effectiveOdds)
        : [],
    [opportunity, customOdds],
  );

  const hasCustomOdds = Object.keys(customOdds).length > 0;

  useEffect(() => {
    let active = true;
    if (!opportunity) {
      setResult(null);
      return () => {
        active = false;
      };
    }
    void calculateStakesAsync(
      effectiveLegOdds,
      Math.max(0, bankroll),
      mode,
      lockedLeg,
      stakeOptions,
    ).then((value) => {
      if (active) setResult(value);
    });
    return () => {
      active = false;
    };
  }, [opportunity, effectiveLegOdds, bankroll, mode, lockedLeg, stakeOptions]);

  const standaloneNumbers = useMemo(() => {
    const activeOdds = calcOdds
      .slice(0, calcLegsCount)
      .map((val) => Number(val) || 0);
    const calcOpts: StakeOptions = {
      distributeLegs: calcDistMask.slice(0, calcLegsCount),
      formula: calcLegsCount === 3 ? calcFormula : 'standard',
      baseCurrency,
      fxRates,
    };
    if (taxPreset === '2') calcOpts.taxPercent = 2;
    else if (taxPreset === '5') calcOpts.taxPercent = 5;
    else if (taxPreset === '12_pl') calcOpts.taxPercent = 12;
    if (showCommissions) {
      calcOpts.legCommissions = calcCommissions.slice(0, calcLegsCount);
    }
    if (showMultiCurrency) {
      calcOpts.legCurrencies = calcCurrencies.slice(0, calcLegsCount);
    }
    const calcResult = calculateStakes(
      activeOdds,
      Math.max(0, bankroll),
      mode,
      calcLockedLeg && calcLockedLeg.index < calcLegsCount ? calcLockedLeg : null,
      calcOpts,
    );
    const margin = impliedMarginPercent(activeOdds, calcOpts);
    return { activeOdds, calcOpts, calcResult, margin };
  }, [
    calcOdds,
    calcLegsCount,
    calcDistMask,
    calcFormula,
    calcLockedLeg,
    bankroll,
    mode,
    taxPreset,
    showCommissions,
    calcCommissions,
    showMultiCurrency,
    calcCurrencies,
    baseCurrency,
    fxRates,
  ]);

  const convertedOdds = useMemo(
    () => convertFromSide(convBaseBackDecimal, 'back'),
    [convBaseBackDecimal],
  );

  const renderSlipTabs = () => (
    <div className="slip-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={calcTab === 'signal'}
        className={`chip sm ${calcTab === 'signal' ? 'active' : ''}`}
        onClick={() => setCalcTab('signal')}
      >
        {t('appSignalModeBtn')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={calcTab === 'calculator'}
        className={`chip sm ${calcTab === 'calculator' ? 'active' : ''}`}
        onClick={() => setCalcTab('calculator')}
      >
        <Calculator size={12} /> {t('appCalcModeBtn')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={calcTab === 'converter'}
        className={`chip sm ${calcTab === 'converter' ? 'active' : ''}`}
        onClick={() => setCalcTab('converter')}
      >
        <ArrowLeftRight size={12} /> {t('appConverterTab')}
      </button>
    </div>
  );

  if (calcTab === 'converter') {
    const handleConverterInput = (side: 'back' | 'lay', field: ConverterField, raw: string) => {
      setConvEditing({ side, field, raw });
      const parsed = parseToDecimal(raw, field === 'probability' ? 'probability' : (field as OddsFormat));
      if (parsed != null && parsed > 1.0001) {
        const updated = convertFromSide(parsed, side);
        setConvBaseBackDecimal(updated.backDecimal);
      }
    };

    return (
      <aside className="execution" id="execution-slip">
        <div className="slip-header">
          <div>
            <div className="eyebrow">{t('appExecutionSlip')}</div>
            <div className="slip-title">{t('appConverterTitle')}</div>
          </div>
          <button className="close" onClick={onClose} aria-label={t('appCloseSlip')}>
            <X size={18} />
          </button>
        </div>

        {renderSlipTabs()}

        <div className="panel" style={{ padding: 14 }}>
          <div className="subtle" style={{ marginBottom: 12 }}>
            {t('appConverterExplainer')}
          </div>

          <div className="converter-grid">
            <div className="converter-head">
              <span />
              <strong>{t('appOddsBack')}</strong>
              <strong>{t('appOddsLay')}</strong>
            </div>
            {CONVERTER_ROWS.map(([field, labelKey]) => {
              const backVal =
                convEditing?.side === 'back' && convEditing.field === field
                  ? convEditing.raw
                  : convertedOdds.back[field];
              const layVal =
                convEditing?.side === 'lay' && convEditing.field === field
                  ? convEditing.raw
                  : convertedOdds.lay[field];
              return (
                <div className="converter-row" key={field}>
                  <label className="subtle">{t(labelKey)}</label>
                  <input
                    type="text"
                    className="select sm-select num"
                    aria-label={`${t('appOddsBack')} ${t(labelKey)}`}
                    value={backVal}
                    onFocus={() => setConvEditing({ side: 'back', field, raw: convertedOdds.back[field] })}
                    onBlur={() => setConvEditing(null)}
                    onChange={(e) => handleConverterInput('back', field, e.target.value)}
                  />
                  <input
                    type="text"
                    className="select sm-select num"
                    aria-label={`${t('appOddsLay')} ${t(labelKey)}`}
                    value={layVal}
                    onFocus={() => setConvEditing({ side: 'lay', field, raw: convertedOdds.lay[field] })}
                    onBlur={() => setConvEditing(null)}
                    onChange={(e) => handleConverterInput('lay', field, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    );
  }

  const showStandalone = calcTab === 'calculator' || !opportunity || !result;

  if (showStandalone) {
    const { activeOdds, calcOpts, calcResult, margin } = standaloneNumbers;
    const isArb = margin != null && margin > 0;
    const totalCalcStaked = calcResult.roundedStakes.reduce((sum, s) => sum + s, 0);

    const handleCopyStandalone = async () => {
      const lines = Array.from({ length: calcLegsCount }).map((_, idx) => {
        const curr = showMultiCurrency ? calcCurrencies[idx] : baseCurrency;
        const stakeShown = showMultiCurrency ? (calcResult.localStakes?.[idx] ?? 0) : (calcResult.roundedStakes[idx] ?? 0);
        return `${tf('appCalcOutcomeN', { n: String(idx + 1) })}: @ ${activeOdds[idx].toFixed(2)} — ${formatWithCurr(stakeShown, curr)} (${t('appReturns')} ${formatWithCurr(calcResult.individualReturns[idx] ?? 0, baseCurrency)})`;
      });
      lines.push(
        `${t('totalStake')}: ${formatWithCurr(totalCalcStaked, baseCurrency)} | ${t('appClaimWorstCase')}: ${calcResult.worstCaseProfit >= 0 ? '+' : ''}${formatWithCurr(calcResult.worstCaseProfit, baseCurrency)}`,
      );
      const ok = await copyTextWithFeedback(lines.join('\n'));
      if (ok) notify(t('appToastPositionCopied'), 'success');
    };

    return (
      <aside className="execution" id="execution-slip">
        <div className="slip-header">
          <div>
            <div className="eyebrow">{t('appExecutionSlip')}</div>
            <div className="slip-title">
              {opportunity ? t('appCalcTitle') : t('appSelectOpportunity')}
            </div>
          </div>
          {opportunity ? (
            <button className="close" onClick={onClose} aria-label={t('appCloseSlip')}>
              <X size={18} />
            </button>
          ) : (
            <Calculator size={19} color="#61718a" />
          )}
        </div>

        {renderSlipTabs()}

        {!opportunity && (
          <div className="slip-explainer" style={{ marginBottom: 12 }}>
            {t('appSlipEmpty')}
          </div>
        )}

        <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>{t('appCalcModeBtn')}</div>
          <div className="subtle" style={{ marginBottom: 10 }}>{t('appCalcExplainer')}</div>

          <div className="inline-actions" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            {([2, 3, 4] as const).map((cnt) => (
              <button
                key={`calc-cnt-${cnt}`}
                type="button"
                className={`chip sm ${calcLegsCount === cnt ? 'active' : ''}`}
                onClick={() => {
                  setCalcLegsCount(cnt);
                  if (calcLockedLeg && calcLockedLeg.index >= cnt) setCalcLockedLeg(null);
                }}
              >
                {cnt === 2 ? t('appCalcTwoWay') : cnt === 3 ? t('appCalcThreeWay') : t('appCalcFourWay')}
              </button>
            ))}
          </div>

          {calcLegsCount === 3 && (
            <div className="control-field" style={{ marginBottom: 10 }}>
              <label>{t('appSurebetFormulaLabel')}</label>
              <select
                className="select sm-select"
                aria-label={t('appSurebetFormulaLabel')}
                value={calcFormula}
                onChange={(e) => setCalcFormula(e.target.value as SurebetFormula)}
              >
                <option value="standard">{t('appFormulaStandard')}</option>
                <option value="dnb_home_x_away">{t('appFormulaDnbHome')}</option>
                <option value="home_x_dnb_away">{t('appFormulaDnbAway')}</option>
              </select>
            </div>
          )}

          <div className="inline-actions" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`chip sm ${showCommissions ? 'active' : ''}`}
              onClick={() => setShowCommissions((v) => !v)}
            >
              {t('appShowCommissionsBtn')}
            </button>
            <button
              type="button"
              className={`chip sm ${showMultiCurrency ? 'active' : ''}`}
              onClick={() => setShowMultiCurrency((v) => !v)}
            >
              {t('appMultiCurrencyBtn')}
            </button>
          </div>

          <div className="slip-legs" style={{ marginBottom: 10 }}>
            {Array.from({ length: calcLegsCount }).map((_, idx) => {
              const isLocked = calcLockedLeg?.index === idx;
              const curr = showMultiCurrency ? calcCurrencies[idx] : baseCurrency;
              const shownStake = showMultiCurrency
                ? (calcResult.localStakes?.[idx] ?? 0)
                : (calcResult.roundedStakes[idx] ?? 0);
              const legProfit = calcResult.legProfits?.[idx] ?? 0;

              return (
                <div className="leg-row" key={`calc-leg-${idx}`}>
                  <div style={{ minWidth: 0 }}>
                    <small style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{tf('appCalcOutcomeN', { n: String(idx + 1) })}</span>
                      <label className="df-badge" title={t('appDistributeCheckTitle')}>
                        <input
                          type="checkbox"
                          checked={calcDistMask[idx]}
                          onChange={(e) => {
                            const next = [...calcDistMask] as [boolean, boolean, boolean, boolean];
                            next[idx] = e.target.checked;
                            setCalcDistMask(next);
                          }}
                        />
                        <span>D</span>
                      </label>
                      <button
                        type="button"
                        className={`df-radio ${isLocked ? 'active' : ''}`}
                        title={t('appFixedStakeTitle')}
                        onClick={() => {
                          if (isLocked) {
                            setCalcLockedLeg(null);
                          } else {
                            const initStake = Math.max(10, Math.round((shownStake || 100) * 100) / 100);
                            setCalcLockedLeg({ index: idx, stake: initStake });
                            const scaled = bankrollFromLockedLeg(activeOdds, idx, initStake, calcOpts);
                            if (scaled > 0) setBankroll(Math.round(scaled));
                          }
                        }}
                      >
                        F
                      </button>
                    </small>
                    <div className="leg-inline-controls">
                      <input
                        type="number"
                        step="0.01"
                        min="1.01"
                        aria-label={tf('appCalcOutcomeN', { n: String(idx + 1) })}
                        className="select sm-select num"
                        style={{ width: 84, fontWeight: 700 }}
                        value={calcOdds[idx]}
                        onChange={(e) => {
                          const next = [...calcOdds] as [string, string, string, string];
                          next[idx] = e.target.value;
                          setCalcOdds(next);
                        }}
                      />
                      {showCommissions && (
                        <label className="inline-odd-edit">
                          <span>{t('appCommissionShort')}</span>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="50"
                            className="odd-mini-input num"
                            style={{ width: 52 }}
                            value={calcCommissions[idx]}
                            onChange={(e) => {
                              const next = [...calcCommissions] as [number, number, number, number];
                              next[idx] = Math.max(0, Number(e.target.value) || 0);
                              setCalcCommissions(next);
                            }}
                          />
                        </label>
                      )}
                      {showMultiCurrency && (
                        <select
                          className="select sm-select"
                          style={{ padding: '2px 6px', fontSize: 11.5 }}
                          value={calcCurrencies[idx]}
                          onChange={(e) => {
                            const next = [...calcCurrencies] as [CurrencyCode, CurrencyCode, CurrencyCode, CurrencyCode];
                            next[idx] = e.target.value as CurrencyCode;
                            setCalcCurrencies(next);
                          }}
                        >
                          {CURRENCY_CODES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="num" style={{ textAlign: 'right' }}>
                    {isLocked ? (
                      <input
                        type="number"
                        min={1}
                        step={10}
                        className="locked-stake-input num"
                        value={calcLockedLeg.stake}
                        onChange={(e) => {
                          const val = Math.max(0, Number(e.target.value) || 0);
                          setCalcLockedLeg({ index: idx, stake: val });
                          const scaled = bankrollFromLockedLeg(activeOdds, idx, val, calcOpts);
                          if (scaled > 0) setBankroll(Math.round(scaled));
                        }}
                      />
                    ) : (
                      <strong>{formatWithCurr(shownStake, curr)}</strong>
                    )}
                    <small>
                      {t('appReturns')} {formatWithCurr(calcResult.individualReturns[idx] ?? 0, baseCurrency)}
                    </small>
                    <small style={{ color: legProfit >= 0 ? 'var(--accent-green-text)' : 'var(--text-muted)' }}>
                      {legProfit >= 0 ? '+' : ''}
                      {formatWithCurr(legProfit, baseCurrency)}
                    </small>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="field-label">
            <label htmlFor="calc-bankroll">{t('totalStake')}</label>
            <span>{baseCurrency}</span>
          </div>
          <input
            id="calc-bankroll"
            className="stake-input num"
            type="number"
            min={0}
            step={50}
            value={calcLockedLeg ? Math.round(totalCalcStaked) : bankroll}
            onChange={(event) => {
              setCalcLockedLeg(null);
              setBankroll(Math.max(0, Number(event.target.value) || 0));
            }}
          />

          <div className="field-label">
            <span>{t('appTaxLabel')}</span>
          </div>
          <div className="rounding">
            {(
              [
                ['0', '0%'],
                ['2', '2%'],
                ['5', '5%'],
                ['12_pl', '12% PL'],
              ] as [TaxPreset, string][]
            ).map(([preset, shortLabel]) => (
              <button
                key={`calc-tax-${preset}`}
                type="button"
                className={taxPreset === preset ? 'active' : ''}
                onClick={() => setTaxPreset(preset)}
              >
                {shortLabel}
              </button>
            ))}
          </div>

          <div className="field-label">
            <span>{t('appSmartRounding')}</span>
            <span>{calcResult.isRounded ? t('appAdjusted') : t('appExact')}</span>
          </div>
          <div className="rounding">
            {(['raw', 'five', 'ten', 'smart'] as RoundingMode[]).map((item) => (
              <button
                key={`calc-round-${item}`}
                type="button"
                className={mode === item ? 'active' : ''}
                onClick={() => setMode(item)}
              >
                {item === 'raw'
                  ? t('appRoundingRaw')
                  : item === 'five'
                    ? t('appRoundingFive')
                    : item === 'ten'
                      ? t('appRoundingTen')
                      : t('appRoundingSmart')}
              </button>
            ))}
          </div>

          <div className="return-box" style={{ marginBottom: 10 }}>
            <div className={`return ${calcResult.worstCaseProfit > 0 ? 'good' : ''}`}>
              <span>{t('appClaimWorstCase')}</span>
              <strong className="num">
                {calcResult.worstCaseProfit >= 0 ? '+' : ''}
                {formatWithCurr(calcResult.worstCaseProfit, baseCurrency)}
              </strong>
            </div>
            <div className={`return ${isArb ? 'good' : ''}`}>
              <span>{isArb ? t('appCalcMarginSurebet') : t('appCalcMarginHold')}</span>
              <strong className="num">
                {margin != null ? `${margin >= 0 ? '+' : ''}${formatPercent(margin, 2)}` : '—'}
              </strong>
            </div>
          </div>

          <button type="button" className="chip sm" onClick={() => void handleCopyStandalone()}>
            <Copy size={12} /> {t('appCopyPositionBtn')}
          </button>
        </div>
      </aside>
    );
  }

  const isSingle = opportunity.type === 'positive_ev';
  const totalRoundedStaked = result.roundedStakes.reduce((sum, stake) => sum + stake, 0);
  const placedStake = isSingle ? (result.roundedStakes[0] ?? 0) : (lockedLeg ? totalRoundedStaked : bankroll);
  const summary = slipSummary(
    opportunity,
    placedStake,
    {
      worstCaseProfit: result.worstCaseProfit,
      worstCaseRoi: result.worstCaseRoi,
      totalStaked: totalRoundedStaked,
    },
    (amount) => formatWithCurr(amount, baseCurrency),
    formatPercent,
  );
  const evUnreconcilable = summary.unreconciled;
  const navigableLegs = opportunity.legs.filter((leg) => isNavigable(leg.deepLinkUrl));

  const bookCounts = new Map<string, { name: string; count: number }>();
  for (const leg of opportunity.legs) {
    const prev = bookCounts.get(leg.bookmakerId);
    bookCounts.set(leg.bookmakerId, { name: leg.bookmakerName, count: (prev?.count ?? 0) + 1 });
  }
  const duplicateBooks = [...bookCounts.values()].filter((b) => b.count > 1).map((b) => b.name);

  const togglePlacedLeg = (idx: number) => {
    setPlacedLegs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleLockToggle = (index: number) => {
    if (lockedLeg?.index === index) {
      setLockedLeg(null);
      return;
    }
    const baseStake = showMultiCurrency
      ? (result.localStakes?.[index] || 100)
      : (result.roundedStakes[index] || 100);
    const currentLegStake = Math.max(10, Math.round(baseStake * 100) / 100);
    setLockedLeg({ index, stake: currentLegStake });
    const scaled = bankrollFromLockedLeg(effectiveLegOdds, index, currentLegStake, stakeOptions);
    if (scaled > 0) setBankroll(Math.round(scaled));
  };

  const handleLockedStakeChange = (index: number, nextStake: number) => {
    const clean = Math.max(0, nextStake);
    setLockedLeg({ index, stake: clean });
    const scaled = bankrollFromLockedLeg(effectiveLegOdds, index, clean, stakeOptions);
    if (scaled > 0) setBankroll(Math.round(scaled));
  };

  const handleCopyStake = async (index: number, stakeVal: number) => {
    const ok = await copyTextWithFeedback(stakeVal.toFixed(mode === 'raw' ? 2 : 0));
    if (ok) {
      setCopiedIdx(index);
      const curr = showMultiCurrency ? (legCurrencies[index] ?? baseCurrency) : baseCurrency;
      notify(tf('appToastStakeCopied', { stake: formatWithCurr(stakeVal, curr) }), 'success');
      setTimeout(() => setCopiedIdx((prev) => (prev === index ? null : prev)), 1500);
    }
  };

  const handleCopyPositionSummary = async () => {
    const header = `${opportunity.homeTeam} vs ${opportunity.awayTeam} (${opportunity.league} · ${localizeMarketLabel(opportunity.marketName, t)})`;
    const legLines = opportunity.legs.map((leg, i) => {
      const curr = showMultiCurrency ? (legCurrencies[i] ?? baseCurrency) : baseCurrency;
      const st = showMultiCurrency ? (result.localStakes?.[i] ?? 0) : (result.roundedStakes[i] ?? 0);
      const odd = effectiveLegOdds[i] ?? leg.effectiveOdds;
      return `• ${leg.bookmakerName}: ${leg.selection} @ ${odd.toFixed(2)} — ${formatWithCurr(st, curr)}`;
    });
    const footer = `${t('totalStake')}: ${formatWithCurr(totalRoundedStaked, baseCurrency)} | ${t(summary.aLabel)}: ${summary.aValue}`;
    const ok = await copyTextWithFeedback([header, ...legLines, footer].join('\n'));
    if (ok) notify(t('appToastPositionCopied'), 'success');
  };

  const handleOpenSlips = async () => {
    if (navigableLegs.length > 0) {
      for (const leg of navigableLegs) {
        if (leg.deepLinkUrl) window.open(leg.deepLinkUrl, '_blank', 'noopener,noreferrer');
      }
      if (navigableLegs.length < opportunity.legs.length) {
        await copyTextWithFeedback(`${opportunity.homeTeam} vs ${opportunity.awayTeam}`);
        notify(t('appToastPartialLinksOpened'), 'info');
      }
    } else {
      await copyTextWithFeedback(`${opportunity.homeTeam} vs ${opportunity.awayTeam}`);
      notify(t('appToastMatchCopiedForSearch'), 'info');
    }
  };

  const handleLogToTracker = async () => {
    if (savingBet) return;
    setSavingBet(true);
    try {
      const legsToLog = isSingle ? [opportunity.legs[0]] : opportunity.legs;
      const posPrefix = !isSingle && legsToLog.length >= 2 ? `[pos:${Date.now().toString(36).slice(-6)}] ` : '';
      let loggedCount = 0;
      for (let i = 0; i < legsToLog.length; i += 1) {
        const leg = legsToLog[i];
        const actualOdds = result.effectiveNetOdds?.[i] ?? effectiveLegOdds[i] ?? leg.effectiveOdds;
        const stakeAmount = Number(result.roundedStakes[i] ?? 0);
        if (stakeAmount <= 0 || actualOdds <= 1) continue;
        await addTrackedBet({
          eventKey: opportunity.eventKey ?? `${opportunity.homeTeam} vs ${opportunity.awayTeam}`,
          marketKey: leg.marketKey || opportunity.marketKey || opportunity.marketName,
          selection: `${opportunity.homeTeam} vs ${opportunity.awayTeam} — ${leg.selection}`,
          sourceId: leg.bookmakerId,
          odds: actualOdds,
          stake: stakeAmount,
          status: 'pending',
          notes: `${posPrefix}${familyWord(opportunity.type)} · ${localizeMarketLabel(leg.marketName, t)}`,
          provenance: 'scan',
        });
        loggedCount += 1;
      }
      if (loggedCount > 0) {
        setSavedPositionId(opportunity.id);
        notify(tf('appToastPositionLogged', { n: String(loggedCount) }), 'success');
      } else {
        notify(t('appToastEnterValidStake'), 'error');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    } finally {
      setSavingBet(false);
    }
  };

  const handleVerifyNow = async () => {
    if (verifyingGlobal) return;
    setVerifyingGlobal(true);
    try {
      const targets = opportunity.rawTarget ? [opportunity.rawTarget] : undefined;
      const res = await runVerification(targets);
      await refresh();
      notify(
        tf('appToastVerifyComplete', {
          confirmed: String(res.confirmed),
          rejected: String(res.rejected),
        }),
        res.confirmed > 0 ? 'success' : 'info',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastVerifyFailed'), 'error');
    } finally {
      setVerifyingGlobal(false);
    }
  };

  const requiredLegsCount = isSingle ? 1 : opportunity.legs.length;

  return (
    <aside className="execution" id="execution-slip">
      <div className="slip-header">
        <div>
          <div className="eyebrow">{tf('appExecutionSlipWith', { kind: familyWord(opportunity.type) })}</div>
          <div className="slip-title">
            {opportunity.type === 'positive_ev'
              ? t('appSlipTitleSingle')
              : opportunity.type === 'middle'
                ? t('appSlipTitleMiddle')
                : t('appSlipTitleSurebet')}
          </div>
        </div>
        <button className="close" onClick={onClose} aria-label={t('appCloseSlip')}>
          <X size={18} />
        </button>
      </div>

      {renderSlipTabs()}

      <div className="slip-event">
        <strong>{opportunity.homeTeam} {t('vs')} {opportunity.awayTeam}</strong>
        <span className="subtle">
          {[opportunity.league, formatTime(opportunity.startTime), localizeMarketLabel(opportunity.marketName, t)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      <div className="slip-explainer">
        {opportunity.type === 'surebet'
          ? t('appExplainSurebetSlip')
          : opportunity.type === 'middle'
            ? t('appExplainMiddleSlip')
            : t('appExplainEvSlip')}
      </div>

      {duplicateBooks.length > 0 && (
        <div className="notice">
          <strong><ShieldAlert size={13} /> {t('appSameBookWarningTitle')}</strong>
          <br />
          {tf('appSameBookWarningBody', { books: duplicateBooks.join(', ') })}
        </div>
      )}

      {opportunity.ruleSafety.severity !== 'safe' && (
        <div className="notice">
          <strong><ShieldAlert size={13} /> {t('appSettlementWarning')}</strong>
          <br />
          {opportunity.ruleSafety.severity === 'unverified'
            ? t('appUnverifiedNotice')
            : localizeRuleReason(opportunity.ruleSafety.ruleMismatchReason, t)}
        </div>
      )}

      {evUnreconcilable && (
        <div className="notice">
          <strong><ShieldAlert size={13} /> {t('appQuotedEdgeTitle')}</strong>
          <br />
          {t('appQuotedEdgeNote')}
        </div>
      )}

      {opportunity.type === 'surebet' &&
        (hasCustomOdds || taxPreset !== '0' || showCommissions) &&
        result.worstCaseProfit < 0 && (
          <div className="notice danger-notice">
            <strong>
              <ShieldAlert size={13} />{' '}
              {tf('appNegativeArbWarning', { loss: formatWithCurr(Math.abs(result.worstCaseProfit), baseCurrency) })}
            </strong>
          </div>
        )}

      {isDnbOrLevelMarket(opportunity) && (
        <div className="slip-explainer" style={{ borderColor: 'rgba(16, 185, 129, 0.35)' }}>
          {t('appDnbPushNote')}
        </div>
      )}

      {opportunity.type === 'middle' && result.individualReturns.length >= 2 && (
        <div className="slip-explainer" style={{ borderColor: 'rgba(245, 158, 11, 0.45)' }}>
          <strong style={{ display: 'block', color: 'var(--text-strong)', marginBottom: 2 }}>
            {tf('appMiddleWindowTitle', { window: describeMiddleWindow(opportunity) ?? '—' })}
          </strong>
          <span>
            {tf('appMiddleBothHitPnl', {
              profit: formatWithCurr(
                Math.max(0, result.individualReturns[0] + result.individualReturns[1] - totalRoundedStaked),
                baseCurrency,
              ),
              single: `${result.worstCaseProfit >= 0 ? '+' : ''}${formatWithCurr(result.worstCaseProfit, baseCurrency)}`,
            })}
          </span>
        </div>
      )}

      <div className="field-label">
        <label htmlFor="bankroll">{t('totalStake')}</label>
        <span>
          {lockedLeg
            ? tf('appLockedStakeActive', { n: String(lockedLeg.index + 1) })
            : baseCurrency}
        </span>
      </div>
      <input
        id="bankroll"
        className="stake-input num"
        type="number"
        min={0}
        step={50}
        value={lockedLeg ? Math.round(totalRoundedStaked) : bankroll}
        onChange={(event) => {
          setLockedLeg(null);
          setBankroll(Math.max(0, Number(event.target.value) || 0));
        }}
      />
      <div className="quick">
        <button onClick={() => { setLockedLeg(null); setBankroll(200); }}>200</button>
        <button onClick={() => { setLockedLeg(null); setBankroll(500); }}>500</button>
        <button onClick={() => { setLockedLeg(null); setBankroll(1000); }}>{formatNum(1000)}</button>
        <button onClick={() => { setLockedLeg(null); setBankroll((value) => value + 250); }}>+250</button>
        <button onClick={() => { setLockedLeg(null); setBankroll(defaultBankroll); }}>{t('appReset')}</button>
      </div>

      {isSingle && opportunity.consensusProbability != null && !evUnreconcilable && (
        <>
          <div className="field-label">
            <span>{t('appKellySizingLabel')}</span>
            <span>{formatWithCurr(defaultBankroll, baseCurrency)}</span>
          </div>
          <div className="rounding" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {(
              [
                [0.25, t('appKellyQuarter')],
                [0.5, t('appKellyHalf')],
                [1, t('appKellyFull')],
              ] as [number, string][]
            ).map(([frac, label]) => {
              const sized = Math.max(
                1,
                Math.round(
                  kellyStake(
                    effectiveLegOdds[0] ?? opportunity.legs[0].effectiveOdds,
                    opportunity.consensusProbability ?? 0,
                    defaultBankroll,
                    frac,
                  ),
                ),
              );
              return (
                <button
                  key={label}
                  type="button"
                  className={bankroll === sized ? 'active' : ''}
                  onClick={() => {
                    setLockedLeg(null);
                    setBankroll(sized);
                  }}
                >
                  {label} ({sized})
                </button>
              );
            })}
          </div>
        </>
      )}

      {opportunity.type === 'surebet' && opportunity.legs.length >= 2 && (
        <>
          <div className="field-label">
            <span>{t('appProfitDistLabel')}</span>
          </div>
          <div
            className="rounding"
            style={{ gridTemplateColumns: `repeat(${opportunity.legs.length + 1}, 1fr)` }}
          >
            <button
              type="button"
              className={targetSummary === 'equal' ? 'active' : ''}
              onClick={() => setDistributeMask(new Array(opportunity.legs.length).fill(true))}
            >
              {t('appDistEqual')}
            </button>
            {opportunity.legs.map((_, idx) => (
              <button
                key={`dist-leg-${idx}`}
                type="button"
                className={targetSummary === idx ? 'active' : ''}
                onClick={() =>
                  setDistributeMask(opportunity.legs.map((__, j) => j === idx))
                }
              >
                {tf('appDistTargetLeg', { n: String(idx + 1) })}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="field-label">
        <span>{t('appTaxLabel')}</span>
        {hasPlBook && <span className="risk-note">{t('appTaxPlHint')}</span>}
      </div>
      <div className="rounding">
        {(
          [
            ['0', '0%', t('appTaxNone')],
            ['2', '2%', '2%'],
            ['5', '5%', '5%'],
            ['12_pl', '12% PL', '12% PL'],
          ] as [TaxPreset, string, string][]
        ).map(([preset, shortLabel, titleText]) => (
          <button
            key={preset}
            type="button"
            title={titleText}
            className={taxPreset === preset ? 'active' : ''}
            onClick={() => setTaxPreset(preset)}
          >
            {shortLabel}
          </button>
        ))}
      </div>

      <div className="inline-actions" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`chip sm ${showCommissions ? 'active' : ''}`}
          onClick={() => setShowCommissions((v) => !v)}
        >
          {t('appShowCommissionsBtn')}
        </button>
        <button
          type="button"
          className={`chip sm ${showMultiCurrency ? 'active' : ''}`}
          onClick={() => setShowMultiCurrency((v) => !v)}
        >
          {t('appMultiCurrencyBtn')}
        </button>
      </div>

      <div className="field-label">
        <span>{t('appSmartRounding')}</span>
        <span>{result.isRounded ? t('appAdjusted') : t('appExact')}</span>
      </div>
      <div className="rounding">
        {(['raw', 'five', 'ten', 'smart'] as RoundingMode[]).map((item) => (
          <button
            key={item}
            className={mode === item ? 'active' : ''}
            onClick={() => setMode(item)}
          >
            {item === 'raw'
              ? t('appRoundingRaw')
              : item === 'five'
                ? t('appRoundingFive')
                : item === 'ten'
                  ? t('appRoundingTen')
                  : t('appRoundingSmart')}
          </button>
        ))}
      </div>

      <div className="field-label" style={{ marginBottom: 6 }}>
        <span>{t('appLiveOddsHint')}</span>
        {hasCustomOdds && (
          <button
            type="button"
            className="text-link-btn"
            onClick={() => setCustomOdds({})}
          >
            <RotateCcw size={11} /> {t('appResetOdds')}
          </button>
        )}
      </div>

      <div className="slip-legs">
        {opportunity.legs.map((leg, index) => {
          const canOpen = isNavigable(leg.deepLinkUrl);
          const currentOdd = effectiveLegOdds[index] ?? leg.effectiveOdds;
          const netOdd = result.effectiveNetOdds?.[index] ?? currentOdd;
          const legProfit = result.legProfits?.[index];
          const isLocked = lockedLeg?.index === index;
          const isPlaced = placedLegs.has(index);
          const legCurr = showMultiCurrency ? (legCurrencies[index] ?? baseCurrency) : baseCurrency;
          const shownStake = showMultiCurrency
            ? (result.localStakes?.[index] ?? 0)
            : (result.roundedStakes[index] ?? 0);
          const isCheckedD = distributeMask[index] ?? true;

          return (
            <div className={`leg-row slip-leg-card ${isPlaced ? 'placed' : ''}`} key={`${leg.bookmakerId}-slip-${index}`}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <small style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    <span className="book-dot" style={{ background: bookmakerColor(leg.bookmakerId) }} />
                    {leg.bookmakerName}
                  </span>
                  <span className="subtle">· {localizeMarketLabel(leg.marketName, t)}</span>
                  {!isSingle && (
                    <label className="df-badge" title={t('appDistributeCheckTitle')}>
                      <input
                        type="checkbox"
                        checked={isCheckedD}
                        onChange={(e) => {
                          const next = [...distributeMask];
                          next[index] = e.target.checked;
                          setDistributeMask(next);
                        }}
                      />
                      <span>D</span>
                    </label>
                  )}
                </small>
                <strong>{leg.selection}</strong>
                <div className="leg-inline-controls">
                  <label className="inline-odd-edit">
                    <span>{t('odds')}</span>
                    <input
                      type="number"
                      step="0.01"
                      min="1.01"
                      className="odd-mini-input num"
                      value={currentOdd}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val) && val > 1) {
                          setCustomOdds((prev) => ({ ...prev, [index]: val }));
                        }
                      }}
                    />
                  </label>
                  {showCommissions && (
                    <label className="inline-odd-edit">
                      <span>{t('appCommissionShort')}</span>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        max="50"
                        className="odd-mini-input num"
                        style={{ width: 52 }}
                        value={legCommissions[index] ?? 0}
                        onChange={(e) => {
                          const next = [...legCommissions];
                          next[index] = Math.max(0, Number(e.target.value) || 0);
                          setLegCommissions(next);
                        }}
                      />
                    </label>
                  )}
                  {showMultiCurrency && (
                    <select
                      className="select sm-select"
                      style={{ padding: '2px 6px', fontSize: 11.5 }}
                      value={legCurr}
                      onChange={(e) => {
                        const next = [...legCurrencies];
                        next[index] = e.target.value as CurrencyCode;
                        setLegCurrencies(next);
                      }}
                    >
                      {CURRENCY_CODES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  )}
                  {Math.abs(netOdd - currentOdd) > 0.001 && (
                    <span className="subtle num" style={{ fontSize: 10.5 }}>
                      ({tf('appNetOddHint', { odd: netOdd.toFixed(2) })})
                    </span>
                  )}
                  <button
                    type="button"
                    className={`placed-toggle ${isPlaced ? 'done' : ''}`}
                    onClick={() => togglePlacedLeg(index)}
                    title={t('appMarkLegPlaced')}
                  >
                    {isPlaced ? <CheckSquare size={12} /> : <Square size={12} />}
                    <span>{isPlaced ? t('appLegPlaced') : t('appMarkLegPlaced')}</span>
                  </button>
                </div>
              </div>

              <div className="num" style={{ textAlign: 'right' }}>
                {isLocked ? (
                  <input
                    type="number"
                    min={1}
                    step={10}
                    className="locked-stake-input num"
                    value={lockedLeg.stake}
                    onChange={(e) => handleLockedStakeChange(index, Number(e.target.value) || 0)}
                  />
                ) : (
                  <strong>{formatWithCurr(shownStake, legCurr)}</strong>
                )}
                {showMultiCurrency && legCurr !== baseCurrency && (
                  <small className="subtle">≈ {formatWithCurr(result.roundedStakes[index] ?? 0, baseCurrency)}</small>
                )}
                <small>{t('appReturns')} {formatWithCurr(result.individualReturns[index] ?? 0, baseCurrency)}</small>
                {targetSummary !== 'equal' && legProfit != null && (
                  <small style={{ color: isCheckedD ? 'var(--accent-green-text)' : 'var(--text-muted)' }}>
                    {isCheckedD
                      ? `${legProfit >= 0 ? '+' : ''}${formatWithCurr(legProfit, baseCurrency)}`
                      : t('appTargetBreakEvenTag')}
                  </small>
                )}
              </div>

              <span className="inline-actions">
                {!isSingle && (
                  <button
                    type="button"
                    className={`icon-button ${isLocked ? 'active-lock' : ''}`}
                    title={isLocked ? t('appUnlockLegStake') : t('appLockLegStake')}
                    onClick={() => handleLockToggle(index)}
                  >
                    {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
                  </button>
                )}
                <button
                  className="icon-button"
                  title={t('appCopyStake')}
                  onClick={() => void handleCopyStake(index, shownStake)}
                >
                  {copiedIdx === index ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                </button>
                {canOpen && leg.deepLinkUrl ? (
                  <a
                    className="icon-button"
                    href={leg.deepLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={tf('appOpenBook', { book: leg.bookmakerName })}
                  >
                    <ExternalLink size={14} />
                  </a>
                ) : (
                  <button
                    className="icon-button"
                    title={tf('appCopyMatchForBook', { book: leg.bookmakerName })}
                    onClick={async () => {
                      await copyTextWithFeedback(`${opportunity.homeTeam} vs ${opportunity.awayTeam}`);
                      notify(tf('appCopyMatchForBook', { book: leg.bookmakerName }), 'info');
                    }}
                  >
                    <ChevronRight size={14} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="checklist-box">
        <div className="field-label" style={{ marginBottom: 2 }}>
          <span>
            {tf('appPlacementChecklist', {
              done: String(Math.min(placedLegs.size, requiredLegsCount)),
              total: String(requiredLegsCount),
            })}
          </span>
        </div>
        <span className="subtle" style={{ fontSize: 11 }}>{t('appChecklistRule')}</span>
      </div>

      <div className="return-box">
        <div className={`return ${result.worstCaseProfit >= 0 ? 'good' : ''}`}>
          <span>{t(summary.aLabel)}</span>
          <strong className="num">{summary.aValue}</strong>
        </div>
        <div className="return">
          <span>{t(summary.bLabel)}</span>
          <strong className="num">
            {summary.bValue}
            {summary.bQualifier && ` · ${t(summary.bQualifier)}`}
          </strong>
        </div>
      </div>

      <div className="slip-actions-stack">
        {opportunity.ruleSafety.severity === 'blocked' ? (
          <div className="action blocked-action">
            <ShieldAlert size={16} /> {t('appContractBlocked')}
          </div>
        ) : (
          <button className="action" onClick={() => void handleOpenSlips()}>
            {navigableLegs.length > 0 ? t('appOpenSlips') : t('appCopyMatchAndPlace')}
            <ChevronRight size={16} />
          </button>
        )}

        <div className="slip-secondary-actions">
          <button
            className={`chip ${placedLegs.size >= requiredLegsCount && savedPositionId !== opportunity.id ? 'active' : ''}`}
            disabled={savingBet || opportunity.ruleSafety.severity === 'blocked'}
            onClick={() => void handleLogToTracker()}
          >
            <BookmarkPlus size={14} />
            {savedPositionId === opportunity.id ? t('appSavedToTracker') : t('appSaveToTracker')}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => void handleCopyPositionSummary()}
          >
            <Copy size={14} /> {t('appCopyPositionBtn')}
          </button>
          <button
            className="chip"
            onClick={() => onCompareOdds(opportunity)}
          >
            <Layers size={14} /> {t('appCompareOddsBtn')}
          </button>
          {Boolean(opportunity.rawTarget) && (
            <button
              className="chip"
              disabled={verifyingGlobal}
              onClick={() => void handleVerifyNow()}
            >
              {verifyingGlobal ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />}
              {t('appVerifyContractBtn')}
            </button>
          )}
          {savedPositionId === opportunity.id && (
            <button className="chip active" onClick={onOpenTracker}>
              {t('appViewInTracker')}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
