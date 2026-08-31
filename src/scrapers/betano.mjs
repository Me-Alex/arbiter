import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

/**
 * Betano scraper. Betano runs on the Kambi platform; their public events feed
 * is gated behind a JS-rendered shell, so we use Playwright here too.
 */
export default class BetanoScraper extends ScraperBase {
  id = 'betano';
  name = 'Betano';
  sourceIds = ['betano'];

  timeoutMs = 35_000;
  maxAttempts = 2;

  async fetchRaw() {
    let playwright;
    try {
      playwright = await import('playwright');
    } catch (err) {
      throw new UpstreamError('playwright not installed', { cause: err });
    }
    const browser = await playwright.chromium.launch({ headless: true });
    const ctx = await browser.newContext({ locale: 'ro-RO' });
    const page = await ctx.newPage();
    try {
      const payload = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new UpstreamError('betano offer timeout', { code: 'ETIMEOUT' })),
          this.timeoutMs,
        );
        page.on('response', async (res) => {
          try {
            const u = new URL(res.url());
            if (u.hostname.includes('kambi') || u.pathname.includes('offer')) {
              const ct = res.headers()['content-type'] || '';
              if (!ct.includes('json')) return;
              const body = await res.json();
              clearTimeout(timer);
              resolve(body);
            }
          } catch {
            // ignore
          }
        });
        page.goto('https://betano.ro/sport/fotbal', { waitUntil: 'domcontentloaded', timeout: this.timeoutMs })
          .catch((err) => { clearTimeout(timer); reject(err); });
      });
      return payload;
    } finally {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('betano: payload not an object', { field: 'root' });
    }
    const events = raw.events || raw.eventsGroup?.events || [];
    if (!Array.isArray(events)) {
      throw new ValidationError('betano: payload missing events', { field: 'events' });
    }
    return events;
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const e of rawEvents) {
      const home = e?.event?.homeName || e?.homeTeam;
      const away = e?.event?.awayName || e?.awayTeam;
      if (!home || !away) continue;
      const kickoff = new Date(e?.event?.start || e?.start || Date.now()).toISOString();
      const eventKey = [
        normalizeTeamName(e?.sport || 'unknown'),
        normalizeTeamName(e?.leagueName || e?.path?.[1] || 'unknown'),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      const offers = e?.betOffers || [];
      const markets = [];
      for (const o of offers) {
        const key = String(o?.criterion?.label || o?.betOfferType?.name || o?.type || '').trim();
        if (!key) continue;
        const outcomes = o?.outcomes || [];
        const selections = outcomes.map((s) => ({
          id: String(s?.id ?? ''),
          name: String(s?.label || s?.name || '').trim(),
          odds: Number(s?.odds ?? s?.price ?? NaN),
          handicap: s?.criterion?.value ?? s?.handicap ?? null,
          group: o?.group || 'Main',
        })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
        if (selections.length === 0) continue;
        markets.push({ key, name: key, selections });
      }
      if (markets.length === 0) continue;
      out.push({
        id: String(e?.event?.id || e?.id || `${home}-${away}-${kickoff}`),
        sourceId: 'betano',
        sport: e?.sport || 'Football',
        league: e?.leagueName || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        eventKey,
        markets,
      });
    }
    return out;
  }
}
