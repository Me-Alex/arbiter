/**
 * Phase 1 — Discovery.
 *
 * For each bookmaker, we ask TinyFish to navigate the sports landing page and
 * enumerate upcoming matches with their URLs. The output is a flat list we
 * then feed to the extraction phase in parallel.
 */

import { runSync } from './client.mjs';
import { discoverLinksViaBrowser } from './browser-discovery.mjs';

const DEFAULT_DISCOVERY_GOAL = `
Navigate to the sports landing page (often /sport or /prematch).
Find the pre-match football section.
Return up to {maxMatches} upcoming match URLs you can see on the page.

Output as a JSON array:
[{
  "url": "<absolute URL of the match page>",
  "league": "<league / competition name>",
  "homeTeam": "<home team name as displayed>",
  "awayTeam": "<away team name as displayed>",
  "kickoff": "<ISO 8601 timestamp>"
}]

Rules:
- Read only the links already visible after the football page loads.
- Do not open match pages, paginate, click "show more", or keep scrolling.
- Only return matches whose URLs you actually saw on the page.
- Do not invent URLs. If unsure, omit the match.
- Prefer pre-match (not in-play) markets.
- Finish immediately after collecting the visible links, even if fewer than the limit.
`.trim();

const DISCOVERY_OUTPUT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['url', 'homeTeam', 'awayTeam'],
    properties: {
      url: { type: 'string', minLength: 1 },
      league: { type: 'string' },
      homeTeam: { type: 'string', minLength: 1 },
      awayTeam: { type: 'string', minLength: 1 },
      kickoff: { type: ['string', 'null'] },
      sport: { type: 'string' },
    },
  },
};

/**
 * One agent-discovered match row, coerced field by field.
 *
 * Extracted as a pure function so the coercion of every field is a claim a
 * test can fire directly: the agent schema marks only `url`, `homeTeam` and
 * `awayTeam` required, so `sport` arrives missing on rows the model did not
 * fill in, and where the row is labelled matters — the label feeds
 * `eventIdentityKey`, where an invented sport pairs events cross-book that
 * no feed ever said were the same sport.
 *
 * @param {unknown} m
 * @param {{currency: string, locale: string}} ctx
 * @returns {object|null} null when the row cannot become a match at all.
 */
export function agentMatchFrom(m, { currency, locale }) {
  if (!m || typeof m !== 'object' || typeof m.url !== 'string') return null;
  return {
    url: m.url,
    league: typeof m.league === 'string' ? m.league : 'Unknown',
    homeTeam: typeof m.homeTeam === 'string' ? m.homeTeam : '',
    awayTeam: typeof m.awayTeam === 'string' ? m.awayTeam : '',
    kickoff: typeof m.kickoff === 'string' ? m.kickoff : null,
    sport: typeof m.sport === 'string' ? m.sport : 'Unknown',
    live: false,
    currency,
    locale,
  };
}

export async function discoverMatches({
  baseUrl,
  liveUrl,
  locale = 'ro-RO',
  currency = 'RON',
  maxMatches = 30,
  maxLiveMatches = maxMatches,
  goal,
  sessionId,
  browserProfile,
  strategy = 'browser',
  eventUrlPattern,
  tournamentUrlPattern,
  eventElementSelector,
  eventIdSelector,
  eventIdAttribute,
  eventIdPattern,
  eventUrlTemplate,
  teamSelector,
  leagueSelector,
  stripEventQuery = false,
  maxTournaments = 12,
  tournamentNavigation = true,
  onProgress = () => {},
  maxDurationSeconds = 180,
  maxSteps, // intentionally not passed to the CLI by default; some accounts aren't in the beta.
  signal,
}) {
  let browserFailure = null;
  const browserFailures = [];
  if (strategy !== 'agent') {
    const browserMatches = new Map();
    const browserTournaments = new Map();
    const sessionIds = [];
    const targets = [
      { url: baseUrl, live: false, limit: maxMatches, navigateTournaments: tournamentNavigation },
      ...(liveUrl ? [{ url: liveUrl, live: true, limit: maxLiveMatches, navigateTournaments: false }] : []),
    ];
    for (const target of targets) {
      try {
        const discovered = await discoverLinksViaBrowser({
          baseUrl: target.url,
          browserProfile,
          eventUrlPattern,
          tournamentUrlPattern,
          eventElementSelector,
          eventIdSelector,
          eventIdAttribute,
          eventIdPattern,
          eventUrlTemplate,
          teamSelector,
          leagueSelector,
          stripEventQuery,
          maxMatches: target.limit,
          maxTournaments,
          tournamentNavigation: target.navigateTournaments,
          live: target.live,
          onProgress: (event) => onProgress({ ...event, mode: target.live ? 'live' : 'prematch' }),
          signal,
        });
        sessionIds.push(discovered.sessionId);
        for (const match of discovered.matches) {
          const previous = browserMatches.get(match.url);
          browserMatches.set(match.url, previous ? { ...previous, live: previous.live || match.live } : match);
        }
        for (const tournament of discovered.tournaments) {
          browserTournaments.set(tournament.url, tournament);
        }
      } catch (err) {
        browserFailure ||= err;
        browserFailures.push({
          mode: target.live ? 'live' : 'prematch',
          url: target.url,
          error: err.message,
        });
        onProgress({
          phase: 'route-error',
          mode: target.live ? 'live' : 'prematch',
          url: target.url,
          error: err.message,
        });
      }
    }
    if (browserMatches.size > 0 || (strategy === 'browser-only' && !browserFailure)) {
      return {
        matches: [...browserMatches.values()].map((match) => ({
          ...match,
          currency,
          locale,
        })),
        tournaments: [...browserTournaments.values()],
        raw: {
          runId: sessionIds[0] || null,
          sessionIds,
          status: 'COMPLETED',
          strategy: 'browser',
          routes: targets.map((target) => ({
            mode: target.live ? 'live' : 'prematch',
            url: target.url,
          })),
          failures: browserFailures,
        },
      };
    }
    if (strategy === 'browser-only' && browserFailure) throw browserFailure;
  }

  const finalGoal = (goal || DEFAULT_DISCOVERY_GOAL).replace('{maxMatches}', String(maxMatches));
  const args = {
    url: baseUrl,
    goal: finalGoal,
    outputSchema: DISCOVERY_OUTPUT_SCHEMA,
    maxDurationSeconds,
    sessionId,
    browserProfile,
    signal,
  };
  if (maxSteps !== null && maxSteps !== undefined) args.maxSteps = maxSteps;
  const out = await runSync(args);
  if (!out.result) return { matches: [], raw: out };
  const list = Array.isArray(out.result) ? out.result : (out.result.events || out.result.matches || []);
  const matches = list
    .map((m) => agentMatchFrom(m, { currency, locale }))
    .filter((m) => m && m.homeTeam && m.awayTeam);
  return {
    matches,
    tournaments: [],
    raw: {
      ...out,
      strategy: 'agent',
      browserFailure: browserFailure?.message || null,
      browserFailures,
    },
  };
}

