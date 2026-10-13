/**
 * platforms.mjs — the platform catalogue the bookmaker scaffold reads.
 *
 * Adding a book used to mean learning six files (the adapter, config, the
 * dispatcher's DIRECT and DIRECT_CONTRACTS maps, the platform's brand table,
 * the endpoint registry) from by-hand reading of previous additions. This
 * module is the single place that says what a platform is, so
 * `scripts/add-book.mjs` can turn "BetX is a Digitain book" into all the edits
 * that platform needs, and so "is this platform independent or a reseller" has
 * an answer that already exists.
 *
 * The keys are the platform strings config/scrapers.json and
 * data/endpoints/endpoints.json already use, not new names: a scaffolded job
 * that wrote a different string would be the only book of its kind in the
 * registry. Every recipe is derived from real, shipped books, and each entry
 * says which ones — the engine/transport values below were read out of
 * config/scrapers.json (2026-10-08) and the adapters named in each
 * `derivedFrom`, not invented:
 *
 *   digitain           winner/mrplay/888sport/bet7   (BRANDS row + subclass)
 *   egt-digital        prowin/ultrabet/vipbet         (TENANTS row + subclass)
 *   nsoft              betmen/admiral/stanleybet/maxbet (TENANTS tuple + subclass)
 *   altenar-sb2        don/topbet/million/baumbet/powerbet/winbet (two registries,
 *                     no new adapter: one AltenarPublic serves every tenant)
 *   everymatrix-odds   getsbet/contibet               (skeleton)
 *   exalogic-xsport    excelbet/winboss/las-vegas/magnumbet (skeleton)
 *   kindred-xns        unibet                         (skeleton)
 *   sportify           netbet                         (skeleton)
 *   kaizen-betano      betano                         (skeleton)
 *   superbet-offer     superbet                       (skeleton)
 *   erlyline           favbet                         (skeleton)
 *   fortuna-group      fortuna/casa-pariurilor        (skeleton)
 *   custom             —                              (nothing verified yet)
 *
 * `script` is <id>.mjs for every recipe except altenar-sb2, where all six
 * tenants share altenar-sites.mjs because the matcher in altenar-public.mjs
 * requires that exact string. Each other brand gets its own adapter file, which
 * is what makes the DIRECT_CONTRACTS route in src/scrapers/index.mjs an exact
 * contract rather than a family guess.
 */

/**
 * @typedef {object} PlatformRecipe
 * @property {string} platform        canonical id, matching the config's `platform` field
 * @property {string} engine          default engine string for a new job
 * @property {string} transport       default transport string for a new job
 * @property {string} [script]        forced script (only when the platform demands one)
 * @property {string[]} [locked]      contract fields that may not be overridden
 * @property {string} url             human note about what the feed is
 * @property {{ kind: 'brand'|'tenant'|'tenant-array'|'skeleton', file?: string,
 *             table?: string, extra?: string, idsFile?: string, idsArray?: string }} adapter
 *           brand        — subclass a base whose brand table this scaffold extends;
 *                          requires --host (and --unit where the table needs it)
 *           tenant       — subclass a base whose TENANTS tuple this scaffold extends;
 *                          requires --uuid
 *           tenant-array — append to a base's tenant array and its exported id list;
 *                          no new adapter file is written at all
 *           skeleton     — a fresh ScraperBase adapter the operator writes
 * @property {string[]} notes         what a new book on this platform is worth,
 *                                     and whether it adds an independent price
 */

