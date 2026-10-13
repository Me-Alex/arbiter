/**
 * add-book.mjs — scaffold a new bookmaker in one command.
 *
 *   npm run new-book -- --id betex --platform digitain --endpoint https://betex.ro \
 *       --host micros-prod1.gambling-solutions.ro
 *
 * Adding a book used to mean learning five places at once and editing four of
 * them by hand: the adapter file, the config job, the dispatcher's DIRECT and
 * DIRECT_CONTRACTS maps, the platform's own brand/tenant table, and the
 * endpoint registry record. Each was guarded by a test that failed loudly on a
 * half-finished addition, which is what made the process safe and slow in the
 * same measure. This script performs exactly the edits those tests demand, in
 * the shape they demand, and deliberately no more:
 *
 *   - it never enables a job, never validates one, never sets feedStatus, and
 *     never declares a feed group;
 *   - it records only the endpoint it was given, marked unverified;
 *   - it refuses outright rather than writing a half-book;
 *   - it prints the remaining checklist, because the rest — a capture, a live
 *     smoke, the feed-group decision, the promotion — is judgement, not
 *     scaffolding.
 *
 * What it writes is derived from the functions this file exports, and
 * test/add-book-scaffold.test.mjs runs the whole thing against a throwaway copy
 * of the tree and asserts the result passes every gate a real addition must
 * pass. A scaffold that is never executed is a document; this one is checked.
 *
 * Platform knowledge lives in src/scrapers/platforms.mjs, not here, so "which
 * platforms exist and what does a new book on one need" has exactly one answer.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformRecipe, classPrefix, defaultDisplayName, PLATFORM_IDS } from '../src/scrapers/platforms.mjs';
import { sportOptions } from '../src/sports/registry.mjs';

// `new URL(import.meta.url).pathname` is the wrong tool on a path containing a
// space: it percent-encodes, so 'E:\AI Folder Projects\arbiter' arrives as
// 'E:/AI%20Folder%20Projects/arbiter' and every join() below misses. fileURLToPath
// does not encode, which is the entire reason it exists.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PLATFORM_LIST = PLATFORM_IDS.join(', ');

const USAGE = `Usage: npm run new-book -- --id <book-id> --platform <platform> --endpoint <url> [options]

Required:
  --id <id>            lowercase kebab id, e.g. betex (also the workspace filename)
  --platform <name>    one of: ${PLATFORM_LIST}
  --endpoint <url>     the public odds URL you actually observed (http/https)

Per platform (the scaffold asks for what its recipe needs):
  --host <host>        brand/tenant table platforms: digitain, egt-digital, altenar-sb2
  --unit <BU>          egt-digital only: the businessUnit in the brand's API paths
  --uuid <uuid>        nsoft only: the companyUuid read from the brand's front end

Optional:
  --name <Name>        display name (default: derived from the id)
  --sports a,b,c       supportedSports, validated against src/sports/registry.mjs
                       (default: football)
  --engine <string>    override the platform default engine
  --transport <string> override the platform default transport
  --script <file>      override the adapter filename (default: <id>.mjs)
  --root <dir>         operate on another copy of the tree (used by the test)
  --dry-run            print the plan, write nothing
  -h, --help           this text

Nothing this writes is enabled, validated or verified. The scaffold edits
config/scrapers.json, the dispatcher, the platform table and the endpoint
registry so that the job exists as a candidate — promotion is a measured,
human decision and stays one. See docs/adding-a-book.md.
`;

// ---------------------------------------------------------------- CLI parsing

/**
 * Flags that take a value. A flag with a missing or missing-looking value is an
 * error rather than a silently-absent field: `--host` with no argument reads as
 * a boolean to the operator and as a missing required field to the plan.
 */
const VALUED_FLAGS = new Set([
  '--id', '--platform', '--endpoint', '--host', '--uuid', '--unit', '--name',
  '--sports', '--engine', '--transport', '--script', '--root',
]);

