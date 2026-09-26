import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName, decimalOdds } from '../shared/text.mjs';

/**
 * Unibet scraper (Kambi platform). Same shape considerations as Betano.
 */
export default class UnibetScraper extends ProviderContract {
  id = 'unibet';
  name = 'Unibet';
  sourceIds = ['unibet'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.unibet.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/api/kambi/offer/v1/betoffer/list.json', {
      headers: { 'x-application': 'web' },
    });
  }

  parse(raw) {
    const events = raw?.events || [];
    return events.map((e) => {
      const home = e?.event?.homeName || '';
      const away = e?.event?.awayName || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.event?.start || Date.now()).toISOString();
      return {
        id: String(e?.event?.id ?? e?.id ?? `${home}-${away}-${kickoff}`),
        sport: e?.sport || 'Unknown',
        league: e?.leagueName || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        groups: [{ name: 'Main', markets: e?.betOffers || [] }],
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
        const ms = g.markets || [];
        for (const m of ms) {
          const key = String(m?.criterion?.label || m?.betOfferType?.name || m?.type || m?.name || '').trim();
          if (!key) continue;
          const sels = m?.outcomes || [];
          const selections = sels.map((s) => ({
            id: String(s?.id ?? ''),
            name: String(s?.label || s?.name || '').trim(),
            odds: decimalOdds(s?.odds ?? s?.price ?? s),
            handicap: s?.criterion?.value ?? s?.handicap ?? null,
            group: 'Main',
          })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
          if (selections.length === 0) continue;
          markets.push({ key, name: key, selections });
        }
      }
      if (markets.length === 0) continue;
      out.push({
        id: r.id,
        sourceId: 'unibet',
        // Deep link to the event page, never the JSON offer feed. Kambi
        // events are addressable by their own id under /sportsbook/#/event.
        // Guarded on a numeric id: `parse()` above synthesises a
        // `${home}-${away}-${kickoff}` fallback when the provider omits one,
        // and a truthy check alone would emit that as a link that 404s.
        sourceUrl: (this.baseUrl && /^\d+$/.test(r.id)) ? `${this.baseUrl}/sportsbook/#/event/${r.id}` : null,
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
