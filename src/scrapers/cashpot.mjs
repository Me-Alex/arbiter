import ExcelBetScraper from './excelbet.mjs';

/**
 * Cashpot scraper — Exalogic XSport platform at exalogic.cashpot.ro.
 *
 * Inherits all logic from ExcelBet; overrides id, name, sourceIds, and API base.
 */
export default class CashpotScraper extends ExcelBetScraper {
  id = 'cashpot';
  name = 'Cashpot';
  sourceIds = ['cashpot'];

  constructor(opts = {}) {
    super({ apiBase: 'https://exalogic.cashpot.ro/XSportDatastore', systemCode: 'CASHPOT', ...opts });
  }
}
