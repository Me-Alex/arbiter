import { create } from 'zustand';
import type {
  ArbitrageOpportunity,
  LowHoldRow,
  ScanSource,
  ScrapeState,
} from './domain';
import {
  connectEvents,
  fetchScan,
  fetchScrapeState,
  type ScanPayload,
} from './api';
import { playHighValueChime, playStandardClick } from './audio';
import { alertable } from './claims';
import {
  DEFAULT_FILTER_CRITERIA,
  EMPTY_HIDDEN_RULES,
  criteriaForPreset,
  type FilterPreset,
  type HiddenRules,
  type OpportunityFilterCriteria,
} from './workspace';
import {
  DEFAULT_FX_RATES,
  type CurrencyCode,
  type RoundingMode,
} from './stakes';
import type { OddsFormat } from './odds-format';

function getStorageItem(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function setStorageItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* ignore quota / privacy errors */
  }
}

function readJsonStorage<T>(key: string, fallback: T): T {
  const raw = getStorageItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface FeedHealth {
  status: string;
  actionableSourceCount: number;
  sources: Record<string, number>;
  eventCount: number;
  scannedAt: number | null;
  published: boolean;
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'info' | 'error';
}

function readHealth(scan: ScanPayload, published: boolean): FeedHealth {
  const health = scan.dataHealth ?? {};
  const sources = health.sources ?? {};
  return {
    status: health.status ?? 'unknown',
    actionableSourceCount: health.actionableSourceCount ?? 0,
    sources,
    eventCount: scan.eventCount ?? 0,
    scannedAt: scan.scrapedAt ? Date.parse(scan.scrapedAt) : null,
    published,
  };
}

interface FeedState {
  opportunities: ArbitrageOpportunity[];
  lowHold: LowHoldRow[];
  scanSources: ScanSource[];
  verificationSummary: ScanPayload['verificationSummary'] | null;
  health: FeedHealth | null;
  scrapeState: ScrapeState | null;
  verifying: boolean;
  paused: boolean;
  queuedUpdates: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  connection: 'disconnected' | 'connected' | 'reconnecting';
  error?: string;
  toast: ToastMessage | null;
  notify: (text: string, tone?: ToastMessage['tone']) => void;
  clearToast: () => void;
  setScrapeState: (state: ScrapeState | null) => void;
  setVerifying: (verifying: boolean) => void;
  setPaused: (paused: boolean) => void;
  togglePaused: () => void;
  refresh: () => Promise<void>;
  start: () => () => void;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useFeedStore = create<FeedState>((set, get) => ({
  opportunities: [],
  lowHold: [],
  scanSources: [],
  verificationSummary: null,
  health: null,
  scrapeState: null,
  verifying: false,
  paused: false,
  queuedUpdates: 0,
  status: 'idle',
  connection: 'disconnected',
  toast: null,
  notify(text, tone = 'info') {
    toastSeq += 1;
    const id = toastSeq;
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: { id, text, tone } });
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 3800);
  },
  clearToast() {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },
  setScrapeState(scrapeState) {
    set({ scrapeState });
  },
  setVerifying(verifying) {
    set({ verifying });
  },
  setPaused(paused) {
    const hadQueued = get().queuedUpdates > 0;
    set({ paused, queuedUpdates: paused ? get().queuedUpdates : 0 });
    if (!paused && hadQueued) {
      void get().refresh();
    }
  },
  togglePaused() {
    get().setPaused(!get().paused);
  },
  async refresh() {
    set({ status: get().opportunities.length ? 'ready' : 'loading', error: undefined });
    try {
      const result = await fetchScan();
      useFilterStore.getState().syncPinnedSnapshots(result.opportunities);
      set({
        opportunities: result.opportunities,
        lowHold: result.lowHold,
        scanSources: result.scan.sources ?? [],
        verificationSummary: result.scan.verificationSummary ?? null,
        health: readHealth(result.scan, result.published),
        queuedUpdates: 0,
        status: 'ready',
      });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to load scan',
      });
    }
  },
  start() {
    void fetchScrapeState()
      .then((state) => set({ scrapeState: state }))
      .catch(() => { /* ignore initial state probe error */ });

    const queueOrRefresh = () => {
      if (get().paused) {
        set((state) => ({ queuedUpdates: state.queuedUpdates + 1 }));
      } else {
        void get().refresh();
      }
    };

    const stop = connectEvents(
      (type, payload) => {
        if (type === 'scrape-update' && payload && typeof payload === 'object') {
          const prevStatus = get().scrapeState?.status;
          const nextState = payload as ScrapeState;
          set({ scrapeState: nextState });
          if (
            prevStatus === 'running' &&
            nextState.status !== 'running'
          ) {
            queueOrRefresh();
          }
          return;
        }
        if (type === 'scan-update') {
          queueOrRefresh();
          return;
        }
        if (type === 'verify-start') {
          set({ verifying: true });
          return;
        }
        if (type === 'verify-end') {
          set({ verifying: false });
          queueOrRefresh();
        }
      },
      (connection) => set({ connection: connection === 'open' ? 'connected' : 'reconnecting' }),
    );
    set({ connection: 'reconnecting' });
    return () => {
      stop();
      set({ connection: 'disconnected' });
    };
  },
}));

