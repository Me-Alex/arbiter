import EveryMatrixWampScraper from './everymatrix-wamp.mjs';

/**
 * Get's Bet (Romania) — EveryMatrix ODDS platform.
 *
 * Odds are not served over REST (the REST API answers HTTP 500 to every
 * unauthenticated shape); the sportsbook's own frontend reads them from the
 * RealtimeDealer WebSocket via WAMP v2. Working recipe (fully
 * reverse-engineered against the live dealer):
 *
 *   wss://api-online.getsbet.ro/v2   realm online.getsbet.ro   operator 2476
 *   HELLO → WELCOME → REGISTER → REGISTERED → CALL /sports#initialDump
 *
 * Match discovery uses the tournament-aggregator-groups-overview topics
 * (groups 2794 Home/Draw/Away + 2795 totals), 1X2 odds come from each
 * event's match-odds/market-group/Populare dump (bettingTypeId 69
 * "Final - Timp regulamentar."). Every value comes from the live dealer.
 */
export default class GetsBetScraper extends EveryMatrixWampScraper {
  id = 'getsbet';
  name = "Get's Bet";
  sourceIds = ['getsbet'];
  transport = 'everymatrix-odds-wamp';

  wsUrl = 'wss://api-online.getsbet.ro/v2';
  realm = 'online.getsbet.ro';
  origin = 'https://sports2.getsbet.ro';
  operatorId = '2476';
  siteBaseUrl = 'https://sports2.getsbet.ro';
}