import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { describeError, summariseReasons } from './feg-common.mjs';

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

    // Injectable so the empty-session path is reachable without a browser:
    // every way this adapter can come back empty used to end in a silent
    // success, and none of them could be tested without launching Chromium.
    // `ctx` is declared here rather than inside the else-branch so the teardown
    // below can close it on the injected path too, where there is no browser.
    let page;
    let ctx = null;
    let browser = null;
    if (this.pageFactory) {
      page = await this.pageFactory();
    } else {
      browser = await pw.chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
      // No userAgent override: the context inherits the UA of the Chromium that
      // is actually running. The context used to pin Chrome/131 while
      // Playwright 1.62 ships a much newer build, and a declared identity that
      // disagrees with the binary's own TLS fingerprint is one of the most
      // heavily weighted bot signals there is — it defeats the stealth plugin
      // this adapter depends on rather than helping it.
      ctx = await browser.newContext({ locale: 'ro-RO' });
      page = await ctx.newPage();
    }
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

    const merged = {
      data: { topEventsV2: { eventIdList: [], events: {}, leagues: {}, markets: {}, selections: {} } },
    };

    try {
      // Step 1: Navigate to main page to clear Cloudflare
      await page.goto('https://ro.betano.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      // The title only reads "Pariuri" once the app has mounted, and a runner's
      // locale may never produce it. The old loop ran its full 30 s in that
      // case, on every run, before a single feed request — which is why this
      // book took 40 s on the runner and 23 s locally. Half the budget, and the
      // title is logged below either way, so a wait that never succeeds is
      // visible rather than merely slow.
      const titleDeadline = Date.now() + 15_000;
      let title = '';
      while (Date.now() < titleDeadline) {
        await page.waitForTimeout(2000);
        title = await page.title();
        if (title.includes('Pariuri')) break;
      }
      if (!title.includes('Pariuri')) {
        this.logger('info', `Betano: home page never showed the app (title="${title}")`);
      }
      await page.waitForTimeout(3000);

      // Step 2: Navigate to a sport page to establish session
      await page.goto('https://betano.ro/sport/fotbal', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(5000);

      // Step 3: Fetch top-events-v2 for each sport ID via in-page fetch.
      //
      // Every failure used to be swallowed: a non-2xx returned null, a missing
      // topEventsV2 continued, a thrown in-page request was caught and ignored.
      // All 36 could fail and the run still reported success with zero events,
      // which is indistinguishable from a day with no fixtures. The reasons are
      // counted so a total failure can say what actually came back.
      const reasons = new Map();
      const record = (why) => reasons.set(why, (reasons.get(why) || 0) + 1);

      for (const sportId of SPORT_IDS) {
        signal?.throwIfAborted();
        try {
          const payload = await page.evaluate(async (sid) => {
            const res = await fetch('/api/home/top-events-v2/?sportId=' + sid, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) return { __status: res.status };
            return res.json();
          }, sportId);

          if (payload?.__status) { record(`HTTP ${payload.__status}`); continue; }
          const top = payload?.data?.topEventsV2;
          // `typeof {} === 'object'`, so a well-formed empty body used to pass
          // this shape check. An empty topEventsV2 means the session was never
          // established, not that there are no fixtures.
          if (!top || typeof top !== 'object' || !Array.isArray(top.eventIdList)) {
            record('no topEventsV2 in the response');
            continue;
          }
          for (const eid of (top.eventIdList || [])) {
            if (!merged.data.topEventsV2.events[String(eid)]) {
              merged.data.topEventsV2.eventIdList.push(eid);
            }
          }
          Object.assign(merged.data.topEventsV2.events, top.events || {});
          Object.assign(merged.data.topEventsV2.leagues, top.leagues || {});
          Object.assign(merged.data.topEventsV2.markets, top.markets || {});
          Object.assign(merged.data.topEventsV2.selections, top.selections || {});
        } catch (err) {
          if (signal?.aborted) throw err;
          record(describeError(err));
        }
      }

      // A run where nothing at all came back is a failed run. Reporting it as
      // an empty success is how this book went missing for a day while the run
      // report said "ok".
      if (merged.data.topEventsV2.eventIdList.length === 0) {
        throw new UpstreamError(
          `Betano: no events from ${SPORT_IDS.length} in-page requests — ${summariseReasons(reasons)}`,
        );
      }

      // Step 4: search/topevents is redundant — all its events are already
      // covered by the multi-sportId top-events-v2 queries above.

      this.logger('info', `Betano: merged ${merged.data.topEventsV2.eventIdList.length} event IDs, ${Object.keys(merged.data.topEventsV2.events).length} with details`);
    } finally {
      // No context on the injected path, where there is no browser to close.
      await ctx?.close().catch(() => {});
      // No browser on the injected path, where there is none to close.
      await browser?.close().catch(() => {});
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
