/**
 * ci-preflight.mjs — run locally what the workflow runs remotely, before the
 * first push.
 *
 * A workflow is a claim about a machine nobody on the project has used. The
 * unit gate in particular had a defect for a whole day: it installed the
 * playwright package but not the browser binaries, so it would have failed on
 * a clean runner for a reason that had nothing to do with the code. That was
 * only findable by asking what a clean runner looks like.
 *
 * This script answers that question locally, and covers the checks a runner
 * performs that a developer machine never does:
 *
 *   - a fresh dependency install, in a directory with no node_modules;
 *   - case sensitivity: Linux is case-sensitive, Windows is not, so a path
 *     that resolves here can fail there;
 *   - required binaries and environment, declared as assertions rather than
 *     discovered at run time.
 *
 * It is not a replacement for the first real run. A workflow still has to run
 * once on the runner; this makes that run a check rather than a surprise.
 *
 * Usage:
 *   node scripts/ci-preflight.mjs            # structural + local command checks
 *   node scripts/ci-preflight.mjs --clean    # also reinstall into a temp dir
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');

const CLEAN = process.argv.includes('--clean');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const workflowText = readFileSync(WORKFLOW, 'utf8');

// ---- 1. Structural assertions about the workflow itself -------------------

const onBlocks = (workflowText.match(/^on:/gm) || []).length;
check('a single `on:` block', onBlocks === 1,
  'a second one would silently replace the first, so the live gate would be the only trigger');

check('the unit gate runs on push and pull_request',
  /^\s{2}push:/m.test(workflowText) && /^\s{2}pull_request:/m.test(workflowText));

check('push is not restricted to the default branch',
  // Work here happens on fix/… and cleanup/… branches, which is the project's
  // own convention. A trigger filtered to master/main would mean the gate never
  // appears on the commits it exists to check, and nothing would look wrong:
  // the workflow would simply never run.
  !/^\s{4}branches:/m.test(workflowText),
  'a branch filter skips every fix/… branch the project actually uses');

check('the live gate is scheduled',
  /^\s{2}schedule:/m.test(workflowText) && /cron: '\d+ \d+ \* \* [\d,]+'/.test(workflowText),
  (workflowText.match(/cron: '([^']+)'/) || [])[1] || 'no cron found');

check('the live job records itself before the gate can fail it',
  // A step that fails skips every later step. With the gate before the
  // history step, a failing run — the one that most needs recording — was
  // never filed, so the series had no failed runs in it and could never show a
  // trend. The gate must be the last step that can fail the job.
  (() => {
    const gate = workflowText.indexOf('run: npm run smoke:live');
    // Search after the gate: the restore step also writes into the history
    // directory, and matching the first occurrence of either string would
    // compare the restore against the gate and report an order that is fine.
    const file = workflowText.indexOf('data-health-history/$stamp.json', gate);
    const trend = workflowText.indexOf('run: npm run smoke:trend', gate);
    if (gate < 0 || file < 0 || trend < 0) return false;
    return gate < file && file < trend;
  })(),
  'record the report, then judge the series — otherwise a failed run leaves no trace');

check('the restored history matches the artifact that is uploaded', () => {
  // A pattern that matches nothing fails silently: download-artifact with
  // continue-on-error restores an empty directory, the trend sees zero runs,
  // and it reports "not enough history" — which looks like the gate working.
  const upload = workflowText.match(/name:\s*(\S[\w-]*)\s*\n\s*path: data-health\.json/);
  const restore = workflowText.match(/pattern:\s*(\S[\w-]*)\s*\n\s*path: data-health-history/);
  if (!upload || !restore) return false;
  return upload[1] === restore[1];
}, 'the download pattern and the upload name are the same string, or the history restores empty');

check('the history is restored from earlier runs, not just this one', () => {
  // `actions/download-artifact` resolves `run-id` to the run in progress no
  // matter what token it is given, so it can only see this job's own
  // artifacts — and the upload comes later in the job. The step still
  // succeeds, the directory is empty, and the trend gate reports "not enough
  // history" for ever, which looks exactly like a working gate.
  const restore = workflowText.match(/- name: Restore the reports from earlier runs([\s\S]*?)- name: /);
  if (!restore) return false;
  const usesAction = /actions\/download-artifact/.test(restore[1]);
  const queriesApi = /actions\/artifacts\?name=data-health/.test(restore[1]);
  // Either it does not use the action, or it does and the API path is gone.
  return !usesAction || queriesApi;
}, 'history comes from the artifacts API, not from a per-run download');

check('the history outlives the runs needed to judge a trend', () => {
  // The gate needs three runs to say anything and runs twice a week. A
  // retention shorter than that expires the evidence before a verdict, and the
  // gate then reports "not enough history" indefinitely while appearing to work.
  const days = [...workflowText.matchAll(/name: data-health\b[\s\S]*?retention-days:\s*(\d+)/g)].map((m) => Number(m[1]));
  return days.length > 0 && Math.min(...days) >= 180;
}, `retention-days: ${[...workflowText.matchAll(/retention-days:\s*(\d+)/g)].map((m) => m[1]).join(', ')}`);

check('the live job is gated to schedule or manual dispatch',
  /event_name == 'schedule'/.test(workflowText) && /event_name == 'workflow_dispatch'/.test(workflowText),
  'a push must not reach 22 third-party endpoints');

// Job keys sit under `jobs:` and are indented two spaces. Matching any
// two-space key would also pick up `on.push` and `on.schedule`, which is not a
// failure of the workflow, so the scan starts after the `jobs:` line.
const jobsStart = workflowText.indexOf('\njobs:\n');
const jobBlock = jobsStart >= 0 ? workflowText.slice(jobsStart + 7) : '';
const jobNames = [...jobBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
check('both jobs are declared under jobs:', jobNames.length === 2, jobNames.join(', '));

check('lint and tests are separate steps',
  /run: npm run lint/.test(workflowText) && /run: npm test\b/.test(workflowText),
  'a lint failure should not hide whether the tests pass');

const browserSteps = (workflowText.match(/playwright install/g) || []).length;
check('the browser binaries are installed in both jobs', browserSteps === 2,
  'npm ci installs the playwright package but not Chromium, which the UI test and betano both need');

check('the live gate invokes the gate that fails on an empty run',
  /run: npm run smoke:live/.test(workflowText));

// ---- 2. Node version: the workflow pins one, the machine may differ -------

// The workflow reads .nvmrc, so the pin lives in exactly one place and the two
// cannot drift. This compares the file against the running machine so a
// developer on a different major finds out here rather than in CI.
const nvmrc = existsSync(join(ROOT, '.nvmrc')) ? readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim() : null;
check('the workflow reads .nvmrc rather than a hardcoded major',
  (workflowText.match(/node-version-file: \.nvmrc/g) || []).length === 2,
  `${(workflowText.match(/node-version-file: \.nvmrc/g) || []).length} of 2 jobs`);
check('.nvmrc exists and names a major', Boolean(nvmrc && /^\d+$/.test(nvmrc)), `.nvmrc = ${nvmrc}`);
// A newer local major is fine — the project supports >=20 and a newer runtime
// is not a defect. An *older* one is a real mismatch, because the code may
// rely on something the pinned version lacks. So this is a warning when the
// machine is ahead, and a failure when it is behind.
const localNode = process.versions.node.split('.')[0];
const nodeAhead = Number(localNode) > Number(nvmrc);
check(nvmrc === localNode || nodeAhead,
  `local Node ${localNode} vs .nvmrc ${nvmrc}`,
  nodeAhead
    ? 'the machine runs a newer major than CI pins — acceptable, but the run is not a rehearsal of the runner'
    : 'a mismatch is a source of "worked here, failed there"');

// ---- 3. Case sensitivity: Linux is strict, Windows is not ----------------

/** Every relative path the workflow and the scripts reference must match on disk exactly. */
const CASE_SENSITIVE_PATHS = [
  'package.json',
  'config/scrapers.json',
  'src/server.mjs',
  'scripts/smoke-live.mjs',
  'scripts/live-check.mjs',
  'test/scrape-ui.browser.test.mjs',
  'public/index.html',
  'public/admin/scrape.html',
];
for (const p of CASE_SENSITIVE_PATHS) {
  const exact = existsSync(join(ROOT, p));
  check(`path resolves exactly: ${p}`, exact, exact ? '' : 'case or path mismatch — this resolves on Windows and fails on Linux');
}

