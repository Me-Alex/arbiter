import ExcelBetScraper from './excelbet.mjs';

/**
 * Las Vegas scraper — Exalogic XSport platform at exalogic.lasvegas.ro.
 *
 * Inherits all logic from ExcelBet; overrides id, name, sourceIds, and API base.
 * This used to be a near-verbatim copy of excelbet.mjs, so any fix to the shared
 * parsing had to be repeated per tenant and could silently drift.
 */
export default class LasVegasScraper extends ExcelBetScraper {
  id = 'las-vegas';
  name = 'Las Vegas';
  sourceIds = ['las-vegas'];

  constructor(opts = {}) {
    super({ apiBase: 'https://exalogic.lasvegas.ro/XSportDatastore', systemCode: 'LASVEGAS', ...opts });
  }
}
