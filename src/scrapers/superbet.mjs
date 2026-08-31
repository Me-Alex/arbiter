import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

/**
 * Superbet scraper.
 *
 * Superbet gates its odds endpoint behind a JS-driven SPA, so we use Playwright
 * to bootstrap a session, intercept the /prematch/offer response, and let the
 * parser run against that JSON. If you'd rather do headless HTTP, swap
 * fetchRaw() with the direct REST call (will likely break as they rotate
 * tokens).
 */
export default class SuperbetScraper extends ScraperBase {
  id = 'superbet';
  name = 'Superbet';
  sourceIds = ['superbet'];

  timeoutMs = 35_000;
  maxAttempts = 2;

  async fetchRaw() {
    const url = 'https://superbet.ro/prematch/offer';
    let playwright;
    try {
      playwright = await import('playwright');
    } catch (err) {
      throw new UpstreamError(
        'playwright not installed — run `npm install playwright && npx playwright install chromium`',
        { cause: err },
      );
    }
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'ro-RO',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
    });
    const page = await context.newPage();
    try {
      const payload = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new UpstreamError('superbet offer timeout', { code: 'ETIMEOUT' })), this.timeoutMs);
        const onResponse = async (res) => {
          try {
            const u = new URL(res.url());
            if (u.pathname.includes('/prematch/offer') || u.pathname.includes('/offer')) {
              const ct = res.headers()['content-type'] || '';
              if (!ct.includes('json')) return;
              const body = await res.json();
              clearTimeout(timer);
              page.off('response', onResponse);
              resolve(body);
            }
          } catch {
            // ignore non-JSON responses
          }
        };
        page.on('response', onResponse);
        (async () => {
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
            await page.waitForLoadState('networkidle', { timeout: this.timeoutMs }).catch(() => {});
          } catch (err) {
            clearTimeout(timer);
            page.off('response', onResponse);
            reject(err);
          }
        })();
      });
      return payload;
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('superbet: payload not an object', { field: 'root' });
    }
    const events = raw.events || raw.data?.events || [];
    if (!Array.isArray(events)) {
      throw new ValidationError('superbet: payload missing events', { field: 'events' });
    }
    return events;
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const e of rawEvents) {
      const home = e?.competitors?.[0]?.name || e?.homeTeam;
      const away = e?.competitors?.[1]?.name || e?.awayTeam;
      if (!home || !away) continue;
      const kickoff = new Date(e.startDate || e.kickoff || Date.now()).toISOString();
      const eventKey = [
        normalizeTeamName(e.sport?.name || 'unknown'),
        normalizeTeamName(e.tournament?.name || 'unknown'),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      const markets = this._flatten(e.betOfferGroups || e.markets || [], e);
      if (markets.length === 0) continue;
      out.push({
        id: String(e.id || e.eventId || `${home}-${away}-${kickoff}`),
        sourceId: 'superbet',
        sport: e.sport?.name || 'Unknown',
        league: e.tournament?.name || e.category?.name || 'Unknown',
        kickoff,
        homeTeam: home,
        awayTeam: away,
        eventKey,
        markets,
      });
    }
    return out;
  }

  _flatten(groups, _root) {
    const markets = [];
    for (const g of groups) {
      const groupName = g?.name || 'Main';
      const offers = g?.betOffers || g?.markets || [];
      if (!Array.isArray(offers)) continue;
      for (const o of offers) {
        const key = String(o?.betOfferType?.name || o?.type || o?.key || '').trim();
        if (!key) continue;
        const outcomes = o?.outcomes || o?.selections || [];
        if (!Array.isArray(outcomes)) continue;
        const selections = outcomes.map((s) => ({
          id: String(s?.id ?? ''),
          name: String(s?.label || s?.name || '').trim(),
          odds: Number(s?.oddsAmerican ? americanToDecimal(s.oddsAmerican) : s?.odds ?? NaN),
          handicap: s?.criterion?.value ?? s?.handicap ?? null,
          group: groupName,
        })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
        if (selections.length === 0) continue;
        markets.push({ key, name: o?.betOfferType?.name || key, selections });
      }
    }
    return markets;
  }
}

function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a)) return NaN;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}
