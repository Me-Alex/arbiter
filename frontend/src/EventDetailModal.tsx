import { useEffect, useMemo, useState } from 'react';
import { Calculator, ExternalLink, Layers, RefreshCw, Sparkles, X } from 'lucide-react';
import type { ArbitrageOpportunity, EventDetailBookEvent, EventDetailMarket, EventDetailSelection } from './domain';
import { bookmakerColor } from './domain';
import { canonicalizeRawMarketLabel, fetchEventDetail, formatBookmakerName } from './api';
import { formatKickoff, formatMoney, formatPercent, useNavigableUrlGate } from './format';
import { t, tf } from './i18n';
import { localizeMarketLabel } from './labels';
import { calculateStakes, impliedMarginPercent } from './stakes';
import { usePreferencesStore } from './stores';

interface CustomBuilderLeg {
  id: string;
  sourceId: string;
  label: string;
  odds: number;
  marketName: string;
}

function stripAccentsUpper(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function detectRawPeriodSuffix(rawKey?: string, rawName?: string, declaredPeriod?: string): string {
  const p = stripAccentsUpper(declaredPeriod ?? '');
  if (p === 'FULLTIME_OT' || p === 'FT_OT' || p === 'INCL_OT') return 'FULLTIME_OT';
  if (p === 'HALF1' || p === '1H' || p === '1ST_HALF' || p === 'FIRST_HALF') return '1H';
  if (p === 'HALF2' || p === '2H' || p === '2ND_HALF' || p === 'SECOND_HALF') return '2H';
  if (/^SET[1-5]$/.test(p)) return p;
  if (/^Q[1-4]$/.test(p)) return p;

  const hay = stripAccentsUpper(`${rawKey ?? ''} ${rawName ?? ''}`);
  if (/(?:INCL\.?\s*(?:OVERTIME|PRELUNGIRI)|INCLUDING OVERTIME|WITH OVERTIME|Z DOGRYWK|CU PRELUNGIRI)/.test(hay)) {
    return 'FULLTIME_OT';
  }
  if (/(?:1ST HALF|FIRST HALF|PRIMA REPRIZ|REPRIZA 1|1\.?\s*POLOW|HALF1|\b1H\b)/.test(hay)) {
    return '1H';
  }
  if (/(?:2ND HALF|SECOND HALF|REPRIZA A? ?2|A DOUA REPRIZ|2\.?\s*POLOW|HALF2|\b2H\b)/.test(hay)) {
    return '2H';
  }
  const setMatch = hay.match(/\bSET(?:UL)?\s*([1-5])\b/);
  if (setMatch) return `SET${setMatch[1]}`;
  const qMatch = hay.match(/\b(?:QUARTER|SFERT(?:UL)?|Q)\s*([1-4])\b/);
  if (qMatch) return `Q${qMatch[1]}`;
  return 'FT';
}

function detectTeamScopePrefix(m: EventDetailMarket): 'Home ' | 'Away ' | '' {
  const t = stripAccentsUpper(m.team ?? '');
  if (t === 'HOME' || t === '1') return 'Home ';
  if (t === 'AWAY' || t === '2') return 'Away ';
  const hay = stripAccentsUpper(`${m.key ?? ''} ${m.name ?? ''}`);
  if (/(?:\bHOME TEAM\b|\bECHIPA GAZDA\b|\bGAZDE TOTAL|\bTEAM 1\b|\bGOSPODARZ)/.test(hay)) return 'Home ';
  if (/(?:\bAWAY TEAM\b|\bECHIPA OASPETE\b|\bOASPETI TOTAL|\bTEAM 2\b|\bGOSC)/.test(hay)) return 'Away ';
  return '';
}

function extractMarketLine(m: EventDetailMarket, baseName: string): string | undefined {
  const fromBase = baseName.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
  if (fromBase) return fromBase[1];
  for (const sel of m.selections) {
    if (sel.handicap != null && sel.handicap !== '') {
      const h = String(sel.handicap).trim();
      if (/^[+-]?\d+(?:\.\d+)?$/.test(h)) return h;
    }
    const overUnder = String(sel.name).match(/(?:over|under|peste|sub|powyzej|ponizej)\s+([+-]?\d+(?:\.\d+)?)/i);
    if (overUnder) return overUnder[1];
  }
  return undefined;
}

function normalizeSelectionOutcome(
  sel: EventDetailSelection,
  canonicalBase: string,
  line: string | undefined,
  homeTeam: string,
  awayTeam: string,
): string {
  const raw = String(sel.name ?? '').trim();
  const upper = stripAccentsUpper(raw);
  const homeNorm = stripAccentsUpper(homeTeam);
  const awayNorm = stripAccentsUpper(awayTeam);

  if (canonicalBase === 'Match Result' || canonicalBase === 'Draw No Bet (level)' || canonicalBase === 'Set Winner') {
    if (upper === '1' || upper === 'HOME' || upper === 'GAZDE' || (homeNorm && upper === homeNorm)) return '1';
    if (upper === 'X' || upper === 'DRAW' || upper === 'EGAL' || upper === 'REMIS') return 'X';
    if (upper === '2' || upper === 'AWAY' || upper === 'OASPETI' || (awayNorm && upper === awayNorm)) return '2';
  }

  if (canonicalBase === 'Both Teams to Score') {
    if (upper === 'DA' || upper === 'YES' || upper === 'GG' || upper === 'TAK') return 'Yes';
    if (upper === 'NU' || upper === 'NO' || upper === 'NG' || upper === 'NIE') return 'No';
  }

  if (canonicalBase === 'Double Chance') {
    if (upper === '1X' || upper === 'X1') return '1X';
    if (upper === '12' || upper === '21') return '12';
    if (upper === 'X2' || upper === '2X') return 'X2';
  }

  if (
    canonicalBase.startsWith('Total ') ||
    canonicalBase.startsWith('Corners') ||
    canonicalBase.startsWith('Games')
  ) {
    const numMatch = raw.match(/([+-]?\d+(?:\.\d+)?)/);
    const resolvedLine = numMatch?.[1] ?? (sel.handicap != null && sel.handicap !== '' ? String(sel.handicap) : line);
    if (/^(?:OVER|PESTE|POWYZEJ|O\b)/i.test(upper)) {
      return resolvedLine ? `Over ${resolvedLine}` : 'Over';
    }
    if (/^(?:UNDER|SUB|PONIZEJ|U\b)/i.test(upper)) {
      return resolvedLine ? `Under ${resolvedLine}` : 'Under';
    }
  }

  if (sel.handicap != null && sel.handicap !== '' && !raw.includes(String(sel.handicap))) {
    return `${raw} (${sel.handicap})`;
  }
  return raw;
}

function canonicalGroupForMarket(
  m: EventDetailMarket,
  eventLive?: boolean,
): { groupKey: string; displayName: string; baseName: string; line?: string } {
  const rawCanon = canonicalizeRawMarketLabel(m.key, m.name);
  const period = detectRawPeriodSuffix(m.key, m.name, m.period);
  const teamPrefix = detectTeamScopePrefix(m);
  const scopeTag = m.live || eventLive ? 'LIVE' : 'PRE';
  const baseWithoutLine = rawCanon.replace(/\s+[+-]?\d+(?:\.\d+)?$/, '');
  const line = extractMarketLine(m, rawCanon);
  const isKnownFamily =
    baseWithoutLine === 'Match Result' ||
    baseWithoutLine === 'Both Teams to Score' ||
    baseWithoutLine === 'Double Chance' ||
    baseWithoutLine === 'Draw No Bet (level)' ||
    baseWithoutLine === 'Set Winner' ||
    baseWithoutLine === 'Asian Handicap' ||
    baseWithoutLine.startsWith('Total ') ||
    baseWithoutLine === 'Corners';

  if (!isKnownFamily) {
    return {
      groupKey: `RAW::${scopeTag}::${m.key}::${period}`,
      displayName: rawCanon,
      baseName: baseWithoutLine,
      line,
    };
  }

  const needsLine =
    baseWithoutLine === 'Asian Handicap' ||
    baseWithoutLine.startsWith('Total ') ||
    baseWithoutLine === 'Corners';
  const coreBase = needsLine && line ? `${baseWithoutLine} ${line}` : rawCanon;
  const titledBase = teamPrefix && !coreBase.startsWith(teamPrefix) ? `${teamPrefix}${coreBase}` : coreBase;
  const displayName = `${titledBase} · ${period}`;
  return {
    groupKey: `CANON::${scopeTag}::${displayName}`,
    displayName,
    baseName: baseWithoutLine,
    line,
  };
}

export function EventDetailModal({
  opportunity,
  onClose,
}: {
  opportunity: ArbitrageOpportunity | null;
  onClose: () => void;
}) {
  const defaultBankroll = usePreferencesStore((s) => s.defaultBankroll);
  const defaultRounding = usePreferencesStore((s) => s.defaultRounding);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<EventDetailBookEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<string>('all');
  const [builderLegs, setBuilderLegs] = useState<CustomBuilderLeg[]>([]);
  const [builderBankroll, setBuilderBankroll] = useState<number>(defaultBankroll);
  const isNavigable = useNavigableUrlGate();

  useEffect(() => {
    setBuilderBankroll(defaultBankroll);
  }, [defaultBankroll]);

  useEffect(() => {
    if (!opportunity) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    setMarketFilter('all');
    setBuilderLegs([]);

    const sportCandidates = Array.from(
      new Set([opportunity.rawSport, 'Football', 'Fotbal', opportunity.sport].filter(Boolean) as string[]),
    );

    (async () => {
      try {
        let matched: EventDetailBookEvent[] = [];
        for (const candidate of sportCandidates) {
          const res = await fetchEventDetail({
            sport: candidate,
            home: opportunity.homeTeam,
            away: opportunity.awayTeam,
            kickoff: opportunity.startTime,
          });
          if (res.length > 0) {
            matched = res;
            break;
          }
        }
        if (active) {
          setEvents(matched);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : t('appOddsLoadFailed'));
          setLoading(false);
        }
      }
    })();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      active = false;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [opportunity, onClose]);

  const groupedMarkets = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        rawKeys: Set<string>;
        name: string;
        live: boolean;
        arb?: EventDetailBookEvent['markets'][number]['arb'];
        rows: Array<{
          sourceId: string;
          sourceUrl: string | null;
          selections: Array<{ label: string; odds: number }>;
        }>;
        bestBySelection: Map<string, { odds: number; sourceId: string }>;
      }
    >();

    const homeTeam = opportunity?.homeTeam ?? '';
    const awayTeam = opportunity?.awayTeam ?? '';

    for (const ev of events) {
      for (const m of ev.markets) {
        const { groupKey, displayName, baseName, line } = canonicalGroupForMarket(m, ev.live);
        const entry = map.get(groupKey) ?? {
          key: groupKey,
          rawKeys: new Set<string>(),
          name: displayName,
          live: Boolean(m.live || ev.live),
          arb: m.arb,
          rows: [],
          bestBySelection: new Map<string, { odds: number; sourceId: string }>(),
        };
        entry.rawKeys.add(m.key);
        if (!entry.arb && m.arb) entry.arb = m.arb;
        const selections = m.selections.map((s) => {
          const label = normalizeSelectionOutcome(s, baseName, line, ev.homeTeam || homeTeam, ev.awayTeam || awayTeam);
          const odds = Number(s.odds) || 0;
          const prev = entry.bestBySelection.get(label)?.odds ?? 0;
          if (odds > prev) entry.bestBySelection.set(label, { odds, sourceId: ev.sourceId });
          return { label, odds };
        });

        const existingBookIdx = entry.rows.findIndex((r) => r.sourceId === ev.sourceId);
        if (existingBookIdx === -1) {
          entry.rows.push({
            sourceId: ev.sourceId,
            sourceUrl: ev.sourceUrl,
            selections,
          });
        }
        map.set(groupKey, entry);
      }
    }

    return [...map.values()]
      .map((entry) => {
        // Compute live cross-book margin when 2 or 3 distinct canonical outcomes exist across >=2 books
        if (!entry.arb && entry.rows.length >= 2 && (entry.bestBySelection.size === 2 || entry.bestBySelection.size === 3)) {
          const bestOdds = [...entry.bestBySelection.values()].map((b) => b.odds);
          const bestBooks = new Set([...entry.bestBySelection.values()].map((b) => b.sourceId));
          const liveMargin = impliedMarginPercent(bestOdds);
          if (liveMargin != null && liveMargin > 0 && bestBooks.size >= 2) {
            return {
              ...entry,
              arb: { marginPercent: Math.round(liveMargin * 100) / 100 },
            };
          }
        }
        return entry;
      })
      .sort((a, b) => (b.arb ? 1 : 0) - (a.arb ? 1 : 0) || b.rows.length - a.rows.length);
  }, [events, opportunity?.homeTeam, opportunity?.awayTeam]);

  const builderEval = useMemo(() => {
    const odds = builderLegs.map((l) => l.odds);
    const margin = impliedMarginPercent(odds);
    const stakes = calculateStakes(odds, Math.max(0, builderBankroll), defaultRounding);
    return { margin, stakes };
  }, [builderLegs, builderBankroll, defaultRounding]);

  const toggleBuilderLeg = (leg: CustomBuilderLeg) => {
    setBuilderLegs((prev) => {
      if (prev.some((item) => item.id === leg.id)) {
        return prev.filter((item) => item.id !== leg.id);
      }
      const sameLabelIdx = prev.findIndex((item) => item.label === leg.label);
      if (sameLabelIdx !== -1) {
        const next = [...prev];
        next[sameLabelIdx] = leg;
        return next;
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), leg];
      }
      return [...prev, leg];
    });
  };

  if (!opportunity) return null;

  const visibleMarkets = marketFilter === 'all'
    ? groupedMarkets
    : groupedMarkets.filter((m) => m.key === marketFilter);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${opportunity.homeTeam} vs ${opportunity.awayTeam}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel modal-dialog">
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t('appCompareAllOdds')}</div>
            <h2 className="modal-title">
              {opportunity.homeTeam} <span className="subtle">{t('vs')}</span> {opportunity.awayTeam}
            </h2>
            <div className="opp-meta">
              <span>{formatKickoff(opportunity.startTime)}</span>
              {opportunity.league && <><span>·</span><span>{opportunity.league}</span></>}
              <span>·</span>
              <span>{localizeMarketLabel(opportunity.marketName, t)}</span>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t('appCloseModal')}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* Card's own snapshot legs, always shown first for clarity */}
          <div className="modal-section">
            <div className="eyebrow" style={{ marginBottom: 8 }}>{t('appSignalLegsSnapshot')}</div>
            <div className="legs">
              {opportunity.legs.map((leg, i) => (
                <div className="leg" key={`${leg.bookmakerId}-${i}`}>
                  <div className="leg-book">
                    <span className="book-dot" style={{ background: bookmakerColor(leg.bookmakerId) }} />
                    <strong>{leg.bookmakerName}</strong>
                    {isNavigable(leg.deepLinkUrl) && (
                      <a
                        href={leg.deepLinkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="icon-button"
                        style={{ marginLeft: 'auto' }}
                        title={tf('appOpenBook', { book: leg.bookmakerName })}
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  <div className="leg-pick">{leg.selection}</div>
                  <div className="leg-odds num">{leg.effectiveOdds.toFixed(2)}</div>
                  <div className="leg-liq">{localizeMarketLabel(leg.marketName, t)}</div>
                </div>
              ))}
            </div>
          </div>

          {loading && (
            <div className="state-panel">
              <RefreshCw size={16} className="spin" />
              <span>{t('appLoadingCrossBookOdds')}</span>
            </div>
          )}

          {!loading && error && (
            <div className="notice">{error}</div>
          )}

          {!loading && !error && groupedMarkets.length === 0 && (
            <div className="panel" style={{ padding: 14 }}>
              <span className="subtle">{t('appNoWorkspaceSnapshotsForEvent')}</span>
            </div>
          )}

          {!loading && groupedMarkets.length > 0 && (
            <div className="modal-section">
              <div className="custom-builder-bar" style={{ marginBottom: 14 }}>
                <div className="opportunity-head" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Calculator size={14} color="#10b981" />
                    <strong>{t('appCustomBuilderTitle')}</strong>
                  </div>
                  {builderLegs.length > 0 && (
                    <button
                      type="button"
                      className="chip sm"
                      onClick={() => setBuilderLegs([])}
                    >
                      {t('appBuilderClearBtn')}
                    </button>
                  )}
                </div>
                {builderLegs.length === 0 ? (
                  <span className="subtle">{t('appCustomBuilderHint')}</span>
                ) : (
                  <>
                    <div className="legs">
                      {builderLegs.map((bLeg, idx) => (
                        <div className="leg" key={bLeg.id}>
                          <div className="leg-book">
                            <span className="book-dot" style={{ background: bookmakerColor(bLeg.sourceId) }} />
                            <strong>{formatBookmakerName(bLeg.sourceId)}</strong>
                          </div>
                          <div className="leg-pick">{bLeg.label}</div>
                          <div className="leg-odds num">{bLeg.odds.toFixed(2)}</div>
                          {builderLegs.length >= 2 && (
                            <div className="leg-liq num">
                              {t('stake')}: <strong>{formatMoney(builderEval.stakes.roundedStakes[idx] ?? 0)}</strong>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {builderLegs.length >= 2 && (
                      <div className="inline-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                        <label className="inline-odd-edit">
                          <span>{t('totalStake')} (RON)</span>
                          <input
                            type="number"
                            min={10}
                            step={50}
                            className="locked-stake-input num"
                            value={builderBankroll}
                            onChange={(e) => setBuilderBankroll(Math.max(0, Number(e.target.value) || 0))}
                          />
                        </label>
                        <div className="inline-actions">
                          <span className={builderEval.margin != null && builderEval.margin > 0 ? 'safe-tag num' : 'market-badge num'}>
                            {builderEval.margin != null
                              ? `${builderEval.margin > 0 ? t('appCalcMarginSurebet') : t('appCalcMarginHold')}: ${builderEval.margin >= 0 ? '+' : ''}${formatPercent(builderEval.margin, 2)}`
                              : '—'}
                          </span>
                          <span className={builderEval.stakes.worstCaseProfit >= 0 ? 'safe-tag num' : 'risk-tag num'}>
                            {t('appClaimWorstCase')}: {builderEval.stakes.worstCaseProfit >= 0 ? '+' : ''}
                            {formatMoney(builderEval.stakes.worstCaseProfit)}
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="toolbar" style={{ marginBottom: 12 }}>
                <Layers size={15} />
                <button
                  className={`chip sm ${marketFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setMarketFilter('all')}
                >
                  {tf('appAllMarketsCount', { n: String(groupedMarkets.length) })}
                </button>
                {groupedMarkets.slice(0, 8).map((m) => (
                  <button
                    key={m.key}
                    className={`chip sm ${marketFilter === m.key ? 'active' : ''}`}
                    onClick={() => setMarketFilter(m.key)}
                  >
                    {localizeMarketLabel(m.name, t)} ({m.rows.length})
                  </button>
                ))}
              </div>

              <div className="market-matrix-list">
                {visibleMarkets.map((market) => (
                  <div className="panel market-matrix-card" key={market.key}>
                    <div className="opportunity-head" style={{ marginBottom: 10 }}>
                      <div>
                        <strong>{localizeMarketLabel(market.name, t)}</strong>
                        <span className="subtle" style={{ marginLeft: 8 }}>
                          ({[...market.rawKeys].slice(0, 3).join(', ')})
                        </span>
                      </div>
                      <div className="inline-actions">
                        {market.rows.length >= 2 && market.bestBySelection.size >= 2 && market.bestBySelection.size <= 3 && (
                          <button
                            type="button"
                            className="chip sm"
                            onClick={() => {
                              const bestLegs: CustomBuilderLeg[] = [...market.bestBySelection.entries()].map(
                                ([label, best]) => ({
                                  id: `${market.key}::${best.sourceId}::${label}`,
                                  sourceId: best.sourceId,
                                  label,
                                  odds: best.odds,
                                  marketName: market.name,
                                }),
                              );
                              setBuilderLegs(bestLegs);
                            }}
                          >
                            {t('appLoadBestOddsBtn')}
                          </button>
                        )}
                        {market.arb && market.arb.marginPercent != null && (
                          <span className="safe-tag">
                            <Sparkles size={11} /> +{formatPercent(market.arb.marginPercent, 2)}
                            {market.arb.guaranteedProfit != null && ` · +${formatMoney(market.arb.guaranteedProfit)}`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="matrix-rows">
                      {market.rows.map((row, idx) => (
                        <div className="matrix-row" key={`${market.key}-${row.sourceId}-${idx}`}>
                          <div className="matrix-book">
                            <span className="book-dot" style={{ background: bookmakerColor(row.sourceId) }} />
                            <strong>{formatBookmakerName(row.sourceId)}</strong>
                            {isNavigable(row.sourceUrl) && (
                              <a
                                href={row.sourceUrl ?? '#'}
                                target="_blank"
                                rel="noreferrer"
                                className="icon-button"
                                title={tf('appOpenBook', { book: formatBookmakerName(row.sourceId) })}
                              >
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                          <div className="matrix-selections">
                            {row.selections.map((sel, sIdx) => {
                              const isBest = sel.odds > 0 && sel.odds === market.bestBySelection.get(sel.label)?.odds;
                              const pillId = `${market.key}::${row.sourceId}::${sel.label}`;
                              const isSelected = builderLegs.some((b) => b.id === pillId);
                              return (
                                <button
                                  type="button"
                                  key={`${sel.label}-${sIdx}`}
                                  className={`odds-pill num ${isBest ? 'best' : ''} ${isSelected ? 'selected' : ''}`}
                                  onClick={() =>
                                    toggleBuilderLeg({
                                      id: pillId,
                                      sourceId: row.sourceId,
                                      label: sel.label,
                                      odds: sel.odds,
                                      marketName: market.name,
                                    })
                                  }
                                >
                                  <small>{sel.label}</small>
                                  <strong>{sel.odds.toFixed(2)}</strong>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