/**
 * @param {string[]} argv
 * @returns {{id?: string, platform?: string, endpoint?: string, host?: string,
 *   uuid?: string, unit?: string, name?: string, sports: string[], engine?: string,
 *   transport?: string, script?: string, root: string, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { sports: ['football'], root: ROOT, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    if (!VALUED_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || VALUED_FLAGS.has(value) || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    i += 1;
    switch (arg) {
      case '--id': out.id = value; break;
      case '--platform': out.platform = value; break;
      case '--endpoint': out.endpoint = value; break;
      case '--host': out.host = value; break;
      case '--uuid': out.uuid = value; break;
      case '--unit': out.unit = value; break;
      case '--name': out.name = value; break;
      case '--sports': out.sports = value.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--engine': out.engine = value; break;
      case '--transport': out.transport = value; break;
      case '--script': out.script = value; break;
      // Resolved against the process cwd, not against the repo root: a test that
      // passes an absolute temp path must get that path, not ROOT/<temp path>.
      case '--root': out.root = resolve(value); break;
      default: throw new Error(`unhandled flag: ${arg}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------- reading

/** The parts of the tree this script reads, with plain errors when missing. */
export async function readTree(root = ROOT) {
  const paths = {
    config: join(root, 'config', 'scrapers.json'),
    registry: join(root, 'data', 'endpoints', 'endpoints.json'),
    index: join(root, 'src', 'scrapers', 'index.mjs'),
  };
  const missing = Object.entries(paths).filter(([, file]) => !existsSync(file)).map(([key]) => key);
  if (missing.length) {
    throw new Error(`this does not look like the project tree: no ${missing.join(', ')} under ${root} — pass --root`);
  }
  const [configText, registryText, indexText] = await Promise.all(
    Object.values(paths).map((file) => readFile(file, 'utf8')),
  );
  return {
    paths,
    configText,
    registryText,
    indexText,
    config: JSON.parse(configText),
    registry: JSON.parse(registryText),
  };
}

// ------------------------------------------------------------------ validating

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every reason this plan must be refused. An empty list is a green light; a
 * non-empty one means nothing gets written. The checks are in the order the
 * operator would hit them, and each one names the file it is protecting.
 */
