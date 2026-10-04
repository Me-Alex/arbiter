import Superbet from './superbet.mjs';
import NSoft, { matchesNSoftConfig, NSOFT_TENANT_IDS } from './nsoft.mjs';
import Egt, { matchesEgtConfig, EGT_TENANT_IDS } from './egt.mjs';
import AltenarPublic, { matchesAltenarConfig } from './altenar-public.mjs';
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
import MagnumBet from './magnumbet.mjs';
import Winner from './winner.mjs';
import GetsBet from './getsbet.mjs';
import ContiBet from './contibet.mjs';
import Favbet from './favbet.mjs';
import { TENANTS as ALTENAR_TENANTS, createAltenarTenant } from './altenar-sites.mjs';


/**
 * Registry of every concrete scraper class keyed by job.id from
 * config/scrapers.json. The orchestrator calls instantiate(id, opts) to get a
 * ready-to-run scraper instance.
 *
 * For the Altenar job we don't have one class — we have five tenants that
 * fan out into one class each. createAltenarTenant handles that case.
 *
 * TinyFish scraping is disabled. Configured feeds require a matching adapter;
 * legacy standalone callers can only use direct scrapers or Altenar tenants.
 */

const DIRECT = {
  superbet: Superbet,
  betano: Betano,
  fortuna: Fortuna,
  // Active again since 2026-09-28: the feed was recovered as a REST crawl
  // behind the Kindred sports BFF, so it is an ordinary configured job.
  unibet: Unibet,
  // The three below are the legacy ProviderContract path. No configured job
  // routes to them: maxbet, admiral and stanleybet are all NSoft books whose
  // config entries point at nsoft.mjs. They are kept as the reference for that
  // shape (and for the Kambi offer format) and are reachable only by a direct
  // `instantiate` without a job config. Their endpoints are retired — see the
  // header in each file. Unibet was the fourth member of this group until its
  // feed was recovered; it now sits above with the live adapters.
  stanleybet: Stanleybet,
  admiral: Admiral,
  maxbet: MaxBet,
  'casa-pariurilor': CasaPariurilor,
  excelbet: ExcelBet,
  netbet: NetBet,
  winboss: WinBoss,
  magnumbet: MagnumBet,
  winner: Winner,
  getsbet: GetsBet,
  contibet: ContiBet,
  favbet: Favbet,
  'las-vegas': LasVegas,
};

/**
 * The exact (engine, transport, script) triple each DIRECT job must declare.
 *
 * `config/scrapers.json` names the feed; this table names the contract the
 * adapter in DIRECT was actually written against. A configured job whose
 * triple does not match is rejected, so editing one field cannot silently
 * point a scraper at a feed it does not implement. Keep in sync with
 * config/scrapers.json — the routing test fails when the two drift.
 */
const DIRECT_CONTRACTS = {
  betano: { engine: 'top-events-v2-json', transport: 'betano-top-events-json', script: 'betano.mjs' },
  fortuna: { engine: 'fortuna-bff-rest', transport: 'fortuna-bff-rest-json', script: 'fortuna.mjs' },
  'casa-pariurilor': { engine: 'fortuna-bff-rest', transport: 'fortuna-bff-rest-json', script: 'casa-pariurilor.mjs' },
  unibet: { engine: 'public-sports-api-v2', transport: 'bookmaker-public-json', script: 'unibet.mjs' },
  excelbet: { engine: 'exalogic-xsport', transport: 'exalogic-xsport-public-json', script: 'excelbet.mjs' },
  winboss: { engine: 'exalogic-xsport', transport: 'exalogic-xsport-public-json', script: 'winboss.mjs' },
  'las-vegas': { engine: 'exalogic-xsport', transport: 'exalogic-xsport-public-json', script: 'las-vegas.mjs' },
  magnumbet: { engine: 'exalogic-xsport', transport: 'exalogic-xsport-public-json', script: 'magnumbet.mjs' },
  netbet: { engine: 'sportify-public-json', transport: 'bookmaker-public-json', script: 'netbet.mjs' },
  winner: { engine: 'digitain', transport: 'winner-digitain-public-json', script: 'winner.mjs' },
  favbet: { engine: 'erlyline', transport: 'favbet-erlyline-jsonrpc', script: 'favbet.mjs' },
  getsbet: { engine: 'everymatrix-odds-wamp', transport: 'everymatrix-odds-wamp', script: 'getsbet.mjs' },
  contibet: { engine: 'everymatrix-odds-wamp', transport: 'everymatrix-odds-wamp', script: 'contibet.mjs' },
  // Legacy provider-contract classes, still routed for their own tenants.
  admiral: { engine: 'nsoft-public-json', transport: 'bookmaker-public-json', script: 'admiral.mjs' },
  stanleybet: { engine: 'nsoft-public-json', transport: 'nsoft-public-sports-json', script: 'stanleybet.mjs' },
  maxbet: { engine: 'nsoft', transport: 'nsoft-public-sports-json', script: 'maxbet.mjs' },
};

