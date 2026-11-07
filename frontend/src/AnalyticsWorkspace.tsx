import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ArbitrageOpportunity, Sport, TrackedBet } from './domain';
import { bookmakerColor } from './domain';
import {
  addTrackedBet,
  bookActivity,
  canonicalizeRawMarketLabel,
  deleteTrackedBet,
  fetchCatalog,
  fetchTracker,
  formatBookmakerName,
  importTrackerCsv,
  trackerExportUrl,
  updateTrackedBet,
} from './api';
import { verifiedFigures } from './claims';
import { formatMoney, formatNum, formatPercent, sportLabel } from './format';
import { t, tf } from './i18n';
import { localizeMarketLabel } from './labels';
import { useFeedStore, useFilterStore } from './stores';

type BetStatusFilter = 'all' | 'pending' | 'won' | 'lost' | 'void';

interface CatalogMarketRow {
  sourceId: string;
  marketKey: string;
  marketName?: string;
  eventCount: number;
  selectionCount: number;
}

interface CatalogEventRow {
  eventKey: string;
  sport?: string;
  league?: string;
  kickoff?: string;
  homeTeam?: string;
  awayTeam?: string;
  sources: string[];
  marketKeys?: string[];
  selectionCount: number;
}

interface CatalogPayload {
  builtAt?: string;
  sources?: Array<{ sourceId: string }>;
  markets?: CatalogMarketRow[];
  events?: CatalogEventRow[];
}

function betNetProfit(bet: TrackedBet): number {
  if (bet.status === 'won') return Math.round((bet.stake * (bet.odds - 1) + Number.EPSILON) * 100) / 100;
  if (bet.status === 'lost') return -bet.stake;
  return 0;
}

function parsePositionTag(notes?: string): { posId: string | null; cleanNotes: string } {
  const raw = String(notes ?? '');
  const m = raw.match(/^\[pos:([a-z0-9_-]+)\]\s*/i);
  if (!m) return { posId: null, cleanNotes: raw };
  return { posId: m[1], cleanNotes: raw.slice(m[0].length) };
}