export function validateCandidate(plan, tree) {
  const problems = [];
  if (!plan.id) problems.push('--id is required');
  if (plan.id && !ID_PATTERN.test(plan.id)) {
    problems.push(`--id "${plan.id}" must be lowercase kebab-case (a-z, 0-9, single hyphens)`);
  }
  if (plan.id && plan.id.length > 40) problems.push('--id is longer than 40 characters');
  if (!plan.platform) problems.push('--platform is required');
  const recipe = plan.platform ? platformRecipe(plan.platform) : null;
  if (plan.platform && !recipe) {
    problems.push(`unknown platform "${plan.platform}" — see src/scrapers/platforms.mjs (${PLATFORM_LIST})`);
  }
  if (!plan.endpoint) {
    problems.push('--endpoint is required: the scaffold records only what you have observed');
  } else if (!/^https?:\/\/\S+$/.test(plan.endpoint)) {
    problems.push(`--endpoint "${plan.endpoint}" is not an http(s) URL`);
  }
  if (recipe?.adapter?.extra === 'host' && !plan.host) {
    problems.push(`--host is required on ${plan.platform}: its table wants a hostname`);
  }
  if (recipe?.adapter?.extra === 'uuid' && !plan.uuid) {
    problems.push(`--uuid is required on ${plan.platform}: its TENANTS tuple wants a companyUuid`);
  }
  if (plan.host && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(plan.host)) {
    problems.push(`--host "${plan.host}" is not a hostname`);
  }
  if (plan.uuid && !/^[0-9a-f-]{36}$/i.test(plan.uuid)) {
    problems.push(`--uuid "${plan.uuid}" is not a uuid`);
  }
  // Refusing a flag the platform has no use for is the same class of mistake as
  // writing a value nothing reads: both look like configuration and change nothing.
  if (plan.unit !== undefined && plan.platform !== 'egt-digital') {
    problems.push(`--unit is only meaningful on egt-digital, not ${plan.platform}`);
  }
  // A locked contract is what the platform's own matcher compares against, so an
  // override would produce a job the dispatcher cannot route: exactly the silent
  // half-configuration this script exists to prevent. Compared against the
  // recipe, not against the already-resolved plan — comparing the override with
  // the value it overwrote is a tautology, and a tautology never refuses.
  for (const field of recipe?.locked || []) {
    const override = plan.overrides?.[field];
    if (override && override !== recipe[field]) {
      problems.push(`--${field} ${override} cannot override ${plan.platform}'s ${recipe[field]}: `
        + 'the platform matcher requires that exact value');
    }
  }
  if (plan.sports.length === 0) problems.push('--sports listed no sport');

  if (plan.id) {
    if (tree.config.jobs.some((job) => job.id === plan.id)) {
      problems.push(`${plan.id} already has a job in config/scrapers.json`);
    }
    if (tree.registry.books?.[plan.id]) {
      problems.push(`${plan.id} already has a record in data/endpoints/endpoints.json`);
    }
    // Only a book with an adapter of its own can collide on a filename. A
    // tenant on egt/nsoft/altenar is *expected* to name a script the dispatcher
    // already imports — nsoft.mjs, egt.mjs and altenar-sites.mjs are all shared
    // by their platform's books — so this check would refuse every one of them.
    if (plan.writesAdapter && plan.script && tree.indexText.includes(`'./${plan.script}'`)) {
      problems.push(`${plan.script} is already imported by src/scrapers/index.mjs`);
    }
    if (plan.id && new RegExp(`^\\s*(?:'${plan.id}'|"${plan.id}"|${plan.id}):`, 'm').test(tree.indexText)) {
      problems.push(`${plan.id} already appears as a key in src/scrapers/index.mjs`);
    }
    const adapterPath = join(plan.root, 'src', 'scrapers', plan.script);
    if (plan.writesAdapter && existsSync(adapterPath)) {
      problems.push(`src/scrapers/${plan.script} already exists — refusing to overwrite an adapter`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- file writing

/**
 * Insert text immediately before the closing brace of a top-level object literal,
 * found by scanning for the declaration and then the first line that is only a
 * brace. Anchoring on the current last entry would break the next time a book is
 * added before this one; a closing-brace scan does not.
 *
 * Returns null when the declaration is absent, so a caller that accepts either
 * form can try the next one; `appendToObject` is the throwing wrapper.
 *
 * @param {string} source
 * @param {string} declaration  the line the object starts with, e.g. 'const DIRECT = {'
 * @param {string} text         the line(s) to insert, without a trailing newline
 * @param {string[]} closeForms  acceptable closing lines, e.g. ['};', '});']
 */
function insertBeforeClose(source, declaration, text, closeForms) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(declaration));
  if (start === -1) return null;
  const end = closeForms
    .map((form) => lines.findIndex((line, i) => i > start && line.trim() === form))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  if (end === undefined) {
    throw new Error(`found ${declaration} but no closing ${closeForms.join('/')} — the file changed shape`);
  }
  lines.splice(end, 0, text.replace(/\r?\n$/, ''));
  return lines.join('\n');
}

/** As `insertBeforeClose`, but a missing declaration is an error, not a null. */
export function appendToObject(source, declaration, text, closeForms = ['};']) {
  const out = insertBeforeClose(source, declaration, text, closeForms);
  if (out === null) throw new Error(`${declaration} not found — the file changed shape`);
  return out;
}

/**
 * Append a row to a named table, in whichever form the module declares it.
 *
 * Both forms are real in this tree and the difference is not cosmetic:
 * `Object.freeze({...})` in digitain-brands.mjs and egt.mjs, a plain `{...}` in
 * nsoft.mjs. Guessing the wrong one used to abort the nsoft scaffold with a
 * "changed shape" error naming a file that had not changed at all.
 *
 * @param {string} source
 * @param {string} table    the identifier, e.g. 'TENANTS'
 * @param {string} id       the row's key
 * @param {string} value    the row's value expression
 */
export function appendToTable(source, table, id, value) {
  const key = /^[A-Za-z_$][\w$]*$/.test(id) ? id : JSON.stringify(id);
  const row = `  ${key}: ${value},`;
  for (const [declaration, closeForms] of [
    [`const ${table} = Object.freeze({`, ['});', '};']],
    [`const ${table} = {`, ['};']],
  ]) {
    const out = insertBeforeClose(source, declaration, row, closeForms);
    if (out !== null) return out;
  }
  throw new Error(`no ${table} table found — the file changed shape`);
}

/**
 * Append an object literal to an array literal, keeping the closing bracket on
 * its own line the way the file already writes it.
 */
export function appendToArray(source, declaration, text) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(declaration));
  if (start === -1) throw new Error(`${declaration} not found — the file changed shape`);
  const end = lines.findIndex((line, i) => i > start && line.trim() === '];');
  if (end === -1) throw new Error(`found ${declaration} but no ]; — the file changed shape`);
  // The existing elements already carry their own indentation; the caller writes
  // the row the way the file writes its other rows.
  lines.splice(end, 0, ...text.split('\n'));
  return lines.join('\n');
}

