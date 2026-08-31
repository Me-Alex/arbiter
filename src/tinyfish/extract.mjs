/**
 * Phase 2 — Extraction.
 *
 * Given a list of match URLs from the discovery phase, hit each URL in
 * parallel (with a hard cap) and ask TinyFish to extract the odds as JSON.
 * Failures are isolated — one bad match doesn't tank the whole batch.
 */

import { submit, getResult, withTinyfishSlot } from './client.mjs';

const DEFAULT_EXTRACTION_GOAL = `
You are looking at a single match page.
Extract ALL pre-match betting markets you can see on the page.

Output as JSON:
{
  "homeTeam": "<exact home team name as displayed>",
  "awayTeam": "<exact away team name as displayed>",
  "league": "<league / competition>",
  "kickoff": "<ISO 8601 timestamp>",
  "sport": "Football",
  "markets": [
    {
      "key": "MATCH_ODDS",
      "name": "Final / 1X2 / Match Winner (whatever it's labelled)",
      "selections": [
        { "name": "<Home team or 'Home'>", "odds": 1.85, "handicap": null },
        { "name": "<Draw or 'X' or 'Egalitate'>", "odds": 3.40, "handicap": null },
        { "name": "<Away team or 'Away'>", "odds": 4.20, "handicap": null }
      ]
    },
    {
      "key": "OVER_UNDER_25",
      "name": "Total goluri Peste/Sub 2.5 (or whatever the page says)",
      "selections": [
        { "name": "Peste 2.5", "odds": 1.95, "handicap": 2.5 },
        { "name": "Sub 2.5", "odds": 1.90, "handicap": 2.5 }
      ]
    }
    // ... continue for every market you can see (BTTS, handicap, corners, etc.)
  ]
}

Rules:
- Use decimals (e.g. 1.85, not +185 or 6/4).
- Use 1.0 to mean even money / even / egal.
- handicap is the line value (e.g. -1.5, +2.5, 0.5). null for outright markets.
- Don't fabricate markets. If a market has zero selections, drop it.
- Skip live / in-play markets — pre-match only.
`.trim();

const LIVE_EXTRACTION_GOAL = DEFAULT_EXTRACTION_GOAL
  .replace('Extract ALL pre-match betting markets you can see on the page.', 'Extract ALL currently available live / in-play betting markets you can see on the page.')
  .replace('  "sport": "Football",', '  "sport": "Football",\n  "live": true,')
  .replace('- Skip live / in-play markets — pre-match only.', '- This is a live event. Only extract currently available in-play markets.');

