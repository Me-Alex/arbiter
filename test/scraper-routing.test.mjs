import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instantiate, ALL_SCRAPERS, isKnownJob } from '../src/scrapers/index.mjs';
import Superbet from '../src/scrapers/superbet.mjs';
import Betano from '../src/scrapers/betano.mjs';
import { runScraperBatch } from '../src/scraper-service.mjs';
import { runVerificationPass } from '../src/verification.mjs';
import { ScrapeOrchestrator } from '../src/scrape-orchestrator.mjs';

// These fixtures carry `validationStatus: 'validated'` because the orchestrator's
// promotion gate now excludes unvalidated jobs BEFORE dispatch. Without it these
// tests would stop at "no enabled bookmaker jobs selected" and never reach the
// rejection they exist to check — the gate would silently mask them.
const tinyfishJob = (id) => ({ id, enabled: true, validationStatus: 'validated', engine: 'tinyfish', transport: 'tinyfish-browser', script: 'tinyfish-scraper.mjs' });
const unknownJob = (id) => ({ id, enabled: true, validationStatus: 'validated', engine: 'unknown-engine', transport: 'unknown-transport', script: 'unknown.mjs' });
async function fixture(t, jobs) {
  // Under the OS temp dir, not the repo root: a test that dies before its
  // cleanup hook leaves no litter behind, and the suite still runs from a
  // read-only checkout.
  const dir = await fs.mkdtemp(join(tmpdir(), 'arbiter-routing-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'custom.json');
  await fs.writeFile(configPath, JSON.stringify({ jobs }));
  return { dataDir: dir, configPath };
}

test('the registry cannot express an unvalidated job as enabled', () => {
  // The promotion gate at runtime is defence-in-depth. The property that
  // actually matches README's "validation is a required promotion gate rather
  // than a configuration shortcut" is that the INVALID STATE is not
  // representable in the registry in the first place: an enabled job whose
  // validation is not "validated" is a mistake, and it should fail in CI on
  // the commit that promotes it, not on the run that later trips over it.
  //
  // Today this passes because the two experimental jobs are also disabled. It
  // is the assertion that stops that coincidence from mattering.
  const { jobs } = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  const promoted = jobs.filter((j) => j.enabled !== false && j.validationStatus !== 'validated');
  assert.deepEqual(
    promoted.map((j) => `${j.id}=${j.validationStatus ?? 'unset'}`),
    [],
    'an enabled job must be validated; set enabled:false until validation passes'
  );
});

test('every enabled job in the config instantiates, and no disabled one does', async () => {
  const { jobs } = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  // This used to compare against a hand-maintained list of implemented ids.
  // That silently rotted: adding a job to config/scrapers.json turned the suite
  // red with a misleading "expected ESCRAPERCONFIG", which reads like a missing
  // implementation rather than an out-of-date test. The property that actually
  // matters is the one stated here: whatever the config enables must run.
  for (const jobConfig of jobs) {
    if (jobConfig.engine === 'tinyfish') continue; // TinyFish is disabled outright
    if (jobConfig.enabled === false) {
      // A registered but disabled job must be rejected, not silently run.
      assert.throws(() => instantiate(jobConfig.id, { jobConfig }), { code: 'ESCRAPERCONFIG' }, `${jobConfig.id} is disabled and must not instantiate`);
      continue;
    }
    const inst = instantiate(jobConfig.id, { jobConfig });
    assert.ok(inst, `expected an instance for enabled job ${jobConfig.id}`);
  }
});

test('a configured job whose contract drifts from its implementation is rejected', async () => {
  // The safety property behind the removed list: editing engine/transport/script
  // in the config must produce a configuration error, never a run against a
  // feed the adapter was not written for.
  const { jobs } = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  for (const jobConfig of jobs.filter((j) => j.enabled !== false && j.engine !== 'tinyfish')) {
    for (const field of ['engine', 'transport', 'script']) {
      assert.throws(
        () => instantiate(jobConfig.id, { jobConfig: { ...jobConfig, [field]: 'drifted' } }),
        { code: 'ESCRAPERCONFIG' },
        `${jobConfig.id} must reject ${field} drift`,
      );
    }
  }
});

test('TinyFish configurations are rejected before any client creation', () => {
  const cfg = tinyfishJob('superbet');
  const disabled = { code: 'ESCRAPERCONFIG', message: /TinyFish scraping is disabled/ };
  assert.throws(() => instantiate('superbet', { jobConfig: cfg }), disabled);
  for (const field of ['engine', 'transport', 'script']) {
    const partial = { id: 'superbet', enabled: true, [field]: cfg[field] };
    assert.throws(() => instantiate('superbet', { jobConfig: partial }), disabled);
  }
  assert.throws(() => instantiate('superbet', { jobConfig: undefined }), { code: 'ESCRAPERCONFIG' });
});

test('disabled configuration is rejected', () => {
  const cfg = { id: 'superbet', enabled: false, engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' };
  assert.throws(() => instantiate('superbet', { jobConfig: cfg }), { code: 'ESCRAPERCONFIG', message: /job is disabled/ });
});

test('no-config overlapping books select only their legacy direct adapters', () => {
  assert.ok(instantiate('superbet') instanceof Superbet);
  assert.ok(instantiate('betano') instanceof Betano);
  assert.equal(new Set(ALL_SCRAPERS).size, ALL_SCRAPERS.length);
  assert.equal(isKnownJob('unknown-book'), false);
  assert.equal(instantiate('unknown-book'), null);
});

test('parallel batches use direct scrapers for configured books and reject TinyFish/unknown', async (t) => {
  const opts = await fixture(t, [
    { id: 'superbet', enabled: true, engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' },
    tinyfishJob('betano'),
    unknownJob('unknown-book'),
  ]);
  t.mock.method(Superbet.prototype, 'run', async function run() {
    return { valid: true, status: 'ok', events: 5, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, error: null, outputs: [], sourceIds: ['superbet'], rawSize: 0 };
  });
  t.mock.method(Betano.prototype, 'run', () => { assert.fail('must not scrape'); });
  const { report } = await runScraperBatch({ ...opts, books: ['superbet', 'betano', 'unknown-book'], parallel: 3 });
  const byId = Object.fromEntries(report.jobs.map((j) => [j.id, j]));
  // superbet uses the direct scraper and succeeds
  assert.equal(byId.superbet.valid, true);
  assert.equal(byId.superbet.events, 5);
  // betano uses TinyFish config — rejected
  assert.equal(byId.betano.valid, false);
  assert.equal(byId.betano.error.code, 'ESCRAPERCONFIG');
  assert.match(byId.betano.error.message, /TinyFish scraping is disabled/);
  // unknown-book has no implementation — rejected
  assert.equal(byId['unknown-book'].valid, false);
  assert.equal(byId['unknown-book'].error.code, 'ESCRAPERCONFIG');
});

test('missing, disabled, malformed and duplicate configuration cannot fall back', async (t) => {
  const opts = await fixture(t, [{ id: 'betano', enabled: false, engine: 'top-events-v2-json', transport: 'betano-top-events-json', script: 'betano.mjs' }]);
  t.mock.method(Superbet.prototype, 'run', () => { assert.fail('must not scrape'); });
  const { jobs } = await runScraperBatch({ ...opts, books: ['superbet', 'betano'] });
  assert.ok(jobs.every((j) => j.error.code === 'ESCRAPERCONFIG'));
  await fs.writeFile(opts.configPath, JSON.stringify({ jobs: [tinyfishJob('betano'), tinyfishJob('betano')] }));
  await assert.rejects(runScraperBatch({ ...opts, books: ['betano'] }), { code: 'ESCRAPERCONFIG' });
  await fs.writeFile(opts.configPath, '{');
  await assert.rejects(runScraperBatch({ ...opts, books: ['betano'] }), SyntaxError);
  await assert.rejects(runScraperBatch({ ...opts, configPath: join(opts.dataDir, 'missing.json'), books: ['betano'] }), { code: 'ENOENT' });
});

test('verification forwards custom configuration without any network collection', async (t) => {
  const opts = await fixture(t, [tinyfishJob('superbet')]);
  const controller = new AbortController();
  let result;
  await runVerificationPass([{ legs: [{ sourceId: 'superbet' }] }], {}, { ...opts, signal: controller.signal, onEvent(e) {
    if (e.type === 'verify-job-complete') { result = e.result; controller.abort(); }
  } });
  assert.equal(result.error.code, 'ESCRAPERCONFIG');
  assert.match(result.error.message, /TinyFish scraping is disabled/);
});

for (const maxEvents of ['all', 321]) {
  test(`verification preserves collection limit ${maxEvents}`, async (t) => {
    const opts = await fixture(t, [{ id: 'superbet', enabled: true, engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' }]);
    let observed;
    t.mock.method(Superbet.prototype, 'run', async function () {
      observed = this.maxEvents;
      return { valid: true, status: 'ok', events: 0, outputs: [], sourceIds: ['superbet'] };
    });
    await runVerificationPass([{ legs: [{ sourceId: 'superbet' }] }], {}, { ...opts, maxEvents });
    assert.equal(observed, maxEvents === 'all' ? 5000 : maxEvents);
  });
}

test('orchestrator forwards custom configuration to initial batch', async (t) => {
  const opts = await fixture(t, [tinyfishJob('superbet')]);
  const orchestrator = new ScrapeOrchestrator(opts);
  await orchestrator.launch({ bookIds: ['superbet'] });
  await orchestrator._pipeline;
  const report = JSON.parse(await fs.readFile(join(opts.dataDir, 'latest-scrape-run.json'), 'utf8'));
  assert.equal(report.jobs[0].error.name, 'ScraperConfigurationError');
  assert.match(report.jobs[0].error.message, /TinyFish scraping is disabled/);
});