const RECIPES = {
  digitain: {
    platform: 'digitain',
    engine: 'digitain',
    transport: 'digitain-public-json',
    url: 'Digitain public JSON (alias feed of winner)',
    adapter: { kind: 'brand', file: 'digitain-brands.mjs', table: 'BRANDS', extra: 'host' },
    notes: [
      'Derived from mrplay/888sport/bet7, all DigitainBrand subclasses with engine digitain and transport digitain-public-json. winner is the same platform with its own transport (winner-digitain-public-json) and is not the model for a new brand.',
      'NOT an independent price source: feed-groups.mjs groups winner/mrplay/888sport/bet7 as one feed.',
      'Add such a book only as coverage (events another brand might miss), never as arbitrage independence.',
    ],
  },
  'egt-digital': {
    platform: 'egt-digital',
    engine: 'egt-public-sports-api',
    transport: 'egt-public-sports-json',
    url: 'EGT Digital public sports API',
    adapter: { kind: 'brand', file: 'egt.mjs', table: 'TENANTS', extra: 'host' },
    notes: [
      'Derived from vipbet: an Egt subclass with a bounded container read, engine egt-public-sports-api / transport egt-public-sports-json / script <id>.mjs.',
      'prowin and ultrabet route through egt.mjs itself (script egt.mjs), which is the other shape on this platform; a new brand gets its own file like vipbet.',
      'All EGT brands share one upstream feed (see egt.mjs header); the feed-group decision is left to the operator, not assumed by the scaffold.',
    ],
  },
  nsoft: {
    platform: 'nsoft',
    engine: 'nsoft-public-json',
    transport: 'nsoft-public-sports-json',
    script: 'nsoft.mjs',
    locked: ['script'],
    url: 'NSoft distribution API (company uuid per tenant)',
    adapter: { kind: 'tenant', file: 'nsoft.mjs', table: 'TENANTS', extra: 'uuid' },
    notes: [
      'Derived from betmen: a [companyUuid, engine, transport, script] tuple plus a config job, engine nsoft-public-json / transport nsoft-public-sports-json / script nsoft.mjs. No adapter file is written: matchesNSoftConfig() routes every tenant to the NSoftScraper base, so a subclass here would be a file nothing imports.',
      'maxbet is the same platform under engine "nsoft" (not "nsoft-public-json") and its tuple names script maxbet.mjs — but it still routes through nsoft.mjs, and test/provider-contract.test.mjs exists to keep that true. That is why script is locked for this platform: a new tenant naming a file nothing serves would be a job pointing at nothing.',
      'Same company uuid = same feed: admiral/stanleybet are one group, maxbet shares the platform but prices differently — confirm before grouping.',
    ],
  },
  'altenar-sb2': {
    platform: 'altenar-sb2',
    engine: 'altenar-tenancy',
    transport: 'altenar-sb2-widget-json',
    script: 'altenar-sites.mjs',
    locked: ['engine', 'transport', 'script'],
    url: 'Altenar SB2 widget feed (integration id per tenant)',
    adapter: {
      kind: 'tenant-array', file: 'altenar-sites.mjs', table: 'TENANTS',
      extra: 'host', idsFile: 'altenar-public.mjs', idsArray: 'ALTENAR_IDS',
    },
    notes: [
      'Derived from don/topbet/million/baumbet/powerbet/winbet. No new adapter file is written: matchesAltenarConfig() in src/scrapers/altenar-public.mjs requires engine altenar-tenancy, transport altenar-sb2-widget-json, script altenar-sites.mjs and sourceIds [<id>], and it only recognises ids listed in the ALTENAR_IDS array in that same file. The scaffold appends to both.',
      'The feed is one shared host (sb2frontend-altenar2.biahosted.com) with ?integration=<id>; the tenant row in altenar-sites.mjs is metadata that createAltenarTenant() checks, and the sportId catalogue is per tenant — a new tenant publishes only the sports its own GetSportMenu lists.',
    ],
  },
  'everymatrix-odds': {
    platform: 'everymatrix-odds',
    engine: 'everymatrix-odds-wamp',
    transport: 'everymatrix-odds-wamp',
    url: 'EveryMatrix odds WAMP session',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from getsbet/contibet; the WAMP session is only exercised live, so a capture against this platform needs a real session.',
      'New books on this platform scope to whatever tournaments their dealer publishes.',
    ],
  },
  'exalogic-xsport': {
    platform: 'exalogic-xsport',
    engine: 'exalogic-xsport',
    transport: 'exalogic-xsport-public-json',
    url: 'Exalogic XSport public JSON',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from excelbet/winboss/las-vegas/magnumbet.',
      'One feed per site but the books are independently configured in feed-group terms — check the capture before assuming independence.',
    ],
  },
  'kindred-xns': {
    platform: 'kindred-xns',
    engine: 'public-sports-api-v2',
    transport: 'bookmaker-public-json',
    url: 'Kindred sports BFF (az-menu crawl)',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from unibet; sports resolve against the az-menu keys case-insensitively.',
      'A new Kindred skin is a host change, not a new transport — but each host still needs its own capture.',
    ],
  },
  sportify: {
    platform: 'sportify',
    engine: 'sportify-public-json',
    transport: 'bookmaker-public-json',
    url: 'Sportify public JSON',
    adapter: { kind: 'skeleton' },
    notes: ['Derived from netbet; the payload carries its own sport namespace.'],
  },
  'kaizen-betano': {
    platform: 'kaizen-betano',
    engine: 'top-events-v2-json',
    transport: 'betano-top-events-json',
    url: 'Betano top-events v2 (Playwright-rendered session)',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from betano; the crawl renders in a browser and maps 36 sport ids by name.',
      'This is the only catalogued platform whose adapter needs a browser at run time, so a new skin here is the most expensive to verify.',
    ],
  },
  'superbet-offer': {
    platform: 'superbet-offer',
    engine: 'public-offer-v3',
    transport: 'bookmaker-public-json',
    url: 'Superbet public offer v3 (multi-sport event + detail feeds)',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from superbet; sport keys filter a multi-sport feed and the detail market id+name is the contract.',
      'superbet has its own matcher in src/scrapers/index.mjs, so a second book on this platform needs the dispatcher taught about it first — the scaffold will not route it.',
    ],
  },
  erlyline: {
    platform: 'erlyline',
    engine: 'erlyline',
    transport: 'favbet-erlyline-jsonrpc',
    url: 'Erlyline JSON-RPC',
    adapter: { kind: 'skeleton' },
    notes: ['Derived from favbet; the JSON-RPC edge can answer 403 under a challenge — a run then reports rejected.'],
  },
  'fortuna-group': {
    platform: 'fortuna-group',
    engine: 'fortuna-bff-rest',
    transport: 'fortuna-bff-rest-json',
    url: 'Fortuna BFF REST',
    adapter: { kind: 'skeleton' },
    notes: [
      'Derived from fortuna and casa-pariurilor, which are two brands on one engine/transport/script-per-brand shape.',
      'Both shipped books are enabled and validated, so this is the platform with the fewest open questions.',
    ],
  },
  'betfair-exchange': {
    platform: 'betfair-exchange',
    engine: 'betfair-exchange-api',
    transport: 'betfair-exchange-readonly-json',
    url: 'Betfair Exchange public readonly REST surface (scan-inbf + ERO bymarket)',
    adapter: { kind: 'skeleton' },
    notes: [
      'Betfair Exchange: the only licensed betting exchange in Romania (betfair.ro).',
      'Direct public REST surface: scan-inbf.betfair.ro for event discovery and ero.betfair.ro for market order-book depth.',
      'Independent price source: real peer-to-peer exchange order book with back and lay liquidity, not a sportsbook reseller.',
    ],
  },
  custom: {
    platform: 'custom',
    engine: 'custom-json',
    transport: 'custom-json',
    url: 'unclassified — scaffold now, classify from the first capture',
    adapter: { kind: 'skeleton' },
    notes: [
      'Use while the platform is unknown; rename engine/transport to the real platform once the capture says which it is (and move the recipe here when two books share it).',
      'The scaffold still refuses to mark the job enabled — only a measured, smoke-verified book is promoted.',
    ],
  },
};

