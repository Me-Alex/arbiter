/**
 * add-book-scaffold.test.mjs — the bookmaker scaffold, run for real.
 *
 * The claim this file checks is not "the script parses" and not "the script
 * prints what it intends to write". It is: after `npm run new-book`, the tree
 * still satisfies every gate a hand-written addition has to satisfy. A scaffold
 * that produces a tree which fails scraper-routing.test.mjs has not made adding
 * a book easier, it has moved the six-file edit somewhere less visible.
 *
 * So each case copies the tree to a temp directory, scaffolds into the copy,
 * and then runs the repository's OWN gate tests against that copy:
 *
 *   scraper-routing              enabled → validated; every enabled job
 *                                instantiates; contract drift is rejected
 *   provider-contract            every registered scraper is enabled or carries a
 *                                reason; no job routes to a legacy adapter
 *   endpoints-registry           the registry covers every job and agrees with
 *                                config on the platform
 *   sport-registry-consistency   declared sports resolve, both directions
 *   field-census                 feedStatus stays one value across every job and
 *                                is backed by the registry
 *
 * Running them rather than restating their rules is the point. This file keeps
 * no private copy of what "a valid book" means, so it cannot drift into
 * agreeing with a scaffold that stopped producing one.
 *
 * The copy lives under scratch/ rather than the OS temp dir, and that is not
 * cosmetic: src/scrapers/index.mjs transitively imports betano.mjs, which
 * imports playwright-extra. Node resolves that from node_modules by walking up
 * from the file, and a copy under C:\Users\…\Temp walks up into nothing. Under
 * scratch/ it walks up into this repository and resolves. scratch/ is
 * gitignored, and test/nsoft-public.test.mjs already puts its temp dirs there.
 *
 * One case per dispatch shape, because "it worked for digitain" is not the
 * claim — these are four different code paths through the dispatcher:
 *
 *   digitain     brand subclass + BRANDS row + DIRECT + DIRECT_CONTRACTS
 *   egt-digital  brand subclass + TENANTS row + DIRECT + DIRECT_CONTRACTS
 *   nsoft        TENANTS tuple only; the platform matcher routes it
 *   altenar-sb2  TENANTS array row + ALTENAR_IDS; no adapter file at all
 *   custom       skeleton adapter that fails closed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseArgs, buildPlan, applyPlan, checklistFor, resolvePlan,
  appendToTable, appendToObject, appendToInlineArray, appendToArray, appendImport,
} from '../scripts/add-book.mjs';
import { platformRecipe, classPrefix, defaultDisplayName, PLATFORM_IDS } from '../src/scrapers/platforms.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(ROOT, 'scratch');

/**
 * The gate tests a scaffolded tree must still pass. Named rather than globbed,
 * so a rename cannot quietly reduce this list to one file.
 */
const GATES = [
  ['scraper-routing.test.mjs', 'enabled → validated, every enabled job instantiates, contract drift rejected'],
  ['provider-contract.test.mjs', 'every registered scraper is enabled or carries a reason; no legacy adapter is routed'],
  ['endpoints-registry.test.mjs', 'the registry covers every job and agrees with config'],
  ['sport-registry-consistency.test.mjs', 'declared sports resolve against the registry, both directions'],
  ['field-census.test.mjs', 'feedStatus stays one value across every job, backed by the registry'],
];

/**
 * What the copy needs. `data/endpoints/captures` is deliberately not copied: no
 * gate reads a capture, and the capture directory is 3 MB across 137 files, which
 * is a lot of copying to assert nothing about.
 */
const COPY = [
  'src', 'config', 'test', 'public',
  'data/endpoints/endpoints.json', 'data/scrape-state.json', 'data/latest-scrape-run.json',
];

