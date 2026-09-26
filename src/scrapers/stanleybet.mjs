import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName, decimalOdds } from '../shared/text.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';

/**
 * LEGACY — not the live path for Stanleybet.
 *
 * Stanleybet runs on the NSoft platform, and `config/scrapers.json` routes
 * the `stanleybet` job to `nsoft.mjs` through `matchesNSoftConfig`, so nothing
 * in a normal run instantiates this class. It shares Admiral's company UUID
 * and its feed event-for-event, so the two are grouped in
 * `src/scanner/feed-groups.mjs` and never paired with each other.
 *
 * The endpoint this class targets, `/feeds/events`, returns the SPA shell
 * rather than JSON. The saved capture in data/endpoints-all/ already records
 * NSoft URLs, which is the path that works.
 */
export default class StanleybetScraper extends ProviderContract {
  id = 'stanleybet';
  name = 'Stanleybet';
  sourceIds = ['stanleybet'];

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.stanleybet.ro', locale: 'ro-RO', ...opts });
  }

  async fetchRaw() {
    return await this.fetchJson('/feeds/events', {
      headers: { Accept: 'application/json' },
    });
  }

  parse(raw) {
    const list = raw?.events || raw?.data?.events || raw || [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
      const home = e?.home || e?.homeTeam || e?.HomeTeam || '';
      const away = e?.away || e?.awayTeam || e?.AwayTeam || '';
      if (!home || !away) return null;
      const kickoff = new Date(e?.date || e?.kickoff || e?.StartDate || Date.now()).toISOString();
      const markets = [];
      // 1X2
      const threeWay = [];
      if (Number.isFinite(Number(e?.homeOdds ?? e?.Home))) threeWay.push({ name: home, odds: Number(e.homeOdds ?? e.Home) });
      if (Number.isFinite(Number(e?.drawOdds ?? e?.Draw))) threeWay.push({ name: 'Draw', odds: Number(e.drawOdds ?? e.Draw) });
      if (Number.isFinite(Number(e?.awayOdds ?? e?.Away))) threeWay.push({ name: away, odds: Number(e.awayOdds ?? e.Away) });
      if (threeWay.length === 3) markets.push({ key: 'MATCH_ODDS', name: 'Match Odds', selections: threeWay });
      // totals + others
      const extras = e?.markets || e?.extraMarkets || [];
      for (const m of extras) {
        const sels = (m?.selections || []).map((s) => ({
          name: s?.label || s?.name || '',
          odds: decimalOdds(s?.odds ?? s?.price ?? s),
          handicap: s?.handicap ?? s?.total ?? null,
          group: 'Main',
        })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
        if (sels.length === 0) continue;
        markets.push({ key: m?.key || m?.type || 'MISC', name: m?.name || m?.key || 'Market', selections: sels });
      }
      return {
        id: String(e?.id ?? `${normalizeTeamName(home)}-${normalizeTeamName(away)}-${kickoff}`),
        sport: e?.sport || 'Football',
        league: e?.league || e?.competition || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        groups: [{ name: 'Main', markets }],
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
        sourceId: 'stanleybet',
        // Deep link to the event page, never /feeds/events. Guarded on a
        // provider-issued id so a synthesised fallback key can't produce a
        // URL that looks browseable but 404s.
        sourceUrl: (this.baseUrl && /^\d+$/.test(r.id)) ? `${this.baseUrl}/eveniment/${r.id}` : null,
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
