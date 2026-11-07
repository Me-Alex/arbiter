import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  BookmarkPlus,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  CreditCard,
  Download,
  EyeOff,
  HelpCircle,
  Languages,
  Layers,
  LayoutDashboard,
  Moon,
  Pause,
  Pin,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import type { ArbitrageOpportunity, LowHoldRow, Sport } from './domain';
import { bookmakerColor } from './domain';
import { bookActivity, buildScanExportUrl, canonicalizeRawMarketLabel, formatBookmakerName } from './api';
import { profitLabel, rankOpportunities, surebetCounts, titleClaim, verifiedFigures } from './claims';
import { AnalyticsWorkspace } from './AnalyticsWorkspace';
import { BookmakersWorkspace } from './BookmakersWorkspace';
import { DashboardWorkspace } from './DashboardWorkspace';
import { EventDetailModal } from './EventDetailModal';
import { ExecutionSlip } from './ExecutionSlip';
import { QuickGuide } from './QuickGuide';
import { ScannerWorkspace } from './ScannerWorkspace';
import { SettingsWorkspace } from './SettingsWorkspace';
import { formatAge } from './age';
import {
  copyTextWithFeedback,
  formatClock,
  formatKickoff,
  formatMoney,
  formatNum,
  formatPercent,
  sportLabel,
} from './format';
import { t, tf, useLanguage } from './i18n';
import { localizeMarketLabel } from './labels';
import { formatOdds, type OddsFormat } from './odds-format';
import { localizeRuleReason } from './reasons';
import {
  useAlertStore,
  useFeedStore,
  useFilterStore,
  usePreferencesStore,
  type HiddenEntryKind,
} from './stores';
import {
  DEFAULT_FILTER_CRITERIA,
  DEFAULT_VIEW,
  NAV_VIEWS,
  annualizedRoiPercent,
  desiredSelection,
  eventGroupKey,
  filterOpportunities,
  groupOpportunitiesByEvent,
  hashForView,
  isTerminalView,
  mergePinnedOpportunities,
  viewFromHash,
  type AgeWindow,
  type EventDuring,
  type FilterPreset,
  type OutcomeCountFilter,
  type SafetyFilter,
  type SortMode,
  type TimingFilter,
  type WorkspaceView,
} from './workspace';
import './styles.css';

const icons = {
  Dashboard: LayoutDashboard,
  Opportunities: Activity,
  Scanner: Radio,
  Bookmakers: BookOpen,
  Analytics: BarChart3,
  Plans: CreditCard,
  Settings,
};

const WORKSPACE_LABEL_KEYS: Record<WorkspaceView, string> = {
  Dashboard: 'dashboard',
  Opportunities: 'opportunities',
  Scanner: 'scanner',
  Bookmakers: 'bookmakers',
  Analytics: 'analytics',
  Plans: 'plans',
  Settings: 'settings',
};

const WORKSPACE_SUBTITLE_KEYS: Record<WorkspaceView, string> = {
  Dashboard: 'appSubtitleDashboard',
  Opportunities: 'appTerminalSubtitle',
  Scanner: 'appSubtitleScanner',
  Bookmakers: 'appSubtitleBookmakers',
  Analytics: 'appSubtitleAnalytics',
  Plans: 'appPlansDisclaimer',
  Settings: 'appSubtitleSettings',
};

