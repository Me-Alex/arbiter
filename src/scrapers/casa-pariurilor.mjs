import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

/**
 * Casa Pariurilor — large Romanian bookmaker, runs on its own backend. Public
 * feed endpoint rotates seasonally; this is a defensive template.
 */
export default class CasaPariurilorScraper extends ProviderContract {
  id = 'casa-pariurilor';
  name = 'Casa Pariurilor';
  sourceIds = ['casa-pariurilor'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.casapariurilor.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/sports/events', {
      headers: { 'x-source': 'web' },
    });
  }

  parse(raw) {
    const list = raw?.events || raw?.data || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.team1?.name || e?.homeTeam || '';
      const away = e?.team2?.name || e?.awayTeam || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.startDate || e?.kickoff || Date.now()).toISOString();
      const groups = e?.marketGroups || [{
        name: 'Main',
        markets: [
          ...(e?.odds?.['1'] ? [{ key: 'HOME', name: home, selections: [{ name: home, odds: Number(e.odds['1']) }] }] : []),
          ...(e?.odds?.['X'] ? [{ key: 'DRAW', name: 'Draw', selections: [{ name: 'Draw', odds: Number(e.odds['X']) }] }] : []),
          ...(e?.odds?.['2'] ? [{ key: 'AWAY', name: away, selections: [{ name: away, odds: Number(e.odds['2']) }] }] : []),
          ...(e?.extraMarkets || []).map((m) => ({
            key: m?.key || 'MISC',
            name: m?.name || m?.key || 'Market',
            selections: (m?.odds || []).map((o) => ({
              name: o?.label || o?.name || '',
              odds: Number(o?.value ?? o?.odds ?? NaN),
              handicap: o?.handicap ?? null,
            })),
          })),
        ],
      }];
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sportName || e?.sport || 'Football',
        league: e?.leagueName || e?.competition || 'Unknown',
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
      // Make sure the 3-way market is exposed as MATCH_ODDS so the engine can
      // find it across books.
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
        sourceId: 'casa-pariurilor',
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
