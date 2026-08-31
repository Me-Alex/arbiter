import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

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
        sport: e?.SportName || 'Football',
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
          selections: [one.selections[0], drw.selections[0], two.selections[0]],
        });
      }
      if (markets.length === 0) continue;
      out.push({
        id: r.id,
        sourceId: 'maxbet',
        sport: r.sport,
        league: r.league,
        kickoff: r.kickoff,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        eventKey,
        markets,
      });
    }
    return out;
  }
}
