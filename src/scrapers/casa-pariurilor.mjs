import { FegCatalogueScraper } from './feg-common.mjs';

/**
 * Casa Pariurilor scraper — catalogue-based traversal.
 *
 * Same upstream feed as Fortuna (both are resold from the Fortuna BFF, see the
 * `fortuna-bff` group in scanner/feed-groups.mjs), so the traversal lives in
 * FegCatalogueScraper and this class supplies only its own origin, identity and
 * the transport label stamped on Casa Pariurilor's events.
 */
export default class CasaPariurilorScraper extends FegCatalogueScraper {
  id = 'casa-pariurilor';
  name = 'Casa Pariurilor';
  sourceIds = ['casa-pariurilor'];
  apiBase = 'https://api.casapariurilor.ro';
  transport = 'casa-catalogue-v1';
}
