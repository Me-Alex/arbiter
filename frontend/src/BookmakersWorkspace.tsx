import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Info, Play, Search, Zap } from 'lucide-react';
import type { ArbitrageOpportunity, ScanSource, ScraperJob } from './domain';
import { BOOKMAKERS, bookmakerColor } from './domain';
import { bookActivity, fetchScrapers, formatBookmakerName, startScrape } from './api';
import { formatAge } from './age';
import { formatNum } from './format';
import { t, tf } from './i18n';
import { useFeedStore, useFilterStore } from './stores';

const overtimeLabels: Record<string, string> = {
  includes_ot: 'appIncludesOt',
  regulation_only: 'appRegulationOnly',
  includes_ot_so: 'appIncludesOtSo',
};
const retirementLabels: Record<string, string> = {
  one_ball: 'appOneBall',
  one_set: 'appOneSet',
  match_completion: 'appFullMatch',
};

type BookFilter = 'all' | 'pricing' | 'fresh' | 'live' | 'clones';

function realCaptureAgeSec(source?: ScanSource): number | null {
  if (!source) return null;
  if (source.capturedAt) {
    const ts = Date.parse(source.capturedAt);
    if (Number.isFinite(ts)) {
      return Math.max(0, Math.round((Date.now() - ts) / 1000));
    }
  }
  if (source.ageMs != null && Number.isFinite(source.ageMs)) {
    return Math.max(0, Math.round(source.ageMs / 1000));
  }
  return null;
}

