import ExcelBetScraper from './excelbet.mjs';

/**
 * Luck (luck.com / luck.ro) — Exalogic XSport platform at sport.luck.com.
 *
 * Discovered via REA MCP (`capture_browser_scenario`, evidence
 * `ev_0a528ad60c4baec081c8dcac1d7e246229e9f2e71756ce2868e0cde7315d9244`):
 * `https://sport.luck.com/XSportDatastore` with `systemCode=LUCKY`.
 * Measured 100/100 byte-identical 1X2 vectors against `excelbet`; grouped
 * under `exalogic-xsport` in `src/scanner/feed-groups.mjs`.
 */
export default class LuckScraper extends ExcelBetScraper {
  id = 'luck';
  name = 'Luck';
  sourceIds = ['luck'];

  constructor(opts = {}) {
    super({ apiBase: 'https://sport.luck.com/XSportDatastore', systemCode: 'LUCKY', ...opts });
    this.sourceUrl = opts.sourceUrl || 'https://luck.com/sport';
  }
}
