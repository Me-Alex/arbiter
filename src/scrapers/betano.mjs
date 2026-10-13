import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { describeError, summariseReasons } from './feg-common.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

/** All known Betano sport IDs from sportCallerSportMapping + live layout. */
const SPORT_IDS = ['FOOT', 'TENN', 'BASK', 'HANB', 'ICEH', 'VOLY', 'FUTS', 'DART', 'SNOO', 'MMA', 'RUGB', 'CRIC', 'ESPORTS', 'TABT', 'BADM', 'BASE', 'AMFO', 'MMAF', 'ESPS', 'VOLL', 'HAND', 'WTPL', 'TABL', 'BOXI', 'BCHV', 'VRTS', 'SWIM', 'FENC', 'TAEK', 'WINT', 'ATHL', 'GYMA', 'MOGP', 'RALL', 'MOTO', 'SPED', 'FRM1'];

/**
 * Betano markets whose two selections are bare signed spreads with no side
 * token at all — "FHOT" (Handicap) publishes "-8.5" / "+8.5" and nothing else.
 * Neither leg can be labelled home or away from its own name, so the contract
 * resolved (the line is legible) and then priced no leg at all.
 *
 * The SIGN is the side, which is what a spread without team names means: a
 * negative line is the home handicap, a positive one the away handicap. Index
 * order carries no such guarantee and cannot be used — measured on the
 * 2026-09-29 capture, FHOT listed the negative leg first on 29 markets and the
 * positive leg first on 15. Ordering the buckets by position would have split
 * one handicap across two lineKeys, so the side is stamped into the name and
 * the provider's own leg order is left untouched; handicapLineKey then normalises
 * by the token and both orders collapse onto the same line.
 *
 * Only a market whose BOTH legs are bare, opposite-signed and on a half line is
 * rewritten. Anything else is passed through unchanged so resolveContract keeps
 * withholding a shape it cannot prove exhaustive.
 *
 * BETANO SERVES NO FOOTBALL HANDICAP, so none of the above reaches a football
 * event — and that is worth stating here, at the one function a reader would
 * otherwise assume is how betano's handicap is read.
 *
 * Measured 2026-09-29 over the whole board this feed exposes: betano answers 25
 * to 43 events per sport id and football is 26 of 232, and NONE of those 26
 * carries a handicap market. The feed's four handicap-typed markets are
 * `FHOT "Handicap"` (29 rows), `HCAP` (12), `AHOT` (25) and `FAHC` (29, split
 * between "Handicap" and "Handicap meci"), and every one of them sits on a
 * non-football event: the samples read "Elverum -3.5 / Hammarby HB +3.5"
 * (ice hockey), "Alejandro Tabilo -3.5 / Tommy Paul +3.5" (tennis), "FaZe Clan
 * -1.5 / Nemiga +1.5" (esports), and a -8.5/+8.5 pair that is a set line and
 * not a football handicap at any level.
 *
 * Football is nine shapes and no handicap: `MRES` result, `MR12` MegaCote
 * result, `HCTG` total goals, `OUH1` first-half goals, `BTSC` both teams to
 * score, `DBLC` double chance, `DNOB` draw no bet, `CNOU` corners, `TCOU`
 * cards. Corners and cards are withheld because the engine has no family for
 * them; double chance and draw-no-bet are catalogued and not arbitrable.
 *
 * So this rewrite is a guard, not the live football path: it is correct, it is
 * tested, and it costs nothing, but the honest reading of the coverage table is
 * that betano contributes two families on football and that the other seven are
 * not on offer here. The same trap this documents is live at netbet, whose
 * `handicap` / `goals_handicap` / `run_line` rows are likewise other sports.
 */
const BARE_SPREAD_KEYS = new Set(['FHOT']);
const BARE_SPREAD = /^\s*([+-])\s*(\d+(?:[.,]\d+)?)\s*$/;

/**
 * Resolve Betano market period with dynamic sub-window identification
 * (halves, quarters, sets) based on both market name and Betano type codes.
 */
function periodForBetano(mType, mName) {
  const fromName = extractPeriodFromName(mName);
  if (fromName) return fromName;
  const t = String(mType || '').toUpperCase();
  if (/^OUH1\b|^MRH1\b|^BTH1\b|^H1PO\b|^DCH1\b|^DNH1\b/.test(t) || /(?:^|_)H1(?:_|$)/.test(t)) return 'half1';
  if (/^OUH2\b|^MRH2\b|^BTH2\b|^H2PO\b|^DCH2\b|^DNH2\b/.test(t) || /(?:^|_)H2(?:_|$)/.test(t)) return 'half2';
  const qM = /^Q([1-4])/.exec(t);
  if (qM) return `q${qM[1]}`;
  const sM = /^S([1-5])/.exec(t);
  if (sM) return `set${sM[1]}`;
  return 'fulltime';
}