export function BookmakersWorkspace({
  opportunities,
  scanSources,
  onSelectBookmaker,
  onOpenScanner,
}: {
  opportunities: ArbitrageOpportunity[];
  scanSources: ScanSource[];
  onSelectBookmaker: (bookmakerId: string) => void;
  onOpenScanner: () => void;
}) {
  const [jobs, setJobs] = useState<ScraperJob[]>([]);
  const [filter, setFilter] = useState<BookFilter>('all');
  const [search, setSearch] = useState('');
  const notify = useFeedStore((s) => s.notify);
  const setScrapeState = useFeedStore((s) => s.setScrapeState);
  const scrapeState = useFeedStore((s) => s.scrapeState);
  const setCriteria = useFilterStore((s) => s.setCriteria);

  useEffect(() => {
    let active = true;
    fetchScrapers()
      .then((res) => {
        if (active) setJobs(res.jobs);
      })
      .catch(() => {
        /* fallback to scanSources */
      });
    return () => {
      active = false;
    };
  }, []);

  const activity = useMemo(() => bookActivity(opportunities), [opportunities]);
  const rulesByBook = useMemo(() => new Map(BOOKMAKERS.map((b) => [b.id, b.rules])), []);

  const mergedRows = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string;
        name: string;
        job?: ScraperJob;
        source?: ScanSource;
        pricedLegs: number;
        opportunitiesCount: number;
      }
    >();

    for (const job of jobs) {
      byId.set(job.id, {
        id: job.id,
        name: formatBookmakerName(job.id),
        job,
        pricedLegs: activity.get(job.id)?.pricedLegs ?? 0,
        opportunitiesCount: activity.get(job.id)?.opportunities ?? 0,
      });
    }

    for (const src of scanSources) {
      const existing = byId.get(src.sourceId);
      if (existing) {
        existing.source = src;
      } else {
        byId.set(src.sourceId, {
          id: src.sourceId,
          name: formatBookmakerName(src.sourceId),
          source: src,
          pricedLegs: activity.get(src.sourceId)?.pricedLegs ?? 0,
          opportunitiesCount: activity.get(src.sourceId)?.opportunities ?? 0,
        });
      }
    }

    for (const book of BOOKMAKERS) {
      if (!byId.has(book.id)) {
        byId.set(book.id, {
          id: book.id,
          name: book.name,
          pricedLegs: activity.get(book.id)?.pricedLegs ?? 0,
          opportunitiesCount: activity.get(book.id)?.opportunities ?? 0,
        });
      }
    }

    return [...byId.values()].sort(
      (a, b) =>
        b.opportunitiesCount - a.opportunitiesCount ||
        (b.source?.count ?? 0) - (a.source?.count ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }, [jobs, scanSources, activity]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mergedRows.filter((row) => {
      if (filter === 'pricing' && row.pricedLegs === 0) return false;
      if (filter === 'fresh' && row.source?.dataStatus !== 'fresh') return false;
      if (filter === 'live' && row.job?.liveCapability?.inPlay !== 'supported') return false;
      if (filter === 'clones' && !(row.source?.sharedFeedWith && row.source.sharedFeedWith.length > 0)) return false;
      if (q) {
        const hay = `${row.name} ${row.id} ${row.job?.platform ?? ''} ${row.source?.feedGroup ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [mergedRows, filter, search]);

  const pricingCount = mergedRows.filter((r) => r.pricedLegs > 0).length;
  const freshCount = mergedRows.filter((r) => r.source?.dataStatus === 'fresh').length;
  const liveCapableCount = mergedRows.filter((r) => r.job?.liveCapability?.inPlay === 'supported').length;
  const cloneCount = mergedRows.filter((r) => (r.source?.sharedFeedWith?.length ?? 0) > 0).length;

  const handleScrapeSingle = async (bookId: string) => {
    if (scrapeState?.status === 'running') {
      onOpenScanner();
      return;
    }
    try {
      const next = await startScrape([bookId], {});
      setScrapeState(next);
      notify(tf('appToastSingleBookScrape', { book: formatBookmakerName(bookId) }), 'success');
      onOpenScanner();
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logFailedLaunch'), 'error');
    }
  };

  return (
    <div className="workspace-stack">
      <section className="kpis">
        <div className="kpi clickable-kpi" onClick={() => setFilter('all')}>
          <div className="kpi-label">{t('sources')}</div>
          <div className="kpi-value num">{formatNum(mergedRows.length)}</div>
          <span className="subtle">{t('appSourceMatrix')}</span>
        </div>
        <div className="kpi clickable-kpi" onClick={() => setFilter('pricing')}>
          <div className="kpi-label">{t('appPricing')}</div>
          <div className="kpi-value green num">{formatNum(pricingCount)}</div>
          <span className="subtle">{t('appBooksWithSignals')}</span>
        </div>
        <div className="kpi clickable-kpi" onClick={() => setFilter('fresh')}>
          <div className="kpi-label">{t('fresh')}</div>
          <div className="kpi-value green num">{formatNum(freshCount)}</div>
          <span className="subtle">{t('appFreshCapturesHint')}</span>
        </div>
        <div className="kpi clickable-kpi" onClick={() => setFilter('clones')}>
          <div className="kpi-label">{t('appSharedFeedsLabel')}</div>
          <div className="kpi-value purple num">{formatNum(cloneCount)}</div>
          <span className="subtle">{t('appSharedFeedsHint')}</span>
        </div>
      </section>

      <section className="panel toolbar">
        <BookOpen size={15} color="#728199" />
        {(
          [
            ['all', tf('appAllBookmakersCount', { n: formatNum(mergedRows.length) })],
            ['pricing', `${t('appPricing')} (${formatNum(pricingCount)})`],
            ['fresh', `${t('statusFresh')} (${formatNum(freshCount)})`],
            ['live', `${t('live')} (${formatNum(liveCapableCount)})`],
            ['clones', `${t('appSharedFeedsLabel')} (${formatNum(cloneCount)})`],
          ] as [BookFilter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`chip ${filter === key ? 'active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}

        <div className="search-input-wrap" style={{ marginLeft: 'auto' }}>
          <Search size={14} color="#728199" />
          <input
            className="select"
            placeholder={t('filterSourcesLabel')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

      {cloneCount > 0 && (
        <section className="panel workspace-card" style={{ padding: '11px 15px' }}>
          <div className="opp-meta" style={{ fontSize: 12 }}>
            <Info size={14} color="#728199" />
            <span>{t('appSharedFeedsBanner')}</span>
          </div>
        </section>
      )}

      <section className="panel workspace-table">
        <div className="eyebrow" style={{ marginBottom: 8 }}>{t('appSourceMatrix')}</div>
        {filtered.length === 0 ? (
          <div className="subtle" style={{ padding: '14px 0' }}>{t('appNoMatches')}</div>
        ) : (
          filtered.map((row) => {
            const rules = rulesByBook.get(row.id);
            const eventsCount = row.source?.count ?? 0;
            const ageSec = realCaptureAgeSec(row.source);
            const shared = row.source?.sharedFeedWith ?? [];
            const inPlaySupported = row.job?.liveCapability?.inPlay === 'supported';

            return (
              <div className="source-row rich-source-row" key={row.id}>
                <span className="book-dot" style={{ background: bookmakerColor(row.id) }} />
                <div>
                  <strong>{row.name}</strong>
                  <div className="opp-meta" style={{ marginTop: 3 }}>
                    {row.job?.validationStatus === 'validated' && (
                      <span className="safe-tag">{t('validatedGroup')}</span>
                    )}
                    {inPlaySupported && (
                      <span className="type-tag"><Zap size={10} /> {t('live')}</span>
                    )}
                    {shared.length > 0 && (
                      <span
                        className="risk-tag unverified"
                        title={tf('appSharedCloneTooltip', { peers: shared.map(formatBookmakerName).join(', ') })}
                      >
                        {t('appCloneBadge')}: {row.source?.feedGroup ?? shared[0]}
                      </span>
                    )}
                  </div>
                </div>

                <div className="subtle">
                  <div>
                    {row.pricedLegs > 0
                      ? tf('appPricedLegs', {
                          legs: formatNum(row.pricedLegs),
                          markets: formatNum(row.opportunitiesCount),
                        })
                      : t('appNoPricedLegs')}
                    {eventsCount > 0 && ` · ${formatNum(eventsCount)} ${t('events').toLowerCase()}`}
                    {ageSec != null &&
                      ` · ${formatAge(ageSec, (days) => tf('appAgeDay', { n: formatNum(days) }))}`}
                  </div>
                  {rules && (
                    <div style={{ marginTop: 2 }}>
                      {tf('appBookRules', {
                        tennis: t(retirementLabels[rules.tennis_retirement] ?? rules.tennis_retirement),
                        basketball: t(overtimeLabels[rules.basketball_2way] ?? rules.basketball_2way),
                      })}
                    </div>
                  )}
                </div>

                <div className="inline-actions">
                  {row.opportunitiesCount > 0 && (
                    <button
                      className="chip sm active"
                      onClick={() => {
                        setCriteria({ bookmaker: row.id });
                        onSelectBookmaker(row.id);
                      }}
                    >
                      {formatNum(row.opportunitiesCount)} {t('opps')}
                    </button>
                  )}
                  {row.job && (
                    <button
                      className="chip sm"
                      title={tf('appScrapeSingleBookTitle', { book: row.name })}
                      onClick={() => void handleScrapeSingle(row.id)}
                    >
                      <Play size={12} /> {t('scrape')}
                    </button>
                  )}
                  <span className={row.pricedLegs > 0 ? 'source-online' : 'risk-tag unverified'}>
                    {row.pricedLegs > 0 ? t('appPricing') : t('appNoPrices')}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
