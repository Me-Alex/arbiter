import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, eventIdentityKey, normalizeTeamName } from '../shared/text.mjs';

const API_BASE = 'https://totalbet.pl/dealer/bdata/v1/bet';

/**
 * TotalBet Poland Scraper — Polish Licensed Sportsbook (totalbet.pl).
 *
 * REST API architecture:
 *   - Events listing: /dealer/bdata/v1/bet/events?type=prematch&per_page={limit}&page={page}
 *   - Event details: /dealer/bdata/v1/bet/events/{uuid}
 *   - Exact odds parity verified against live totalbet.pl in-browser.
 *   - Markets: 1X2 (Wynik meczu), Obie drużyny strzelą gola (BTTS), Total Over/Under.
 */
export default class TotalBetPlScraper extends ScraperBase {
  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.id = 'totalbet-pl';
    this.name = 'TotalBet Poland';
    this.sourceIds = ['totalbet-pl'];
    this.engine = 'totalbet-rest-v1';
    this.transport = 'totalbet-public-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.detailLimit = opts.detailLimit === 'all' ? 120 : Number(opts.detailLimit ?? 60);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();
    this.sport = opts.sport || 'football';
    this.endpoint = opts.endpoint || `${API_BASE}/events?type=prematch&per_page=100&page=1`;
    this.sourceUrl = this.endpoint;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    const allEvents = [];
    const perPage = Math.min(this.maxEvents, 100);
    const maxPages = Math.ceil(this.maxEvents / perPage);