export interface SavedFilterProfile {
  id: string;
  name: string;
  criteria: OpportunityFilterCriteria;
}

function readInitialHidden(): HiddenRules {
  const parsed = readJsonStorage<Partial<HiddenRules>>('arbiter.hiddenRules', {});
  return {
    opportunityIds: Array.isArray(parsed.opportunityIds) ? parsed.opportunityIds : [],
    eventKeys: Array.isArray(parsed.eventKeys) ? parsed.eventKeys : [],
    leagues: Array.isArray(parsed.leagues) ? parsed.leagues : [],
    bookmakers: Array.isArray(parsed.bookmakers) ? parsed.bookmakers : [],
  };
}

function readInitialSavedFilters(): SavedFilterProfile[] {
  const parsed = readJsonStorage<SavedFilterProfile[]>('arbiter.savedFilters', []);
  return Array.isArray(parsed) ? parsed.filter((f) => Boolean(f?.id && f?.name && f?.criteria)) : [];
}

export type HiddenEntryKind = keyof HiddenRules;

interface FilterState {
  criteria: OpportunityFilterCriteria;
  activePreset: FilterPreset;
  showLowHold: boolean;
  compactCards: boolean;
  groupByEvent: boolean;
  pinnedIds: string[];
  pinnedSnapshots: Record<string, ArbitrageOpportunity>;
  hidden: HiddenRules;
  savedFilters: SavedFilterProfile[];
  setCriteria: (patch: Partial<OpportunityFilterCriteria>) => void;
  applyPreset: (preset: FilterPreset) => void;
  resetFilters: () => void;
  setShowLowHold: (show: boolean) => void;
  setCompactCards: (compact: boolean) => void;
  setGroupByEvent: (group: boolean) => void;
  togglePin: (opp: ArbitrageOpportunity) => void;
  syncPinnedSnapshots: (fresh: ArbitrageOpportunity[]) => void;
  hideEntry: (kind: HiddenEntryKind, value: string) => void;
  unhideEntry: (kind: HiddenEntryKind, value: string) => void;
  clearHidden: () => void;
  saveFilterProfile: (name: string) => void;
  applySavedFilter: (id: string) => void;
  deleteSavedFilter: (id: string) => void;
}