/** Append a quoted id to a single-line array literal: `export const X = ['a'];` */
export function appendToInlineArray(source, declaration, value) {
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?const\\s+${declaration}\\s*=\\s*\\[)([^\\]]*)(\\];)`, 'm');
  if (!pattern.test(source)) throw new Error(`one-line array ${declaration} not found`);
  return source.replace(pattern, (_, head, body, tail) => {
    const items = body.trim();
    if (!items) return `${head}${value}${tail}`;
    return `${head}${items.replace(/,\s*$/, '')}, ${value}${tail}`;
  });
}

/** Insert an import after the last relative import in the file. */
export function appendImport(source, line) {
  const lines = source.split('\n');
  let last = -1;
  lines.forEach((text, index) => {
    if (/^import .* from '\.[^']*';$/.test(text.trim())) last = index;
  });
  if (last === -1) throw new Error('no relative import block found');
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

// ------------------------------------------------------------- adapter source

/**
 * The adapter for each recipe kind.
 *
 * `brand`   — subclasses a base that already parses this platform's wire format
 *             and extends that base's own table in the same run. The subclass is
 *             deliberately four lines: every behaviour worth changing needs a
 *             capture to justify, and a subclass that guesses is worse than one
 *             that does nothing.
 * `skeleton`— a fresh ScraperBase adapter whose hooks fail closed, so an
 *             unimplemented book reports a refusal instead of an empty day.
 *             `custom` and the platforms with no derived adapter land here.
 */
function adapterSource(plan, dateStr) {
  const cls = classPrefix(plan.id);
  const recipe = plan.recipe;

  if (recipe.adapter.kind === 'brand') {
    const isDigitain = plan.platform === 'digitain';
    const imports = isDigitain
      ? `import DigitainBrand from './digitain-brands.mjs';`
      : `import Egt from './egt.mjs';\nimport { eventLimit } from './event-limit.mjs';`;
    const superclass = isDigitain ? 'DigitainBrand' : 'Egt';
    const pass = isDigitain
      ? `'${plan.id}', opts`
      : `'${plan.id}', { ...opts, maxEvents: eventLimit(opts.maxEvents) }`;
    const nameLine = isDigitain ? '' : `    this.name = '${plan.name}';\n`;
    return `${imports}

/**
 * ${plan.name} — ${plan.platform}, scaffolded by \`npm run new-book\` on ${dateStr}.
 *
 * The wire parser, the request shape and the market mapping are ${superclass}'s,
 * already exercised by the books that share this platform. What is new here is
 * one row in that base's table${isDigitain ? ' (BRANDS' : ' (TENANTS'}, added by
 * the same command — so this file has no state of its own to get out of sync.
 *
 * ${plan.endpoint}
 *
 * Still unmeasured. Before this book is enabled it needs a real capture under
 * data/endpoints/captures/ and fixtures written from it, because the only claim
 * made here is that the brand was recorded, not that it returns priced markets.
 * docs/adding-a-book.md has the order.
 */
export default class ${cls} extends ${superclass} {
  constructor(opts = {}) {
    super(${pass});
${nameLine}  }
}
`;
  }

  return `import ScraperBase from './base.mjs';
import { ValidationError } from '../shared/errors.mjs';