const EXTRACTION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['homeTeam', 'awayTeam', 'markets'],
  properties: {
    homeTeam: { type: 'string', minLength: 1 },
    awayTeam: { type: 'string', minLength: 1 },
    league: { type: 'string' },
    kickoff: { type: ['string', 'null'] },
    sport: { type: 'string' },
    live: { type: 'boolean' },
    markets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'selections'],
        properties: {
          key: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          selections: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'odds'],
              properties: {
                name: { type: 'string', minLength: 1 },
                odds: { type: 'number', exclusiveMinimum: 1 },
                handicap: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * @param {object} args
 * @param {Array<{url, league, homeTeam, awayTeam, kickoff, currency, locale}>} args.matches
 * @param {number} [args.parallel=2]   wallet supports two concurrent runs
 * @param {number} [args.maxDurationSeconds=180]
 * @param {number} [args.maxSteps]     gated TinyFish option; omitted by default
 * @param {'lite'|'stealth'} [args.browserProfile]
 * @param {string} [args.goal]   override the default extraction prompt
 * @param {Function} [args.onProgress]  ({done, total, url, status}) => void
 */
export async function extractOdds({
  matches,
  parallel = 2,
  maxDurationSeconds = 180,
  maxSteps,
  browserProfile,
  goal,
  onProgress = () => {},
  signal,
}) {
  if (!Array.isArray(matches) || matches.length === 0) return { events: [], runs: [] };

  const queue = matches.slice();
  const results = [];
  const parallelCount = Math.max(1, Math.min(parallel, queue.length));
  const workers = Array.from({ length: parallelCount }, () => worker());
  await Promise.all(workers);

  async function worker() {
    while (queue.length > 0) {
      const m = queue.shift();
      let runResult;
      try {
        if (signal?.aborted) throw new Error('TinyFish extraction aborted');
        const submitArgs = {
          url: m.url,
          goal: goal || (m.live ? LIVE_EXTRACTION_GOAL : DEFAULT_EXTRACTION_GOAL),
          outputSchema: EXTRACTION_OUTPUT_SCHEMA,
          maxDurationSeconds,
          browserProfile,
        };
        if (maxSteps !== null && maxSteps !== undefined) submitArgs.maxSteps = maxSteps;
        const out = await withTinyfishSlot(async () => {
          const { runId } = await submit(submitArgs);
          return await getResult(runId, {
            timeoutMs: maxDurationSeconds * 1000 + 30_000,
            pollMs: 4_000,
            signal,
          });
        }, { signal });
        runResult = { ...out, url: m.url, ok: true };
      } catch (err) {
        if (signal?.aborted) throw err;
        runResult = { url: m.url, ok: false, error: err.message || String(err) };
      }
      results.push(runResult);
      try { onProgress({ done: results.length, total: matches.length, url: m.url, ok: runResult.ok }); } catch { /* ignore */ }
    }
  }

  const events = [];
  for (const r of results) {
    if (!r.ok || !r.result) continue;
    const match = matches.find((item) => item.url === r.url);
    const ev = normalizeExtraction(r.result, r.url, match);
    if (ev) events.push(ev);
  }
  return { events, runs: results };
}

function normalizeExtraction(raw, sourceUrl, match = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const homeTeam = raw.homeTeam || raw.home || '';
  const awayTeam = raw.awayTeam || raw.away || '';
  if (!homeTeam || !awayTeam) return null;
  const markets = Array.isArray(raw.markets) ? raw.markets : [];
  const norm = [];
  for (const m of markets) {
    if (!m || !Array.isArray(m.selections)) continue;
    const key = canonicalMarketKey(m.key || m.name);
    if (!key) continue;
    const sels = m.selections
      .map((s) => ({
        name: String(s.name || '').trim(),
        odds: Number(s.odds),
        handicap: s.handicap === null || s.handicap === undefined ? null : Number(s.handicap),
      }))
      .filter((s) => s.name && Number.isFinite(s.odds) && s.odds > 1);
    if (sels.length < 2) continue;
    norm.push({ key, name: String(m.name || m.key || key), selections: sels });
  }
  if (norm.length === 0) return null;
  return {
    sourceUrl,
    homeTeam,
    awayTeam,
    league: raw.league || 'Unknown',
    sport: raw.sport || 'Football',
    kickoff: raw.kickoff || null,
    live: Boolean(match.live || raw.live),
    markets: norm,
  };
}

/**
 * Map a free-form market name into a stable key the engine recognises.
 * Tolerant of Romanian ("Peste/Sub"), English ("Over/Under"), German, etc.
 */
const KEY_PATTERNS = [
  [/^(1x2|match\s*winner|match\s*odds|final|vincitore)/i, 'MATCH_ODDS'],
  [/(over|under|peste|sub|sub\s*\/\s*peste|total)\s*(goals?|goluri)?\s*([0-9]+\.?[0-9]*)/i, (m) => `OVER_UNDER_${m[3].replace('.', '_')}`],
  [/both\s*teams?\s*to\s*score|ambele\s*marcheaza|^btts$/i, 'BTTS'],
  [/asian\s*handicap|^ah[\s_-]/i, (m) => `AH_${(m[0] || '').replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`],
  [/handicap/i, 'HANDICAP'],
  [/corners?|corneruri/i, 'CORNERS'],
  [/cards?|cartona/i, 'CARDS'],
];

export function canonicalMarketKey(name) {
  if (!name) return null;
  const s = String(name).toLowerCase().trim();
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s)) return s.toUpperCase();
  const searchable = s.replace(/[_-]+/g, ' ');
  for (const [re, target] of KEY_PATTERNS) {
    const m = searchable.match(re);
    if (m) {
      return typeof target === 'function' ? target(m).slice(0, 64) : target;
    }
  }
  // Fall back to a slugged version of the raw name.
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || null;
}
