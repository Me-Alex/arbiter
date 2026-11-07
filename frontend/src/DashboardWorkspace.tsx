import { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Play,
  Radar,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { ArbitrageOpportunity, ScanSource } from './domain';
import { bookmakerColor } from './domain';
import { formatBookmakerName, runVerification, startScrape } from './api';
import { profitLabel, rankOpportunities, surebetCounts, verifiedFigures } from './claims';
import { formatAge } from './age';
import { formatKickoff, formatNum, formatPercent, sportLabel } from './format';
import { t, tf } from './i18n';
import { localizeMarketLabel } from './labels';
import { useFeedStore, useFilterStore, type FeedHealth } from './stores';
import type { WorkspaceView } from './workspace';

export function DashboardWorkspace({
  opportunities,
  scanSources,
  health,
  connection,
  onNavigate,
  onOpenOpportunity,
}: {
  opportunities: ArbitrageOpportunity[];
  scanSources: ScanSource[];
  health: FeedHealth | null;
  connection: 'disconnected' | 'connected' | 'reconnecting';
  onNavigate: (view: WorkspaceView) => void;
  onOpenOpportunity: (opp: ArbitrageOpportunity) => void;
}) {
  const applyPreset = useFilterStore((s) => s.applyPreset);
  const notify = useFeedStore((s) => s.notify);
  const refresh = useFeedStore((s) => s.refresh);
  const scrapeState = useFeedStore((s) => s.scrapeState);
  const setScrapeState = useFeedStore((s) => s.setScrapeState);
  const verifying = useFeedStore((s) => s.verifying);
  const setVerifying = useFeedStore((s) => s.setVerifying);

  const surebets = surebetCounts(opportunities);
  const figures = verifiedFigures(opportunities);
  const middlesCount = opportunities.filter((o) => o.type === 'middle').length;
  const reconciledEvCount = opportunities.filter((o) => o.type === 'positive_ev' && !o.evConsensusSuspect).length;

  const marketCounts = useMemo(() => {
    let matchOdds = 0;
    let totals = 0;
    let btts = 0;
    let handicap = 0;
    let doubleChance = 0;
    let synthetic = 0;

    for (const opp of opportunities) {
      const key = String(opp.marketKey || '').toUpperCase();
      const name = String(opp.marketName || '').toUpperCase();
      if (key.includes('SYNTHETIC') || key.startsWith('1X_') || key.startsWith('X2_') || key.startsWith('12_') || key.startsWith('DNB_')) {
        synthetic += 1;
      } else if (key === '1X2' || key === 'MATCH_ODDS' || /MATCH RESULT|MATCH WINNER/i.test(name)) {
        matchOdds += 1;
      } else if (key.includes('OVER_UNDER') || key.includes('TOTAL') || /OVER|UNDER|PESTE|SUB/i.test(name)) {
        totals += 1;
      } else if (key.includes('BTTS') || key.includes('BOTH_TEAMS') || /BOTH TEAMS/i.test(name)) {
        btts += 1;
      } else if (key.includes('HANDICAP') || key.includes('SPREAD') || /HANDICAP/i.test(name)) {
        handicap += 1;
      } else if (key.includes('DOUBLE_CHANCE') || key.includes('DC') || /DOUBLE CHANCE/i.test(name)) {
        doubleChance += 1;
      } else {
        matchOdds += 1;
      }
    }

    return { matchOdds, totals, btts, handicap, doubleChance, synthetic };
  }, [opportunities]);

  const rankedTop = rankOpportunities(
    opportunities.filter((o) => o.ruleSafety.severity !== 'blocked' && !o.evConsensusSuspect),
  ).slice(0, 6);

  const sourceTotals = health ? Object.values(health.sources).reduce((a, b) => a + b, 0) : scanSources.length;
  const freshSources = health?.sources.fresh ?? scanSources.filter((s) => s.dataStatus === 'fresh').length;
  const scanAgeSec = health?.scannedAt ? Math.max(0, Math.round((Date.now() - health.scannedAt) / 1000)) : null;
  const isStaleScan = scanAgeSec != null && scanAgeSec > 2 * 3600;
  const isScraping = scrapeState?.status === 'running';

  const handleQuickScrape = async () => {
    if (isScraping) {
      onNavigate('Scanner');
      return;
    }
    try {
      const next = await startScrape([], { includeLive: false });
      setScrapeState(next);
      notify(t('appToastScrapeStarted'), 'success');
      onNavigate('Scanner');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logFailedLaunch'), 'error');
    }
  };

  const handleQuickVerify = async () => {
    if (verifying) return;
    setVerifying(true);
    try {
      const res = await runVerification();
      await refresh();
      notify(
        tf('appToastVerifyComplete', {
          confirmed: String(res.confirmed),
          rejected: String(res.rejected),
        }),
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastVerifyFailed'), 'error');
    } finally {
      setVerifying(false);
    }
  };

  const activeSources = [...scanSources]
    .filter((s) => (s.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 10);

  return (
    <div className="workspace-stack">
      {isStaleScan && (
        <section className="panel stale-banner">
          <div className="stale-banner-text">
            <AlertTriangle size={18} color="#f59e0b" />
            <div>
              <strong>
                {tf('appStaleBannerTitle', {
                  age: formatAge(scanAgeSec, (days) => tf('appAgeDay', { n: formatNum(days) })),
                })}
              </strong>
              <span className="subtle">{t('appStaleBannerNote')}</span>
            </div>
          </div>
          <button className="action sm-action" onClick={() => void handleQuickScrape()}>
            <Play size={14} /> {isScraping ? t('appViewLiveScrape') : t('runScrape')}
          </button>
        </section>
      )}

      <section className="kpis">
        <div className="kpi clickable-kpi" onClick={() => { applyPreset('safe_surebets'); onNavigate('Opportunities'); }}>
          <div className="kpi-label">{t('appDashboardSafeSurebets')}</div>
          <div className="kpi-value green num">
            {formatNum(surebets.actionable)}
            <small className="subtle"> / {formatNum(surebets.total)}</small>
          </div>
          <span className="subtle">
            {figures.guaranteed > 0
              ? `${t('appBestGuaranteed')}: +${formatPercent(figures.guaranteed, 2)}`
              : t('appRuleSafeAvailable')}
          </span>
        </div>

        <div className="kpi clickable-kpi" onClick={() => { applyPreset('middles'); onNavigate('Opportunities'); }}>
          <div className="kpi-label">{t('middlesLabel')}</div>
          <div className="kpi-value purple num">{formatNum(middlesCount)}</div>
          <span className="subtle">{t('appDashboardMiddlesHint')}</span>
        </div>

        <div className="kpi clickable-kpi" onClick={() => { applyPreset('verified_ev'); onNavigate('Opportunities'); }}>
          <div className="kpi-label">{t('appDashboardReconciledEv')}</div>
          <div className="kpi-value amber num">{formatNum(reconciledEvCount)}</div>
          <span className="subtle">
            {figures.expectedEdge > 0
              ? `${t('appClaimExpectedEdge')}: +${formatPercent(figures.expectedEdge, 2)}`
              : t('appDashboardEvHint')}
          </span>
        </div>

        <div className="kpi clickable-kpi" onClick={() => onNavigate('Bookmakers')}>
          <div className="kpi-label">{t('appFeedHealth')}</div>
          <div className="kpi-value num">
            {formatNum(freshSources)}
            <small className="subtle"> / {formatNum(sourceTotals)}</small>
          </div>
          <span className="subtle">
            {tf('appEventsScannedCount', { n: formatNum(health?.eventCount ?? 0) })} ·{' '}
            {connection === 'connected' ? t('appConnectedWord') : t('appReconnectingWord')}
          </span>
        </div>
      </section>

      <section className="panel toolbar quick-actions-bar">
        <span className="eyebrow" style={{ marginRight: 6 }}>{t('appQuickActions')}</span>
        <button className="chip active" onClick={() => { applyPreset('safe_surebets'); onNavigate('Opportunities'); }}>
          <CheckCircle2 size={14} /> {t('appPresetSafeSurebets')}
        </button>
        <button className="chip" onClick={() => void handleQuickScrape()}>
          <Radar size={14} /> {isScraping ? t('appViewLiveScrape') : t('appCollectFreshOdds')}
        </button>
        <button className="chip" disabled={verifying} onClick={() => void handleQuickVerify()}>
          <ShieldCheck size={14} /> {t('appVerifyAllSurebets')}
        </button>
        <button className="chip" onClick={() => onNavigate('Analytics')}>
          <TrendingUp size={14} /> {t('tracker')}
        </button>
        <button className="chip" onClick={() => onNavigate('Bookmakers')}>
          <BookOpen size={14} /> {t('appExploreSources')}
        </button>
      </section>

      <section className="panel" style={{ padding: '10px 14px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="eyebrow">{t('discoveredMarkets')}</span>
          <span className="subtle" style={{ fontSize: '0.75rem' }}>{t('marketCatalog')}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <div className="chip sm active">
            <span>{t('marketMatchResult')}</span>: <strong className="num">{formatNum(marketCounts.matchOdds)}</strong>
          </div>
          <div className="chip sm">
            <span>{t('marketOverUnder')}</span>: <strong className="num">{formatNum(marketCounts.totals)}</strong>
          </div>
          <div className="chip sm">
            <span>{t('marketBothTeamsScore')}</span>: <strong className="num">{formatNum(marketCounts.btts)}</strong>
          </div>
          <div className="chip sm">
            <span>{t('marketAsianHandicap')}</span>: <strong className="num">{formatNum(marketCounts.handicap)}</strong>
          </div>
          <div className="chip sm">
            <span>{t('marketDoubleChance')}</span>: <strong className="num">{formatNum(marketCounts.doubleChance)}</strong>
          </div>
          <div className="chip sm">
            <span>{t('marketSyntheticEquivalence')}</span>: <strong className="num">{formatNum(marketCounts.synthetic)}</strong>
          </div>
        </div>
      </section>

      <div className="dashboard-columns">
        <section className="panel workspace-table">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('appDecisionQueue')}</div>
              <h3>{t('appTopOpportunitiesNow')}</h3>
            </div>
            <button className="chip sm" onClick={() => onNavigate('Opportunities')}>
              {t('appViewAllSignals')} <ArrowRight size={13} />
            </button>
          </div>

          {rankedTop.length === 0 ? (
            <div className="state-panel">
              <Activity size={18} />
              <span className="subtle">{t('appNoMatches')}</span>
            </div>
          ) : (
            <div className="preview-list">
              {rankedTop.map((opp) => {
                const label = profitLabel(opp, formatPercent);
                return (
                  <button
                    key={opp.id}
                    className="preview-row"
                    onClick={() => onOpenOpportunity(opp)}
                  >
                    <div className="preview-main">
                      <div className="opp-meta">
                        <span className={`type-tag ${opp.type === 'middle' ? 'middle' : opp.type === 'positive_ev' ? 'ev' : ''}`}>
                          {opp.type === 'surebet' ? t('surebet') : opp.type === 'middle' ? t('middleChip') : '+EV'}
                        </span>
                        {opp.ruleSafety.severity === 'safe' && <span className="safe-tag">{t('appRulesSafe')}</span>}
                        <span>{sportLabel(opp.sport)}</span>
                        <span>·</span>
                        <span>{formatKickoff(opp.startTime)}</span>
                      </div>
                      <strong>{opp.homeTeam} {t('vs')} {opp.awayTeam}</strong>
                      <span className="subtle">
                        {localizeMarketLabel(opp.marketName, t)} · {opp.legs.map((l) => `${l.bookmakerName} (${l.effectiveOdds.toFixed(2)})`).join(' / ')}
                      </span>
                    </div>
                    <div className="profit-cell">
                      <strong className={`profit num ${opp.type === 'middle' ? 'purple' : opp.type === 'positive_ev' ? 'amber' : ''} ${label.tone}`}>
                        {label.value}
                      </strong>
                      <small className="subtle">{t(label.qualifier)}</small>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel workspace-table">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('appSourceMatrix')}</div>
              <h3>{t('appTopActiveFeeds')}</h3>
            </div>
            <button className="chip sm" onClick={() => onNavigate('Bookmakers')}>
              {t('appAllBookmakersBtn')} <ArrowRight size={13} />
            </button>
          </div>

          {activeSources.length === 0 ? (
            <div className="subtle" style={{ padding: '12px 0' }}>{t('appFeedUnknown')}</div>
          ) : (
            <div>
              {activeSources.map((src) => (
                <div className="source-row compact-source-row" key={src.sourceId}>
                  <span className="book-dot" style={{ background: bookmakerColor(src.sourceId) }} />
                  <strong>{formatBookmakerName(src.sourceId)}</strong>
                  <span className="subtle num">{formatNum(src.count ?? 0)} {t('events').toLowerCase()}</span>
                  <span className={src.dataStatus === 'fresh' ? 'safe-tag' : 'risk-tag unverified'}>
                    {src.dataStatus === 'fresh' ? t('fresh') : src.dataStatus ?? t('unknown')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
