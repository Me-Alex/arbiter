import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';

/**
 * Fortuna scraper — headless HTTP against fortuna.ro's public feed.
 *
 * NOTE: this is a working template; the exact endpoint shape changes between
 * seasons. If parse() throws ValidationError, the latest-scrape-run.json will
 * surface the field name and you can patch it without restarting the app.
 */
export default class FortunaScraper extends ProviderContract {
  id = 'fortuna';
  name = 'Fortuna';
  sourceIds = ['fortuna'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.fortuna.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/rest/offer/v1/events', {
      headers: { 'x-client': 'web' },
    });
  }

  parse(raw) {
    const list = raw?.data?.events || raw?.events || raw?.data || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.homeTeam || e?.home?.name || e?.competitors?.[0]?.name || '';
      const away = e?.awayTeam || e?.away?.name || e?.competitors?.[1]?.name || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.startTime || e?.kickoff || e?.start || Date.now()).toISOString();
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sport?.name || e?.sportName || 'Unknown',
        league: e?.league?.name || e?.leagueName || e?.category?.name || 'Unknown',
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
      const eventKey = [
        normalizeTeamName(r.sport),
        normalizeTeamName(r.league),
        r.kickoff,
        normalizeTeamName(r.homeTeam),
        normalizeTeamName(r.awayTeam),
      ].join('|');
      const markets = [];
      for (const g of r.groups) {
        const groupName = g?.name || 'Main';
        const ms = g?.markets || g?.betOffers || [];
        for (const m of ms) {
          const key = String(m?.type || m?.key || m?.name || '').trim();
          if (!key) continue;
          const sels = m?.selections || m?.outcomes || m?.odds || [];
          const selections = sels.map((s) => ({
            id: String(s?.id ?? ''),
            name: String(s?.name || s?.label || '').trim(),
            odds: Number(s?.odds ?? s?.price ?? s?.value ?? NaN),
            handicap: s?.handicap ?? s?.point ?? null,
            group: groupName,
          })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
          if (selections.length === 0) continue;
          markets.push({ key, name: m?.name || key, selections });
        }
      }
      if (markets.length === 0) continue;
      out.push({
        id: r.id,
        sourceId: 'fortuna',
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
