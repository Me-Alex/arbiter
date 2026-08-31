import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

export default class AdmiralScraper extends ProviderContract {
  id = 'admiral';
  name = 'Admiral';
  sourceIds = ['admiral'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.admiral.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/feeds/prematch.json');
  }

  parse(raw) {
    const list = raw?.events || raw?.data || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.home || e?.homeTeam || '';
      const away = e?.away || e?.awayTeam || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.kickoff || e?.start || Date.now()).toISOString();
      const groups = e?.marketGroups || [{
        name: 'Main',
        markets: [
          ...(Number.isFinite(Number(e?.odd_1)) ? [{ key: 'HOME', name: home, selections: [{ name: home, odds: Number(e.odd_1) }] }] : []),
          ...(Number.isFinite(Number(e?.odd_x)) ? [{ key: 'DRAW', name: 'Draw', selections: [{ name: 'Draw', odds: Number(e.odd_x) }] }] : []),
          ...(Number.isFinite(Number(e?.odd_2)) ? [{ key: 'AWAY', name: away, selections: [{ name: away, odds: Number(e.odd_2) }] }] : []),
        ],
      }];
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sport || 'Football',
        league: e?.league || 'Unknown',
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
        sourceId: 'admiral',
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
