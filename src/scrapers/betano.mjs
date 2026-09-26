import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError } from '../shared/errors.mjs';

/** All known Betano sport IDs from sportCallerSportMapping + live layout. */
const SPORT_IDS = ['FOOT', 'TENN', 'BASK', 'HANB', 'ICEH', 'VOLY', 'FUTS', 'DART', 'SNOO', 'MMA', 'RUGB', 'CRIC', 'ESPORTS', 'TABT', 'BADM', 'BASE', 'AMFO', 'MMAF', 'ESPS', 'VOLL', 'HAND', 'WTPL', 'TABL', 'BOXI', 'BCHV', 'VRTS', 'SWIM', 'FENC', 'TAEK', 'WINT', 'ATHL', 'GYMA', 'MOGP', 'RALL', 'MOTO', 'SPED', 'FRM1'];

/**
 * Betano scraper — multi-sport stealth interception.
 *
 * Navigates to one sport page to clear Cloudflare, then fetches
 * top-events-v2 for each sport ID via in-page fetch. Each sportId
 * param returns different event details (25-43 per sport).
 */
export default class BetanoScraper extends ScraperBase {
  id = 'betano';
  name = 'Betano';
  sourceIds = ['betano'];

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxAttempts = 1;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    let pw;
    try {
      pw = await import('playwright-extra');
      const stealth = (await import('puppeteer-extra-plugin-stealth')).default;
      pw.chromium.use(stealth());
    } catch { pw = await import('playwright'); }

    const browser = await pw.chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({ locale: 'ro-RO', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const merged = {
      data: { topEventsV2: { eventIdList: [], events: {}, leagues: {}, markets: {}, selections: {} } },
    };

    try {
      // Step 1: Navigate to main page to clear Cloudflare
      await page.goto('https://ro.betano.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      for (let i = 0; i < 15; i++) { await page.waitForTimeout(2000); if ((await page.title()).includes('Pariuri')) break; }
      await page.waitForTimeout(3000);

      // Step 2: Navigate to a sport page to establish session
      await page.goto('https://betano.ro/sport/fotbal', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(5000);

      // Step 3: Fetch top-events-v2 for each sport ID via in-page fetch

      for (const sportId of SPORT_IDS) {
        signal?.throwIfAborted();
        try {
          const payload = await page.evaluate(async (sid) => {
            const res = await fetch('/api/home/top-events-v2/?sportId=' + sid, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) return null;
            return res.json();
          }, sportId);

          const top = payload?.data?.topEventsV2;
          if (!top) continue;
          for (const eid of (top.eventIdList || [])) {
            if (!merged.data.topEventsV2.events[String(eid)]) {
              merged.data.topEventsV2.eventIdList.push(eid);
            }
          }
          Object.assign(merged.data.topEventsV2.events, top.events || {});
          Object.assign(merged.data.topEventsV2.leagues, top.leagues || {});
          Object.assign(merged.data.topEventsV2.markets, top.markets || {});
          Object.assign(merged.data.topEventsV2.selections, top.selections || {});
        } catch { /* skip failed sports */ }
      }

      // Step 4: search/topevents is redundant — all its events are already
      // covered by the multi-sportId top-events-v2 queries above.

      this.logger('info', `Betano: merged ${merged.data.topEventsV2.eventIdList.length} event IDs, ${Object.keys(merged.data.topEventsV2.events).length} with details`);
    } finally {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    this.sourceUrl = 'https://betano.ro (multi-sport top-events-v2)';
    this.observedAt = new Date().toISOString();
    return merged;
  }

  normalize(raw) {
    const top = raw?.data?.topEventsV2 || raw?.topEventsV2;
    if (!top?.events || typeof top.events !== 'object') {
      throw new ValidationError('Betano: missing topEventsV2.events');
    }
    return top;
  }

  extractEvents(top) {
    const { events: evts = {}, leagues = {}, markets: mktMap = {}, selections: selMap = {}, eventIdList = [] } = top;
    const out = [];
    const ids = eventIdList.length ? eventIdList : Object.keys(evts);
    const SPORT_NAMES = { FOOT: 'Football', TENN: 'Tennis', BASK: 'Basketball', HANB: 'Handball', ICEH: 'Ice Hockey', VOLY: 'Volleyball', FUTS: 'Futsal', DART: 'Darts', SNOO: 'Snooker', MMA: 'MMA', RUGB: 'Rugby', CRIC: 'Cricket', ESPORTS: 'Esports', TABT: 'Table Tennis', BADM: 'Badminton', BASE: 'Baseball', AMFO: 'American Football' };
    for (const eid of ids) {
      if (out.length >= this.maxEvents) break;
      const ev = evts[String(eid)];
      if (!ev) continue;
      const home = ev.participants?.[0]?.shortName || ev.participants?.[0]?.name || '';
      const away = ev.participants?.[1]?.shortName || ev.participants?.[1]?.name || '';
      if (!home || !away) continue;
      const kickoff = ev.startTime ? new Date(ev.startTime).toISOString() : new Date().toISOString();
      const league = leagues?.[String(ev.leagueId)]?.name || 'Unknown';
      const sportName = SPORT_NAMES[ev.sportId] || ev.sportId || 'Unknown';
      const eventKey = [
        normalizeTeamName(sportName.toLowerCase()), normalizeTeamName(league), kickoff,
        normalizeTeamName(home), normalizeTeamName(away),
      ].join('|');
      const eventMarkets = [];
      // Source 1: top-events-v2 format (markets in separate map)
      for (const mid of (ev.marketIdList || [])) {
        if (String(mid).startsWith('search_')) continue; // skip search-market IDs
        const m = mktMap[String(mid)];
        if (!m) continue;
        const sels = (m.selectionIdList || [])
          .map((sid) => selMap?.[String(sid)]).filter(Boolean)
          .filter((s) => Number.isFinite(s.price) && s.price > 1)
          .map((s) => ({ id: String(s.id), name: String(s.shortName || s.name || '').trim(), odds: Number(s.price), handicap: s.handicap ?? null, group: 'Main' }));
        if (sels.length < 2) continue;
        eventMarkets.push({ key: m.type || String(mid), name: m.name || m.type || 'Market', period: 'fulltime', selections: sels });
      }
      if (eventMarkets.length === 0) continue;
      // Per-event deep link only. The feed URL is an API endpoint, not a
      // browseable page: emitting it as a fallback would render a link icon
      // that dumps raw JSON on the user, so an event without a public path
      // gets null and the UI omits the link entirely.
      const sourceUrl = ev.url ? `https://ro.betano.com${ev.url}` : null;
      out.push({
        id: String(eid), sourceId: 'betano', sourceUrl,
        sport: sportName, league, kickoff,
        homeTeam: home, awayTeam: away, eventKey,
        markets: eventMarkets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'betano-top-events-json', observedAt: this.observedAt,
      coverage: { sport: 'multi-sport', allMarkets: true, live: false, maxEvents: this.maxEvents } };
  }
}