const ALTENAR_IDS = new Set(ALTENAR_TENANTS.map((t) => t.id));


/**
 * @param {string} jobId
 * @param {{ dataDir?: string, logger?: Function, dryRun?: boolean, dryRunPayload?: object }} [opts]
 */
export function instantiate(jobId, opts = {}) {
  if (Object.hasOwn(opts, 'jobConfig')) {
    const cfg = opts.jobConfig;
    if (!cfg || cfg.id !== jobId) {
      const err = new Error(`scraper configuration for ${jobId}: job is missing or has a mismatched id`);
      err.name = 'ScraperConfigurationError';
      err.code = 'ESCRAPERCONFIG';
      throw err;
    }
    if (cfg.enabled === false) {
      const err = new Error(`scraper configuration for ${jobId}: job is disabled`);
      err.name = 'ScraperConfigurationError';
      err.code = 'ESCRAPERCONFIG';
      throw err;
    }
    // TinyFish scraping is disabled — reject any TinyFish configuration.
    if (cfg.engine === 'tinyfish' || cfg.transport === 'tinyfish-browser'
        || cfg.script === 'tinyfish-scraper.mjs') {
      const err = new Error(`scraper configuration for ${jobId}: TinyFish scraping is disabled`);
      err.name = 'ScraperConfigurationError';
      err.code = 'ESCRAPERCONFIG';
      throw err;
    }
    // Only dispatch a configured feed when its exact contract is implemented.
    // Legacy classes below do not implement the current configured schemas.
    if (jobId === 'superbet' && cfg.engine === 'public-offer-v3'
        && cfg.transport === 'bookmaker-public-json' && cfg.script === 'superbet.mjs') {
      return new Superbet(opts);
    }
    if (matchesNSoftConfig(jobId, cfg)) return new NSoft(jobId, opts);
    if (matchesEgtConfig(jobId, cfg)) return new Egt(jobId, opts);
    if (matchesAltenarConfig(jobId, cfg)) return new AltenarPublic(jobId, opts);
    // Every job that has an exact-contract matcher is validated against it, so
    // a typo in engine/transport/script is a configuration error rather than a
    // silently instantiated hardcoded class. Falling through to DIRECT for a
    // configured job would run a scraper against a feed it was never written
    // for, which is exactly what the project rule "register only the exact
    // implemented engine/transport/script contract" forbids.
    const matchesDirectContract = (id) => {
      const job = DIRECT_CONTRACTS[id];
      return Boolean(job)
        && cfg.engine === job.engine
        && cfg.transport === job.transport
        && cfg.script === job.script;
    };
    if (matchesDirectContract(jobId)) return new DIRECT[jobId](opts);
    // Jobs whose config has a specific matcher above but did not match exactly
    // are mis-configured — reject, don't silently fall back to DIRECT.
    // This covers superbet (public-offer-v3), every NSoft tenant, every EGT
    // tenant, and the Altenar tenants (don, topbet, etc.).
    //
    // The tenant sets are exported by the modules that implement them rather
    // than re-typed here. A hand-kept list rots invisibly: a tenant missing
    // from this set still fails closed at the fall-through throw below, so the
    // routing tests stay green while this guard has stopped guarding. Only a
    // tenant that also appears in DIRECT would fall through unnoticed, which is
    // exactly stanleybet's situation.
    const SPECIFICALLY_MATCHED_IDS = new Set([
      'superbet',
      ...NSOFT_TENANT_IDS,
      ...EGT_TENANT_IDS,
      ...ALTENAR_IDS,
      ...Object.keys(DIRECT_CONTRACTS),
    ]);
    if (SPECIFICALLY_MATCHED_IDS.has(jobId)) {
      const err = new Error(`scraper configuration for ${jobId}: unsupported source: no verified matching scraper implementation for engine=${cfg.engine ?? '<missing>'}, transport=${cfg.transport ?? '<missing>'}, script=${cfg.script ?? '<missing>'}`);
      err.name = 'ScraperConfigurationError';
      err.code = 'ESCRAPERCONFIG';
      throw err;
    }
    // Fall back to the direct class registry for scrapers that predate the
    // config-driven dispatch but still have a working implementation.
    const DirectCls = DIRECT[jobId];
    if (DirectCls) return new DirectCls(opts);
    // No implementation available for this job.
    const err = new Error(`scraper configuration for ${jobId}: unsupported source: no verified matching scraper implementation for engine=${cfg.engine ?? '<missing>'}, transport=${cfg.transport ?? '<missing>'}, script=${cfg.script ?? '<missing>'}`);
    err.name = 'ScraperConfigurationError';
    err.code = 'ESCRAPERCONFIG';
    throw err;
  }
  // Compatibility for standalone callers without a job config.
  if (ALTENAR_IDS.has(jobId)) return createAltenarTenant(jobId, opts);
  const Cls = DIRECT[jobId];
  if (!Cls) return null;
  return new Cls(opts);
}

export const ALL_SCRAPERS = Object.keys(DIRECT);