function useWorkspaceView() {
  const [view, setView] = useState<WorkspaceView>(() => viewFromHash(window.location.hash) ?? DEFAULT_VIEW);
  useEffect(() => {
    const onHashChange = () => {
      setView(viewFromHash(window.location.hash) ?? DEFAULT_VIEW);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHashChange);
    if (!viewFromHash(window.location.hash)) {
      window.location.replace(`${window.location.pathname}${window.location.search}${hashForView(DEFAULT_VIEW)}`);
    }
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = useCallback((next: WorkspaceView) => {
    window.location.hash = hashForView(next);
    window.scrollTo(0, 0);
  }, []);
  return [view, navigate] as const;
}

function OpportunityCard({
  opportunity,
  selected,
  defaultBankroll,
  oddsFormat,
  isPinned,
  isStalePinned,
  hideMenuOpen,
  siblingCount = 0,
  siblingsExpanded = false,
  onToggleSiblings,
  onTogglePin,
  onToggleHideMenu,
  onHide,
  onSelect,
  onCompareOdds,
  onCopyMatch,
}: {
  opportunity: ArbitrageOpportunity;
  selected: boolean;
  defaultBankroll: number;
  oddsFormat: OddsFormat;
  isPinned: boolean;
  isStalePinned: boolean;
  hideMenuOpen: boolean;
  siblingCount?: number;
  siblingsExpanded?: boolean;
  onToggleSiblings?: () => void;
  onTogglePin: () => void;
  onToggleHideMenu: () => void;
  onHide: (kind: HiddenEntryKind, value: string) => void;
  onSelect: () => void;
  onCompareOdds: () => void;
  onCopyMatch: () => void;
}) {
  const tag =
    opportunity.type === 'surebet'
      ? t('surebet')
      : opportunity.type === 'middle'
        ? t('middleChip')
        : '+EV';
  const tone =
    opportunity.type === 'surebet'
      ? ''
      : opportunity.type === 'middle'
        ? 'purple'
        : 'amber';
  const ttl = Math.max(8, Math.min(100, opportunity.ttlSeconds * 2.8));
  const profit = profitLabel(opportunity, formatPercent);
  const bookCount = new Set(opportunity.legs.map((leg) => leg.bookmakerId)).size;
  const sameBookDutcher = opportunity.legs.length > bookCount;
  const signalAgeSec = Math.max(0, Math.round((Date.now() - opportunity.createdAt) / 1000));
  const annualRoi = annualizedRoiPercent(opportunity);
  const uniqueBooks = useMemo(
    () => [...new Map(opportunity.legs.map((leg) => [leg.bookmakerId, leg.bookmakerName])).entries()],
    [opportunity.legs],
  );

  return (
    <article
      className={`panel opportunity ${selected ? 'selected' : ''} ${isPinned ? 'pinned' : ''}`}
      onClick={onSelect}
    >
      <div className="opportunity-head">
        <div className="opp-meta">
          <span className={`dot ${opportunity.isLive ? 'live' : ''}`} />
          {opportunity.isLive ? t('live').toUpperCase() : formatKickoff(opportunity.startTime)}
          <span>·</span>
          <span>{sportLabel(opportunity.sport)}</span>
          {opportunity.league && (
            <>
              <span>·</span>
              <span>{opportunity.league}</span>
            </>
          )}
          <span>·</span>
          <span className="num">
            {tf('appSignalAgeBadge', {
              age: formatAge(signalAgeSec, (days) => tf('appAgeDay', { n: formatNum(days) })),
            })}
          </span>
        </div>
        <div className="opp-meta">
          {isStalePinned && <span className="pinned-stale-tag">{t('appPinnedStaleBadge')}</span>}
          {opportunity.type === 'surebet' && annualRoi != null && (
            <span className="roi-badge num">
              {tf('appAnnualizedRoiBadge', { roi: formatNum(Math.min(annualRoi, 99999), 0) })}
            </span>
          )}
          <span className={`type-tag ${tone === 'purple' ? 'middle' : tone === 'amber' ? 'ev' : ''}`}>
            {tag}
          </span>
          {opportunity.ruleSafety.severity !== 'safe' ? (
            <span
              className={`risk-tag ${
                opportunity.ruleSafety.severity === 'blocked'
                  ? 'blocked'
                  : opportunity.ruleSafety.severity === 'unverified'
                    ? 'unverified'
                    : ''
              }`}
              title={
                opportunity.ruleSafety.severity === 'unverified'
                  ? t('appUnverifiedNotice')
                  : localizeRuleReason(opportunity.ruleSafety.ruleMismatchReason, t)
              }
            >
              <ShieldAlert size={11} />{' '}
              {opportunity.ruleSafety.severity === 'blocked'
                ? t('appBlockedContract')
                : opportunity.ruleSafety.severity === 'unverified'
                  ? t('appUnverifiedContract')
                  : t('appRuleHazard')}
            </span>
          ) : (
            <span className="safe-tag">{t('appRulesSafe')}</span>
          )}
        </div>
      </div>

      <div className="opp-title">
        <strong>
          {opportunity.homeTeam} <span>{t('vs')}</span> {opportunity.awayTeam}
        </strong>
        <span className="inline-actions" style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            className={`icon-button ${isPinned ? 'active-pin' : ''}`}
            title={isPinned ? t('appUnpinFromTop') : t('appPinToTop')}
            aria-label={isPinned ? t('appUnpinFromTop') : t('appPinToTop')}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
          >
            <Pin size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('appCompareAllOdds')}
            onClick={(event) => {
              event.stopPropagation();
              onCompareOdds();
            }}
          >
            <Layers size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t('appCopyEventName')}
            onClick={(event) => {
              event.stopPropagation();
              onCopyMatch();
            }}
          >
            <Copy size={14} />
          </button>
          <span className="hide-menu-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={`icon-button ${hideMenuOpen ? 'active-pin' : ''}`}
              title={t('appHideMenuTitle')}
              aria-label={t('appHideMenuTitle')}
              aria-expanded={hideMenuOpen}
              onClick={onToggleHideMenu}
            >
              <EyeOff size={14} />
            </button>
            {hideMenuOpen && (
              <div className="hide-menu-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onHide('opportunityIds', opportunity.id)}
                >
                  {t('appHideThisSignal')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onHide('eventKeys', eventGroupKey(opportunity))}
                >
                  {t('appHideThisEvent')}
                </button>
                {opportunity.league && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onHide('leagues', opportunity.league)}
                  >
                    {tf('appHideThisLeague', { league: opportunity.league })}
                  </button>
                )}
                {uniqueBooks.map(([bookId, bookName]) => (
                  <button
                    key={bookId}
                    type="button"
                    role="menuitem"
                    onClick={() => onHide('bookmakers', bookId)}
                  >
                    {tf('appHideBookmaker', { book: bookName })}
                  </button>
                ))}
              </div>
            )}
          </span>
          <ChevronRight size={15} color="#66758e" />
        </span>
      </div>

      <div className="opp-meta market-line">
        <span className="market-badge">{localizeMarketLabel(opportunity.marketName, t)}</span>
        {opportunity.type === 'middle' && opportunity.gap != null && (
          <span>
            {t('gap')} {opportunity.gap}
          </span>
        )}
        {opportunity.type === 'middle' && opportunity.riskPercent != null && (
          <span>
            {t('appRisk')} {formatPercent(opportunity.riskPercent, 1)}
          </span>
        )}
        {opportunity.type === 'positive_ev' && opportunity.consensusProbability != null && (
          <span>
            {t('consensus')} {formatPercent(opportunity.consensusProbability * 100, 1)}
          </span>
        )}
      </div>

      <div className="legs">
        {opportunity.legs.map((leg, legIndex) => (
          <div className="leg" key={`${opportunity.id}-${leg.bookmakerId}-${legIndex}`}>
            <div className="leg-book">
              <span className="book-dot" style={{ background: bookmakerColor(leg.bookmakerId) }} />
              {leg.bookmakerName}
            </div>
            <div className="leg-pick">{leg.selection}</div>
            <div className="leg-odds num">
              {formatOdds(leg.rawOdds, oddsFormat)}
              {leg.rawOdds !== leg.effectiveOdds && (
                <span style={{ color: '#718096', fontSize: 11 }}>
                  {' '}
                  → {formatOdds(leg.effectiveOdds, oddsFormat)}
                </span>
              )}
            </div>
            {leg.liquidity ? (
              <div className="leg-liq">
                {t('appLiquidity')} {formatMoney(leg.liquidity)}
              </div>
            ) : (
              <div className="leg-liq">{localizeMarketLabel(leg.marketName, t)}</div>
            )}
          </div>
        ))}
      </div>

      <div className="slip-foot" style={{ marginTop: 14 }}>
        <span className="subtle">
          {tf('appBookmakersCount', { n: formatNum(bookCount) })}
          {sameBookDutcher && (
            <span className="risk-note" title={t('appSameBookDutchHint')}>
              {t('appSameBookDutch')}
            </span>
          )}
          {tf('appScanAt', { time: formatClock(opportunity.scannedAt) })}
          {opportunity.totalStake != null && tf('appStakeAmount', { value: formatMoney(opportunity.totalStake) })}
        </span>
        <span className="profit-cell">
          <strong className={`profit num ${tone} ${profit.tone}`}>{profit.value}</strong>
          <small className="subtle">
            {t(profit.qualifier)}
            {opportunity.type === 'surebet' &&
              opportunity.ruleSafety.severity === 'safe' &&
              opportunity.profitPercent > 0 &&
              defaultBankroll > 0 &&
              ` · +${formatMoney((defaultBankroll * opportunity.profitPercent) / 100)}`}
          </small>
        </span>
      </div>

      {siblingCount > 0 && onToggleSiblings && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="event-siblings-toggle"
            onClick={(event) => {
              event.stopPropagation();
              onToggleSiblings();
            }}
          >
            {siblingsExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span>
              {siblingsExpanded
                ? tf('appCollapseSiblings', { n: formatNum(siblingCount) })
                : tf('appMoreForEvent', { n: formatNum(siblingCount) })}
            </span>
          </button>
        </div>
      )}

      <div className="ttl">
        <span style={{ width: `${ttl}%` }} />
      </div>
    </article>
  );
}

function LowHoldCard({ row, oddsFormat }: { row: LowHoldRow; oddsFormat: OddsFormat }) {
  return (
    <article className="panel opportunity">
      <div className="opportunity-head">
        <div className="opp-meta">
          <span className={`dot ${row.isLive ? 'live' : ''}`} />
          {row.isLive ? t('live').toUpperCase() : formatKickoff(row.startTime)}
          <span>·</span>
          <span>{sportLabel(row.sport)}</span>
          {row.league && (
            <>
              <span>·</span>
              <span>{row.league}</span>
            </>
          )}
        </div>
        <span className="market-badge">{t('appLowHoldBadge')}</span>
      </div>
      <div className="opp-title">
        <strong>
          {row.homeTeam} <span>{t('vs')}</span> {row.awayTeam}
        </strong>
      </div>
      <div className="opp-meta market-line">
        <span className="market-badge">{localizeMarketLabel(row.marketName, t)}</span>
      </div>
      <div className="legs">
        {row.legs.map((leg, i) => (
          <div className="leg" key={`${row.id}-${leg.bookmakerId}-${i}`}>
            <div className="leg-book">
              <span className="book-dot" style={{ background: bookmakerColor(leg.bookmakerId) }} />
              {leg.bookmakerName}
            </div>
            <div className="leg-pick">{leg.selection}</div>
            <div className="leg-odds num">{formatOdds(leg.effectiveOdds, oddsFormat)}</div>
          </div>
        ))}
      </div>
      <div className="slip-foot" style={{ marginTop: 12 }}>
        <span className="subtle">{t('appLowHoldExplain')}</span>
        <span className="profit-cell">
          <strong className="profit num muted">{formatPercent(row.holdPercent, 2)}</strong>
          <small className="subtle">{t('appHoldQualifier')}</small>
        </span>
      </div>
    </article>
  );
}