/** Every platform id the scaffold accepts, for CLI help and validation. */
export const PLATFORM_IDS = Object.freeze(Object.keys(RECIPES));

/**
 * The recipe for a platform, or null for an id not in the catalogue. A null
 * is a refusal with a reason the caller prints, not a silent default: the
 * scaffold uses `custom` explicitly rather than letting an unknown platform
 * through.
 */
export function platformRecipe(platform) {
  return Object.prototype.hasOwnProperty.call(RECIPES, platform)
    ? { ...RECIPES[platform], notes: [...(RECIPES[platform].notes || [])] }
    : null;
}

/**
 * PascalCase for the adapter class name: bet7 → Bet7, las-vegas → LasVegas.
 *
 * A leading digit cannot start a JavaScript identifier, and book ids like
 * 888sport do start with one — the shipped spelling of that class is Sport888,
 * but the scaffold cannot know which word a brand wants moved to the front, so
 * it prefixes Book: 888sport → Book888sport. Valid, deterministic, and the
 * operator can rename the class in the one file it appears.
 */
export function classPrefix(id) {
  const cls = String(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return /^[0-9]/.test(cls) ? `Book${cls}` : cls;
}

/**
 * The default display name for a job: 'bet-7' → 'Bet 7', '888sport' → '888sport'.
 * Matching an existing brand spelling is the operator's `--name`, this is only
 * the starting point.
 */
export function defaultDisplayName(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 && /^\d/.test(part)
      ? part
      : (part.length <= 3 && part === part.toUpperCase() ? part : part.charAt(0).toUpperCase() + part.slice(1))))
    .join(' ');
}