    for (let page = 1; page <= maxPages; page++) {
      bounded.throwIfAborted();
      const url = `${API_BASE}/events?type=prematch&per_page=${perPage}&page=${page}`;
      let res;
      try {
        res = await this.fetchImpl(url, {
          signal: bounded,
          headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new UpstreamError(`TotalBet PL: events fetch failed (${err.message})`, { cause: err });
      }

      if (!res.ok) {
        throw new UpstreamError(`TotalBet PL: events HTTP ${res.status}`, { status: res.status });
      }

      const json = await readBoundedJson(res, { maxBytes: 15_000_000 });
      const pageEvents = Array.isArray(json?.data?.events) ? json.data.events : [];
      if (pageEvents.length === 0) break;

      allEvents.push(...pageEvents);

      const totalPages = Number(json?._meta?.pagination?.total_pages);
      if (Number.isFinite(totalPages) && page >= totalPages) break;
      if (allEvents.length >= this.maxEvents) break;
    }

    // Enrich top events with detail component_lists using bounded concurrency
    const detailCandidates = allEvents.slice(0, this.detailLimit).filter((e) => !e.component_lists || e.component_lists.length <= 1);
    let detailCursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, detailCandidates.length) }, async () => {
        while (detailCursor < detailCandidates.length) {
          const ev = detailCandidates[detailCursor++];
          try {
            const detailRes = await this.fetchImpl(`${API_BASE}/events/${ev.uuid}`, {
              signal: bounded,
              headers: {
                accept: 'application/json',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              },
            });
            if (detailRes.ok) {
              const detailData = await readBoundedJson(detailRes, { maxBytes: 5_000_000 });
              if (detailData?.data?.event?.component_lists) {
                ev.component_lists = detailData.data.event.component_lists;
              }
            }
          } catch {
            // Gracefully retain list-level markets
          }
        }
      })
    );

    return { events: allEvents };
  }

  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.events)) return raw.events;
    if (Array.isArray(raw?.data?.events)) return raw.data.events;
    if (Array.isArray(raw?.data)) return raw.data;
    return [];
  }

  extractEvents(rawEvents) {
    const events = [];
    const seen = new Set();
    const liveEvidence = liveCoverageFor('totalbet-pl');
    const isLiveDefault = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      if (!ev) continue;

      let homeTeam = '';
      let awayTeam = '';

      if (Array.isArray(ev.participants) && ev.participants.length >= 2) {
        homeTeam = String(ev.participants[0]?.name || '').trim();
        awayTeam = String(ev.participants[1]?.name || '').trim();
      }

      if (!homeTeam || !awayTeam) {
        const rawName = String(ev.name || '').trim();
        const parts = rawName.includes(' - ') ? rawName.split(' - ') : rawName.split(/\s+vs\.?\s+/i);
        if (parts.length >= 2) {
          homeTeam = parts[0].trim();
          awayTeam = parts.slice(1).join(' - ').trim();
        }
      }

      if (!homeTeam || !awayTeam) continue;

      const startTime = Date.parse(ev.start_at);
      if (!Number.isFinite(startTime) || startTime <= 0) continue;

      const now = this.from ?? Date.now();
      const isPast = startTime < now;
      if (isPast && !this.includePast) continue;

      const windowEnd = this.to ?? (now + this.windowHours * 3600000);
      if (startTime > windowEnd) continue;

      const id = String(ev.uuid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const kickoff = new Date(startTime).toISOString();
      const league = String(ev.tournament?.name || ev.category?.name || 'Ekstraklasa').trim();

      const markets = [];

      // 1. Full-time 1X2 or 2-way Winner from event.markets
      const eventMarkets = Array.isArray(ev.markets) ? ev.markets : [];
      for (const m of eventMarkets) {
        if (!m || !Array.isArray(m.outcomes)) continue;
        const mName = String(m.name || '').trim();
        if ((m.game_type === 'threeway' || /wynik\s+meczu/i.test(mName)) && m.outcomes.length >= 3) {
          let o1 = null;
          let oX = null;
          let o2 = null;

          for (const oc of m.outcomes) {
            const odds = Number(oc.odds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const sort = oc.sort;
            const name = String(oc.name || '').trim().toLowerCase();

            if (sort === 1 || name === homeTeam.toLowerCase()) {
              o1 = odds;
            } else if (sort === 2 || name === 'remis' || name === 'x') {
              oX = odds;
            } else if (sort === 3 || name === awayTeam.toLowerCase()) {
              o2 = odds;
            }
          }

          if (o1 && oX && o2) {
            markets.push({
              key: '1x2',
              name: '1X2',
              period: 'fulltime',
              live: isLiveDefault,
              selections: [
                { id: `${id}:1x2:1`, name: '1', odds: o1, handicap: null },
                { id: `${id}:1x2:X`, name: 'X', odds: oX, handicap: null },
                { id: `${id}:1x2:2`, name: '2', odds: o2, handicap: null },
              ],
            });
          }
        } else if (
          m.outcomes.length === 2
          && (m.game_type === 'twoway' || /^(?:zwyci[eę]zca(?:\s+meczu|\s*\((?:wraz\s+z|z)\s+dogrywk[aą]\))?|12|wynik\s+meczu)$/i.test(mName))
          && !/remis\s*=\s*zwrot|zak[łl]ad\s+bez\s+remisu|handicap/i.test(mName)
        ) {
          let o1 = null;
          let o2 = null;
          for (const oc of m.outcomes) {
            const odds = Number(oc.odds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const sort = oc.sort;
            const name = String(oc.name || '').trim().toLowerCase();
            if (name === homeTeam.toLowerCase() || name === '1' || sort === 1) {
              o1 = odds;
            } else if (name === awayTeam.toLowerCase() || name === '2' || sort === 2 || sort === 3) {
              o2 = odds;
            }
          }
          if (o1 && o2) {
            const isOt = !/\bbez\s+dogrywki\b/i.test(mName) && /\b(?:wraz\s+z|z)\s+dogrywk[aą]/i.test(mName);
            const period = isOt ? 'fulltime_ot' : 'fulltime';
            markets.push({
              key: 'MATCH_ODDS',
              name: isOt ? 'Match Winner (z dogrywką)' : 'Match Winner',
              period,
              live: isLiveDefault,
              selections: [
                { id: `${id}:ml:1`, name: homeTeam, odds: o1, handicap: null },
                { id: `${id}:ml:2`, name: awayTeam, odds: o2, handicap: null },
              ],
            });
          }
        }
      }

      // 2. Parse component_lists if present (BTTS, DC, DNB, Halves, Handicap, Match & Team Totals)
      const componentLists = Array.isArray(ev.component_lists) ? ev.component_lists : [];
      const periodFromColLabel = (txt) => {
        const s = String(txt || '').trim().toLowerCase();
        if (!s || /ca[łl]y\s+mecz|mecz/i.test(s)) return 'fulltime';
        if (/^1\.\s*po[łl]owa/i.test(s)) return 'half1';
        if (/^2\.\s*po[łl]owa/i.test(s)) return 'half2';
        return null;
      };
      for (const comp of componentLists) {
        if (!comp || !Array.isArray(comp.grid) || comp.grid.length === 0) continue;
        const compName = String(comp.name || '').trim();
        const headerRow = Array.isArray(comp.grid[0]) ? comp.grid[0] : [];

        // Obie drużyny strzelą gola (BTTS — per column: Cały mecz / 1. Połowa / 2. Połowa)
        if (/^obie\s+dru[żz]yny\s+strzel/i.test(compName)) {
          const cols = headerRow.length > 1 ? headerRow.length : 2;
          for (let col = 1; col < cols; col++) {
            const period = headerRow[col]?.text ? periodFromColLabel(headerRow[col].text) : (col === 1 ? 'fulltime' : null);
            if (!period) continue;
            let yesOdds = null;
            let noOdds = null;
            for (let r = 1; r < comp.grid.length; r++) {
              const cell = comp.grid[r]?.[col];
              if (cell?.type === 'outcome') {
                const odds = Number(cell.odds);
                if (Number.isFinite(odds) && odds > 1) {
                  const label = String(cell.name || comp.grid[r]?.[0]?.text || '').trim().toLowerCase();
                  if (label === 'tak' || label === 'yes') yesOdds = odds;
                  else if (label === 'nie' || label === 'no') noOdds = odds;
                }
              }
            }
            if (yesOdds && noOdds) {
              const mKey = period === 'fulltime' ? 'btts' : (period === 'half1' ? 'BTH1' : 'BTH2');
              markets.push({
                key: mKey,
                name: period === 'fulltime' ? 'Both Teams to Score' : `${period === 'half1' ? '1st Half' : '2nd Half'} Both Teams to Score`,
                period,
                live: isLiveDefault,
                selections: [
                  { id: `${id}:${mKey}:yes`, name: 'Yes', odds: yesOdds, handicap: null },
                  { id: `${id}:${mKey}:no`, name: 'No', odds: noOdds, handicap: null },
                ],
              });
            }
          }
        }

        // Podwójna szansa (Double Chance — Cały mecz & 1. Połowa)
        if (/^podw[óo]jna\s+szansa$/i.test(compName) && comp.type === 'markets_in_columns') {
          for (let col = 1; col < headerRow.length; col++) {
            const period = periodFromColLabel(headerRow[col]?.text);
            if (!period) continue;
            const c1x = Number(comp.grid[1]?.[col]?.odds);
            const c12 = Number(comp.grid[2]?.[col]?.odds);
            const cx2 = Number(comp.grid[3]?.[col]?.odds);
            if (c1x > 1 && c12 > 1 && cx2 > 1) {
              const mKey = period === 'fulltime' ? 'DOUBLE_CHANCE' : (period === 'half1' ? 'DCH1' : 'DCH2');
              markets.push({
                key: mKey,
                name: period === 'fulltime' ? 'Double Chance' : `${period === 'half1' ? '1st Half' : '2nd Half'} Double Chance`,
                period,
                live: isLiveDefault,
                selections: [
                  { id: `${id}:${mKey}:1X`, name: '1X', odds: c1x, handicap: null },
                  { id: `${id}:${mKey}:12`, name: '12', odds: c12, handicap: null },
                  { id: `${id}:${mKey}:X2`, name: 'X2', odds: cx2, handicap: null },
                ],
              });
            }
          }
        }

        // Remis = zwrot (Draw No Bet — Cały mecz & 1. Połowa)
        if (/^remis\s*=\s*zwrot$/i.test(compName) && comp.type === 'markets_in_columns') {
          for (let col = 1; col < headerRow.length; col++) {
            const period = periodFromColLabel(headerRow[col]?.text);
            if (!period) continue;
            const o1 = Number(comp.grid[1]?.[col]?.odds);
            const o2 = Number(comp.grid[2]?.[col]?.odds);
            if (o1 > 1 && o2 > 1) {
              const mKey = period === 'fulltime' ? 'DRAW_NO_BET' : (period === 'half1' ? 'DNH1' : 'DNH2');
              markets.push({
                key: mKey,
                name: period === 'fulltime' ? 'Draw No Bet' : `${period === 'half1' ? '1st Half' : '2nd Half'} Draw No Bet`,
                period,
                live: isLiveDefault,
                selections: [
                  { id: `${id}:${mKey}:1`, name: '1', odds: o1, handicap: null },
                  { id: `${id}:${mKey}:2`, name: '2', odds: o2, handicap: null },
                ],
              });
            }
          }
        }

        // Wynik połowy (1st Half & 2nd Half 1X2 — non-literal ['Home','Draw','Away'] per base.mjs contract)
        if (/^wynik\s+po[łl]owy$/i.test(compName) && comp.type === 'markets_in_columns') {
          for (let col = 1; col < headerRow.length; col++) {
            const period = periodFromColLabel(headerRow[col]?.text);
            if (period !== 'half1' && period !== 'half2') continue;
            const o1 = Number(comp.grid[1]?.[col]?.odds);
            const oX = Number(comp.grid[2]?.[col]?.odds);
            const o2 = Number(comp.grid[3]?.[col]?.odds);
            if (o1 > 1 && oX > 1 && o2 > 1) {
              const mKey = period === 'half1' ? 'MRH1' : 'MRH2';
              markets.push({
                key: mKey,
                name: period === 'half1' ? '1st Half Result' : '2nd Half Result',
                period,
                live: isLiveDefault,
                selections: [
                  { id: `${id}:${mKey}:1`, name: 'Home', odds: o1, handicap: null },
                  { id: `${id}:${mKey}:X`, name: 'Draw', odds: oX, handicap: null },
                  { id: `${id}:${mKey}:2`, name: 'Away', odds: o2, handicap: null },
                ],
              });
            }
          }
        }

        // Handicap 2-way (FT, 1st Half, 2nd Half)
        if (comp.type === 'handicap_2col' && /^(?:(?:[12]\.\s*po[łl]owa\s*-\s*)?handicap)$/i.test(compName)) {
          const period = /^1\./i.test(compName) ? 'half1' : (/^2\./i.test(compName) ? 'half2' : 'fulltime');
          for (let r = 1; r < comp.grid.length; r++) {
            const row = comp.grid[r];
            if (!Array.isArray(row) || row.length < 4) continue;
            const h1 = Number(String(row[0]?.text || '').replace(',', '.'));
            const o1 = Number(row[1]?.odds);
            const h2 = Number(String(row[2]?.text || '').replace(',', '.'));
            const o2 = Number(row[3]?.odds);
            if (!Number.isFinite(h1) || !Number.isFinite(h2) || !(o1 > 1) || !(o2 > 1)) continue;
            if (h1 === 0 && h2 === 0) continue; // already covered by Remis = zwrot
            markets.push({
              key: `handicap:${period}:${h1}`,
              name: `${compName} ${h1}`,
              period,
              live: isLiveDefault,
              line: h1,
              selections: [
                { id: `${id}:ah:${period}:${h1}:1`, name: `1 (${h1})`, odds: o1, handicap: h1 },
                { id: `${id}:ah:${period}:${h1}:2`, name: `2 (${h2})`, odds: o2, handicap: h2 },
              ],
            });
          }
        }

        // Total (suma) Over/Under — Match FT, 1H, 2H, and Home/Away Team Totals
        if (comp.type === 'total' && /total\s*\(suma\)/i.test(compName)) {
          let period = 'fulltime';
          let team = null;
          if (/^1\.\s*po[łl]owa/i.test(compName)) period = 'half1';
          else if (/^2\.\s*po[łl]owa/i.test(compName)) period = 'half2';
          const prefix = compName.replace(/\s*-\s*total\s*\(suma\).*$/i, '').trim();
          if (prefix && prefix.toLowerCase() !== 'total (suma)' && !/^[12]\.\s*po[łl]owa$/i.test(prefix)) {
            const normPrefix = normalizeTeamName(prefix);
            if (normPrefix && normPrefix === normalizeTeamName(homeTeam)) team = 'home';
            else if (normPrefix && normPrefix === normalizeTeamName(awayTeam)) team = 'away';
            else continue;
          }

          for (const row of comp.grid) {
            if (!Array.isArray(row) || row.length < 3) continue;
            const lineCell = row[0];
            const line = Number(lineCell?.text);
            if (!Number.isFinite(line) || line <= 0) continue;

            const underCell = row[1];
            const overCell = row[2];

            const underOdds = Number(underCell?.odds);
            const overOdds = Number(overCell?.odds);

            if (Number.isFinite(underOdds) && underOdds > 1 && Number.isFinite(overOdds) && overOdds > 1) {
              const isMainMatchTotal = period === 'fulltime' && !team;
              const mKey = isMainMatchTotal ? `total:${line}` : `total:${period}:${team || 'match'}:${line}`;
              markets.push({
                key: mKey,
                name: isMainMatchTotal ? `Total Over/Under ${line}` : `${compName} ${line}`,
                period,
                ...(team ? { team } : {}),
                live: isLiveDefault,
                line,
                selections: [
                  { id: `${id}:${mKey}:over`, name: `Over ${line}`, odds: overOdds, handicap: line },
                  { id: `${id}:${mKey}:under`, name: `Under ${line}`, odds: underOdds, handicap: line },
                ],
              });
            }
          }
        }
      }

      if (markets.length === 0) continue;

      const evSport = canonicalSport(ev.sport?.name || ev.path?.[0]?.name || this.sport || 'football');
      events.push({
        id,
        sourceId: this.id,
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        runId: this.runId,
        observedAt: this.observedAt ?? new Date().toISOString(),
        sport: evSport,
        league,
        homeTeam,
        awayTeam,
        kickoff,
        live: isLiveDefault,
        eventKey: eventIdentityKey({ sport: evSport, kickoff, homeTeam, awayTeam }),
        markets,
      });

      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}