/**
 * ${plan.name} (${plan.id}) — ${plan.platform}, scaffolded by \`npm run new-book\`
 * on ${dateStr}.
 *
 * Platform: ${plan.platform} (${plan.engine} / ${plan.transport})
 * Recorded endpoint: ${plan.endpoint}
 *
 * Not implemented, and deliberately so. These hooks fail closed rather than
 * returning an empty day, because a book that collects nothing reports exactly
 * like one that collected a quiet fixture list — the failure mode this project
 * has measured repeatedly (winboss, las-vegas, unibet). Implement in this order:
 *
 *   1. fetchRaw(signal)          → the raw payload, redirects refused
 *   2. normalize(raw)            → RawEvent[] with a stable eventKey
 *   3. extractEvents(rawEvents)  → the shapes the engine consumes
 *
 * Then capture a real response under data/endpoints/captures/, write fixtures
 * against it — the fixture is the live payload, not what the parser would like
 * to receive (test/winner.test.mjs is the model) — and follow
 * docs/adding-a-book.md from there.
 */
export default class ${cls} extends ScraperBase {
  constructor(opts = {}) {
    super(opts);
    this.id = '${plan.id}';
    this.name = '${plan.name}';
    this.sourceIds = ['${plan.id}'];
    this.endpoint = ${JSON.stringify(plan.endpoint)};
  }

  async fetchRaw() {
    throw new ValidationError('${plan.id}: fetchRaw not implemented — implement it against ${plan.endpoint} (docs/adding-a-book.md)');
  }

  normalize() {
    throw new ValidationError('${plan.id}: normalize not implemented');
  }

  extractEvents() {
    throw new ValidationError('${plan.id}: extractEvents not implemented — a book that collects nothing must not look like a quiet day');
  }
}
`;
}

// ---------------------------------------------------------------- test source

function testSource(plan, dateStr) {
  return `/**
 * ${plan.name} (${plan.id}) — scaffolded by \`npm run new-book\` on ${dateStr}.
 *
 * These checks assert what can be asserted before anything has been measured. They
 * deliberately assert nothing about the feed:
 *
 *   1. the candidate was written disabled and unvalidated;
 *   2. the declared contract is the one the adapter was written against;
 *   3. the dispatcher resolves the job.
 *
 * ${plan.writesAdapter && !plan.failsClosed
    ? `On ${plan.platform} the adapter is a subclass, so 3 also proves the row the base looks
 * up by id exists: the base constructor throws without it (digitain-brands.mjs,
 * egt.mjs, nsoft.mjs), and routing here goes through that constructor. There is
 * therefore no separate table test to write — and no vacuous one that passes
 * because it asserts nothing.
 *`
    : ''}
 * ${plan.failsClosed
    ? `Checks 1 and 4 describe a state the book is meant to grow out of, so each says so
 * and steps aside (t.skip) once it no longer applies. A check that keeps firing at
 * the moment the book starts working is worse than no check: it punishes the
 * documented order in docs/adding-a-book.md. When 4 steps aside, replace it with
 * fixtures taken from a real capture under data/endpoints/captures/ —
 * test/winner.test.mjs is the model.`
    : `Check 1 describes a state the book is meant to grow out of, so it says so and
 * steps aside (t.skip) once the book is promoted. A check that keeps firing at the
 * moment the book starts working is worse than no check: it punishes the documented
 * order in docs/adding-a-book.md.`}
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === '${plan.id}');

test('${plan.id}: the candidate was written disabled and unvalidated', (t) => {
  // Promotion is the point of the exercise, so a book that is enabled *and*
  // validated has left the state this check describes and it steps aside. Enabled
  // but not validated is not that state — it is the illegal one, and the whole
  // reason this check exists is to catch it, so it must not skip there.
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('${plan.id}: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    [${JSON.stringify(plan.engine)}, ${JSON.stringify(plan.transport)}, ${JSON.stringify(plan.script)}],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('${plan.id}: the dispatcher routes the job when it is promoted', () => {
  // The disabled config is what instantiate() rejects, so the promotion is
  // simulated here — which is exactly the state a reviewer will create. A book
  // whose config cannot be routed is caught now rather than on a live run.
${plan.writesAdapter
    ? `  const scraper = instantiate('${plan.id}', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, '${plan.id}');`
    : `  const scraper = instantiate('${plan.id}', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the platform matcher must route the job');
  assert.equal(scraper.sourceIds[0], '${plan.id}');`}
});

${plan.failsClosed
    ? `
test('${plan.id}: an unimplemented book fails closed rather than collecting nothing', async (t) => {
  const scraper = instantiate('${plan.id}', { jobConfig: { ...JOB, enabled: true } });
  // The scaffolded adapter refuses with this sentinel. Once the adapter is
  // implemented against a real capture the sentinel is gone, and what is
  // unmeasured by then is the feed — so the check says so and steps aside for
  // fixture tests rather than firing on a book that now works.
  if (!String(scraper.fetchRaw).includes('not implemented')) {
    return t.skip('adapter implemented — replace this with fixtures from a real capture');
  }
  await assert.rejects(scraper.fetchRaw(), { name: 'ValidationError' },
    'a scaffolded adapter must refuse to collect rather than report an empty day');
});`
    : ''}
`;
}

// -------------------------------------------------------------------- planning

/**
 * Resolve every field of the plan from the recipe and the flags, so the rest of
 * this file is pure string-building over `plan`.
 */
