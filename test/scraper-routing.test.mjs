import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instantiate, ALL_SCRAPERS, ALL_TINYFISH_IDS, isKnownJob } from '../src/scrapers/index.mjs';
import Superbet from '../src/scrapers/superbet.mjs';
import Betano from '../src/scrapers/betano.mjs';
import { runScraperBatch } from '../src/scraper-service.mjs';
import { runVerificationPass } from '../src/verification.mjs';
import { ScrapeOrchestrator } from '../src/scrape-orchestrator.mjs';

const tinyfishJob = (id) => ({ id, enabled: true, engine: 'tinyfish', transport: 'tinyfish-browser', script: 'tinyfish-scraper.mjs' });
const unknownJob = (id) => ({ id, enabled: true, engine: 'unknown-engine', transport: 'unknown-transport', script: 'unknown.mjs' });
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

test('configured jobs with a matching direct scraper class instantiate that class', async () => {
  const { jobs } = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  // Job IDs that have a concrete scraper class in the DIRECT registry or a
  // specific config-driven matcher (NSoft, Altenar).  Every enabled job in
  // the config that is NOT in this list has no implementation and must throw.
  const implemented = new Set([
    'superbet', 'betano', 'fortuna', 'unibet', 'stanleybet', 'casa-pariurilor',
    'excelbet', 'netbet', 'admiral', 'winboss', 'maxbet', 'las-vegas',
    'don', 'topbet', 'million', 'baumbet', 'powerbet', 'winbet', 'magnumbet', 'winner',
    'getsbet', 'contibet', 'favbet',
  ]);
  for (const jobConfig of jobs) {
    if (jobConfig.engine === 'tinyfish') continue; // skip TinyFish jobs
    if (jobConfig.enabled === false) continue; // skip disabled
    if (implemented.has(jobConfig.id)) {
      const inst = instantiate(jobConfig.id, { jobConfig });
      assert.ok(inst, `expected an instance for ${jobConfig.id}`);
    } else {
      // No implementation exists — should throw ESCRAPERCONFIG
      assert.throws(() => instantiate(jobConfig.id, { jobConfig }), { code: 'ESCRAPERCONFIG' });
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
  assert.deepEqual(ALL_TINYFISH_IDS, []);
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