/** Scaffold `id` with `args` into a fresh temp copy of the tree. */
async function scaffold(t, id, args) {
  await fs.mkdir(SCRATCH, { recursive: true });
  const dir = await fs.mkdtemp(join(SCRATCH, 'add-book-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const entry of COPY) {
    const from = join(ROOT, entry);
    // The two data state files are inputs field-census reads; if one is absent
    // from a checkout, that gate has nothing to say and is skipped rather than
    // failed on a missing fixture.
    if (!existsSync(from)) continue;
    await fs.cp(from, join(dir, entry), { recursive: true });
  }
  const before = {
    config: await fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8'),
    registry: await fs.readFile(join(dir, 'data', 'endpoints', 'endpoints.json'), 'utf8'),
  };
  const plan = await buildPlan(parseArgs(['--id', id, '--root', dir, ...args]));
  assert.equal(plan.ok, true, `the scaffold refused ${id}: ${(plan.problems || []).join('; ')}`);
  await applyPlan(plan);
  const jobs = JSON.parse(await fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8')).jobs;
  return { dir, plan, before, id, job: jobs.find((j) => j.id === id) };
}

/** Load a module out of the scaffolded tree. */
const loadTree = (dir, file) => import(pathToFileURL(join(dir, file)).href);

/**
 * Run one gate test against a scaffolded tree.
 *
 * The child env is the whole trick, and it was a silent trap. This file runs
 * under `node --test`, which exports NODE_TEST_CONTEXT to the test process; a
 * child `node --test` that inherits it prints "run() is being called recursively
 * within a test file. skipping running files", runs nothing, and exits 0. Every
 * assertion below compares status to 0, so an inherited context turned all five
 * gates into no-ops that passed — the proof of the whole system, verified against
 * gates that never executed. Stripped here, and `ran` below makes the same class
 * of silent pass impossible again.
 */
function runGate(dir, file) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', join(dir, 'test', file)], {
    encoding: 'utf8',
    cwd: dir,
    env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // A gate that ran reports its tally; one that was skipped reports nothing.
  const ran = /\u2139 tests (\d+)/.test(output);
  const tally = Object.fromEntries(
    ['tests', 'pass', 'fail', 'skipped', 'cancelled']
      .map((key) => [key, Number(new RegExp(`\u2139 ${key} (\\d+)`).exec(output)?.[1] ?? -1)]));
  return { status: result.status, output, ran, tally };
}

// -------------------------------------------------------------- the five shapes

const CASES = [
  {
    label: 'digitain — brand subclass, BRANDS row, dispatcher entry',
    id: 'scaffold-digitain',
    args: ['--platform', 'digitain', '--endpoint', 'https://scaffold-digitain.ro',
      '--host', 'micros-prod1.gambling-solutions.ro', '--name', 'Scaffold Digitain'],
    script: 'scaffold-digitain.mjs',
    engine: 'digitain',
    adapter: 'scaffold-digitain.mjs',
  },
  {
    label: 'egt-digital — brand subclass, TENANTS row',
    id: 'scaffold-egt',
    args: ['--platform', 'egt-digital', '--endpoint', 'https://scaffold-egt.ro',
      '--host', 'vsca-api.egt-digital.com', '--unit', 'VSCA'],
    script: 'scaffold-egt.mjs',
    engine: 'egt-public-sports-api',
    adapter: 'scaffold-egt.mjs',
  },
  {
    label: 'nsoft — TENANTS tuple only, routed by the platform matcher',
    id: 'scaffold-nsoft',
    args: ['--platform', 'nsoft', '--endpoint', 'https://scaffold-nsoft.ro',
      '--uuid', '7afdd6f5-f954-43d6-b696-2e0dc0ae4ee2'],
    // No adapter file: matchesNSoftConfig routes every tenant to the NSoftScraper
    // base, so a subclass here would be a module nothing imports.
    script: 'nsoft.mjs',
    engine: 'nsoft-public-json',
    adapter: null,
  },
  {
    label: 'altenar-sb2 — tenant array row + ALTENAR_IDS, no adapter file',
    id: 'scaffold-altenar',
    args: ['--platform', 'altenar-sb2', '--endpoint', 'https://scaffold-altenar.ro',
      '--host', 'scaffold-altenar.ro'],
    script: 'altenar-sites.mjs',
    engine: 'altenar-tenancy',
    adapter: null,
  },
  {
    label: 'custom — skeleton adapter that fails closed',
    id: 'scaffold-custom',
    args: ['--platform', 'custom', '--endpoint', 'https://scaffold-custom.ro'],
    script: 'scaffold-custom.mjs',
    engine: 'custom-json',
    adapter: 'scaffold-custom.mjs',
  },
];

for (const shape of CASES) {
  test(`${shape.label}: the scaffolded tree still passes every gate`, async (t) => {
    const { dir, plan, job } = await scaffold(t, shape.id, shape.args);

    assert.equal(job.script, shape.script, `${shape.id}: the script the config declares`);
    assert.equal(job.engine, shape.engine, `${shape.id}: the engine the config declares`);
    assert.equal(job.platform, plan.plan.platform);
    assert.equal(
      existsSync(join(dir, 'src', 'scrapers', shape.adapter || 'no-such-adapter.mjs')),
      shape.adapter !== null,
      `${shape.id}: an adapter file is written only when the platform needs one`,
    );

    for (const [file, guards] of GATES) {
      const { status, output, ran, tally } = runGate(dir, file);
      // Assert the gate ran before asserting it passed: a skipped child exits 0,
      // and "exit 0" is exactly what a gate that never executed looks like.
      assert.ok(ran,
        `${file} did not run against the scaffolded tree, so its result means nothing.\n${output.slice(-2000)}`);
      assert.equal(tally.fail, 0, `${file} reported failures (of ${tally.tests} tests). It guards: ${guards}.`);
      assert.ok(tally.tests > 0, `${file} ran but reported no tests. It guards: ${guards}.`);
      assert.equal(status, 0,
        `${file} failed on a scaffolded tree. It guards: ${guards}.\n${output.slice(-4000)}`);
    }
  });
}

// -------------------------------------------------- what the scaffold must not do

test('the scaffolded job is a candidate: disabled, unvalidated, no feedStatus', async (t) => {
  // Each of the three is separately load-bearing:
  //
  //   enabled: false    instantiate() rejects a disabled job with ESCRAPERCONFIG,
  //                     which is what keeps a new book out of every live run.
  //   candidate         an enabled job that is not validated is the invalid state
  //                     test/scraper-routing.test.mjs refuses to represent.
  //   no feedStatus     test/field-census.test.mjs asserts this field carries
  //                     exactly one value across all jobs and is backed by the
  //                     registry. A second value invalidates that test's
  //                     exemption silently, so the field is omitted, not invented.
  const { dir, plan, job } = await scaffold(t, 'scaffold-candidate',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-candidate.ro']);

  assert.equal(job.enabled, false);
  assert.equal(job.validationStatus, 'candidate');
  assert.ok(!Object.hasOwn(job, 'feedStatus'), 'a candidate declares no feed status to describe');
  assert.ok(job.validationReason.length > 20,
    'test/provider-contract.test.mjs requires a recorded reason, not just a label');
  assert.deepEqual(job, plan.job, 'the config on disk is the job the plan described');

  const registry = JSON.parse(await fs.readFile(join(dir, 'data', 'endpoints', 'endpoints.json'), 'utf8'));
  const record = registry.books['scaffold-candidate'];
  assert.equal(record.book, 'scaffold-candidate', 'the record key must match its book name');
  assert.equal(record.platform, job.platform, 'the registry and config agree on the platform');
  assert.equal(record.scraped, false);
  assert.equal(record.feedStatus, 'unverified', 'an unreachable endpoint is a claim, not a measurement');
  assert.equal(record.keyEndpoints[0].verified, false, 'the endpoint is recorded, not verified');
  assert.equal(record.keyEndpoints[0].url, job && 'https://scaffold-candidate.ro');
  // The archive's own shape: every one of the 110 shipped records carries these.
  for (const key of ['book', 'platform', 'feedStatus', 'verifiedAt', 'scraped', 'job',
    'oddsFeed', 'crawl', 'unavailableSports', 'captureFiles']) {
    assert.ok(Object.hasOwn(record, key), `every record in this archive carries ${key}`);
  }
});

test('the scaffolded dispatcher routes the job when promoted, and rejects drift', async (t) => {
  // The promotion gate is where a half-added book would otherwise hide: a job
  // config/scrapers.json declares but src/scrapers/index.mjs cannot route fails
  // every live run and no gate notices, because the job is disabled. So the
  // routed state is exercised here directly.
  const { dir, job } = await scaffold(t, 'scaffold-routing',
    ['--platform', 'digitain', '--endpoint', 'https://scaffold-routing.ro',
      '--host', 'micros-prod1.gambling-solutions.ro']);
  const { instantiate } = await loadTree(dir, 'src/scrapers/index.mjs');

  assert.throws(() => instantiate('scaffold-routing', { jobConfig: job }), { code: 'ESCRAPERCONFIG' },
    'the disabled job is refused, so it cannot be scraped by accident');

  const scraper = instantiate('scaffold-routing', { jobConfig: { ...job, enabled: true } });
  assert.equal(scraper.id, 'scaffold-routing');
  assert.equal(scraper.name, 'Scaffold Routing', 'the display name came from the BRANDS row, not the id');

  for (const field of ['engine', 'transport', 'script']) {
    assert.throws(
      () => instantiate('scaffold-routing', { jobConfig: { ...job, enabled: true, [field]: 'drifted' } }),
      { code: 'ESCRAPERCONFIG' },
      `${field} drift must be a configuration error, not a silent fallback`,
    );
  }
});

test('a tenant platform is routed by its own matcher, with no adapter file', async (t) => {
  // nsoft and altenar are the shapes where "write the adapter" is wrong. Both
  // matchers compare engine/transport/script against a table the base module
  // owns, then return the base class. A scaffold that wrote an adapter here
  // would ship a file nothing imports — the quietest kind of broken addition.
  for (const [id, args] of [
    ['scaffold-tenant-nsoft', ['--platform', 'nsoft', '--endpoint', 'https://scaffold-tenant-nsoft.ro',
      '--uuid', '7afdd6f5-f954-43d6-b696-2e0dc0ae4ee2']],
    ['scaffold-tenant-altenar', ['--platform', 'altenar-sb2', '--endpoint', 'https://scaffold-tenant-altenar.ro',
      '--host', 'scaffold-tenant-altenar.ro']],
  ]) {
    const { dir } = await scaffold(t, id, args);
    const { instantiate } = await loadTree(dir, 'src/scrapers/index.mjs');
    const { jobs } = JSON.parse(await fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8'));
    const job = jobs.find((j) => j.id === id);

    const scraper = instantiate(id, { jobConfig: { ...job, enabled: true } });
    assert.ok(scraper, `${id}: the platform matcher must route it`);
    assert.deepEqual(scraper.sourceIds, [id], `${id}: publishes under its own sourceId`);
  }
});

test('a skeleton adapter fails closed instead of collecting nothing', async (t) => {
  // The failure mode this guards is measured repeatedly in this project
  // (winboss, las-vegas, unibet): an adapter returning an empty list is
  // indistinguishable from one that worked on a quiet fixture list.
  const { dir, job } = await scaffold(t, 'scaffold-failsclosed',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-failsclosed.ro']);
  const { instantiate } = await loadTree(dir, 'src/scrapers/index.mjs');
  const scraper = instantiate('scaffold-failsclosed', { jobConfig: { ...job, enabled: true } });

  for (const hook of ['fetchRaw', 'normalize', 'extractEvents']) {
    await assert.rejects(async () => scraper[hook](), { name: 'ValidationError' },
      `${hook} must refuse rather than report an empty day`);
  }
});

// ------------------------------- the generated test file's own lifecycle

/**
 * Edit the config job in a scaffolded tree, rewriting it byte-identically to how
 * add-book.mjs does, so nothing here depends on this file's formatting taste.
 */
async function editJob(dir, id, change) {
  const path = join(dir, 'config', 'scrapers.json');
  const raw = await fs.readFile(path, 'utf8');
  const cfg = JSON.parse(raw);
  change(cfg.jobs.find((j) => j.id === id));
  await fs.writeFile(path, JSON.stringify(cfg, null, 2) + '\n');
}

test('the generated test file stays green through the whole documented order', async (t) => {
  // The defect this pins: the generated file asserted `enabled === false` and
  // asserted an unimplemented adapter refuses to fetch. docs/adding-a-book.md
  // tells the operator to do exactly those two things next, so following the
  // guide turned the repo red at the moment the book started working — one
  // failure after implementing the adapter, two after promoting. A check that
  // fires on success is worse than no check, so each of those two now calls
  // t.skip() once it stops applying.
  const { dir, id } = await scaffold(t, 'scaffold-lifecycle',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-lifecycle.ro']);
  const run = () => runGate(dir, `${id}.test.mjs`);

  const fresh = run();
  assert.ok(fresh.ran, `the generated test did not run:\n${fresh.output}`);
  assert.equal(fresh.status, 0, `a fresh scaffold must be green:\n${fresh.output}`);
  assert.equal(fresh.tally.fail, 0);
  assert.equal(fresh.tally.skipped, 0,
    'nothing skips before the book has left the candidate state');

  // Step 1 of the guide: the adapter is implemented.
  const adapter = join(dir, 'src', 'scrapers', `${id}.mjs`);
  const src = await fs.readFile(adapter, 'utf8');
  const implemented = src.replace(
    /async fetchRaw\(\) \{\n\s+throw new ValidationError\([^\n]*\n\s+\}/,
    'async fetchRaw() {\n    return { events: [] };\n  }');
  assert.notEqual(implemented, src, 'the scaffolded adapter no longer refuses — update this test');
  await fs.writeFile(adapter, implemented);

  const afterImpl = run();
  assert.ok(afterImpl.ran, `the generated test stopped running:\n${afterImpl.output}`);
  assert.equal(afterImpl.status, 0,
    `implementing the adapter must not fail the generated test:\n${afterImpl.output}`);
  assert.ok(afterImpl.tally.skipped >= 1,
    'the fail-closed check must step aside once the adapter is implemented');

  // Step 4 of the guide: the book is promoted.
  await editJob(dir, id, (j) => { j.enabled = true; j.validationStatus = 'validated'; });
  const afterPromo = run();
  assert.ok(afterPromo.ran, `the generated test stopped running:\n${afterPromo.output}`);
  assert.equal(afterPromo.status, 0,
    `promotion must not fail the generated test:\n${afterPromo.output}`);
  assert.ok(afterPromo.tally.skipped >= 2,
    'the candidate check must step aside once the book is promoted');
});

test('a check that steps aside still fires on what it was written to catch', async (t) => {
  // The other half of the lifecycle test, and the half that makes skipping safe:
  // a guard that steps aside too eagerly is worse than no guard, because it still
  // looks like coverage. Measured here rather than asserted in prose.
  const { dir, id } = await scaffold(t, 'scaffold-stillfires',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-stillfires.ro']);

  // Enabled but not validated is the illegal promotion — the one state the
  // candidate check must NOT treat as "promoted and nothing left to say".
  await editJob(dir, id, (j) => { j.enabled = true; j.validationStatus = 'candidate'; });
  const illegal = runGate(dir, `${id}.test.mjs`);
  assert.notEqual(illegal.status, 0, 'enabled without validated must fail the generated test');
  assert.match(illegal.output, /a candidate is never enabled/);

  // Contract drift must still be caught after promotion, when the other two
  // checks have stepped aside.
  await editJob(dir, id, (j) => { j.validationStatus = 'validated'; j.engine = 'drifted-engine'; });
  const drifted = runGate(dir, `${id}.test.mjs`);
  assert.notEqual(drifted.status, 0, 'contract drift must fail the generated test');
  assert.match(drifted.output, /exact contract this adapter implements/);
});

test('no generated check is vacuous on a platform that has no skeleton', async (t) => {
  // The scaffold used to emit a fourth test on every platform, and on brand and
  // tenant platforms its body was a comment explaining that nothing could be
  // asserted — a test that passes because it asserts nothing is not a test. Now
  // nothing is emitted there, and what covers the table row is the routing check
  // (the base constructor throws without it), which this also pins by removing
  // the row the scaffold wrote and watching that check fail.
  const { dir, id } = await scaffold(t, 'scaffold-vacuous',
    ['--platform', 'digitain', '--endpoint', 'https://scaffold-vacuous.ro', '--host', 'scaffold-vacuous.ro']);
  const generated = await fs.readFile(join(dir, 'test', `${id}.test.mjs`), 'utf8');
  const bodies = generated.split(/\ntest\(/).slice(1);
  assert.ok(bodies.length >= 3, `expected at least three checks, got ${bodies.length}`);
  for (const body of bodies) {
    assert.match(body, /assert\./, `a generated check with no assertion cannot fire:\n${body.slice(0, 120)}`);
  }

  const brands = join(dir, 'src', 'scrapers', 'digitain-brands.mjs');
  const before = await fs.readFile(brands, 'utf8');
  const stripped = before.replace(new RegExp(`^[^\\n]*${id}[^\\n]*\\n`, 'm'), '');
  assert.notEqual(stripped, before, 'the scaffold did not write a BRANDS row to remove');
  await fs.writeFile(brands, stripped);

  const withoutRow = runGate(dir, `${id}.test.mjs`);
  assert.notEqual(withoutRow.status, 0,
    'routing must fail without the table row — that is what proves the row exists');
  assert.match(withoutRow.output, /unknown brand/);
});

// ------------------------------------------------------------ what it refuses

test('the scaffold refuses rather than writing a half-book, and writes nothing', async (t) => {
  const { dir } = await scaffold(t, 'scaffold-refusal',
    ['--platform', 'digitain', '--endpoint', 'https://scaffold-refusal.ro',
      '--host', 'micros-prod1.gambling-solutions.ro']);
  const snapshot = await Promise.all([
    fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8'),
    fs.readFile(join(dir, 'data', 'endpoints', 'endpoints.json'), 'utf8'),
    fs.readFile(join(dir, 'src', 'scrapers', 'index.mjs'), 'utf8'),
  ]);

  const REFUSALS = [
    ['an id that already has a job',
      ['--id', 'scaffold-refusal', '--platform', 'digitain', '--endpoint', 'https://x.ro', '--host', 'x.example.com'],
      /already has a job/],
    ['an id that already has a registry record',
      ['--id', 'bet7', '--platform', 'custom', '--endpoint', 'https://x.ro'],
      /already has a job in config\/scrapers\.json/],
    ['a platform nobody has measured',
      ['--id', 'zz-new', '--platform', 'not-a-platform', '--endpoint', 'https://x.ro'],
      /unknown platform/],
    ['an endpoint that is not a URL',
      ['--id', 'zz-new', '--platform', 'custom', '--endpoint', 'betex.ro'],
      /not an http\(s\) URL/],
    ['a sport the registry does not declare',
      ['--id', 'zz-new', '--platform', 'custom', '--endpoint', 'https://x.ro', '--sports', 'football,chess'],
      /not registered in src\/sports\/registry\.mjs/],
    ['an id that is not kebab-case',
      ['--id', 'Scaffold_Ref', '--platform', 'custom', '--endpoint', 'https://x.ro'],
      /lowercase kebab-case/],
    ['a platform-specific value the recipe needs',
      ['--id', 'zz-new', '--platform', 'nsoft', '--endpoint', 'https://x.ro'],
      /--uuid is required/],
    ['an override the platform matcher cannot accept',
      ['--id', 'zz-new', '--platform', 'altenar-sb2', '--endpoint', 'https://x.ro', '--host', 'x.ro', '--transport', 'something-else'],
      /cannot override/],
    ['a flag nothing on this platform reads',
      ['--id', 'zz-new', '--platform', 'custom', '--endpoint', 'https://x.ro', '--unit', 'NOPE'],
      /--unit is only meaningful on egt-digital/],
    ['a value flag with no value',
      ['--id', 'zz-new', '--platform', 'custom', '--endpoint'],
      /needs a value/],
  ];

  for (const [label, args, expected] of REFUSALS) {
    let plan;
    try {
      plan = await buildPlan(parseArgs([...args, '--root', dir]));
    } catch (error) {
      assert.match(error.message, expected, `${label}: ${error.message}`);
      continue;
    }
    assert.equal(plan.ok, false, `${label}: must be refused`);
    assert.match(plan.problems.join(' | '), expected, `${label}:`);
  }

  const after = await Promise.all([
    fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8'),
    fs.readFile(join(dir, 'data', 'endpoints', 'endpoints.json'), 'utf8'),
    fs.readFile(join(dir, 'src', 'scrapers', 'index.mjs'), 'utf8'),
  ]);
  assert.deepEqual(after, snapshot, 'a refused scaffold wrote nothing');
});

test('the scaffold adds exactly one job and one record, touching nothing else', async (t) => {
  // A scaffold that rewrote config/scrapers.json from a parsed object would keep
  // every value and still produce a 30-job diff. This asserts the pre-existing
  // entries are byte-identical, so the addition is reviewable as one addition.
  const { dir, before } = await scaffold(t, 'scaffold-preserves',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-preserves.ro']);

  const after = JSON.parse(await fs.readFile(join(dir, 'config', 'scrapers.json'), 'utf8'));
  const original = JSON.parse(before.config);
  assert.equal(after.jobs.length, original.jobs.length + 1, 'exactly one job is added');
  assert.deepEqual(after.jobs.slice(0, original.jobs.length), original.jobs,
    'every pre-existing job is untouched, in order');
  assert.deepEqual(Object.keys(after).filter((k) => k !== 'jobs'), Object.keys(original).filter((k) => k !== 'jobs'),
    'no top-level config key is added, removed or reordered');

  const registry = JSON.parse(await fs.readFile(join(dir, 'data', 'endpoints', 'endpoints.json'), 'utf8'));
  const originalRegistry = JSON.parse(before.registry);
  assert.equal(registry.schemaVersion, originalRegistry.schemaVersion);
  assert.equal(Object.keys(registry.books).length, Object.keys(originalRegistry.books).length + 1,
    'exactly one registry record is added');
  for (const [book, record] of Object.entries(originalRegistry.books)) {
    assert.deepEqual(registry.books[book], record, `${book}: the pre-existing record is untouched`);
  }
});

// --------------------------------------------------------------- the catalog

test('every platform in the catalogue ships real books with real contracts', async () => {
  // The catalogue is the input to every other scaffold, so a stale entry here is
  // worse than a bug in one recipe: it produces a book that is confidently
  // misconfigured. Measured against the two documents the shipped books live in
  // rather than against the catalogue's own claims.
  const config = JSON.parse(await fs.readFile(join(ROOT, 'config', 'scrapers.json'), 'utf8'));
  const registry = JSON.parse(await fs.readFile(join(ROOT, 'data', 'endpoints', 'endpoints.json'), 'utf8'));
  const byPlatform = new Map();
  for (const job of config.jobs) {
    if (!byPlatform.has(job.platform)) byPlatform.set(job.platform, []);
    byPlatform.get(job.platform).push(job);
  }

  const orphans = PLATFORM_IDS.filter((id) => id !== 'custom' && !byPlatform.has(id));
  assert.deepEqual(orphans, [],
    'these platforms ship no job, so the recipe describes a platform nobody has built against');

  for (const id of PLATFORM_IDS) {
    const recipe = platformRecipe(id);
    assert.equal(recipe.platform, id, `${id}: the recipe echoes its own key`);
    assert.ok(recipe.engine, `${id}: a recipe needs the engine half of the contract`);
    assert.ok(recipe.transport, `${id}: a recipe needs the transport half`);
    assert.ok(recipe.notes.length > 0, `${id}: a recipe says what a new book here is worth`);
    for (const job of byPlatform.get(id) || []) {
      assert.equal(registry.books[job.id]?.platform, job.platform,
        `${job.id}: config and registry disagree about the platform`);
    }
  }
});

test('a locked field cannot be overridden, and the check is not a tautology', async () => {
  // The first version compared an override against the value it had already
  // replaced, so it could never fire: every locked field was silently
  // overridable and every override produced a job no matcher routes. This is
  // here because a check that cannot fail is worse than no check.
  const refused = await buildPlan(parseArgs([
    '--id', 'zz-locked', '--platform', 'altenar-sb2', '--endpoint', 'https://zz-locked.ro',
    '--host', 'zz-locked.ro', '--transport', 'something-else',
  ]));
  assert.equal(refused.ok, false);
  assert.ok(refused.problems.some((p) => /cannot override/.test(p) && /something-else/.test(p)),
    `the override must be named: ${JSON.stringify(refused.problems)}`);

  // And the recipe's own value must pass, so the refusal is about the value and
  // not about the flag's presence.
  const allowed = await buildPlan(parseArgs([
    '--id', 'zz-locked', '--platform', 'altenar-sb2', '--endpoint', 'https://zz-locked.ro',
    '--host', 'zz-locked.ro', '--transport', 'altenar-sb2-widget-json',
  ]));
  assert.equal(allowed.ok, true, `the recipe's own value must be accepted: ${(allowed.problems || []).join('; ')}`);
});

test('a recipe declares exactly the shape its kind needs', async () => {
  // The adapter field set is what the scaffold branches on, and the two mistakes
  // are silent. A skeleton given a `file` would subclass a base module that does
  // not exist; a table recipe without an `extra` would be asked for nothing and
  // patch in a blank row. So the field set is pinned per kind, exactly.
  const EXPECTED = {
    digitain: 'brand',
    'egt-digital': 'brand',
    nsoft: 'tenant',
    'altenar-sb2': 'tenant-array',
    'everymatrix-odds': 'skeleton',
    'exalogic-xsport': 'skeleton',
    'kindred-xns': 'skeleton',
    sportify: 'skeleton',
    'kaizen-betano': 'skeleton',
    'superbet-offer': 'skeleton',
    erlyline: 'skeleton',
    'fortuna-group': 'skeleton',
    'betfair-exchange': 'skeleton',
    custom: 'skeleton',
  };
  const SHAPE = {
    brand: ['kind', 'file', 'table', 'extra'],
    tenant: ['kind', 'file', 'table', 'extra'],
    'tenant-array': ['kind', 'file', 'table', 'extra', 'idsFile', 'idsArray'],
    // No file and no table: the scaffold names the new adapter after the book id
    // and the operator writes its body. That is what makes it fail closed.
    skeleton: ['kind'],
  };
  assert.deepEqual([...PLATFORM_IDS].sort(), Object.keys(EXPECTED).sort(),
    'the catalogue and the expected dispatch shapes must name the same platforms');

  for (const [id, kind] of Object.entries(EXPECTED)) {
    const { adapter } = platformRecipe(id);
    assert.equal(adapter.kind, kind, `${id}: adapter kind`);
    assert.deepEqual(Object.keys(adapter).sort(), [...SHAPE[kind]].sort(),
      `${id}: a ${kind} recipe declares exactly these fields`);

    if (kind !== 'skeleton') {
      // Only 'host' and 'uuid' are collected and checked (validateCandidate asks
      // for exactly those two). Any other value would be gathered from nothing.
      assert.ok(['host', 'uuid'].includes(adapter.extra),
        `${id}: extra "${adapter.extra}" is not a value the scaffold collects`);
      // A renamed platform file otherwise fails only at write time, and only for
      // whoever happens to add the next book on that platform.
      for (const file of [adapter.file, adapter.idsFile].filter(Boolean)) {
        assert.ok(existsSync(join(ROOT, 'src', 'scrapers', file)),
          `${id}: ${file} does not exist in src/scrapers`);
      }
    }
  }
});

test('the matcher-routed platforms never get their own adapter file', async () => {
  // This is the mistake the catalogue exists to prevent, and it is invisible in
  // the diff: the tenant platforms are routed by their own matcher (the exported
  // config matcher in nsoft.mjs, and the Altenar one in altenar-public.mjs),
  // which runs before DIRECT_CONTRACTS in src/scrapers/index.mjs. A subclass
  // written for them would be a file nothing imports, and a DIRECT entry for them
  // would be a second route to an id the matcher already owns — with
  // ALL_SCRAPERS being Object.keys(DIRECT), provider-contract.test.mjs would then
  // demand a reason for a book the config never reaches. Measured over the whole
  // catalogue, not just the shapes the end-to-end cases above happen to cover.
  //
  // The matchers are described here rather than named, because
  // test/export-census.test.mjs counts any mention in a consumer file — comment
  // included — as a consumer, and naming them would silently drop them from its
  // backend-only set.
  for (const id of PLATFORM_IDS) {
    const { adapter } = platformRecipe(id);
    const plan = resolvePlan({ id: 'probe-book', platform: id, endpoint: 'https://probe.example' });
    const routedByMatcher = adapter.kind === 'tenant' || adapter.kind === 'tenant-array';
    assert.equal(plan.writesAdapter, !routedByMatcher,
      `${id}: a matcher-routed platform must not write an adapter module`);
    assert.equal(plan.failsClosed, adapter.kind === 'skeleton',
      `${id}: only a skeleton is unimplemented, so only a skeleton fails closed`);
    if (routedByMatcher) {
      // The matcher dispatches on this exact string; a job naming any other file
      // is a job pointing at nothing, which is why these platforms lock script.
      assert.ok(plan.recipe.locked?.includes('script'),
        `${id}: a matcher-routed platform must lock script`);
    }
  }
});

// ------------------------------------------------------- the pure edit helpers

test('the table patchers anchor on the closing brace, not on the last row', () => {
  // Anchoring on the current last entry is the obvious implementation and it
  // breaks the first time a book is added after another one: the row lands in
  // the wrong place, or replaces a row that has since changed. Asserted against
  // the three shapes that actually occur in this tree.
  const frozen = 'const TENANTS = Object.freeze({\n  a: 1,\n  b: 2,\n});\n';
  assert.equal(appendToTable(frozen, 'TENANTS', 'c', '3'),
    'const TENANTS = Object.freeze({\n  a: 1,\n  b: 2,\n  c: 3,\n});\n');
  const plain = 'const TENANTS = {\n  a: [1, 2],\n};\n';
  assert.equal(appendToTable(plain, 'TENANTS', 'b-c', '[3, 4]'),
    'const TENANTS = {\n  a: [1, 2],\n  "b-c": [3, 4],\n};\n',
    'a quoted key stays quoted: an unquoted hyphen is not an identifier');
  assert.throws(() => appendToTable(plain, 'MISSING', 'c', '3'), /no MISSING table found/);

  const twoObjects = 'const DIRECT = {\n  a: A,\n};\nconst OTHER = {\n  b: B,\n};\n';
  assert.equal(appendToObject(twoObjects, 'const DIRECT = {', '  c: C,'),
    'const DIRECT = {\n  a: A,\n  c: C,\n};\nconst OTHER = {\n  b: B,\n};\n',
    'the scan must stop at DIRECT, not run on into the next object in the file');

  assert.equal(appendToInlineArray("export const ALTENAR_IDS = ['don', 'topbet'];\n", 'ALTENAR_IDS', "'newone'"),
    "export const ALTENAR_IDS = ['don', 'topbet', 'newone'];\n");
  assert.equal(appendToArray("export const TENANTS = [\n  {\n    id: 'a',\n  },\n];\n", 'export const TENANTS = [', "  { id: 'b' },"),
    "export const TENANTS = [\n  {\n    id: 'a',\n  },\n  { id: 'b' },\n];\n");
  assert.equal(appendImport("import A from './a.mjs';\nimport B from './b.mjs';\n\nconst X = 1;\n", "import C from './c.mjs';"),
    "import A from './a.mjs';\nimport B from './b.mjs';\nimport C from './c.mjs';\n\nconst X = 1;\n");
});

test('parseArgs refuses a value flag with nothing after it', () => {
  // A missing value that reads as the next flag produces a config job with a
  // literal '--sports' in it, which no gate rejects and no run reports.
  for (const argv of [['--id'], ['--id', 'x', '--host'], ['--id', 'x', '--sports', '--engine', 'y'], ['--nope', 'x']]) {
    assert.throws(() => parseArgs(argv), /needs a value|unknown argument/, `${JSON.stringify(argv)} must be refused`);
  }
  assert.deepEqual(parseArgs(['--id', 'a', '--sports', ' football , tennis ']).sports, ['football', 'tennis']);
});

test('the checklist names the judgement, not just the writes', async (t) => {
  // The scaffold exists because most of adding a book is measurement, not
  // editing. A checklist listing only the writes would understate the work by
  // exactly the part the scaffold cannot do.
  const { plan } = await scaffold(t, 'scaffold-checklist',
    ['--platform', 'custom', '--endpoint', 'https://scaffold-checklist.ro']);
  const steps = checklistFor(plan, plan.recipe).join('\n');
  for (const needed of ['capture', 'fixtures', 'feed group', 'smoke:live', 'promote', 'npm run lint']) {
    assert.ok(steps.includes(needed), `the checklist must still name the "${needed}" step`);
  }
  assert.match(steps, /platform note: /, 'the platform notes the catalogue carries must reach the operator');
});

// ----------------------------------------------------------- naming decisions

test('an id that cannot start an identifier still yields a valid class name', () => {
  // 888sport is a shipped book and its class is Sport888. The scaffold cannot
  // know which word a brand wants first, but `class 888sport` is a syntax
  // error, so it prefixes Book: valid, deterministic, one line to rename.
  assert.equal(classPrefix('888sport'), 'Book888sport');
  assert.equal(classPrefix('las-vegas'), 'LasVegas');
  assert.equal(classPrefix('bet7'), 'Bet7');
  assert.match(classPrefix('888sport'), /^[A-Za-z_$][\w$]*$/);
  assert.equal(defaultDisplayName('888sport'), '888sport');
  assert.equal(defaultDisplayName('casa-pariurilor'), 'Casa Pariurilor');
});

test('the catalogue hands out copies, so a caller cannot edit it', () => {
  // platformRecipe() returns a copy: a caller that mutated the recipe would make
  // the next scaffold produce something the catalogue no longer describes, with
  // nothing failing.
  const first = platformRecipe('digitain');
  first.engine = 'tampered';
  first.notes.push('tampered');
  assert.equal(platformRecipe('digitain').engine, 'digitain');
  assert.ok(!platformRecipe('digitain').notes.includes('tampered'));
  assert.throws(() => PLATFORM_IDS.push('new-platform'), TypeError, 'the id list is frozen');
  assert.equal(platformRecipe('not-a-platform'), null,
    'an unknown platform is null, not a silent default recipe');
});