export function resolvePlan(options) {
  const recipe = platformRecipe(options.platform || '');
  const adapter = recipe?.adapter || { kind: 'skeleton' };
  const platform = recipe?.platform || options.platform || 'custom';
  const script = recipe?.script || options.script || `${options.id}.mjs`;
  const writesAdapter = adapter.kind === 'brand' || adapter.kind === 'skeleton';
  const plan = {
    root: options.root || ROOT,
    id: options.id,
    name: options.name || defaultDisplayName(options.id || 'book'),
    platform,
    recipe,
    endpoint: options.endpoint,
    host: options.host,
    uuid: options.uuid,
    unit: options.unit,
    sports: options.sports?.length ? options.sports : ['football'],
    engine: options.engine || recipe?.engine || 'custom-json',
    transport: options.transport || recipe?.transport || 'custom-json',
    script,
    writesAdapter,
    // A skeleton is the unimplemented adapter, so it fails closed by
    // construction. A brand/tenant subclass inherits a working parser and does
    // not: refusing to fetch would be a false claim about the platform.
    failsClosed: adapter.kind === 'skeleton',
    overrides: {
      engine: options.engine,
      transport: options.transport,
      script: options.script,
    },
  };
  return plan;
}

/**
 * Every file this scaffold writes, with its reason, and the config job it adds.
 * Nothing here touches the network and nothing here decides whether the book
 * works; that is the checklist's job.
 */
