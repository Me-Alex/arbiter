import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

export default class ExcelBetScraper extends ProviderContract {
  id = 'excelbet';
  name = 'ExcelBet';
  sourceIds = ['excelbet'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.excelbet.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/public/events');
  }

  parse(raw) {
    const list = raw?.events || raw?.data || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.homeName || e?.home || '';
      const away = e?.awayName || e?.away || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.start || e?.kickoff || Date.now()).toISOString();
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sport || 'Football',
        league: e?.league || 'Unknown',
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
        sourceId: 'excelbet',
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
