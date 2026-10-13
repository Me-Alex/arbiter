import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

test('explicit disabled candidate can pass smoke without changing registry gating', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-candidate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(root, 'config/scrapers.json');
  const before = await readFile(configPath, 'utf8');
  const job = JSON.parse(before).jobs.find((job) => job.id === 'prowin');
  assert.equal(job.enabled, false);
  const fixturePath = fileURLToPath(new URL('./fixtures/egt-digital.json', import.meta.url));
  const preload = join(dir, 'capture.mjs');
  await writeFile(preload, `
    import { readFileSync } from 'node:fs';
    const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}));
    Date.now = () => Math.min(...fixture.containers.flatMap(c => Object.values(c.events).map(e => Date.parse(e.startTime)))) - 3600000;
    globalThis.fetch = async (url) => {
      const c = fixture.containers.find(c => String(url).endsWith('/' + c.containerId));
      return new Response(c ? JSON.stringify({ events: c.events }) : '', {
        status: c ? 200 : 404, headers: { 'content-type': 'application/json' }
      });
    };
  `);
  const reportPath = join(dir, 'report.json');
  const { stdout } = await run(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/smoke-live.mjs', '--', 'prowin'], {
    cwd: root, env: { ...process.env, SMOKE_REPORT_PATH: reportPath, GITHUB_STEP_SUMMARY: '' }, timeout: 15000,
  });
  assert.match(stdout, /1\/1 jobs passed/);
  assert.equal(JSON.parse(await readFile(reportPath)).jobs[0].id, 'prowin');
  assert.equal(await readFile(configPath, 'utf8'), before);
  await assert.rejects(run(process.execPath, ['scripts/smoke-live.mjs', 'not-a-book', 'winner'], { cwd: root }),
    (error) => error.code === 1 && /unknown bookmaker/.test(error.stderr));
});
