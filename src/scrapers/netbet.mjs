import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

export default class NetBetScraper extends ProviderContract {
  id = 'netbet';
  name = 'NetBet';
  sourceIds = ['netbet'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.netbet.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/feed/events');
  }

  parse(raw) {
    const list = raw?.events || raw?.data?.events || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.homeTeam || e?.home?.name || '';
      const away = e?.awayTeam || e?.away?.name || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.startDate || e?.kickoff || Date.now()).toISOString();
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sport?.name || e?.sportName || 'Football',
        league: e?.competition?.name || e?.leagueName || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        groups: e?.marketGroups || e?.marketsGroup || [{ name: 'Main', markets: e?.markets || [] }],
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
        sourceId: 'netbet',
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