/** Returns the selections with sides assigned, or the input if it is not this shape. */
function assignBareSpreadSides(key, sels) {
  if (!BARE_SPREAD_KEYS.has(key) || sels.length !== 2) return sels;
  const legs = sels.map((s) => BARE_SPREAD.exec(String(s.name || '')));
  if (legs.some((m) => m === null)) return sels;
  const [a, b] = legs.map((m) => ({ sign: m[1], line: Number(m[2].replace(',', '.')) }));
  if (a.sign === b.sign) return sels;
  // Half lines only. At .0 the result pushes instead of settling, so the market
  // is not exhaustive; this also excludes 0, which is neither a spread nor a line.
  const isHalf = (x) => !Number.isInteger(x) && Number.isInteger(x * 2);
  if (!isHalf(a.line) || !isHalf(b.line)) return sels;
  return sels.map((s, i) => {
    const { sign, line } = i === 0 ? a : b;
    return {
      ...s,
      providerName: s.name,
      // "1 (-8.5)" / "2 (+8.5)": the canonical numbered form every other adapter
      // publishes and the only one canonicalOutcomeFor labels. A signed line on
      // its own is not enough — it is the side token the matcher looks for. The
      // sign is kept inside the brackets because it is what the provider printed.
      name: `${sign === '-' ? '1' : '2'} (${sign}${line})`,
      // The provider's own `handicap` on this market is a type flag (measured:
      // 3 and 4 on FHOT, 1 on TGHC), not a line. Stamping each leg with its own
      // signed line keeps findMiddles comparing lines instead of flags; it never
      // checks that two legs are the same side, so both legs carrying one value
      // would report a middle between one market's own two sides.
      handicap: `${sign}${line}`,
    };
  });
}

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
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxAttempts = 1;
    this.sport = opts.sport || 'all';
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
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
      if (this.sport && this.sport !== 'all' && canonicalSport(sportName) !== canonicalSport(this.sport)) continue;
      const isLive = Boolean(ev.isLive || ev.live || ev.inPlay || ev.state === 'LIVE' || ev.scoreboard);
      if (isLive && !this.includeLive) continue;
      const eventKey = [
        normalizeTeamName(sportName.toLowerCase()), normalizeTeamName(league), kickoff,
        normalizeTeamName(home), normalizeTeamName(away),
      ].join('|');
      const eventMarkets = [];
      const seen = new Set();
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

        let subject;
        if (sportName === 'Basketball') subject = 'points';
        else if (sportName === 'Tennis') subject = 'games';
        else if (/^HCTG$|^OUH[12]$/.test(m.type) || (sportName === 'Football' && (m.type?.includes('OU') || m.type?.includes('TG') || m.type === 'HCTG'))) subject = 'goals';
        else if (sportName === 'Handball' || sportName === 'Ice Hockey') subject = 'goals';

        const period = periodForBetano(m.type, m.name);

        const dedupKey = `${period}:${m.type || mid}:${subject || ''}:${sels.map((s) => `${s.name}:${s.handicap}`).join('|')}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        eventMarkets.push({
          key: m.type || String(mid),
          name: m.name || m.type || 'Market',
          period,
          ...(subject ? { subject } : {}),
          selections: assignBareSpreadSides(m.type || String(mid), sels),
        });
      }
      if (eventMarkets.length === 0) continue;
      markMarketsLive(eventMarkets, () => isLive);
      // Per-event deep link only. The feed URL is an API endpoint, not a
      // browseable page: emitting it as a fallback would render a link icon
      // that dumps raw JSON on the user, so an event without a public path
      // gets null and the UI omits the link entirely.
      const sourceUrl = ev.url ? `https://ro.betano.com${ev.url}` : null;
      out.push({
        id: String(eid), sourceId: 'betano', sourceUrl,
        sport: sportName, league, kickoff,
        homeTeam: home, awayTeam: away, eventKey,
        live: isLive, isLive,
        markets: eventMarkets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'betano-top-events-json', observedAt: this.observedAt,
      coverage: { sport: 'multi-sport', allMarkets: true, ...liveCoverageFor(this.id), maxEvents: this.maxEvents } };
  }
}
