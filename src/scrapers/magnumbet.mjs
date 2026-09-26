import ExcelBetScraper from './excelbet.mjs';

/**
 * MagnumBet scraper — Exalogic XSport platform at sport.magnumbet.ro.
 * Inherits all logic from ExcelBet; overrides id, name, sourceIds, and API base.
 */
export default class MagnumBetScraper extends ExcelBetScraper {
  id = 'magnumbet';
  name = 'MagnumBet';
  sourceIds = ['magnumbet'];

  constructor(opts = {}) {
    super({ apiBase: 'https://sport.magnumbet.ro/XSportDatastore', systemCode: 'MAGNUMBET', ...opts });
  }
}
