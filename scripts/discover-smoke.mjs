// Quick live smoke: just the discovery phase against one book.
import { discoverMatches } from '../src/tinyfish/discovery.mjs';
import { TINYFISH_BOOKS } from '../src/tinyfish/books.mjs';

const book = process.argv[2] || 'superbet';
const cfg = TINYFISH_BOOKS[book];
if (!cfg) throw new Error(`Unknown TinyFish book: ${book}`);
const requestedLimit = Number.parseInt(process.argv[3] || '', 10);
const prematchLimit = Number.isInteger(requestedLimit) && requestedLimit > 0
  ? requestedLimit
  : (cfg.maxDiscoveredMatches || cfg.maxMatches);
console.log(`▶ Discovering matches on ${cfg.name}: ${cfg.baseUrl}`);
const { matches, raw } = await discoverMatches({
  baseUrl: cfg.baseUrl,
  liveUrl: cfg.liveUrl,
  maxMatches: prematchLimit,
  maxLiveMatches: Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : (cfg.maxLiveMatches || prematchLimit),
  maxDurationSeconds: cfg.maxDurationSeconds,
  browserProfile: cfg.browserProfile,
  strategy: cfg.discoveryStrategy || 'browser-only',
  eventUrlPattern: cfg.eventUrlPattern,
  tournamentUrlPattern: cfg.tournamentUrlPattern,
  eventElementSelector: cfg.eventElementSelector,
  eventIdSelector: cfg.eventIdSelector,
  eventIdAttribute: cfg.eventIdAttribute,
  eventIdPattern: cfg.eventIdPattern,
  eventUrlTemplate: cfg.eventUrlTemplate,
  teamSelector: cfg.teamSelector,
  leagueSelector: cfg.leagueSelector,
  stripEventQuery: cfg.stripEventQuery,
  maxTournaments: cfg.maxTournaments,
  tournamentNavigation: cfg.tournamentNavigation,
  onProgress: (event) => console.log('  discovery:', JSON.stringify(event)),
});
console.log(`✓ discovered ${matches.length} matches`);
console.log(`  prematch=${matches.filter((match) => !match.live).length}, live=${matches.filter((match) => match.live).length}`);
for (const m of matches.slice(0, 5)) {
  console.log(`  ${m.kickoff || '????'}  ${m.homeTeam} vs ${m.awayTeam}  (${m.league})`);
  console.log(`    ${m.url}`);
}
console.log(`\nrun steps: ${raw?.steps ?? '?'}, status: ${raw?.status}`);
