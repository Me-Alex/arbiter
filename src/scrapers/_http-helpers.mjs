// ProviderContract kept for JSDoc only — no runtime import needed

/**
 * Shared helpers for the simpler HTTP scrapers. Each bookmaker still ships as
 * its own file (per config/scrapers.json) — these utilities just deduplicate
 * the boring parts: event key construction, market flattening, validation.
 */
export function buildEventKey({ sport, league, kickoff, homeTeam, awayTeam }, normalize) {
  return [
    normalize(sport || 'unknown'),
    normalize(league || 'unknown'),
    new Date(kickoff).toISOString(),
    normalize(homeTeam),
    normalize(awayTeam),
  ].join('|');
}

export function flattenMarkets(groups, { defaultGroupName = 'Main', normalizeOdds = Number } = {}) {
  const markets = [];
  for (const g of groups || []) {
    if (!g) continue;
    const groupName = g.name || g.groupName || defaultGroupName;
    const ms = g.markets || g.betOffers || g.selectionsByMarket || [];
    if (!Array.isArray(ms)) continue;
    for (const m of ms) {
      if (!m) continue;
      const key = String(
        m.type || m.key || m.marketKey || m.marketType || m.name || m.label || '',
      ).trim();
      if (!key) continue;
      const sels = m.selections || m.outcomes || m.odds || [];
      if (!Array.isArray(sels)) continue;
      const selections = [];
      for (const s of sels) {
        if (!s) continue;
        const rawOdds = s.odds ?? s.price ?? s.value ?? s.decimal ?? s.Odds ?? s.Price;
        const odds = normalizeOdds(rawOdds);
        if (!Number.isFinite(odds) || odds <= 1) continue;
        selections.push({
          id: String(s.id ?? s.selectionId ?? s.SelectionId ?? ''),
          name: String(s.name || s.label || s.outcomeName || s.SelectionName || '').trim(),
          odds,
          handicap: s.handicap ?? s.point ?? s.HCP ?? null,
          group: groupName,
        });
      }
      if (selections.length === 0) continue;
      markets.push({ key, name: String(m.name || m.label || key), selections });
    }
  }
  return markets;
}
