import EveryMatrixWampScraper from './everymatrix-wamp.mjs';

/**
 * Player (player) — EveryMatrix ODDS platform.
 *
 * Same plumbing as getsbet and contibet on EveryMatrix ODDS:
 * Player's sportsbook serves odds through its RealtimeDealer WebSocket
 * (wss://api.player.ro/v2, realm www.player.ro, operator 2474).
 * Match discovery via tournament-aggregator-groups-overview, 1X2 via
 * each event's match-odds/market-group/Populare dump (bettingTypeId 69).
 */
export default class PlayerScraper extends EveryMatrixWampScraper {
  id = 'player';
  name = 'Player';
  sourceIds = ['player'];
  transport = 'everymatrix-odds-wamp';

  wsUrl = 'wss://api.player.ro/v2';
  realm = 'www.player.ro';
  origin = 'https://sports2.player.ro';
  operatorId = '2474';
  siteBaseUrl = 'https://sports2.player.ro';
}
