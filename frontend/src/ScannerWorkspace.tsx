import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Play,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Zap,
} from 'lucide-react';
import type {
  LivePollStatus,
  ScanProfile,
  ScraperJob,
  ScrapeJobProgress,
  ScrapeRunReport,
  SchedulerStatus,
  SportOption,
} from './domain';
import { bookmakerColor } from './domain';
import {
  cancelScrape,
  fetchLatestScrapeRun,
  fetchLiveStatus,
  fetchProfiles,
  fetchScheduler,
  fetchScrapers,
  fetchSports,
  formatBookmakerName,
  runCustomScan,
  runVerification,
  saveLiveStatus,
  saveScheduler,
  startScrape,
} from './api';
import { formatNum } from './format';
import { t, tf } from './i18n';
import { useFeedStore } from './stores';

type JobFilterMode = 'active' | 'failed' | 'all';

function jobEventCount(job: ScrapeJobProgress): number {
  const raw = (job as ScrapeJobProgress & { events?: number }).events ?? job.eventsCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function isJobHealthy(job: ScrapeJobProgress): boolean {
  return (job.status === 'completed' || job.status === 'ok') && jobEventCount(job) > 0;
}

export function ScannerWorkspace({ onViewOpportunities }: { onViewOpportunities: () => void }) {
  const scrapeState = useFeedStore((s) => s.scrapeState);
  const setScrapeState = useFeedStore((s) => s.setScrapeState);
  const verifying = useFeedStore((s) => s.verifying);
  const setVerifying = useFeedStore((s) => s.setVerifying);
  const verificationSummary = useFeedStore((s) => s.verificationSummary);
  const notify = useFeedStore((s) => s.notify);
  const refresh = useFeedStore((s) => s.refresh);

  const [scrapers, setScrapers] = useState<ScraperJob[]>([]);
  const [sports, setSports] = useState<SportOption[]>([]);
  const [profiles, setProfiles] = useState<ScanProfile[]>([]);
  const [latestRun, setLatestRun] = useState<ScrapeRunReport | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [livePoll, setLivePoll] = useState<LivePollStatus | null>(null);

  const [activeProfileId, setActiveProfileId] = useState<string>('trusted-prematch');
  const [selectedSport, setSelectedSport] = useState<string>('');
  const [includeLive, setIncludeLive] = useState<boolean>(false);
  const [minMargin, setMinMargin] = useState<number>(0);
  const [maxEvents, setMaxEvents] = useState<string>('all');
  const [bookScope, setBookScope] = useState<'validated' | 'custom'>('validated');
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [rescanning, setRescanning] = useState(false);

  const [jobFilter, setJobFilter] = useState<JobFilterMode>('active');
  const [jobSearch, setJobSearch] = useState<string>('');

  const [schedMinutes, setSchedMinutes] = useState<number>(15);
  const [liveSeconds, setLiveSeconds] = useState<number>(30);
  const [savingAuto, setSavingAuto] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchScrapers().catch(() => ({ jobs: [], enabledJobs: [], validatedJobs: [], experimentalJobs: [] })),
      fetchSports().catch(() => []),
      fetchProfiles().catch(() => []),
      fetchLatestScrapeRun().catch(() => ({ jobs: [] })),
      fetchScheduler().catch(() => null),
      fetchLiveStatus().catch(() => null),
    ]).then(([scr, sp, prof, run, sched, lv]) => {
      if (!active) return;
      setScrapers(scr.enabledJobs.length ? scr.enabledJobs : scr.jobs);
      setSelectedBooks(new Set(scr.validatedJobs.map((j) => j.id)));
      setSports(sp);
      setProfiles(prof);
      setLatestRun(run);
      if (sched) {
        setScheduler(sched);
        if (sched.intervalMinutes) setSchedMinutes(sched.intervalMinutes);
      }
      if (lv) {
        setLivePoll(lv);
        if (lv.intervalSeconds) setLiveSeconds(lv.intervalSeconds);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const isRunning = scrapeState?.status === 'running';
  const activeJobs = useMemo(
    () =>
      scrapeState?.jobs && scrapeState.jobs.length > 0
        ? scrapeState.jobs
        : (latestRun?.jobs ?? []),
    [scrapeState?.jobs, latestRun?.jobs],
  );
  const totalJobs = activeJobs.length;
  const completedJobs = activeJobs.filter(
    (j) => j.status === 'completed' || j.status === 'ok' || j.status === 'failed' || j.status === 'skipped',
  ).length;
  const progressPct = totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0;

  const jobSummary = useMemo(() => {
    let working = 0;
    let unavailable = 0;
    let totalEvents = 0;
    for (const job of activeJobs) {
      const ev = jobEventCount(job);
      totalEvents += ev;
      if (isJobHealthy(job)) working += 1;
      else if (job.status === 'failed' || job.status === 'skipped' || ev === 0) unavailable += 1;
    }
    return { working, unavailable, totalEvents };
  }, [activeJobs]);

  const effectiveJobFilter: JobFilterMode =
    isRunning ? 'all' : jobFilter === 'active' && jobSummary.working === 0 ? 'all' : jobFilter;

  const visibleJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    return [...activeJobs]
      .filter((job) => {
        if (effectiveJobFilter === 'active' && !isJobHealthy(job)) return false;
        if (effectiveJobFilter === 'failed' && isJobHealthy(job)) return false;
        if (q) {
          const name = `${formatBookmakerName(job.id)} ${job.id}`.toLowerCase();
          if (!name.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => jobEventCount(b) - jobEventCount(a) || a.id.localeCompare(b.id));
  }, [activeJobs, effectiveJobFilter, jobSearch]);

  const applyProfile = (profile: ScanProfile) => {
    setActiveProfileId(profile.id);
    setIncludeLive(Boolean(profile.defaults.includeLive));
    setMinMargin(Number(profile.defaults.minMarginPercent ?? 0));
  };

  const toggleBook = (id: string) => {
    setSelectedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLaunchScrape = async () => {
    const bookIds = bookScope === 'custom' ? [...selectedBooks] : [];
    if (bookScope === 'custom' && bookIds.length === 0) {
      notify(t('appSelectAtLeastOneBook'), 'error');
      return;
    }
    try {
      const scanOptions: Record<string, unknown> = {
        includeLive,
        minMarginPercent: minMargin,
        maxEvents: maxEvents !== 'all' ? Number(maxEvents) : 'all',
      };
      if (selectedSport) scanOptions.sport = selectedSport;
      const state = await startScrape(bookIds, scanOptions);
      setScrapeState(state);
      notify(t('appToastScrapeStarted'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logFailedLaunch'), 'error');
    }
  };

  const handleCancelScrape = async () => {
    try {
      await cancelScrape();
      notify(t('logCancellationRequested'), 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logUnableCancel'), 'error');
    }
  };

  const handleRescanDisk = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      const scanOptions: Record<string, unknown> = {
        includeLive,
        minMarginPercent: minMargin,
        maxEvents: maxEvents !== 'all' ? Number(maxEvents) : 'all',
      };
      if (selectedSport) scanOptions.sport = selectedSport;
      await runCustomScan(scanOptions);
      await refresh();
      notify(t('appToastRescanComplete'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appFeedLoadFailed'), 'error');
    } finally {
      setRescanning(false);
    }
  };

  const handleVerifyAll = async () => {
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

  const handleToggleScheduler = async (enable: boolean) => {
    setSavingAuto(true);
    try {
      const updated = await saveScheduler({
        enabled: enable,
        intervalMinutes: Math.max(1, schedMinutes),
        scanOptions: { includeLive, minMarginPercent: minMargin },
      });
      setScheduler(updated);
      notify(
        enable
          ? tf('logSchedulerEnabled', { minutes: String(updated.intervalMinutes || schedMinutes) })
          : tf('logSchedulerDisabled', { minutes: String(schedMinutes) }),
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logUnableSaveScheduler'), 'error');
    } finally {
      setSavingAuto(false);
    }
  };

  const handleToggleLivePoll = async (enable: boolean) => {
    setSavingAuto(true);
    try {
      const updated = await saveLiveStatus({
        enabled: enable,
        intervalSeconds: Math.max(5, liveSeconds),
        scanOptions: { includeLive: true },
      });
      setLivePoll(updated);
      notify(
        enable
          ? tf('logLivePollEnabled', { seconds: String(updated.intervalSeconds || liveSeconds) })
          : tf('logLivePollDisabled', { seconds: String(liveSeconds) }),
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : t('logUnableSaveLive'), 'error');
    } finally {
      setSavingAuto(false);
    }
  };

  const rawRunStatus = scrapeState?.status ?? latestRun?.status ?? 'idle';
  const humanRunBadge = isRunning
    ? `${progressPct}%`
    : rawRunStatus === 'idle'
      ? t('appScannerRunIdle')
      : t('appScannerRunComplete');

  return (
    <div className="workspace-stack">
      <section className="panel workspace-table">
        <div className="section-head">
          <div>
            <div className="eyebrow">{t('scrapeControl')}</div>
            <h3>{t('appScannerLaunchTitle')}</h3>
            <span className="subtle">{t('appScannerLaunchSubtitle')}</span>
          </div>
          <div className="inline-actions">
            {isRunning ? (
              <button className="action danger-action sm-action" onClick={() => void handleCancelScrape()}>
                <Square size={14} /> {t('cancel')}
              </button>
            ) : (
              <button className="action sm-action" onClick={() => void handleLaunchScrape()}>
                <Play size={14} /> {t('runScrape')}
              </button>
            )}
          </div>
        </div>

        {profiles.length > 0 && (
          <div className="profile-cards">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={`panel profile-card ${activeProfileId === p.id ? 'selected' : ''}`}
                onClick={() => applyProfile(p)}
              >
                <div className="opp-meta">
                  <span className={p.mode === 'trusted' ? 'safe-tag' : 'risk-tag'}>
                    {p.mode === 'trusted' ? t('trusted') : t('review')}
                  </span>
                  <strong>{p.label}</strong>
                </div>
                <span className="subtle">{p.description}</span>
              </button>
            ))}
          </div>
        )}

        <div className="scanner-controls-grid">
          <div className="control-field">
            <label htmlFor="scanner-sport">{t('appFilterSport')}</label>
            <select
              id="scanner-sport"
              className="select"
              value={selectedSport}
              onChange={(e) => setSelectedSport(e.target.value)}
            >
              <option value="">{t('appAllSports')}</option>
              {sports.map((sp) => (
                <option key={sp.id} value={sp.id}>{sp.name}</option>
              ))}
            </select>
          </div>

          <div className="control-field">
            <label htmlFor="scanner-min-margin">{t('appMinMarginLabel')}</label>
            <input
              id="scanner-min-margin"
              className="select num"
              type="number"
              step={0.5}
              min={0}
              max={25}
              value={minMargin}
              onChange={(e) => setMinMargin(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>

          <div className="control-field">
            <label htmlFor="scanner-max-events">{t('limit')}</label>
            <select
              id="scanner-max-events"
              className="select"
              value={maxEvents}
              onChange={(e) => setMaxEvents(e.target.value)}
            >
              <option value="all">{t('allEvents')}</option>
              <option value="500">500</option>
              <option value="200">200</option>
              <option value="100">100</option>
            </select>
          </div>

          <div className="control-field">
            <label>{t('appMatchTimingLabel')}</label>
            <button
              type="button"
              className={`chip ${includeLive ? 'active' : ''}`}
              onClick={() => setIncludeLive((v) => !v)}
            >
              <Zap size={13} /> {includeLive ? t('appIncludeLiveOn') : t('profileScopePrematch')}
            </button>
          </div>

          <div className="control-field">
            <label>{t('sources')}</label>
            <div className="inline-actions">
              <button
                type="button"
                className={`chip sm ${bookScope === 'validated' ? 'active' : ''}`}
                onClick={() => setBookScope('validated')}
              >
                {t('appAllValidatedBooks')}
              </button>
              <button
                type="button"
                className={`chip sm ${bookScope === 'custom' ? 'active' : ''}`}
                onClick={() => setBookScope('custom')}
              >
                {tf('appCustomBooksCount', { n: String(selectedBooks.size) })}
              </button>
            </div>
          </div>
        </div>

        {bookScope === 'custom' && scrapers.length > 0 && (
          <div className="book-picker">
            <div className="inline-actions" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="chip sm"
                onClick={() => setSelectedBooks(new Set(scrapers.map((s) => s.id)))}
              >
                {t('appSelectAllBooks')}
              </button>
              <button
                type="button"
                className="chip sm"
                onClick={() => setSelectedBooks(new Set())}
              >
                {t('appClearSelection')}
              </button>
            </div>
            <div className="book-pills">
              {scrapers.map((job) => {
                const checked = selectedBooks.has(job.id);
                return (
                  <button
                    type="button"
                    key={job.id}
                    className={`chip sm ${checked ? 'active' : ''}`}
                    onClick={() => toggleBook(job.id)}
                  >
                    <span className="book-dot" style={{ background: bookmakerColor(job.id) }} />
                    {formatBookmakerName(job.id)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
          <button className="chip" disabled={rescanning || isRunning} onClick={() => void handleRescanDisk()}>
            <RefreshCw size={14} className={rescanning ? 'spin' : ''} /> {t('appRescanSavedSnapshots')}
          </button>
          <button className="chip" disabled={verifying || isRunning} onClick={() => void handleVerifyAll()}>
            <ShieldCheck size={14} className={verifying ? 'spin' : ''} /> {t('appVerifyAllSurebets')}
          </button>
          <button className="chip active" style={{ marginLeft: 'auto' }} onClick={onViewOpportunities}>
            <CheckCircle2 size={14} /> {t('appOpenWorkstationBtn')}
          </button>
        </div>
      </section>

      <section className="panel workspace-table">
        <div className="section-head">
          <div>
            <div className="eyebrow">{t('scrapeProgressTrack')}</div>
            <h3>
              {isRunning
                ? `${t('scraping')} (${completedJobs}/${totalJobs})`
                : scrapeState?.status === 'completed' || latestRun?.status
                  ? t('lastRunResultsCaption')
                  : t('runStatusLabel')}
            </h3>
            {scrapeState?.currentActivity && <span className="subtle">{scrapeState.currentActivity}</span>}
          </div>
          <span className={isRunning || jobSummary.working > 0 ? 'safe-tag' : 'market-badge'}>
            {humanRunBadge}
          </span>
        </div>

        {(isRunning || totalJobs > 0) && (
          <div className="ttl" style={{ height: 6, margin: '8px 0 12px' }}>
            <span style={{ width: `${isRunning ? Math.max(5, progressPct) : 100}%` }} />
          </div>
        )}

        {activeJobs.length > 0 && (
          <div className="scanner-run-summary">
            <div className="opp-meta">
              <span className="safe-tag">
                {tf('appScannerSummaryWorking', { n: formatNum(jobSummary.working) })}
              </span>
              <span className="market-badge num">
                {tf('appScannerSummaryEvents', { n: formatNum(jobSummary.totalEvents) })}
              </span>
              {jobSummary.unavailable > 0 && (
                <span className="risk-tag unverified">
                  {tf('appScannerSummaryUnavailable', { n: formatNum(jobSummary.unavailable) })}
                </span>
              )}
              {verificationSummary && (
                <>
                  <span className="safe-tag">{t('confirmed')}: {formatNum(verificationSummary.confirmed ?? 0)}</span>
                  <span className="risk-tag">{t('rejected')}: {formatNum(verificationSummary.rejected ?? 0)}</span>
                </>
              )}
            </div>
            {jobSummary.unavailable > 0 && (
              <span className="subtle" style={{ display: 'block', marginTop: 6 }}>
                {t('appScannerOfflineNote')}
              </span>
            )}
          </div>
        )}

        {activeJobs.length > 0 && (
          <div className="toolbar" style={{ padding: '0 0 10px', marginBottom: 8 }}>
            <button
              type="button"
              className={`chip sm ${effectiveJobFilter === 'active' ? 'active' : ''}`}
              onClick={() => setJobFilter('active')}
            >
              {tf('appScannerFilterActive', { n: formatNum(jobSummary.working) })}
            </button>
            <button
              type="button"
              className={`chip sm ${effectiveJobFilter === 'failed' ? 'active' : ''}`}
              onClick={() => setJobFilter('failed')}
            >
              {tf('appScannerFilterFailed', { n: formatNum(jobSummary.unavailable) })}
            </button>
            <button
              type="button"
              className={`chip sm ${effectiveJobFilter === 'all' ? 'active' : ''}`}
              onClick={() => setJobFilter('all')}
            >
              {tf('appScannerFilterAll', { n: formatNum(activeJobs.length) })}
            </button>

            <div className="search-input-wrap" style={{ marginLeft: 'auto' }}>
              <Search size={13} color="#728199" />
              <input
                className="select sm-select"
                placeholder={t('filterSourcesLabel')}
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
              />
            </div>
          </div>
        )}

        {activeJobs.length === 0 ? (
          <div className="subtle">{t('appNoScrapeJobsYet')}</div>
        ) : (
          <div className="job-grid">
            {visibleJobs.map((job) => {
              const evCount = jobEventCount(job);
              const healthy = isJobHealthy(job);
              return (
                <div className="job-pill" key={job.id} title={job.error ?? undefined}>
                  <div className="leg-book">
                    <span className="book-dot" style={{ background: bookmakerColor(job.id) }} />
                    <strong>{formatBookmakerName(job.id)}</strong>
                  </div>
                  <div className="opp-meta" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <span className="num">
                      {`${formatNum(evCount)} ${t('events').toLowerCase()}`}
                    </span>
                    <span
                      className={
                        healthy
                          ? 'safe-tag'
                          : job.status === 'running'
                            ? 'type-tag'
                            : 'risk-tag unverified'
                      }
                    >
                      {healthy
                        ? t('appJobStatusOk')
                        : job.status === 'running'
                          ? t('running')
                          : t('appJobStatusUnavailable')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="workspace-grid">
        <section className="panel workspace-card">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('scheduler')}</div>
              <h3>{t('appAutoScheduleTitle')}</h3>
            </div>
            <span className={scheduler?.enabled ? 'safe-tag' : 'risk-tag unverified'}>
              {scheduler?.enabled ? t('appEnabled') : t('appMuted')}
            </span>
          </div>
          <span className="subtle">{t('appAutoScheduleDesc')}</span>
          <div className="inline-actions" style={{ marginTop: 8 }}>
            <label htmlFor="sched-interval" className="subtle">{t('interval')}</label>
            <input
              id="sched-interval"
              type="number"
              min={1}
              max={240}
              className="select num"
              style={{ width: 90 }}
              value={schedMinutes}
              onChange={(e) => setSchedMinutes(Math.max(1, Number(e.target.value) || 15))}
            />
            <button
              className={`chip ${scheduler?.enabled ? '' : 'active'}`}
              disabled={savingAuto}
              onClick={() => void handleToggleScheduler(!scheduler?.enabled)}
            >
              <Clock size={13} /> {scheduler?.enabled ? t('appDisableBtn') : t('appEnableBtn')}
            </button>
          </div>
        </section>

        <section className="panel workspace-card">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('live')}</div>
              <h3>{t('appLivePollingTitle')}</h3>
            </div>
            <span className={livePoll?.enabled ? 'safe-tag' : 'risk-tag unverified'}>
              {livePoll?.enabled ? t('appEnabled') : t('appMuted')}
            </span>
          </div>
          <span className="subtle">{t('appLivePollingDesc')}</span>
          <div className="inline-actions" style={{ marginTop: 8 }}>
            <label htmlFor="live-interval" className="subtle">{t('appIntervalSeconds')}</label>
            <input
              id="live-interval"
              type="number"
              min={5}
              max={300}
              className="select num"
              style={{ width: 90 }}
              value={liveSeconds}
              onChange={(e) => setLiveSeconds(Math.max(5, Number(e.target.value) || 30))}
            />
            <button
              className={`chip ${livePoll?.enabled ? '' : 'active'}`}
              disabled={savingAuto}
              onClick={() => void handleToggleLivePoll(!livePoll?.enabled)}
            >
              <Radar size={13} /> {livePoll?.enabled ? t('appDisableBtn') : t('appEnableBtn')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
