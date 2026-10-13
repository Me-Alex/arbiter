import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';
import { markMarketsLive } from './live-status.mjs';

/**
 * LEGACY — not the live path for MaxBet.
 *
 * MaxBet runs on the NSoft platform, and `config/scrapers.json` routes the
 * `maxbet` job to `nsoft.mjs` through `matchesNSoftConfig`, so nothing in a
 * normal run instantiates this class. It is kept because the NSoft path would
 * need somewhere to fall back to, and because `unibet.mjs` and
 * `stanleybet.mjs` still use the same ProviderContract shape.
 *
 * The endpoint this class targets, `/api/sports`, was never MaxBet's feed: it
 * returns 404, while the NSoft distribution endpoint answers for MaxBet's
 * company UUID with a complete catalogue. The `/api/sports` path came from the
 * class's original assumption, not from an observed request.
 */
export default class MaxBetScraper extends ProviderContract {
  id = 'maxbet';
  name = 'MaxBet';
  sourceIds = ['maxbet'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.maxbet.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/sports');
  }

  parse(raw) {
    const list = raw?.events || raw?.SportsEvents || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.HomeName || e?.home || e?.Team1 || '';
      const away = e?.AwayName || e?.away || e?.Team2 || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.MatchTime || e?.StartTime || Date.now()).toISOString();
      const groups = e?.MarketGroups || [{
        name: 'Main',
        markets: [
          ...(Number.isFinite(Number(e?.HomeOdds)) ? [{ key: 'HOME', name: home, selections: [{ name: home, odds: Number(e.HomeOdds) }] }] : []),
          ...(Number.isFinite(Number(e?.DrawOdds)) ? [{ key: 'DRAW', name: 'Draw', selections: [{ name: 'Draw', odds: Number(e.DrawOdds) }] }] : []),
          ...(Number.isFinite(Number(e?.AwayOdds)) ? [{ key: 'AWAY', name: away, selections: [{ name: away, odds: Number(e.AwayOdds) }] }] : []),
        ],
      }];
      return {
        id: String(e?.EventId ?? e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.SportName || 'Unknown',
        league: e?.LeagueName || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        groups,
      };
    }).filter(Boolean);
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const r of rawEvents) {
      const eventKey = buildEventKey(r, normalizeTeamName);
      const markets = flattenMarkets(r.groups, { defaultGroupName: 'Main' });
      const one = markets.find((m) => m.key === 'HOME');
      const drw = markets.find((m) => m.key === 'DRAW');
      const two = markets.find((m) => m.key === 'AWAY');
      if (one && drw && two) {
        markets.push({
          key: 'MATCH_ODDS',
          name: 'Match Odds',
          period: 'fulltime',
          selections: [one.selections[0], drw.selections[0], two.selections[0]],
        });
      }
      if (markets.length === 0) continue;
      const isLive = Boolean(r.isLive || r.live);
      markMarketsLive(markets, () => isLive);
      out.push({
        id: r.id,
        sourceId: 'maxbet',
        // Deep link to the event page, never /api/sports. Guarded on a
        // provider-issued id so a synthesised fallback key can't produce a
        // URL that looks browseable but 404s.
        sourceUrl: (this.baseUrl && /^\d+$/.test(r.id)) ? `${this.baseUrl}/eveniment/${r.id}` : null,
        sport: r.sport,
        league: r.league,
        kickoff: r.kickoff,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        live: isLive,
        eventKey,
        markets,
      });
    }
    return out;
  }
}