export function AnalyticsWorkspace({
  opportunities,
  onJumpToOpportunities,
}: {
  opportunities: ArbitrageOpportunity[];
  onJumpToOpportunities: () => void;
}) {
  const [bets, setBets] = useState<TrackedBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<BetStatusFilter>('all');
  const [ledgerMode, setLedgerMode] = useState<'all' | 'positions'>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportBox, setShowImportBox] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [catalogSportCount, setCatalogSportCount] = useState<number>(0);
  const [catalogData, setCatalogData] = useState<CatalogPayload | null>(null);
  const [marketFilter, setMarketFilter] = useState('');
  const [coverageFilter, setCoverageFilter] = useState('');

  const [newSelection, setNewSelection] = useState('');
  const [newBook, setNewBook] = useState('superbet');
  const [newOdds, setNewOdds] = useState('2.00');
  const [newStake, setNewStake] = useState('100');
  const [newNotes, setNewNotes] = useState('');

  const notify = useFeedStore((s) => s.notify);
  const setCriteria = useFilterStore((s) => s.setCriteria);
  const resetFilters = useFilterStore((s) => s.resetFilters);

  const loadTrackerData = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await fetchTracker();
      const rawItems = payload.items ?? (payload as unknown as { bets?: TrackedBet[] }).bets ?? [];
      setBets([...rawItems].reverse());
    } catch {
      /* ignore initial tracker load error */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrackerData();
    fetchCatalog()
      .then((cat) => {
        if (cat && typeof cat === 'object') {
          setCatalogData(cat as CatalogPayload);
          const sportsObj = (cat as { sports?: unknown }).sports;
          if (Array.isArray(sportsObj)) setCatalogSportCount(sportsObj.length);
          else if (sportsObj && typeof sportsObj === 'object') setCatalogSportCount(Object.keys(sportsObj).length);
        }
      })
      .catch(() => { /* ignore catalog error */ });
  }, [loadTrackerData]);

  const trackerMetrics = useMemo(() => {
    let totalStaked = 0;
    let settledStaked = 0;
    let realizedPnl = 0;
    let pendingCount = 0;
    let settledCount = 0;
    let wonCount = 0;
    let lostCount = 0;
    let voidCount = 0;

    for (const bet of bets) {
      totalStaked += bet.stake;
      if (bet.status === 'pending') {
        pendingCount += 1;
      } else {
        settledCount += 1;
        if (bet.status === 'won') wonCount += 1;
        else if (bet.status === 'lost') lostCount += 1;
        else if (bet.status === 'void') voidCount += 1;
        if (bet.status !== 'void') settledStaked += bet.stake;
        realizedPnl += betNetProfit(bet);
      }
    }
    const roi = settledStaked > 0 ? (realizedPnl / settledStaked) * 100 : 0;
    return { totalStaked, realizedPnl, roi, pendingCount, settledCount, wonCount, lostCount, voidCount };
  }, [bets]);

  const filteredBets = useMemo(
    () => (statusFilter === 'all' ? bets : bets.filter((b) => b.status === statusFilter)),
    [bets, statusFilter],
  );

  const hedgedPositions = useMemo(() => {
    const groups = new Map<
      string,
      {
        posId: string;
        eventTitle: string;
        cleanNotes: string;
        legs: TrackedBet[];
        totalStake: number;
        netPnl: number;
        allSettled: boolean;
      }
    >();
    // Preserve leg order inside each group from oldest-logged (Leg 1) to newest
    for (const bet of [...bets].reverse()) {
      const { posId, cleanNotes } = parsePositionTag(bet.notes);
      if (!posId) continue;
      const matchPrefix = bet.selection.includes(' — ')
        ? bet.selection.split(' — ')[0]
        : bet.eventKey || bet.selection;
      const entry = groups.get(posId) ?? {
        posId,
        eventTitle: matchPrefix,
        cleanNotes,
        legs: [],
        totalStake: 0,
        netPnl: 0,
        allSettled: true,
      };
      entry.legs.push(bet);
      entry.totalStake += bet.stake;
      if (bet.status === 'pending') entry.allSettled = false;
      else entry.netPnl = Math.round((entry.netPnl + betNetProfit(bet)) * 100) / 100;
      groups.set(posId, entry);
    }
    return [...groups.values()]
      .filter((g) => g.legs.length >= 2)
      .reverse();
  }, [bets]);

  const handleSettlePosition = async (
    legs: TrackedBet[],
    mode: { kind: 'single_winner'; winnerIndex: number } | { kind: 'all_won' } | { kind: 'void_all' },
  ) => {
    try {
      const updates: Array<{ id: string; status: TrackedBet['status'] }> = legs.map((leg, idx) => {
        if (mode.kind === 'void_all') return { id: leg.id, status: 'void' };
        if (mode.kind === 'all_won') return { id: leg.id, status: 'won' };
        return { id: leg.id, status: idx === mode.winnerIndex ? 'won' : 'lost' };
      });
      for (const u of updates) {
        await updateTrackedBet(u.id, { status: u.status });
      }
      const statusById = new Map(updates.map((u) => [u.id, u.status]));
      setBets((prev) =>
        prev.map((b) => (statusById.has(b.id) ? { ...b, status: statusById.get(b.id)! } : b)),
      );
      notify(`${t('tracker')}: ${t('betUpdated')}`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    }
  };

  const figures = useMemo(() => verifiedFigures(opportunities), [opportunities]);
  const stats = useMemo(
    () => ({
      surebet: opportunities.filter((i) => i.type === 'surebet').length,
      middle: opportunities.filter((i) => i.type === 'middle').length,
      ev: opportunities.filter((i) => i.type === 'positive_ev').length,
    }),
    [opportunities],
  );

  const sportBreakdown = useMemo(() => {
    const counts = new Map<Sport, number>();
    for (const item of opportunities) {
      counts.set(item.sport, (counts.get(item.sport) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [opportunities]);

  const topBooks = useMemo(() => {
    const act = bookActivity(opportunities);
    return [...act.values()].sort((a, b) => b.opportunities - a.opportunities).slice(0, 8);
  }, [opportunities]);

  const filteredCatalogMarkets = useMemo(() => {
    const list = catalogData?.markets ?? [];
    if (!marketFilter.trim()) return list.slice(0, 15);
    const q = marketFilter.toLowerCase().trim();
    return list
      .filter((m) => {
        const display = localizeMarketLabel(canonicalizeRawMarketLabel(m.marketKey, m.marketName), t);
        return (
          m.sourceId.toLowerCase().includes(q) ||
          display.toLowerCase().includes(q) ||
          (m.marketName || m.marketKey).toLowerCase().includes(q)
        );
      })
      .slice(0, 15);
  }, [catalogData, marketFilter]);

  const filteredCatalogEvents = useMemo(() => {
    const list = catalogData?.events ?? [];
    if (!coverageFilter.trim()) return list.slice(0, 15);
    const q = coverageFilter.toLowerCase().trim();
    return list
      .filter((e) =>
        (e.homeTeam && e.homeTeam.toLowerCase().includes(q)) ||
        (e.awayTeam && e.awayTeam.toLowerCase().includes(q)) ||
        (e.league && e.league.toLowerCase().includes(q)) ||
        (e.sport && e.sport.toLowerCase().includes(q))
      )
      .slice(0, 15);
  }, [catalogData, coverageFilter]);

  const handleAddBet = async (e: React.FormEvent) => {
    e.preventDefault();
    const odds = Number(newOdds);
    const stake = Number(newStake);
    if (!newSelection.trim() || !Number.isFinite(odds) || odds <= 1 || !Number.isFinite(stake) || stake <= 0) {
      notify(t('appToastEnterValidStake'), 'error');
      return;
    }
    try {
      await addTrackedBet({
        selection: newSelection.trim(),
        sourceId: newBook.trim() || 'manual',
        odds,
        stake,
        notes: newNotes.trim(),
        provenance: 'manual',
      });
      setNewSelection('');
      setNewNotes('');
      setShowAddForm(false);
      await loadTrackerData();
      notify(t('appToastBetAdded'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    }
  };

  const handleStatusChange = async (id: string, status: TrackedBet['status']) => {
    try {
      await updateTrackedBet(id, { status });
      setBets((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)));
      notify(`${t('tracker')}: ${t('betUpdated')}`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    }
  };

  const handleDeleteBet = async (id: string) => {
    try {
      await deleteTrackedBet(id);
      setBets((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    }
  };

  const handleImportCsv = async () => {
    if (!csvText.trim()) return;
    try {
      const res = await importTrackerCsv(csvText);
      await loadTrackerData();
      setCsvText('');
      setShowImportBox(false);
      if (res.imported === 0) notify(t('toastImportEmpty'), 'error');
      else if (res.skipped > 0) notify(tf('toastImportPartial', { n: String(res.imported), skipped: String(res.skipped) }), 'info');
      else notify(tf('toastImportDone', { n: String(res.imported) }), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : t('appToastTrackerFailed'), 'error');
    }
  };

  return (
    <div className="workspace-stack">
      <section className="kpis">
        <div className="kpi">
          <div className="kpi-label">{t('tracker')}</div>
          <div className="kpi-value num">{formatNum(bets.length)}</div>
          <span className="subtle">
            {formatNum(trackerMetrics.pendingCount)} {t('pending').toLowerCase()} · {t('placed')}: {formatMoney(trackerMetrics.totalStaked)}
          </span>
        </div>

        <div className="kpi">
          <div className="kpi-label">{t('profit')}</div>
          <div className={`kpi-value num ${trackerMetrics.realizedPnl >= 0 ? 'green' : 'amber'}`}>
            {trackerMetrics.realizedPnl >= 0 ? '+' : ''}
            {formatMoney(trackerMetrics.realizedPnl)}
          </div>
          <span className="subtle">
            ROI: {trackerMetrics.roi >= 0 ? '+' : ''}{formatPercent(trackerMetrics.roi, 2)} ({formatNum(trackerMetrics.settledCount)} {t('completed').toLowerCase()})
          </span>
        </div>

        <div className="kpi">
          <div className="kpi-label">{t('appOpportunityMix')}</div>
          <div className="kpi-value num">{formatNum(stats.surebet + stats.middle + stats.ev)}</div>
          <span className="subtle">
            {tf('appMixBreakdown', {
              surebets: formatNum(stats.surebet),
              middles: formatNum(stats.middle),
              ev: formatNum(stats.ev),
            })}
          </span>
        </div>

        <div className="kpi">
          <div className="kpi-label">{t('appBestFigures')}</div>
          <div className="kpi-value green num">
            {figures.guaranteed > 0 ? `+${formatPercent(figures.guaranteed, 2)}` : '—'}
          </div>
          <span className="subtle">
            +EV: {figures.expectedEdge > 0 ? `+${formatPercent(figures.expectedEdge, 2)}` : '—'}
            {catalogSportCount > 0 && ` · ${formatNum(catalogSportCount)} ${t('appSportsIndexed')}`}
          </span>
        </div>
      </section>

      <section className="panel workspace-card">
        <div className="eyebrow">{t('appBestFigures')}</div>
        <span className="subtle">
          {t('appBestFiguresA')}
          <strong>{t('appGuaranteedWord')}</strong>
          {tf('appBestFiguresB', {
            edge: figures.expectedEdge > 0 ? `+${formatPercent(figures.expectedEdge, 2)}` : '—',
          })}
        </span>
      </section>

      <section className="panel workspace-table">
        <div className="section-head">
          <div>
            <div className="eyebrow">{t('tracker')}</div>
            <h3>{t('appTrackerLedgerTitle')}</h3>
          </div>
          <div className="inline-actions">
            <button className="chip sm active" onClick={() => setShowAddForm((v) => !v)}>
              <Plus size={13} /> {t('addBet')}
            </button>
            <button className="chip sm" onClick={() => setShowImportBox((v) => !v)}>
              <Upload size={13} /> {t('import')}
            </button>
            <a className="chip sm" href={trackerExportUrl()} download="bet-tracker.csv">
              <Download size={13} /> {t('export')}
            </a>
          </div>
        </div>

        {showAddForm && (
          <form className="panel tracker-form" onSubmit={(e) => void handleAddBet(e)}>
            <div className="scanner-controls-grid">
              <div className="control-field">
                <label htmlFor="bet-selection">{t('selection')}</label>
                <input
                  id="bet-selection"
                  className="select"
                  placeholder={t('appBetSelectionPlaceholder')}
                  value={newSelection}
                  onChange={(e) => setNewSelection(e.target.value)}
                  required
                />
              </div>
              <div className="control-field">
                <label htmlFor="bet-book">{t('bookmaker')}</label>
                <input
                  id="bet-book"
                  className="select"
                  value={newBook}
                  onChange={(e) => setNewBook(e.target.value)}
                />
              </div>
              <div className="control-field">
                <label htmlFor="bet-odds">{t('odds')}</label>
                <input
                  id="bet-odds"
                  type="number"
                  step="0.01"
                  min="1.01"
                  className="select num"
                  value={newOdds}
                  onChange={(e) => setNewOdds(e.target.value)}
                  required
                />
              </div>
              <div className="control-field">
                <label htmlFor="bet-stake">{t('stake')} (RON)</label>
                <input
                  id="bet-stake"
                  type="number"
                  step="1"
                  min="1"
                  className="select num"
                  value={newStake}
                  onChange={(e) => setNewStake(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inline-actions" style={{ marginTop: 10 }}>
              <input
                className="select"
                style={{ flex: 1 }}
                placeholder={t('appBetNotesPlaceholder')}
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
              />
              <button type="submit" className="chip active">{t('addBet')}</button>
              <button type="button" className="chip" onClick={() => setShowAddForm(false)}>{t('cancel')}</button>
            </div>
          </form>
        )}

        {showImportBox && (
          <div className="panel tracker-form">
            <label htmlFor="csv-paste" className="eyebrow">{t('import')}</label>
            <textarea
              id="csv-paste"
              className="select"
              rows={4}
              style={{ width: '100%', marginTop: 6 }}
              placeholder="id,createdAt,eventKey,marketKey,selection,sourceId,odds,stake,status,notes"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
            <div className="inline-actions" style={{ marginTop: 8 }}>
              <button className="chip active" onClick={() => void handleImportCsv()}>{t('import')}</button>
              <button className="chip" onClick={() => setShowImportBox(false)}>{t('cancel')}</button>
            </div>
          </div>
        )}

        <div className="toolbar" style={{ margin: '10px 0' }}>
          {(
            [
              ['all', tf('appAllBetsCount', { n: formatNum(bets.length) })],
              ['pending', `${t('pending')} (${formatNum(trackerMetrics.pendingCount)})`],
              ['won', `${t('appBetWonBadge')} (${formatNum(trackerMetrics.wonCount)})`],
              ['lost', `${t('appBetLostBadge')} (${formatNum(trackerMetrics.lostCount)})`],
              ['void', `${t('appBetVoidBadge')} (${formatNum(trackerMetrics.voidCount)})`],
            ] as [BetStatusFilter, string][]
          ).map(([st, label]) => (
            <button
              key={st}
              className={`chip sm ${ledgerMode === 'all' && statusFilter === st ? 'active' : ''}`}
              onClick={() => {
                setLedgerMode('all');
                setStatusFilter(st);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`chip sm ${ledgerMode === 'positions' ? 'active' : ''}`}
            onClick={() => setLedgerMode((prev) => (prev === 'positions' ? 'all' : 'positions'))}
          >
            {tf('appViewPositionsBtn', { n: formatNum(hedgedPositions.length) })}
          </button>
        </div>

        {loading ? (
          <div className="subtle">{t('appLoadingSignals')}</div>
        ) : ledgerMode === 'positions' ? (
          hedgedPositions.length === 0 ? (
            <div className="subtle" style={{ padding: '14px 0' }}>{t('appNoPositionsYet')}</div>
          ) : (
            <div className="bet-ledger">
              {hedgedPositions.map((pos) => (
                <div className="position-group-card" key={pos.posId}>
                  <div className="opportunity-head" style={{ marginBottom: 0 }}>
                    <div>
                      <strong>{pos.eventTitle}</strong>
                      {pos.cleanNotes && (
                        <span className="subtle" style={{ marginLeft: 8 }}>{pos.cleanNotes}</span>
                      )}
                    </div>
                    <div className="inline-actions">
                      <span className="subtle num">
                        {tf('appPositionTotalStaked', { stake: formatMoney(pos.totalStake) })}
                      </span>
                      <span className={pos.allSettled ? (pos.netPnl >= 0 ? 'safe-tag num' : 'risk-tag num') : 'market-badge num'}>
                        {pos.allSettled
                          ? `${pos.netPnl >= 0 ? '+' : ''}${formatMoney(pos.netPnl)}`
                          : t('pending')}
                      </span>
                    </div>
                  </div>
                  <div className="legs">
                    {pos.legs.map((leg, idx) => (
                      <div className="leg" key={leg.id}>
                        <div className="leg-book">
                          <span className="book-dot" style={{ background: bookmakerColor(leg.sourceId) }} />
                          <strong>{formatBookmakerName(leg.sourceId)}</strong>
                        </div>
                        <div className="leg-pick">
                          {leg.selection.includes(' — ') ? leg.selection.split(' — ').slice(1).join(' — ') : leg.selection}
                        </div>
                        <div className="leg-odds num">{leg.odds.toFixed(2)}</div>
                        <div className="leg-liq num">
                          {t('stake')}: {formatMoney(leg.stake)} ·{' '}
                          {leg.status === 'won'
                            ? t('appBetWonBadge')
                            : leg.status === 'lost'
                              ? t('appBetLostBadge')
                              : leg.status === 'void'
                                ? t('appBetVoidBadge')
                                : t('pending')}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
                    {pos.legs.map((leg, idx) => (
                      <button
                        key={`settle-${leg.id}`}
                        type="button"
                        className="chip sm"
                        onClick={() => void handleSettlePosition(pos.legs, { kind: 'single_winner', winnerIndex: idx })}
                      >
                        <Check size={12} color="#10b981" /> {tf('appPositionLegWonBtn', { n: String(idx + 1) })}
                      </button>
                    ))}
                    {pos.legs.length === 2 && (
                      <button
                        type="button"
                        className="chip sm"
                        onClick={() => void handleSettlePosition(pos.legs, { kind: 'all_won' })}
                      >
                        <Check size={12} color="#10b981" /> {t('appPositionBothWonBtn')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="chip sm"
                      onClick={() => void handleSettlePosition(pos.legs, { kind: 'void_all' })}
                    >
                      <RotateCcw size={11} /> {t('appPositionVoidAllBtn')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : filteredBets.length === 0 ? (
          <div className="subtle" style={{ padding: '14px 0' }}>{t('noBets')}</div>
        ) : (
          <div className="bet-ledger">
            {filteredBets.map((bet) => {
              const net = betNetProfit(bet);
              const { cleanNotes } = parsePositionTag(bet.notes);
              return (
                <div className="source-row bet-row" key={bet.id}>
                  <span className="book-dot" style={{ background: bookmakerColor(bet.sourceId) }} />
                  <div>
                    <strong>{bet.selection}</strong>
                    <div className="opp-meta" style={{ marginTop: 3 }}>
                      <span>{formatBookmakerName(bet.sourceId)}</span>
                      <span>·</span>
                      <span className="num">{t('odds')} {bet.odds.toFixed(2)}</span>
                      <span>·</span>
                      <span className="num">{t('stake')} {formatMoney(bet.stake)}</span>
                      {cleanNotes && <><span>·</span><span>{cleanNotes}</span></>}
                    </div>
                  </div>
                  <div className="num" style={{ textAlign: 'right' }}>
                    <span
                      className={
                        bet.status === 'won'
                          ? 'safe-tag'
                          : bet.status === 'lost'
                            ? 'risk-tag'
                            : 'market-badge'
                      }
                    >
                      {bet.status === 'won'
                        ? `+${formatMoney(net)}`
                        : bet.status === 'lost'
                          ? formatMoney(net)
                          : bet.status === 'void'
                            ? t('appBetVoidBadge')
                            : t('pending')}
                    </span>
                  </div>
                  <div className="inline-actions">
                    <button
                      className={`chip sm ${bet.status === 'won' ? 'active' : ''}`}
                      title={t('markWon')}
                      onClick={() => void handleStatusChange(bet.id, 'won')}
                    >
                      <Check size={12} color="#10b981" /> {t('appBetWonBadge')}
                    </button>
                    <button
                      className={`chip sm ${bet.status === 'lost' ? 'active' : ''}`}
                      title={t('markLost')}
                      onClick={() => void handleStatusChange(bet.id, 'lost')}
                    >
                      <X size={12} color="#ef4444" /> {t('appBetLostBadge')}
                    </button>
                    <button
                      className={`chip sm ${bet.status === 'void' ? 'active' : ''}`}
                      title={t('appBetVoidBadge')}
                      onClick={() => void handleStatusChange(bet.id, 'void')}
                    >
                      <RotateCcw size={11} /> {t('appBetVoidBadge')}
                    </button>
                    <button
                      className="icon-button"
                      title={t('appDeleteBet')}
                      onClick={() => void handleDeleteBet(bet.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="workspace-grid">
        <section className="panel workspace-table">
          <div className="eyebrow" style={{ marginBottom: 8 }}>{t('appBreakdownBySport')}</div>
          {sportBreakdown.map(([sp, count]) => (
            <div className="source-row compact-source-row" key={sp}>
              <strong>{sportLabel(sp)}</strong>
              <span className="subtle num">{formatNum(count)} {t('opps')}</span>
              <button
                className="chip sm"
                onClick={() => {
                  setCriteria({ sport: sp });
                  onJumpToOpportunities();
                }}
              >
                {t('appFilterBtn')}
              </button>
            </div>
          ))}
        </section>

        <section className="panel workspace-table">
          <div className="eyebrow" style={{ marginBottom: 8 }}>{t('appBreakdownByBook')}</div>
          {topBooks.map((b) => (
            <div className="source-row compact-source-row" key={b.bookmakerId}>
              <div className="leg-book">
                <span className="book-dot" style={{ background: bookmakerColor(b.bookmakerId) }} />
                <strong>{formatBookmakerName(b.bookmakerId)}</strong>
              </div>
              <span className="subtle num">{formatNum(b.opportunities)} {t('opps')}</span>
              <button
                className="chip sm"
                onClick={() => {
                  setCriteria({ bookmaker: b.bookmakerId });
                  onJumpToOpportunities();
                }}
              >
                {t('appFilterBtn')}
              </button>
            </div>
          ))}
        </section>
      </div>

      <div className="workspace-grid" style={{ marginTop: 16 }}>
        <section className="panel workspace-table">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('marketCatalog')}</div>
              <h3>{t('marketCatalogTitle')}</h3>
              <span className="subtle">{t('marketCatalogHint')}</span>
            </div>
            {catalogData?.markets && (
              <span className="safe-tag num" style={{ whiteSpace: 'nowrap' }}>
                {formatNum(catalogData.markets.length)} {t('markets').toLowerCase()}
              </span>
            )}
          </div>
          <div className="toolbar" style={{ margin: '8px 0' }}>
            <input
              type="text"
              className="select"
              style={{ width: '100%' }}
              placeholder={t('filterPlaceholder')}
              value={marketFilter}
              onChange={(e) => setMarketFilter(e.target.value)}
            />
          </div>
          {filteredCatalogMarkets.length === 0 ? (
            <div className="subtle" style={{ padding: '12px 0' }}>{t('noMarkets')}</div>
          ) : (
            <div className="bet-ledger">
              {filteredCatalogMarkets.map((m, idx) => {
                const readableMarket = localizeMarketLabel(
                  canonicalizeRawMarketLabel(m.marketKey, m.marketName),
                  t,
                );
                return (
                  <div className="source-row compact-source-row" key={`${m.sourceId}-${m.marketKey}-${idx}`}>
                    <div className="leg-book">
                      <span className="book-dot" style={{ background: bookmakerColor(m.sourceId) }} />
                      <strong>{formatBookmakerName(m.sourceId)}</strong>
                    </div>
                    <span className="market-badge" title={m.marketName || m.marketKey}>
                      {readableMarket}
                    </span>
                    <span className="subtle num">{formatNum(m.eventCount)} {t('events').toLowerCase()}</span>
                    <span className="subtle num">{formatNum(m.selectionCount)} {t('selections').toLowerCase()}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel workspace-table">
          <div className="section-head">
            <div>
              <div className="eyebrow">{t('eventCoverage')}</div>
              <h3>{t('eventCoverageTitle')}</h3>
              <span className="subtle">{t('eventCoverageHint')}</span>
            </div>
            {catalogData?.events && (
              <span className="safe-tag num" style={{ whiteSpace: 'nowrap' }}>
                {formatNum(catalogData.events.length)} {t('events').toLowerCase()}
              </span>
            )}
          </div>
          <div className="toolbar" style={{ margin: '8px 0' }}>
            <input
              type="text"
              className="select"
              style={{ width: '100%' }}
              placeholder={t('eventFilterPlaceholder')}
              value={coverageFilter}
              onChange={(e) => setCoverageFilter(e.target.value)}
            />
          </div>
          {filteredCatalogEvents.length === 0 ? (
            <div className="subtle" style={{ padding: '12px 0' }}>{t('noEvents')}</div>
          ) : (
            <div className="bet-ledger">
              {filteredCatalogEvents.map((ev) => {
                const matchQuery = ev.homeTeam || ev.awayTeam || '';
                return (
                  <div className="source-row compact-source-row" key={ev.eventKey}>
                    <div>
                      <strong>{ev.homeTeam || ev.awayTeam ? `${ev.homeTeam ?? ''} ${t('vs')} ${ev.awayTeam ?? ''}` : ev.eventKey}</strong>
                      {ev.league && <div className="subtle" style={{ fontSize: '0.8rem' }}>{ev.league}</div>}
                    </div>
                    <span className="safe-tag num">{formatNum(ev.sources?.length ?? 0)} {t('books').toLowerCase()}</span>
                    <div className="inline-actions">
                      <span className="subtle num">{formatNum(ev.marketKeys?.length ?? 0)} {t('markets').toLowerCase()}</span>
                      {matchQuery && (
                        <button
                          type="button"
                          className="chip sm"
                          onClick={() => {
                            resetFilters();
                            setCriteria({ query: ev.homeTeam ?? matchQuery });
                            onJumpToOpportunities();
                          }}
                        >
                          {t('appExploreEventOpps')} <ArrowRight size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
