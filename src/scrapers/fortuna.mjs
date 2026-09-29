import { FegCatalogueScraper } from './feg-common.mjs';

/**
 * Fortuna scraper — catalogue-based traversal.
 *
 * Pipeline: tournament catalogue → tournament matches → market overview.
 * Fetches ALL football tournaments, traverses each for fixtures,
 * then hydrates markets in batches. This captures ~595 football fixtures
 * vs the ~20 from the widget endpoint.
 *
 * The traversal itself is shared with Casa Pariurilor (one upstream feed, see
 * FegCatalogueScraper); this class supplies only its own origin, identity and
 * the transport label stamped on Fortuna's events.
 */
export default class FortunaScraper extends FegCatalogueScraper {
  id = 'fortuna';
  name = 'Fortuna';
  sourceIds = ['fortuna'];
  apiBase = 'https://api.efortuna.ro';
  transport = 'fortuna-catalogue-v1';
}