export async function buildPlan(options) {
  const plan = resolvePlan(options);
  const tree = await readTree(plan.root);

  const problems = validateCandidate(plan, tree);
  const known = new Set(sportOptions().map(({ id }) => id));
  for (const sport of plan.sports) {
    if (!known.has(sport)) {
      problems.push(`sport "${sport}" is not registered in src/sports/registry.mjs (${[...known].slice(0, 8).join(', ')}, …)`);
    }
  }
  if (problems.length) return { ok: false, problems };

  const dateStr = new Date().toISOString().slice(0, 10);
  const files = [];

  // 1. the adapter, when the platform needs one
  if (plan.writesAdapter) {
    files.push({
      path: join(plan.root, 'src', 'scrapers', plan.script),
      reason: `the ${plan.recipe.adapter.kind} adapter for ${plan.platform}`,
      content: adapterSource(plan, dateStr),
      isNew: true,
    });
  }

  // 2. the config job — disabled, unvalidated, no feedStatus.
  //
  // `feedStatus` is deliberately absent. test/field-census.test.mjs asserts the
  // field carries exactly one value across every job, and that value is backed
  // by the registry; a second value would mean the exemption in that test has
  // stopped being true and the chip legend is now wrong. A candidate has no
  // measured feed to declare.
  const job = {
    id: plan.id,
    maxEvents: 500,
    name: plan.name,
    enabled: false,
    supportedSports: plan.sports.slice(),
    engine: plan.engine,
    transport: plan.transport,
    script: plan.script,
    sourceIds: [plan.id],
    validationStatus: 'candidate',
    validationReason: `Scaffolded ${dateStr} from the endpoint recorded in data/endpoints/endpoints.json `
      + `(platform ${plan.platform}). Nothing is measured yet: no capture, no fixtures, no live smoke.`,
    platform: plan.platform,
  };
  files.push({
    path: tree.paths.config,
    reason: 'the disabled, unvalidated job entry',
    content: `${JSON.stringify({ ...tree.config, jobs: [...tree.config.jobs, job] }, null, 2)}\n`,
    patch: true,
  });

  // 3. the platform's own table, when the recipe has one
  const adapter = plan.recipe.adapter;
  if (adapter.file) {
    const basePath = join(plan.root, 'src', 'scrapers', adapter.file);
    const before = await readFile(basePath, 'utf8');
    let value;
    if (plan.platform === 'digitain') {
      value = `{ name: ${JSON.stringify(plan.name)}, host: ${JSON.stringify(plan.host)} }`;
    } else if (plan.platform === 'egt-digital') {
      value = `Object.freeze({ host: ${JSON.stringify(plan.host)}, `
        + `businessUnit: ${JSON.stringify(plan.unit || plan.id.toUpperCase())}, `
        + `baseUrl: ${JSON.stringify(plan.endpoint)} })`;
    } else if (plan.platform === 'nsoft') {
      // The tuple's engine/transport/script ARE the config's: matchesNSoftConfig
      // compares all three, so writing different values here would produce a job
      // the dispatcher refuses. One source, used twice.
      value = `[${JSON.stringify(plan.uuid)}, ${JSON.stringify(plan.engine)}, `
        + `${JSON.stringify(plan.transport)}, ${JSON.stringify(plan.script)}]`;
    } else if (plan.platform === 'altenar-sb2') {
      value = `{\n    id: '${plan.id}',\n    name: ${JSON.stringify(plan.name)},\n`
        + `    baseUrl: ${JSON.stringify(plan.endpoint)},\n    locale: 'ro-RO',\n`
        + `    timezone: 'Europe/Bucharest',\n    currency: 'RON',\n`
        + `    path: '/api/widget/GetUpcoming',\n  }`;
    } else {
      throw new Error(`no table row template for platform ${plan.platform}`);
    }
    const rowTable = plan.platform === 'altenar-sb2' ? null : adapter.table;
    const after = rowTable
      ? appendToTable(before, rowTable, plan.id, value)
      : appendToArray(before, `export const ${adapter.table} = [`, `  ${value},`);
    files.push({
      path: basePath,
      reason: `the ${adapter.table} row the ${plan.platform} adapter looks up by id`,
      content: after,
      before,
      patch: true,
    });
  }

  // 4. the id list the platform's matcher consults. altenar-public.mjs decides
  // whether a job is routable from ALTENAR_IDS alone, so a tenant in the table
  // but not in this array fails closed at the dispatcher's fall-through throw.
  if (adapter.idsFile) {
    const idsPath = join(plan.root, 'src', 'scrapers', adapter.idsFile);
    const before = await readFile(idsPath, 'utf8');
    files.push({
      path: idsPath,
      reason: `the ${adapter.idsArray} entry the platform matcher routes on`,
      content: appendToInlineArray(before, adapter.idsArray, `'${plan.id}'`),
      before,
      patch: true,
    });
  }

  // 5. the dispatcher: import, DIRECT, DIRECT_CONTRACTS.
  //
  // Only for a book with an adapter of its own. A tenant on digitain/egt/nsoft/
  // altenar is reached by that platform's own matcher before DIRECT is
  // consulted, so adding a DIRECT entry for it would register a second route to
  // the same id — and ALL_SCRAPERS is Object.keys(DIRECT), which would then list
  // a book the config does not reach.
  if (plan.writesAdapter) {
    const cls = classPrefix(plan.id);
    let next = appendImport(tree.indexText, `import ${cls} from './${plan.script}';`);
    next = appendToObject(next, 'const DIRECT = {', `  ${JSON.stringify(plan.id)}: ${cls},`);
    next = appendToObject(
      next, 'const DIRECT_CONTRACTS = {',
      `  ${JSON.stringify(plan.id)}: { engine: ${JSON.stringify(plan.engine)}, `
        + `transport: ${JSON.stringify(plan.transport)}, script: ${JSON.stringify(plan.script)} },`,
    );
    files.push({
      path: tree.paths.index,
      reason: 'the dispatcher entry (import + DIRECT + the exact contract)',
      content: next,
      patch: true,
    });
  }

  // 6. the endpoint registry record, in the shape the archive uses.
  //
  // Shaped from the 110 records that are there, not from what would be tidy:
  // every one of them carries book/platform/feedStatus/verifiedAt/scraped/job/
  // oddsFeed/crawl/unavailableSports/captureFiles, and a reader that has to
  // special-case a short record is a reader that will.
  const record = {
    book: plan.id,
    endpointCount: 1,
    capturedAt: null,
    keyEndpoints: [{
      method: 'GET',
      url: plan.endpoint,
      verified: false,
      purpose: `Recorded by \`npm run new-book\` on ${dateStr}. This is a claim, not a measurement: `
        + 'reach the endpoint, save the response under data/endpoints/captures/, and set verified: true when it answers.',
    }],
    platform: plan.platform,
    feedStatus: 'unverified',
    verifiedAt: null,
    scraped: false,
    job: { id: plan.id, script: plan.script, engine: plan.engine, transport: plan.transport, enabled: false },
    oddsFeed: null,
    crawl: null,
    unavailableSports: [],
    captureFiles: [],
    bodyShape: 'recorded-url-only',
  };
  files.push({
    path: tree.paths.registry,
    reason: 'the endpoint registry record (unverified until measured)',
    content: `${JSON.stringify({ ...tree.registry, books: { ...tree.registry.books, [plan.id]: record } }, null, 2)}\n`,
    patch: true,
  });

  // 7. the test entry point
  files.push({
    path: join(plan.root, 'test', `${plan.id}.test.mjs`),
    reason: 'the test entry point for this book',
    content: testSource(plan, dateStr),
    isNew: true,
  });

  return { ok: true, plan, files, job, recipe: plan.recipe };
}

