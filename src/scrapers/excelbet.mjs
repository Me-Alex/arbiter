import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const DEFAULT_BASE = 'https://exalogic.excelbet.ro/XSportDatastore';
const SYSTEM_CODE = 'EXCELBET';

/**
 * ExcelBet scraper — Exalogic XSport public getPalinsestoDelGiorno feed.
 *
 * The response has `avs.avs[]` events; each event carries `scs[]` (markets)
 * with `eqs[]` (outcomes). The FINAL market (`cs=3, d="FINAL"`) is the 1X2.
 * Odds are `q / 100`.
 */
export default class ExcelBetScraper extends ScraperBase {
  id = 'excelbet';
  name = 'ExcelBet';
  sourceIds = ['excelbet'];
  /** Platform transport, shared by every Exalogic tenant on this class. */
  transport = 'exalogic-xsport-public-json';

  maxAttempts = 2;

  constructor(opts = {}) {
    super(opts);
    this.apiBase = opts.apiBase || DEFAULT_BASE;
    this.systemCode = opts.systemCode || SYSTEM_CODE;
    // Both were read further down but never assigned from `opts`, so a
    // configured value was silently dropped.
    const days = Number(opts.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      throw new ValidationError('excelbet: invalid days (1-31)');
    }
    this.days = days;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('ExcelBet: invalid maxEvents');
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const days = this.days;
    const today = new Date();
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    /** Fetch a single day's palinsesto. */
    const fetchDay = async (dayOffset) => {
      const d = new Date(today);
      d.setDate(d.getDate() + dayOffset);
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      const url = new URL(`${this.apiBase}/getPalinsestoDelGiorno`);
      url.search = new URLSearchParams({
        systemCode: this.systemCode, lingua: 'RO', hash: '',
        data: ds, idSport: '1', idAggregata: '1', timezone: '3',
      });
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(url.href, { signal: bounded, headers });
      if (!response.ok) {
        throw new UpstreamError(`ExcelBet: HTTP ${response.status} for ${ds}`);
      }
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('json') && !ct.includes('text/plain')) {
        throw new ValidationError(`ExcelBet: expected JSON for ${ds}, received ${ct || 'no content-type'}`);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          bounded.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 20_000_000) throw new ValidationError('ExcelBet: response exceeds 20 MB');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed?.avs?.avs || [];
    };
    this.sourceUrl = `${this.apiBase}/getPalinsestoDelGiorno?systemCode=${this.systemCode}&lingua=RO&data=YYYYMMDD&idSport=1`;
    this.observedAt = new Date().toISOString();
    const results = await Promise.allSettled(Array.from({ length: days }, (_, i) => fetchDay(i)));
    const allEvents = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) allEvents.push(...r.value);
    }
    if (allEvents.length === 0) throw new UpstreamError('ExcelBet: all day fetches returned 0 events');
    return { avs: { avs: allEvents } };
  }

  normalize(raw) {
    if (!raw?.avs?.avs) throw new ValidationError('ExcelBet: missing avs.avs');
    return raw.avs.avs;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const e of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (e.lv) continue; // skip live
      const name = e.dsl?.RO || e.dsl?.EN || '';
      if (!name || !name.includes(' - ')) continue;
      const [homeRaw, awayRaw] = name.split(' - ');
      const home = homeRaw?.trim();
      const away = awayRaw?.trim();
      if (!home || !away) continue;
      // Parse timestamp: "20260921 22:00:00"
      const ts = e.ts || '';
      const match = ts.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (!match) continue;
      const kickoff = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toISOString();
      // A missing bid would serialise as the string "undefined" (which passes
      // the base id check) and poison the dedup set for every later event.
      if (e.bid === undefined || e.bid === null || seen.has(e.bid)) continue;
      seen.add(e.bid);
      // Only the full-time result market (cs=3) is published. The double-chance
      // codes (15/16/17) were previously mapped to the same literal 1/X/2
      // outcome labels, so a 1X/12/X2 price was indistinguishable from the
      // result market and could be paired against another book's full-time
      // legs. They are not needed for the FT 1X2 contract, so they are dropped
      // rather than re-mapped from unverified outcome semantics.
      const marketMap = { 3: '1x2' };
      const markets = (e.scs || [])
        .map((sc) => {
          const key = marketMap[sc.cs];
          if (!key) return null;
          const name = sc.d || key;
          const outcomes = sc.eqs || [];
          const selections = outcomes
            .map((o) => {
              const odds = Number(o.q) / 100;
              if (!Number.isFinite(odds) || odds <= 1) return null;
              let sname;
              if (o.ce === 1) sname = '1';
              else if (o.ce === 2) sname = 'X';
              else if (o.ce === 3) sname = '2';
              else return null;
              return { id: `${e.bid}:${sc.cs}:${o.ce}`, name: sname, odds, handicap: null };
            })
            .filter(Boolean);
          // A 1X2 missing its draw is a two-way market; publishing it as `1x2`
          // would let the engine pair it against a complete three-way result.
          if (selections.length !== 3 || new Set(selections.map((s) => s.name)).size !== 3) return null;
          return { key, name, period: 'fulltime', selections };
        })
        .filter(Boolean);
      if (markets.length === 0) continue;
      const league = String(e.p || 'unknown');
      const eventKey = [
        normalizeTeamName('football'),
        normalizeTeamName(league),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      out.push({
        id: String(e.bid),
        // `this.id`, not a literal: MagnumBet subclasses this class and a
        // hardcoded 'excelbet' attributed its prices to another book, so the
        // engine could never count them as an independent leg.
        sourceId: this.id,
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        observedAt: this.observedAt,
        sport: 'football',
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        isLive: false,
        eventKey,
        markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl,
      transport: this.transport,
      observedAt: this.observedAt,
      coverage: { sport: 'football', market: 'fulltime-1x2', live: false, maxEvents: this.maxEvents },
    };
  }
}
