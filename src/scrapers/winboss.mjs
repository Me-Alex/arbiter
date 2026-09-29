import ExcelBetScraper from './excelbet.mjs';

/**
 * WinBoss scraper — Exalogic XSport platform at exalogic.winboss.ro.
 *
 * Inherits all logic from ExcelBet; overrides id, name, sourceIds, and API base.
 * This used to be a near-verbatim copy of excelbet.mjs, which meant a fix to the
 * shared parsing (market codes, selection ids, the non-2xx guard) had to be
 * repeated per tenant and silently drifted: the copy's content-type error still
 * said "ExcelBet" inside the WinBoss adapter.
 */
export default class WinBossScraper extends ExcelBetScraper {
  id = 'winboss';
  name = 'WinBoss';
  sourceIds = ['winboss'];

  constructor(opts = {}) {
    super({ apiBase: 'https://exalogic.winboss.ro/XSportDatastore', systemCode: 'WINBOSS', ...opts });
  }
}