// -------------------------------------------------------------------- applying

/** Write every file in the plan. New files last would be tidier; this is not. */
export async function applyPlan(plan) {
  for (const file of plan.files) {
    await writeFile(file.path, file.content, 'utf8');
  }
}

/** The work that is judgement rather than writes, in the order it must happen. */
export function checklistFor(plan, recipe) {
  const id = plan.plan.id;
  const steps = [];
  if (plan.plan.writesAdapter && plan.plan.failsClosed) {
    steps.push(`implement ${plan.plan.script}: fetchRaw → normalize → extractEvents (docs/adding-a-book.md)`);
  }
  steps.push(
    'capture a real response into data/endpoints/captures/ and set that record\'s feedStatus to what it answered',
    'write fixtures from that capture into test/<book>.test.mjs — the live payload, not a convenient shape',
    'decide the feed group: independent price source, or an alias of a platform already grouped? (docs/surebet-parity-gaps.md section 1)',
    `run the live gate: npm run smoke:live -- --books ${id}`,
    'promote: enabled true, validationStatus validated, validationReason the measurement — then update SCRAPER-TASKS.md',
    'gates: npm run lint && npm test',
  );
  for (const note of recipe?.notes || []) steps.push(`platform note: ${note}`);
  return steps;
}

// ------------------------------------------------------------------------- CLI

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`add-book: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.id) {
    console.error('add-book: --id is required\n');
    console.error(USAGE);
    return 2;
  }
  let result;
  try {
    result = await buildPlan(options);
  } catch (error) {
    console.error(`add-book: ${error.message}`);
    return 1;
  }
  if (!result.ok) {
    console.error('add-book: refusing to scaffold —');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  const { plan } = result;
  console.log(`add-book: ${plan.id} on ${plan.platform}${options.dryRun ? ' (dry run — nothing written)' : ''}`);
  for (const file of result.files) {
    console.log(`  ${file.isNew ? 'add  ' : 'edit '} ${relative(plan.root, file.path)} — ${file.reason}`);
  }
  if (options.dryRun) return 0;
  await applyPlan(result);
  console.log(`\nScaffolded ${plan.id}. Nothing is enabled, validated or verified yet. The rest is judgement:`);
  for (const step of checklistFor(result, result.recipe)) console.log(`  - ${step}`);
  return 0;
}

// Compare resolved paths rather than URL strings: on Windows `import.meta.url`
// carries a percent-encoded drive path, and a string comparison against
// process.argv[1] misses it often enough to make the CLI silently do nothing.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`add-book: ${error.stack || error.message}`); process.exitCode = 1; },
  );
}