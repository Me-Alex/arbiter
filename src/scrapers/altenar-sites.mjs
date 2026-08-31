import { AltenarTenant } from './altenar-provider.mjs';

/**
 * The single Altenar job in config/scrapers.json fans out to one
 * AltenarTenant per book. We expose one exported list so the scraper-service
 * can iterate them.
 *
 * If you need to add a sixth Altenar book, append an entry below and add the
 * matching sourceId in config/scrapers.json.
 */

export const TENANTS = [
  {
    id: 'don',
    name: 'Don',
    baseUrl: 'https://don.ro',
    locale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
    path: '/api/altenar/events',
  },
  {
    id: 'topbet',
    name: 'TopBet',
    baseUrl: 'https://topbet.ro',
    locale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
    path: '/api/altenar/events',
  },
  {
    id: 'million',
    name: 'Million',
    baseUrl: 'https://million.ro',
    locale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
    path: '/api/altenar/events',
  },
  {
    id: 'baumbet',
    name: 'Baumbet',
    baseUrl: 'https://baumbet.ro',
    locale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
    path: '/api/altenar/events',
  },
  {
    id: 'winbet',
    name: 'Winbet',
    baseUrl: 'https://winbet.ro',
    locale: 'ro-RO',
    timezone: 'Europe/Bucharest',
    currency: 'RON',
    path: '/api/altenar/events',
  },
];

/**
 * Factory used by runScraperJob — given a job.id that points at one of the
 * Altenar books, return an AltenarTenant instance configured with the shared
 * data dir + logger.
 */
export function createAltenarTenant(jobId, { dataDir, logger, runId } = {}) {
  const cfg = TENANTS.find((t) => t.id === jobId);
  if (!cfg) return null;
  return new AltenarTenant({ ...cfg, dataDir, logger, runId });
}

export const ALTENAR_JOB_ID = 'altenar-sites';
