import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

export default class WinBossScraper extends ProviderContract {
  id = 'winboss';
  name = 'WinBoss';
  sourceIds = ['winboss'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.winboss.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/offer');
  }

  parse(raw) {
    const list = raw?.events || raw?.data?.events || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.homeTeam || e?.home || e?.Team1 || '';
      const away = e?.awayTeam || e?.away || e?.Team2 || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.kickoff || e?.startDate || Date.now()).toISOString();
      return {
        id: String(e?.eventId ?? e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sportName || e?.sport || 'Football',
        league: e?.leagueName || e?.league || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        groups: e?.marketGroups || [{ name: 'Main', markets: e?.markets || [] }],
      };
    }).filter(Boolean);
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const r of rawEvents) {
      const eventKey = buildEventKey(r, normalizeTeamName);
      const markets = flattenMarkets(r.groups, { defaultGroupName: 'Main' });
      if (markets.length === 0) continue;
      out.push({
        id: r.id,
        sourceId: 'winboss',
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