// ---- 4. The commands the workflow runs, run here -------------------------

/**
 * Run a command, the way a developer or a CI runner would.
 *
 * On Windows `npm` is a `.cmd` shim, which `execFile` cannot spawn (EINVAL);
 * it needs a shell. Everywhere else the command is spawned directly, so a
 * missing binary surfaces as ENOENT rather than as a shell error.
 */
async function runCommand(name, cmd, args, opts = {}) {
  const isWindows = process.platform === 'win32';
  const command = isWindows && !cmd.endsWith('.exe') ? `${cmd} ${args.join(' ')}` : cmd;
  const spawnArgs = isWindows && !cmd.endsWith('.exe') ? [] : args;
  try {
    const { stdout, stderr } = await run(command, spawnArgs, {
      cwd: ROOT,
      timeout: opts.timeout ?? 300_000,
      shell: isWindows && !cmd.endsWith('.exe'),
      ...opts,
    });
    const lastLine = (stdout || stderr || '').trim().split('\n').filter(Boolean).pop() || 'ok';
    check(name, true, lastLine.slice(0, 70));
    return { stdout, stderr };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').filter(Boolean);
    check(name, false, (out[out.length - 1] || err.message || 'failed').slice(0, 90));
    return { stdout: '', stderr: '' };
  }
}

console.log('ci-preflight — structural checks');
for (const r of results) {
  console.log(`  ${(r.ok ? 'ok  ' : 'FAIL').padEnd(5)} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}

console.log('\nci-preflight — running the workflow\'s own commands');
const commandResults = [];
commandResults.push(await runCommand('npm run lint', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lint']));
const tests = await runCommand('npm test', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { timeout: 420_000 });
commandResults.push(tests);

// ---- 5. A clean install, which is what the runner does -------------------

if (CLEAN) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'arbiter-clean-'));
  try {
    console.log(`\nci-preflight — clean install in ${dir}`);
    for (const f of ['package.json', 'package-lock.json']) {
      await fs.copyFile(join(ROOT, f), join(dir, f));
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await run(npm, ['ci', '--ignore-scripts'], { cwd: dir, timeout: 600_000 });
    check('a clean install succeeds without postinstall scripts', true, 'node_modules resolved from the lockfile alone');

    // A clean install has no browser binaries, which is precisely why the
    // workflow needs an explicit `playwright install`.
    const installed = existsSync(join(dir, 'node_modules', 'playwright'));
    check('playwright is installed by the lockfile alone', installed);
    console.log('  note  a clean install has no Chromium; the workflow installs it explicitly, which is why that step exists');
  } catch (err) {
    check('a clean install succeeds', false, (err.stderr || err.message).slice(0, 120));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
} else {
  console.log('\n(skipping the clean install; pass --clean to include it)');
}

// ---- Report -------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('preflight failed: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
console.log('\nThe workflow is structurally sound and its commands pass here.\n'
  + 'It still has to run once on the runner: this is a preflight, not the run itself.');
