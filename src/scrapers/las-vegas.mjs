import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

export default class LasVegasScraper extends ProviderContract {
  id = 'las-vegas';
  name = 'Las Vegas';
  sourceIds = ['las-vegas'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.lasvegas.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/sport/feed');
  }

  parse(raw) {
    const list = raw?.events || raw?.data || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.HomeTeam || e?.homeTeam || e?.home || '';
      const away = e?.AwayTeam || e?.awayTeam || e?.away || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.EventTime || e?.StartTime || Date.now()).toISOString();
      const groups = e?.Markets || e?.marketGroups || [{
        name: 'Main',
        markets: [
          ...(Number.isFinite(Number(e?.OddsHome)) ? [{ key: 'HOME', name: home, selections: [{ name: home, odds: Number(e.OddsHome) }] }] : []),
          ...(Number.isFinite(Number(e?.OddsDraw)) ? [{ key: 'DRAW', name: 'Draw', selections: [{ name: 'Draw', odds: Number(e.OddsDraw) }] }] : []),
          ...(Number.isFinite(Number(e?.OddsAway)) ? [{ key: 'AWAY', name: away, selections: [{ name: away, odds: Number(e.OddsAway) }] }] : []),
        ],
      }];
      return {
        id: String(e?.Id ?? e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.Sport || 'Football',
        league: e?.League || 'Unknown',
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
        sourceId: 'las-vegas',
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
