import Superbet from './superbet.mjs';
import Betano from './betano.mjs';
import Fortuna from './fortuna.mjs';
import Unibet from './unibet.mjs';
import Stanleybet from './stanleybet.mjs';
import CasaPariurilor from './casa-pariurilor.mjs';
import ExcelBet from './excelbet.mjs';
import NetBet from './netbet.mjs';
import Admiral from './admiral.mjs';
import WinBoss from './winboss.mjs';
import MaxBet from './maxbet.mjs';
import LasVegas from './las-vegas.mjs';
import TinyfishScraper from './tinyfish-scraper.mjs';
import { TENANTS as ALTENAR_TENANTS, createAltenarTenant } from './altenar-sites.mjs';
import { TINYFISH_BOOKS, getBookConfig } from '../tinyfish/books.mjs';

/**
 * Registry of every concrete scraper class keyed by job.id from
 * config/scrapers.json. The orchestrator calls instantiate(id, opts) to get a
 * ready-to-run scraper instance.
 *
 * For the Altenar job we don't have one class — we have five tenants that
 * fan out into one class each. createAltenarTenant handles that case.
 *
 * TinyFish-backed scrapers are constructed lazily from config/tinyfish-books
 * via a single TinyfishScraper class. Adding a book = add an entry to
 * TINYFISH_BOOKS + a job in config/scrapers.json.
 */

const DIRECT = {
  superbet: Superbet,
  betano: Betano,
  fortuna: Fortuna,
  unibet: Unibet,
  stanleybet: Stanleybet,
  'casa-pariurilor': CasaPariurilor,
  excelbet: ExcelBet,
  netbet: NetBet,
  admiral: Admiral,
  winboss: WinBoss,
  maxbet: MaxBet,
  'las-vegas': LasVegas,
};

const ALTENAR_IDS = new Set(ALTENAR_TENANTS.map((t) => t.id));
const TINYFISH_IDS = new Set(Object.keys(TINYFISH_BOOKS));

/**
 * @param {string} jobId
 * @param {{ dataDir?: string, logger?: Function, dryRun?: boolean, dryRunPayload?: object }} [opts]
 */
export function instantiate(jobId, opts = {}) {
  // TinyFish-backed: build a configured TinyfishScraper on the fly.
  if (TINYFISH_IDS.has(jobId)) {
    return new TinyfishScraper({
      ...opts,
      bookConfig: getBookConfig(jobId),
    });
  }
  // Altenar tenants look like ordinary scrapers from the orchestrator's POV.
  if (ALTENAR_IDS.has(jobId)) return createAltenarTenant(jobId, opts);
  const Cls = DIRECT[jobId];
  if (!Cls) return null;
  return new Cls(opts);
}

export function isKnownJob(jobId) {
  return TINYFISH_IDS.has(jobId)
    || DIRECT[jobId] !== undefined && DIRECT[jobId] !== null
    || ALTENAR_IDS.has(jobId)
    || jobId === 'altenar-sites';
}

export const ALL_SCRAPERS = [...Object.keys(DIRECT), ...Object.keys(TINYFISH_BOOKS)];
export const ALL_ALTENAR_IDS = [...ALTENAR_IDS];
export const ALL_TINYFISH_IDS = [...TINYFISH_IDS];
