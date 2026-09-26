import EveryMatrixWampScraper from './everymatrix-wamp.mjs';

/**
 * Conti Bet (Romania) — EveryMatrix ODDS platform.
 *
 * Same plumbing as getsbet, different operator: the conticazino sportsbook
 * also serves odds exclusively through its RealtimeDealer WebSocket
 * (wss://api.conticazino.ro/v2, realm www.conticazino.ro, operator 2349);
 * the REST API answers HTTP 500 to unauthenticated shapes. Match discovery
 * via tournament-aggregator-groups-overview, 1X2 via each event's
 * match-odds/market-group/Populare dump (bettingTypeId 69).
 */
export default class ContiBetScraper extends EveryMatrixWampScraper {
  id = 'contibet';
  name = 'Conti Bet';
  sourceIds = ['contibet'];
  transport = 'everymatrix-odds-wamp';

  wsUrl = 'wss://api.conticazino.ro/v2';
  realm = 'www.conticazino.ro';
  origin = 'https://conticazino.ro';
  operatorId = '2349';
  siteBaseUrl = 'https://conticazino.ro';
}