export default function App() {
  const opportunities = useFeedStore((state) => state.opportunities);
  const lowHold = useFeedStore((state) => state.lowHold);
  const scanSources = useFeedStore((state) => state.scanSources);
  const health = useFeedStore((state) => state.health);
  const scrapeState = useFeedStore((state) => state.scrapeState);
  const verifying = useFeedStore((state) => state.verifying);
  const paused = useFeedStore((state) => state.paused);
  const queuedUpdates = useFeedStore((state) => state.queuedUpdates);
  const togglePaused = useFeedStore((state) => state.togglePaused);
  const feedStatus = useFeedStore((state) => state.status);
  const connection = useFeedStore((state) => state.connection);
  const toast = useFeedStore((state) => state.toast);
  const clearToast = useFeedStore((state) => state.clearToast);
  const notify = useFeedStore((state) => state.notify);
  const refresh = useFeedStore((state) => state.refresh);
  const start = useFeedStore((state) => state.start);

  const criteria = useFilterStore((state) => state.criteria);
  const activePreset = useFilterStore((state) => state.activePreset);
  const showLowHold = useFilterStore((state) => state.showLowHold);
  const groupByEvent = useFilterStore((state) => state.groupByEvent);
  const pinnedIds = useFilterStore((state) => state.pinnedIds);
  const pinnedSnapshots = useFilterStore((state) => state.pinnedSnapshots);
  const hidden = useFilterStore((state) => state.hidden);
  const savedFilters = useFilterStore((state) => state.savedFilters);
  const setCriteria = useFilterStore((state) => state.setCriteria);
  const applyPreset = useFilterStore((state) => state.applyPreset);
  const resetFilters = useFilterStore((state) => state.resetFilters);
  const setShowLowHold = useFilterStore((state) => state.setShowLowHold);
  const setGroupByEvent = useFilterStore((state) => state.setGroupByEvent);
  const togglePin = useFilterStore((state) => state.togglePin);
  const hideEntry = useFilterStore((state) => state.hideEntry);
  const unhideEntry = useFilterStore((state) => state.unhideEntry);
  const clearHidden = useFilterStore((state) => state.clearHidden);
  const saveFilterProfile = useFilterStore((state) => state.saveFilterProfile);
  const applySavedFilter = useFilterStore((state) => state.applySavedFilter);
  const deleteSavedFilter = useFilterStore((state) => state.deleteSavedFilter);

  const theme = usePreferencesStore((state) => state.theme);
  const toggleTheme = usePreferencesStore((state) => state.toggleTheme);
  const defaultBankroll = usePreferencesStore((state) => state.defaultBankroll);
  const oddsFormat = usePreferencesStore((state) => state.oddsFormat);
  const guideOpen = usePreferencesStore((state) => state.guideOpen);
  const setGuideOpen = usePreferencesStore((state) => state.setGuideOpen);
  const requestSlipTab = usePreferencesStore((state) => state.requestSlipTab);

  const [selected, setSelected] = useState<ArbitrageOpportunity | null>(null);
  const [slipDismissed, setSlipDismissed] = useState(false);
  const [compareTarget, setCompareTarget] = useState<ArbitrageOpportunity | null>(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [openHideCardId, setOpenHideCardId] = useState<string | null>(null);
  const [hiddenModalOpen, setHiddenModalOpen] = useState(false);
  const [expandedEventKeys, setExpandedEventKeys] = useState<Set<string>>(new Set());
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');

  const { lang, setLang } = useLanguage();
  const [view, setView] = useWorkspaceView();

  const alertsMuted = useAlertStore((state) => state.muted);
  const toggleAlerts = useAlertStore((state) => state.toggleMuted);
  const syncAlerts = useAlertStore((state) => state.sync);

  useEffect(() => {
    if (!openHideCardId) return undefined;
    const closeMenu = () => setOpenHideCardId(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, [openHideCardId]);

  const rankedAll = useMemo(() => rankOpportunities(opportunities), [opportunities]);
  const filtered = useMemo(
    () => filterOpportunities(rankedAll, criteria, Date.now(), hidden),
    [rankedAll, criteria, hidden],
  );
  const { opportunities: visible, stalePinnedIds } = useMemo(
    () => mergePinnedOpportunities(filtered, pinnedIds, pinnedSnapshots),
    [filtered, pinnedIds, pinnedSnapshots],
  );
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const eventGroups = useMemo(
    () => (groupByEvent ? groupOpportunitiesByEvent(visible) : []),
    [groupByEvent, visible],
  );
  const totalHiddenCount =
    hidden.opportunityIds.length +
    hidden.eventKeys.length +
    hidden.leagues.length +
    hidden.bookmakers.length;

  const visibleLowHold = useMemo(() => {
    const q = criteria.query.trim().toLowerCase();
    return lowHold
      .filter((r) => criteria.sport === 'all' || r.sport === criteria.sport)
      .filter((r) => !q || `${r.homeTeam} ${r.awayTeam} ${r.league}`.toLowerCase().includes(q))
      .slice(0, 200);
  }, [lowHold, criteria.sport, criteria.query]);

  const availableSports = useMemo(() => {
    const counts = new Map<Sport, number>();
    for (const item of opportunities) {
      counts.set(item.sport, (counts.get(item.sport) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [opportunities]);

  const availableBooks = useMemo(() => {
    const act = bookActivity(opportunities);
    return [...act.values()].sort((a, b) => b.opportunities - a.opportunities);
  }, [opportunities]);

  // The tournament and market options are derived from the rows actually on the
  // board, not from a fixed catalogue. A hardcoded list would offer competitions
  // this scan never covered and omit ones it did, which is the same "menu that
  // does not match the data" fault the sport control was fixed for.
  const availableLeagues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of opportunities) {
      if (!item.league) continue;
      counts.set(item.league, (counts.get(item.league) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [opportunities]);

  const availableMarkets = useMemo(() => {
    const counts = new Map<string, number>();
    const sampleNames = new Map<string, string>();
    for (const item of opportunities) {
      const key = item.marketKey || item.marketName;
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!sampleNames.has(key) && item.marketName) {
        sampleNames.set(key, item.marketName);
      }
    }
    return [...counts.entries()]
      .map(([key, count]) => ({
        key,
        count,
        sampleName: sampleNames.get(key) ?? canonicalizeRawMarketLabel(key, key),
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }, [opportunities]);

  const advancedFilterCount =
    (criteria.type !== DEFAULT_FILTER_CRITERIA.type ? 1 : 0) +
    (criteria.safety !== DEFAULT_FILTER_CRITERIA.safety ? 1 : 0) +
    (criteria.timing !== DEFAULT_FILTER_CRITERIA.timing ? 1 : 0) +
    (criteria.minProfit > 0 ? 1 : 0) +
    (criteria.maxProfit > 0 ? 1 : 0) +
    (criteria.minOdds > 0 ? 1 : 0) +
    (criteria.maxOdds > 0 ? 1 : 0) +
    (criteria.noPushOnly ? 1 : 0) +
    (criteria.outcomeCount !== DEFAULT_FILTER_CRITERIA.outcomeCount ? 1 : 0) +
    (criteria.ageWindow !== DEFAULT_FILTER_CRITERIA.ageWindow ? 1 : 0) +
    (criteria.eventDuring !== DEFAULT_FILTER_CRITERIA.eventDuring ? 1 : 0) +
    (criteria.league !== DEFAULT_FILTER_CRITERIA.league ? 1 : 0) +
    (criteria.market !== DEFAULT_FILTER_CRITERIA.market ? 1 : 0);

  const hasCustomFilter =
    advancedFilterCount > 0 ||
    criteria.sport !== DEFAULT_FILTER_CRITERIA.sport ||
    criteria.bookmaker !== DEFAULT_FILTER_CRITERIA.bookmaker ||
    Boolean(criteria.crossBookOnly) ||
    criteria.query.trim() !== '' ||
    criteria.sortBy !== DEFAULT_FILTER_CRITERIA.sortBy ||
    showLowHold;

  const streamCount = groupByEvent ? eventGroups.length : visible.length;
  const streamRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const virtualizer = useVirtualizer({
    count: streamCount,
    getScrollElement: () => streamRef.current,
    estimateSize: () => 236,
    overscan: 8,
  });

  const stats = useMemo(
    () => ({
      surebet: opportunities.filter((item) => item.type === 'surebet').length,
      middle: opportunities.filter((item) => item.type === 'middle').length,
      positive_ev: opportunities.filter((item) => item.type === 'positive_ev').length,
    }),
    [opportunities],
  );
  const figures = useMemo(() => verifiedFigures(opportunities), [opportunities]);
  const bestSurebet = figures.guaranteed;
  const suspectEv = useMemo(
    () => opportunities.filter((item) => item.evConsensusSuspect).length,
    [opportunities],
  );
  const surebets = useMemo(() => surebetCounts(opportunities), [opportunities]);
  const feed = health;
  const sourceTotals = feed ? Object.values(feed.sources).reduce((sum, value) => sum + value, 0) : 0;
  const freshSources = feed?.sources.fresh ?? 0;
  const freshShare = sourceTotals ? (100 * freshSources) / sourceTotals : null;
  const scanAge = feed?.scannedAt ? Math.max(0, Math.round((Date.now() - feed.scannedAt) / 1000)) : null;

  const isTerminal = isTerminalView(view);
  const isScraping = scrapeState?.status === 'running';

  useEffect(() => {
    void refresh();
    const stop = start();
    return stop;
  }, [refresh, start]);

  useEffect(() => {
    const want = desiredSelection({
      view,
      dismissed: slipDismissed,
      selectedId: selected?.id ?? null,
      selectedStillPresent: selected != null && visible.some((item) => item.id === selected.id),
      firstCandidateId: visible[0]?.id ?? null,
    });
    if (want === (selected?.id ?? null)) return;
    setSelected(want == null ? null : visible.find((item) => item.id === want) ?? null);
  }, [view, visible, selected, slipDismissed]);

  const claim = titleClaim(figures);
  const titleSuffix = claim.key
    ? claim.value == null
      ? t(claim.key)
      : tf(claim.key, { value: formatNum(claim.value, 2) })
    : '';
  useEffect(() => {
    document.title = `(${formatNum(visible.length)}) Arbiter${titleSuffix}`;
  }, [visible.length, titleSuffix]);

  useEffect(() => {
    syncAlerts(opportunities);
  }, [opportunities, syncAlerts]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && hiddenModalOpen) {
        setHiddenModalOpen(false);
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)
      ) {
        return;
      }
      if (event.key.toLowerCase() === 'm') {
        toggleAlerts();
      } else if (event.key === '/' && isTerminal) {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === '?') {
        setGuideOpen(!guideOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleAlerts, isTerminal, guideOpen, setGuideOpen, hiddenModalOpen]);

  const exportCsvHref = useMemo(
    () =>
      buildScanExportUrl({
        type: criteria.type,
        sport: criteria.sport,
        q: criteria.query,
        confirmedOnly: criteria.safety === 'safe_only',
      }),
    [criteria.type, criteria.sport, criteria.query, criteria.safety],
  );

  const handleOpenOpportunityFromDashboard = useCallback(
    (opp: ArbitrageOpportunity) => {
      resetFilters();
      setSlipDismissed(false);
      setSelected(opp);
      setView('Opportunities');
    },
    [resetFilters, setView],
  );

  const handleSelectOpportunity = useCallback((opp: ArbitrageOpportunity) => {
    setSlipDismissed(false);
    setSelected(opp);
    requestSlipTab('signal');
    if (window.innerWidth <= 1080) {
      document.getElementById('execution-slip')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [requestSlipTab]);

  const handleHide = useCallback(
    (kind: HiddenEntryKind, value: string) => {
      hideEntry(kind, value);
      setOpenHideCardId(null);
    },
    [hideEntry],
  );

  const toggleEventGroup = useCallback((eventKey: string) => {
    setExpandedEventKeys((prev) => {
      const next = new Set(prev);
      if (next.has(eventKey)) next.delete(eventKey);
      else next.add(eventKey);
      return next;
    });
  }, []);

  const handleSaveFilterSubmit = () => {
    const trimmed = saveFilterName.trim();
    if (!trimmed) return;
    saveFilterProfile(trimmed);
    setSaveFilterName('');
    setSaveFilterOpen(false);
    notify(t('appToastFilterSaved'), 'success');
  };

  const renderCard = (
    opportunity: ArbitrageOpportunity,
    siblingCount = 0,
    eventKey?: string,
  ) => (
    <OpportunityCard
      key={opportunity.id}
      opportunity={opportunity}
      selected={selected?.id === opportunity.id}
      defaultBankroll={defaultBankroll}
      oddsFormat={oddsFormat}
      isPinned={pinnedSet.has(opportunity.id)}
      isStalePinned={stalePinnedIds.has(opportunity.id)}
      hideMenuOpen={openHideCardId === opportunity.id}
      siblingCount={siblingCount}
      siblingsExpanded={eventKey ? expandedEventKeys.has(eventKey) : false}
      onToggleSiblings={eventKey ? () => toggleEventGroup(eventKey) : undefined}
      onTogglePin={() => togglePin(opportunity)}
      onToggleHideMenu={() =>
        setOpenHideCardId((curr) => (curr === opportunity.id ? null : opportunity.id))
      }
      onHide={handleHide}
      onSelect={() => handleSelectOpportunity(opportunity)}
      onCompareOdds={() => setCompareTarget(opportunity)}
      onCopyMatch={async () => {
        const ok = await copyTextWithFeedback(`${opportunity.homeTeam} vs ${opportunity.awayTeam}`);
        if (ok) notify(t('appToastEventCopied'), 'success');
      }}
    />
  );

  return (
    <div className={`app-shell ${isTerminal ? '' : 'no-slip'}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>ARBITER</span>
        </div>

        <div>
          <div className="nav-section">{t('workspace')}</div>
          <nav className="nav">
            {NAV_VIEWS.map((label) => {
              const Icon = icons[label];
              return (
                <button
                  className={view === label ? 'active' : ''}
                  key={label}
                  onClick={() => setView(label)}
                >
                  <Icon size={16} />
                  <span>{t(WORKSPACE_LABEL_KEYS[label])}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div style={{ marginTop: 'auto', display: 'grid', gap: 10 }}>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">{t('appFeedStatus')}</div>
            <div
              style={{
                display: 'flex',
                gap: 7,
                alignItems: 'center',
                margin: '10px 0 5px',
                fontSize: 12,
              }}
            >
              <span
                className="dot"
                style={{
                  background:
                    feed?.status === 'fresh'
                      ? '#10b981'
                      : feed?.status === 'error'
                        ? '#ef4444'
                        : '#f4bd63',
                }}
              />{' '}
              {sourceTotals
                ? tf('appSourcesFresh', {
                    fresh: formatNum(freshSources),
                    total: formatNum(sourceTotals),
                  })
                : t('appFeedUnknown')}
            </div>
            <span className="subtle">
              {freshShare != null ? `${tf('appFreshShare', { share: formatNum(freshShare, 1) })} · ` : ''}
              {tf('appActionableCount', { n: formatNum(feed?.actionableSourceCount ?? 0) })}
              {scanAge != null
                ? tf('appScanAge', {
                    age: formatAge(scanAge, (days) => tf('appAgeDay', { n: formatNum(days) })),
                  })
                : ''}
            </span>
          </div>

          <div className="sidebar-quick-toggles">
            <button
              className="chip sm"
              onClick={() => setLang(lang === 'ro' ? 'en' : 'ro')}
              title={t('appLanguageLabel')}
            >
              <Languages size={14} /> <span>{lang === 'ro' ? 'EN' : 'RO'}</span>
            </button>
            <button
              className="chip sm"
              onClick={toggleTheme}
              title={t('appThemeLabel')}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              <span>{theme === 'dark' ? t('appThemeLightShort') : t('appThemeDarkShort')}</span>
            </button>
            <button
              className={`chip sm ${guideOpen ? 'active' : ''}`}
              onClick={() => setGuideOpen(!guideOpen)}
              title={t('appShowGuideBtn')}
              aria-label={t('appShowGuideBtn')}
            >
              <HelpCircle size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">
              {tf('appMarketIntelligence', { view: t(WORKSPACE_LABEL_KEYS[view]) })}
            </div>
            <h1>
              {isTerminal
                ? t('appOpportunityTerminal')
                : tf('appWorkspaceTitle', { view: t(WORKSPACE_LABEL_KEYS[view]) })}
            </h1>
            <div className="subtle">{t(WORKSPACE_SUBTITLE_KEYS[view])}</div>
          </div>

          <div className="topbar-actions">
            {(isScraping || verifying) && (
              <button className="chip active" onClick={() => setView('Scanner')}>
                <RefreshCw size={13} className="spin" />
                {isScraping ? t('scraping') : t('verifying')}
              </button>
            )}
            <button
              type="button"
              className="chip"
              onClick={() => {
                if (!isTerminal) setView('Opportunities');
                setSlipDismissed(false);
                requestSlipTab('converter');
              }}
            >
              <ArrowLeftRight size={13} /> {t('appConverterTab')}
            </button>
            {view !== 'Scanner' && !isScraping && (
              <button className="chip" onClick={() => setView('Scanner')}>
                <Radio size={13} /> {t('appCollectFreshOdds')}
              </button>
            )}
            <button
              type="button"
              className={`chip ${paused ? 'paused-chip' : ''}`}
              title={t('appStreamPauseHint')}
              onClick={togglePaused}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}{' '}
              {paused
                ? tf('appStreamPausedBtn', { n: formatNum(queuedUpdates) })
                : t('appStreamLiveBtn')}
            </button>
            <button
              className="chip"
              title={t('appRetryScan')}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={feedStatus === 'loading' ? 'spin' : ''} />
            </button>
            <div className="live-pulse">
              <i />{' '}
              {connection === 'connected'
                ? t('appStreamConnected')
                : connection === 'reconnecting'
                  ? t('appStreamReconnecting')
                  : feedStatus === 'error'
                    ? t('appScanUnavailable')
                    : t('appLoadingStream')}{' '}
              <span className="num">{connection === 'connected' ? t('live') : '—'}</span>
            </div>
          </div>
        </header>

        <QuickGuide
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          onNavigate={setView}
          onFilterSafeSurebets={() => {
            applyPreset('safe_surebets');
            setView('Opportunities');
          }}
        />

        {view === 'Dashboard' && (
          <DashboardWorkspace
            opportunities={opportunities}
            scanSources={scanSources}
            health={health}
            connection={connection}
            onNavigate={setView}
            onOpenOpportunity={handleOpenOpportunityFromDashboard}
          />
        )}

        {view === 'Scanner' && (
          <ScannerWorkspace onViewOpportunities={() => setView('Opportunities')} />
        )}

        {view === 'Bookmakers' && (
          <BookmakersWorkspace
            opportunities={opportunities}
            scanSources={scanSources}
            onSelectBookmaker={() => setView('Opportunities')}
            onOpenScanner={() => setView('Scanner')}
          />
        )}

        {view === 'Analytics' && (
          <AnalyticsWorkspace
            opportunities={opportunities}
            onJumpToOpportunities={() => setView('Opportunities')}
          />
        )}

        {view === 'Plans' && (
          <section className="plans-grid">
            <div className="panel plans-intro">
              <div className="eyebrow">{t('appPlansSubtitle')}</div>
              <h2>{t('appPlansHeading')}</h2>
              <p className="plan-enforcement">
                <strong>{t('appPlansEnforcementTitle')}</strong> {t('appPlansEnforcementNote')}
              </p>
              <div className="toolbar" style={{ padding: '12px 0 0', marginBottom: 0 }}>
                <span className="subtle" style={{ fontWeight: 600 }}>{t('appPlansQuickJumpTitle')}</span>
                <button className="chip sm active" onClick={() => { applyPreset('safe_surebets'); setView('Opportunities'); }}>
                  {t('appPresetSafeSurebets')}
                </button>
                <button className="chip sm" onClick={() => { applyPreset('verified_ev'); setView('Opportunities'); }}>
                  {t('appPresetVerifiedEv')}
                </button>
                <button className="chip sm" onClick={() => setView('Scanner')}>
                  {t('scanner')}
                </button>
                <button className="chip sm" onClick={() => setView('Analytics')}>
                  {t('tracker')} & CSV
                </button>
              </div>
            </div>
            <div className="plans-cards">
              <div className="panel plan-card">
                <div className="plan-badge">{t('appPlanFreeBadge')}</div>
                <h3 className="plan-name">{t('appPlanFreeName')}</h3>
                <div className="plan-price">{t('appPlanFreePrice')}</div>
                <p className="subtle">{t('appPlanFreeDesc')}</p>
                <ul className="plan-features">
                  <li>✓ {t('appPlanFreeF1')}</li>
                  <li>✓ {t('appPlanFreeF2')}</li>
                  <li>✗ {t('appPlanFreeF3')}</li>
                  <li>✗ {t('appPlanFreeF4')}</li>
                </ul>
                <div className="plan-action">
                  <span className="risk-tag">{t('appPlanNotEnforced')}</span>
                </div>
              </div>
              <div className="panel plan-card highlighted">
                <div className="plan-badge featured">{t('appPlanProBadge')}</div>
                <h3 className="plan-name">{t('appPlanProName')}</h3>
                <div className="plan-price">{t('appPlanProPrice')}</div>
                <p className="subtle">{t('appPlanProDesc')}</p>
                <ul className="plan-features">
                  <li>✓ {t('appPlanProF1')}</li>
                  <li>✓ {t('appPlanProF2')}</li>
                  <li>✓ {t('appPlanProF3')}</li>
                  <li>✓ {t('appPlanProF4')}</li>
                  <li>✗ {t('appPlanProF5')}</li>
                </ul>
                <div className="plan-action">
                  <span className="subtle">{t('appPlanOperatorProvisioned')}</span>
                </div>
              </div>
              <div className="panel plan-card">
                <div className="plan-badge">{t('appPlanAllBadge')}</div>
                <h3 className="plan-name">{t('appPlanAllName')}</h3>
                <div className="plan-price">{t('appPlanAllPrice')}</div>
                <p className="subtle">{t('appPlanAllDesc')}</p>
                <ul className="plan-features">
                  <li>✓ {t('appPlanAllF1')}</li>
                  <li>✓ {t('appPlanAllF2')}</li>
                  <li>✓ {t('appPlanAllF3')}</li>
                  <li>✓ {t('appPlanAllF4')}</li>
                  <li>✓ {t('appPlanAllF5')}</li>
                </ul>
                <div className="plan-action">
                  <span className="subtle">{t('appPlanOperatorProvisioned')}</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {view === 'Settings' && <SettingsWorkspace />}

        {isTerminal && (
          <>
            <section className="kpis">
              <div
                className={`kpi clickable-kpi ${!showLowHold && activePreset === 'safe_surebets' ? 'kpi-selected' : ''}`}
                onClick={() => applyPreset('safe_surebets')}
              >
                <div className="kpi-label">{t('surebets')}</div>
                <div className="kpi-value green num">{formatNum(surebets.actionable)}</div>
                <span className="subtle">{t('appPerActionable')}</span>
                {(surebets.blocked > 0 || surebets.unverified > 0 || surebets.hazard > 0) && (
                  <span className="subtle" style={{ fontSize: 11 }}>
                    {tf('appBlockedBy', { n: formatNum(surebets.blocked) })}
                    {surebets.hazard > 0 ? tf('appWithHazards', { n: formatNum(surebets.hazard) }) : ''}
                    {surebets.unverified > 0 ? tf('appUnverifiedBy', { n: formatNum(surebets.unverified) }) : ''}
                  </span>
                )}
              </div>

              <div
                className="kpi clickable-kpi"
                onClick={() => applyPreset('safe_surebets')}
              >
                <div className="kpi-label">{t('appBestGuaranteed')}</div>
                <div className="kpi-value green num">+{formatPercent(bestSurebet, 2)}</div>
                <span className="subtle">
                  {bestSurebet > 0 && defaultBankroll > 0
                    ? `${tf('appOnStakeHint', {
                        profit: formatMoney((defaultBankroll * bestSurebet) / 100),
                        stake: formatMoney(defaultBankroll),
                      })} · ${t('appRulesSafe')}`
                    : t('appRulesSafe')}
                </span>
              </div>

              <div
                className={`kpi clickable-kpi ${!showLowHold && activePreset === 'middles' ? 'kpi-selected' : ''}`}
                onClick={() => applyPreset('middles')}
              >
                <div className="kpi-label">{t('middlesLabel')}</div>
                <div className="kpi-value purple num">{formatNum(stats.middle)}</div>
                <span className="subtle">{t('appPerConditional')}</span>
              </div>

              <div
                className={`kpi clickable-kpi ${!showLowHold && activePreset === 'verified_ev' ? 'kpi-selected' : ''}`}
                onClick={() => applyPreset('verified_ev')}
              >
                <div className="kpi-label">{t('positiveEv')}</div>
                <div className="kpi-value amber num">{formatNum(stats.positive_ev - suspectEv)}</div>
                <span className="subtle">{t('appPerPricedEdge')}</span>
              </div>
            </section>

            <section className="panel filter-panel">
              <div className="toolbar filter-presets-row">
                <SlidersHorizontal size={15} color="#728199" />
                {(
                  [
                    ['all', `${t('appAllSignals')} (${formatNum(opportunities.length)})`],
                    ['safe_surebets', `${t('appPresetSafeSurebets')} (${formatNum(surebets.actionable)})`],
                    ['middles', `${t('middlesLabel')} (${formatNum(stats.middle)})`],
                    ['verified_ev', `${t('appPresetVerifiedEv')} (${formatNum(stats.positive_ev - suspectEv)})`],
                    ['live_now', `${t('appPresetLiveNow')} (${formatNum(opportunities.filter((o) => o.isLive).length)})`],
                  ] as [FilterPreset, string][]
                ).map(([presetKey, label]) => (
                  <button
                    key={presetKey}
                    className={`chip ${!showLowHold && activePreset === presetKey ? 'active' : ''}`}
                    onClick={() => applyPreset(presetKey)}
                  >
                    {label}
                  </button>
                ))}
                {lowHold.length > 0 && (
                  <button
                    className={`chip ${showLowHold ? 'active' : ''}`}
                    onClick={() => setShowLowHold(!showLowHold)}
                  >
                    {t('appLowHoldBadge')} ({formatNum(lowHold.length)})
                  </button>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`chip ${groupByEvent ? 'active' : ''}`}
                    onClick={() => setGroupByEvent(!groupByEvent)}
                  >
                    <Layers size={13} /> {t('appGroupByEventBtn')}
                  </button>

                  <button
                    type="button"
                    className={`chip ${totalHiddenCount > 0 ? 'active' : ''}`}
                    onClick={() => setHiddenModalOpen(true)}
                  >
                    <EyeOff size={13} /> {tf('appHiddenCountBtn', { n: formatNum(totalHiddenCount) })}
                  </button>

                  <button
                    className={`chip ${!alertsMuted ? 'active' : ''}`}
                    onClick={toggleAlerts}
                  >
                    <Bell size={13} /> {alertsMuted ? t('appAlertsMuted') : t('appAlertsOn')}{' '}
                    <span className="subtle">M</span>
                  </button>

                  <a
                    className="chip"
                    href={exportCsvHref}
                    download="scan-findings.csv"
                    title={t('export')}
                  >
                    <Download size={13} /> CSV
                  </a>
                </div>
              </div>

              {!showLowHold && (
                <>
                  <div className="toolbar filter-selects-row">
                    <div className="search-input-wrap" style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <Search size={14} color="#728199" />
                      <input
                        ref={searchInputRef}
                        className="select"
                        style={{ width: '100%', minWidth: 0 }}
                        placeholder={t('appSearchPlaceholder')}
                        value={criteria.query}
                        onChange={(event) => setCriteria({ query: event.target.value })}
                      />
                    </div>

                    <select
                      className="select sm-select"
                      aria-label={t('appFilterSport')}
                      value={criteria.sport}
                      onChange={(e) => setCriteria({ sport: e.target.value as 'all' | Sport })}
                    >
                      <option value="all">{t('appAllSports')}</option>
                      {availableSports.map(([sp, count]) => (
                        <option key={sp} value={sp}>
                          {sportLabel(sp)} ({formatNum(count)})
                        </option>
                      ))}
                    </select>

                    <select
                      className="select sm-select"
                      aria-label={t('bookmaker')}
                      value={criteria.bookmaker}
                      onChange={(e) => setCriteria({ bookmaker: e.target.value })}
                    >
                      <option value="all">{t('appAllBookmakersOpt')}</option>
                      {availableBooks.map((b) => (
                        <option key={b.bookmakerId} value={b.bookmakerId}>
                          {formatBookmakerName(b.bookmakerId)} ({formatNum(b.opportunities)})
                        </option>
                      ))}
                    </select>

                    <select
                      className="select sm-select"
                      aria-label={t('appSortByLabel')}
                      value={criteria.sortBy}
                      onChange={(e) => setCriteria({ sortBy: e.target.value as SortMode })}
                    >
                      <option value="recommended">{t('appSortRecommended')}</option>
                      <option value="edge_desc">{t('appSortHighestEdge')}</option>
                      <option value="roi_desc">{t('appSortAnnualizedRoi')}</option>
                      <option value="age_asc">{t('appSortNewestAge')}</option>
                      <option value="kickoff_asc">{t('appSortSoonestKickoff')}</option>
                    </select>

                    <button
                      type="button"
                      className={`chip sm ${criteria.crossBookOnly ? 'active' : ''}`}
                      title={t('appCrossBookOnlyHint')}
                      onClick={() => setCriteria({ crossBookOnly: !criteria.crossBookOnly })}
                    >
                      {t('appCrossBookOnly')}
                    </button>

                    <button
                      type="button"
                      className={`chip sm ${showMoreFilters || advancedFilterCount > 0 ? 'active' : ''}`}
                      onClick={() => setShowMoreFilters((v) => !v)}
                    >
                      <SlidersHorizontal size={12} />{' '}
                      {showMoreFilters ? t('appFewerFilters') : t('appMoreFilters')}
                      {advancedFilterCount > 0 && ` (${advancedFilterCount})`}
                    </button>

                    {!saveFilterOpen ? (
                      <button
                        type="button"
                        className="chip sm"
                        onClick={() => setSaveFilterOpen(true)}
                      >
                        <BookmarkPlus size={12} /> {t('appSaveFilterBtn')}
                      </button>
                    ) : (
                      <span className="inline-actions">
                        <input
                          type="text"
                          className="select sm-select"
                          style={{ width: 148 }}
                          placeholder={t('appSaveFilterPlaceholder')}
                          value={saveFilterName}
                          onChange={(e) => setSaveFilterName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveFilterSubmit();
                            if (e.key === 'Escape') setSaveFilterOpen(false);
                          }}
                        />
                        <button
                          type="button"
                          className="chip sm active"
                          onClick={handleSaveFilterSubmit}
                        >
                          <Check size={12} />
                        </button>
                        <button
                          type="button"
                          className="chip sm"
                          onClick={() => setSaveFilterOpen(false)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    )}

                    {hasCustomFilter && (
                      <button className="chip sm" onClick={resetFilters}>
                        <RotateCcw size={12} /> {t('appReset')}
                      </button>
                    )}
                  </div>

                  {savedFilters.length > 0 && (
                    <div className="toolbar" style={{ paddingTop: 2 }}>
                      {savedFilters.map((profile) => (
                        <span key={profile.id} className="saved-filter-pill">
                          <button
                            type="button"
                            className="saved-filter-apply"
                            onClick={() => applySavedFilter(profile.id)}
                          >
                            {profile.name}
                          </button>
                          <button
                            type="button"
                            className="saved-filter-del"
                            aria-label={t('appCloseModal')}
                            onClick={() => deleteSavedFilter(profile.id)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {(showMoreFilters || advancedFilterCount > 0) && (
                    <div className="advanced-filters-grid">
                      <div className="control-field">
                        <label>{t('appFilterType')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterType')}
                          value={criteria.type}
                          onChange={(e) => setCriteria({ type: e.target.value as typeof criteria.type })}
                        >
                          <option value="all">{t('appAllTypes')}</option>
                          <option value="surebet">{t('surebets')} ({formatNum(stats.surebet)})</option>
                          <option value="middle">{t('middlesLabel')} ({formatNum(stats.middle)})</option>
                          <option value="positive_ev">+EV ({formatNum(stats.positive_ev)})</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appSafetyFilterLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appSafetyFilterLabel')}
                          value={criteria.safety}
                          onChange={(e) => setCriteria({ safety: e.target.value as SafetyFilter })}
                        >
                          <option value="all">{t('appSafetyAll')}</option>
                          <option value="safe_only">{t('appSafetySafeOnly')}</option>
                          <option value="hide_blocked">{t('appSafetyHideBlocked')}</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appMatchTimingLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appMatchTimingLabel')}
                          value={criteria.timing}
                          onChange={(e) => setCriteria({ timing: e.target.value as TimingFilter })}
                        >
                          <option value="all">{t('appTimingAll')}</option>
                          <option value="prematch">{t('profileScopePrematch')}</option>
                          <option value="live">{t('live')}</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterOutcomeLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterOutcomeLabel')}
                          value={criteria.outcomeCount}
                          onChange={(e) => setCriteria({ outcomeCount: e.target.value as OutcomeCountFilter })}
                        >
                          <option value="all">{t('appFilterOutcomeAll')}</option>
                          <option value="2">{t('appFilterOutcome2')}</option>
                          <option value="3">{t('appFilterOutcome3')}</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appMinProfitLabel')}</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.5}
                          className="select sm-select num"
                          value={criteria.minProfit || ''}
                          placeholder="0"
                          onChange={(e) => setCriteria({ minProfit: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterMaxProfit')}</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.5}
                          className="select sm-select num"
                          aria-label={t('appFilterMaxProfit')}
                          value={criteria.maxProfit || ''}
                          placeholder="0"
                          onChange={(e) => setCriteria({ maxProfit: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterMinOdds')}</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.05}
                          className="select sm-select num"
                          aria-label={t('appFilterMinOdds')}
                          value={criteria.minOdds || ''}
                          placeholder="1.01"
                          onChange={(e) => setCriteria({ minOdds: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterMaxOdds')}</label>
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          step={0.1}
                          className="select sm-select num"
                          aria-label={t('appFilterMaxOdds')}
                          value={criteria.maxOdds || ''}
                          placeholder="0"
                          onChange={(e) => setCriteria({ maxOdds: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterAgeLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterAgeLabel')}
                          value={criteria.ageWindow}
                          onChange={(e) => setCriteria({ ageWindow: e.target.value as AgeWindow })}
                        >
                          <option value="all">{t('appFilterAgeAll')}</option>
                          <option value="10m">{t('appFilterAge10m')}</option>
                          <option value="2h">{t('appFilterAge2h')}</option>
                          <option value="12h">{t('appFilterAge12h')}</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appFilterDuringLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterDuringLabel')}
                          value={criteria.eventDuring}
                          onChange={(e) => setCriteria({ eventDuring: e.target.value as EventDuring })}
                        >
                          <option value="all">{t('appFilterDuringAll')}</option>
                          <option value="12h">{t('appFilterDuring12h')}</option>
                          <option value="16h">{t('appFilterDuring16h')}</option>
                          <option value="1d">{t('appFilterDuring1d')}</option>
                          <option value="2d">{t('appFilterDuring2d')}</option>
                          <option value="1w">{t('appFilterDuring1w')}</option>
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appLeagueLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterLeagueAll')}
                          value={criteria.league}
                          onChange={(e) => setCriteria({ league: e.target.value })}
                        >
                          <option value="all">{t('appFilterLeagueAll')}</option>
                          {availableLeagues.map(([league, count]) => (
                            <option key={league} value={league}>{league} ({count})</option>
                          ))}
                          {criteria.league !== 'all' && !availableLeagues.some(([league]) => league === criteria.league) && (
                            <option value={criteria.league}>{criteria.league}</option>
                          )}
                        </select>
                      </div>

                      <div className="control-field">
                        <label>{t('appMarketFilterLabel')}</label>
                        <select
                          className="select sm-select"
                          aria-label={t('appFilterMarketAll')}
                          value={criteria.market}
                          onChange={(e) => setCriteria({ market: e.target.value })}
                        >
                          <option value="all">{t('appFilterMarketAll')}</option>
                          {availableMarkets.map(({ key: market, count, sampleName }) => (
                            <option key={market} value={market}>
                              {localizeMarketLabel(sampleName, t)} ({count})
                            </option>
                          ))}
                          {criteria.market !== 'all' && !availableMarkets.some((m) => m.key === criteria.market) && (
                            <option value={criteria.market}>{criteria.market}</option>
                          )}
                        </select>
                      </div>

                      <div className="control-field" style={{ justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className={`chip sm ${criteria.noPushOnly ? 'active' : ''}`}
                          onClick={() => setCriteria({ noPushOnly: !criteria.noPushOnly })}
                        >
                          {t('appNoPushOnlyLabel')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            {!showLowHold && criteria.safety === 'all' && suspectEv > 0 && (
              <section className="panel suspect-banner">
                <div>
                  <strong>{tf('appSuspectEvTitle', { n: formatNum(suspectEv) })}</strong>
                  <span className="subtle" style={{ display: 'block', marginTop: 2 }}>
                    {t('appSuspectEvNote')}
                  </span>
                </div>
                <button
                  className="chip sm active"
                  onClick={() => setCriteria({ safety: 'hide_blocked' })}
                >
                  {t('appSafetyHideBlocked')}
                </button>
              </section>
            )}

            <div className="slip-foot" style={{ margin: '0 2px 10px' }}>
              <div className="opp-meta">
                <span className="eyebrow">
                  {showLowHold ? t('appLowHoldBadge') : t('appLiveOpportunities')}
                </span>
                <span>
                  {showLowHold
                    ? `${formatNum(visibleLowHold.length)} / ${formatNum(lowHold.length)}`
                    : tf('appShownBreakdown', { n: formatNum(visible.length) })}
                </span>
              </div>
              <div className="opp-meta">
                <Sparkles size={13} color="#f4bd63" /> {t('appWorkerActive')}
              </div>
            </div>

            {feedStatus === 'error' && (
              <div className="panel state-panel">
                <strong>{t('appScanUnavailable')}</strong>
                <span className="subtle">{t('appFeedLoadFailed')}</span>
                <button className="chip active" onClick={() => void refresh()}>
                  {t('appRetryScan')}
                </button>
              </div>
            )}

            {showLowHold && feedStatus !== 'error' && (
              <section className="stream">
                {visibleLowHold.map((row) => (
                  <LowHoldCard key={row.id} row={row} oddsFormat={oddsFormat} />
                ))}
              </section>
            )}

            {!showLowHold && feedStatus !== 'error' && visible.length === 0 && (
              <div className="panel state-panel">
                <strong>{feedStatus === 'loading' ? t('appLoadingSignals') : t('appNoMatches')}</strong>
                <span className="subtle">
                  {feedStatus === 'loading' ? t('appWaitingScan') : t('appAdjustFilters')}
                </span>
                {(hasCustomFilter || totalHiddenCount > 0) && (
                  <div className="inline-actions">
                    {hasCustomFilter && (
                      <button className="chip active" onClick={resetFilters}>
                        {t('appReset')}
                      </button>
                    )}
                    {totalHiddenCount > 0 && (
                      <button className="chip" onClick={() => setHiddenModalOpen(true)}>
                        {tf('appHiddenCountBtn', { n: formatNum(totalHiddenCount) })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!showLowHold && streamCount > 0 && (
              <section className="stream virtual-stream" ref={streamRef}>
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    if (groupByEvent) {
                      const group = eventGroups[item.index];
                      if (!group) return null;
                      const isExpanded = expandedEventKeys.has(group.eventKey);
                      return (
                        <div
                          key={group.eventKey}
                          data-index={item.index}
                          ref={virtualizer.measureElement}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${item.start}px)`,
                            paddingBottom: 10,
                          }}
                        >
                          {renderCard(group.primary, group.siblings.length, group.eventKey)}
                          {isExpanded && group.siblings.length > 0 && (
                            <div className="event-siblings-stack">
                              {group.siblings.map((sib) => renderCard(sib))}
                            </div>
                          )}
                        </div>
                      );
                    }

                    const opportunity = visible[item.index];
                    if (!opportunity) return null;
                    return (
                      <div
                        key={opportunity.id}
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${item.start}px)`,
                          paddingBottom: 10,
                        }}
                      >
                        {renderCard(opportunity)}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {isTerminal && selected && (
        <button
          type="button"
          className="mobile-slip-fab"
          onClick={() => document.getElementById('execution-slip')?.scrollIntoView({ behavior: 'smooth' })}
        >
          <Calculator size={15} /> {t('appJumpToSlip')}
        </button>
      )}

      {isTerminal && (
        <ExecutionSlip
          opportunity={selected}
          onClose={() => {
            setSlipDismissed(true);
            setSelected(null);
          }}
          onCompareOdds={(opp) => setCompareTarget(opp)}
          onOpenTracker={() => setView('Analytics')}
        />
      )}

      <EventDetailModal
        opportunity={compareTarget}
        onClose={() => setCompareTarget(null)}
      />

      {hiddenModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setHiddenModalOpen(false)}
        >
          <div
            className="panel modal-dialog"
            style={{ width: 'min(580px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <div className="eyebrow">{t('opportunities')}</div>
                <h2 className="modal-title">{t('appHiddenModalTitle')}</h2>
              </div>
              <span className="inline-actions">
                {totalHiddenCount > 0 && (
                  <button type="button" className="chip sm active" onClick={clearHidden}>
                    <RotateCcw size={12} /> {t('appHiddenRestoreAll')}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('appCloseModal')}
                  onClick={() => setHiddenModalOpen(false)}
                >
                  <X size={16} />
                </button>
              </span>
            </div>
            <div className="modal-body">
              {totalHiddenCount === 0 ? (
                <div className="subtle">{t('appHiddenEmpty')}</div>
              ) : (
                <div className="matrix-rows">
                  {(
                    [
                      ['opportunityIds', t('appHiddenKindSignal'), hidden.opportunityIds],
                      ['eventKeys', t('appHiddenKindEvent'), hidden.eventKeys],
                      ['leagues', t('appHiddenKindLeague'), hidden.leagues],
                      ['bookmakers', t('appHiddenKindBook'), hidden.bookmakers],
                    ] as [HiddenEntryKind, string, string[]][]
                  ).flatMap(([kind, kindLabel, values]) =>
                    values.map((val) => (
                      <div className="matrix-row" key={`${kind}-${val}`}>
                        <div>
                          <span className="market-badge" style={{ marginRight: 8 }}>
                            {kindLabel}
                          </span>
                          <strong>
                            {kind === 'bookmakers' ? formatBookmakerName(val) : val}
                          </strong>
                        </div>
                        <button
                          type="button"
                          className="chip sm"
                          onClick={() => unhideEntry(kind, val)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )),
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast-banner ${toast.tone}`} role="status" aria-live="polite">
          <span>{toast.text}</span>
          <button className="icon-button" onClick={clearToast} aria-label={t('appCloseModal')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