export const useFilterStore = create<FilterState>((set, get) => ({
  criteria: { ...DEFAULT_FILTER_CRITERIA },
  activePreset: 'all',
  showLowHold: false,
  compactCards: false,
  groupByEvent: getStorageItem('arbiter.groupByEvent') === '1',
  pinnedIds: readJsonStorage<string[]>('arbiter.pinnedIds', []),
  pinnedSnapshots: readJsonStorage<Record<string, ArbitrageOpportunity>>('arbiter.pinnedSnapshots', {}),
  hidden: readInitialHidden(),
  savedFilters: readInitialSavedFilters(),
  setCriteria: (patch) =>
    set((state) => ({
      criteria: { ...state.criteria, ...patch },
      showLowHold: false,
    })),
  applyPreset: (preset) =>
    set((state) => ({
      activePreset: preset,
      showLowHold: false,
      criteria: {
        ...state.criteria,
        ...criteriaForPreset(preset),
      },
    })),
  resetFilters: () =>
    set({
      criteria: { ...DEFAULT_FILTER_CRITERIA },
      activePreset: 'all',
      showLowHold: false,
    }),
  setShowLowHold: (showLowHold) => set({ showLowHold }),
  setCompactCards: (compactCards) => set({ compactCards }),
  setGroupByEvent: (groupByEvent) => {
    setStorageItem('arbiter.groupByEvent', groupByEvent ? '1' : '0');
    set({ groupByEvent });
  },
  togglePin: (opp) =>
    set((state) => {
      const exists = state.pinnedIds.includes(opp.id);
      const nextIds = exists
        ? state.pinnedIds.filter((id) => id !== opp.id)
        : [opp.id, ...state.pinnedIds];
      const nextSnaps = { ...state.pinnedSnapshots };
      if (exists) {
        delete nextSnaps[opp.id];
      } else {
        nextSnaps[opp.id] = opp;
      }
      setStorageItem('arbiter.pinnedIds', JSON.stringify(nextIds));
      setStorageItem('arbiter.pinnedSnapshots', JSON.stringify(nextSnaps));
      return { pinnedIds: nextIds, pinnedSnapshots: nextSnaps };
    }),
  syncPinnedSnapshots: (fresh) => {
    const { pinnedIds, pinnedSnapshots } = get();
    if (!pinnedIds.length) return;
    const byId = new Map(fresh.map((o) => [o.id, o]));
    let changed = false;
    const nextSnaps = { ...pinnedSnapshots };
    for (const id of pinnedIds) {
      const updated = byId.get(id);
      if (updated) {
        nextSnaps[id] = updated;
        changed = true;
      }
    }
    if (changed) {
      setStorageItem('arbiter.pinnedSnapshots', JSON.stringify(nextSnaps));
      set({ pinnedSnapshots: nextSnaps });
    }
  },
  hideEntry: (kind, value) =>
    set((state) => {
      if (!value || state.hidden[kind].includes(value)) return state;
      const nextHidden: HiddenRules = {
        ...state.hidden,
        [kind]: [...state.hidden[kind], value],
      };
      setStorageItem('arbiter.hiddenRules', JSON.stringify(nextHidden));
      return { hidden: nextHidden };
    }),
  unhideEntry: (kind, value) =>
    set((state) => {
      const nextHidden: HiddenRules = {
        ...state.hidden,
        [kind]: state.hidden[kind].filter((item) => item !== value),
      };
      setStorageItem('arbiter.hiddenRules', JSON.stringify(nextHidden));
      return { hidden: nextHidden };
    }),
  clearHidden: () => {
    setStorageItem('arbiter.hiddenRules', JSON.stringify(EMPTY_HIDDEN_RULES));
    set({ hidden: { ...EMPTY_HIDDEN_RULES } });
  },
  saveFilterProfile: (name) =>
    set((state) => {
      const trimmed = name.trim();
      if (!trimmed) return state;
      const profile: SavedFilterProfile = {
        id: `flt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        criteria: { ...state.criteria },
      };
      const next = [...state.savedFilters, profile];
      setStorageItem('arbiter.savedFilters', JSON.stringify(next));
      return { savedFilters: next };
    }),
  applySavedFilter: (id) =>
    set((state) => {
      const match = state.savedFilters.find((f) => f.id === id);
      if (!match) return state;
      return {
        criteria: { ...DEFAULT_FILTER_CRITERIA, ...match.criteria },
        activePreset: 'all',
        showLowHold: false,
      };
    }),
  deleteSavedFilter: (id) =>
    set((state) => {
      const next = state.savedFilters.filter((f) => f.id !== id);
      setStorageItem('arbiter.savedFilters', JSON.stringify(next));
      return { savedFilters: next };
    }),
}));

export type ThemeMode = 'dark' | 'light';
export type SlipTab = 'signal' | 'calculator' | 'converter';

interface PreferencesState {
  theme: ThemeMode;
  defaultBankroll: number;
  defaultRounding: RoundingMode;
  oddsFormat: OddsFormat;
  baseCurrency: CurrencyCode;
  fxRates: Record<CurrencyCode, number>;
  guideOpen: boolean;
  slipTabRequest: { tab: SlipTab; seq: number } | null;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setDefaultBankroll: (value: number) => void;
  setDefaultRounding: (mode: RoundingMode) => void;
  setOddsFormat: (format: OddsFormat) => void;
  setBaseCurrency: (currency: CurrencyCode) => void;
  setFxRate: (currency: CurrencyCode, rate: number) => void;
  resetFxRates: () => void;
  setGuideOpen: (open: boolean) => void;
  requestSlipTab: (tab: SlipTab) => void;
}

function readInitialTheme(): ThemeMode {
  const stored = getStorageItem('arbiter.theme');
  return stored === 'light' ? 'light' : 'dark';
}

function applyThemeToDom(theme: ThemeMode) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

function readInitialOddsFormat(): OddsFormat {
  const stored = getStorageItem('arbiter.oddsFormat');
  if (
    stored === 'decimal' ||
    stored === 'american' ||
    stored === 'fractional' ||
    stored === 'hongkong' ||
    stored === 'malay'
  ) {
    return stored;
  }
  return 'decimal';
}

function readInitialCurrency(): CurrencyCode {
  const stored = getStorageItem('arbiter.baseCurrency');
  if (stored === 'RON' || stored === 'EUR' || stored === 'PLN' || stored === 'USD' || stored === 'GBP') {
    return stored;
  }
  return 'RON';
}

function readInitialFxRates(): Record<CurrencyCode, number> {
  const parsed = readJsonStorage<Partial<Record<CurrencyCode, number>>>('arbiter.fxRates', {});
  return {
    RON: 1,
    EUR: Number(parsed.EUR) > 0 ? Number(parsed.EUR) : DEFAULT_FX_RATES.EUR,
    PLN: Number(parsed.PLN) > 0 ? Number(parsed.PLN) : DEFAULT_FX_RATES.PLN,
    USD: Number(parsed.USD) > 0 ? Number(parsed.USD) : DEFAULT_FX_RATES.USD,
    GBP: Number(parsed.GBP) > 0 ? Number(parsed.GBP) : DEFAULT_FX_RATES.GBP,
  };
}

const initialTheme = readInitialTheme();
applyThemeToDom(initialTheme);
let slipTabSeq = 0;

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  theme: initialTheme,
  defaultBankroll: Number(getStorageItem('arbiter.bankroll')) || 1000,
  defaultRounding: (getStorageItem('arbiter.rounding') as RoundingMode) || 'raw',
  oddsFormat: readInitialOddsFormat(),
  baseCurrency: readInitialCurrency(),
  fxRates: readInitialFxRates(),
  guideOpen: getStorageItem('arbiter.guideDismissed') !== '1',
  slipTabRequest: null,
  setTheme: (theme) => {
    setStorageItem('arbiter.theme', theme);
    applyThemeToDom(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setDefaultBankroll: (value) => {
    const clean = Math.max(10, Math.round(Number(value) || 1000));
    setStorageItem('arbiter.bankroll', String(clean));
    set({ defaultBankroll: clean });
  },
  setDefaultRounding: (mode) => {
    setStorageItem('arbiter.rounding', mode);
    set({ defaultRounding: mode });
  },
  setOddsFormat: (oddsFormat) => {
    setStorageItem('arbiter.oddsFormat', oddsFormat);
    set({ oddsFormat });
  },
  setBaseCurrency: (baseCurrency) => {
    setStorageItem('arbiter.baseCurrency', baseCurrency);
    set({ baseCurrency });
  },
  setFxRate: (currency, rate) => {
    if (currency === 'RON') return;
    const clean = Math.max(0.01, Math.round((Number(rate) || DEFAULT_FX_RATES[currency]) * 1000) / 1000);
    const next = { ...get().fxRates, [currency]: clean };
    setStorageItem('arbiter.fxRates', JSON.stringify(next));
    set({ fxRates: next });
  },
  resetFxRates: () => {
    const next = { ...DEFAULT_FX_RATES };
    setStorageItem('arbiter.fxRates', JSON.stringify(next));
    set({ fxRates: next });
  },
  setGuideOpen: (open) => {
    setStorageItem('arbiter.guideDismissed', open ? '0' : '1');
    set({ guideOpen: open });
  },
  requestSlipTab: (tab) => {
    slipTabSeq += 1;
    set({ slipTabRequest: { tab, seq: slipTabSeq } });
  },
}));

interface AlertState {
  muted: boolean;
  primed: boolean;
  seen: Set<string>;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  /** Compare an arriving scan against the previous one and sound what is new. */
  sync: (opportunities: ArbitrageOpportunity[]) => void;
}

/** Above this margin a surebet is worth interrupting for; below it, a quiet tick. */
const HIGH_VALUE_PERCENT = 3;

export const useAlertStore = create<AlertState>((set, get) => ({
  muted: (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('arbiter-alerts-muted') : null) === '1',
  primed: false,
  seen: new Set(),
  setMuted: (muted) => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('arbiter-alerts-muted', muted ? '1' : '0');
      }
    } catch { /* ignore */ }
    set({ muted });
  },
  toggleMuted: () => get().setMuted(!get().muted),
  sync: (opportunities) => {
    const { muted, seen, primed } = get();
    const actionable = alertable(opportunities);
    const incoming = new Set(actionable.map((item) => item.id));
    if (!primed) {
      set({ seen: incoming, primed: true });
      return;
    }
    const fresh = actionable.filter((item) => !seen.has(item.id));
    if (fresh.length > 0 && !muted) {
      const best = fresh.reduce((top, item) => (item.profitPercent > top.profitPercent ? item : top));
      if (best.profitPercent >= HIGH_VALUE_PERCENT) playHighValueChime();
      else playStandardClick();
    }
    set({ seen: new Set([...seen, ...incoming]) });
  },
}));
