/**
 * settings-page-wiring.test.mjs — the Settings page against the route that
 * serves it, key by key.
 *
 * The page reads five routes and posts to two, and nothing measured it: the
 * scheduler block sent `bookId` and `profileId`, names no file under src/ has
 * ever read, while the route forwards `body.bookIds` and `scheduler.enable()`
 * throws `EBADINPUT` on an empty array — so saving from this page answered 400
 * whenever the schedule was running and did nothing at all when it was not.
 * The profile select was fed from `scrapers.profiles`, a key `GET /api/scrapers`
 * does not publish, and was pre-selected from `status().profileId`, which is not
 * published either.
 *
 * Everything below is measured twice, on both sides of the wire: what the page
 * sends comes out of its own payload literal, what the route accepts comes out
 * of the handler's `body`, and what the page reads back is compared against a
 * `status()` that is executed rather than transcribed from the source. A census
 * that quotes the source on both sides agrees with itself even when the wire is
 * broken, which is exactly how this page shipped broken.
 *
 * The fifth test measures the one gap this file does not fix: two inputs the
 * whole backend has never read. They are pinned as exactly two, so the debt is
 * stated rather than rediscovered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, fieldReads, functionSource, objectEntries } from './helpers/code-only.mjs';
import { SchedulerService } from '../src/scheduler-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const settingsSource = readFileSync(new URL('../public/js/pages/settings.js', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router.mjs', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const settingsCode = codeOnly(settingsSource, true);

/** The scheduler POST handler, cut between two route keys that are themselves pinned. */
function schedulerHandler() {
  const from = routerSource.indexOf("'POST /api/scheduler':");
  const to = routerSource.indexOf("'GET /api/live':");
  assert.ok(from !== -1 && to > from, 'the scheduler route moved — this census is now pointing at nothing');
  // The slice begins at a route key, i.e. at a property of the route table —
  // a fragment that is not a program on its own and cannot be tokenized as
  // one. Re-seat it in the object literal it was cut out of.
  return codeOnly(`const __routes = {${routerSource.slice(from, to)}\n};`, true);
}

/** The profiles GET handler, bounded the same way. */
function profilesHandler() {
  const from = routerSource.indexOf("'GET /api/profiles':");
  const to = routerSource.indexOf("'GET /api/scheduler':");
  assert.ok(from !== -1 && to > from, 'the profiles route moved — this census is now pointing at nothing');
  return codeOnly(`const __routes = {${routerSource.slice(from, to)}\n};`, true);
}

test('the payload the Settings page posts is the payload the route forwards', () => {
  const keys = objectEntries(settingsSource, 'const payload = {').map((e) => e.key).sort();
  assert.deepEqual(keys, ['bookIds', 'enabled', 'intervalMinutes', 'scanOptions'],
    'the scheduler payload changed — the route has to be told about it, not handed a key it drops');
  assert.ok(!keys.includes('bookId'), 'the route takes bookIds, an array: bookId is a name nothing reads');
  assert.ok(!keys.includes('profileId'), 'no file under src/ reads profileId — a profile is applied, not stored');

  // The other half of the same wire: every key the page sends has to be read
  // off `body` by the handler, or the page is writing into a field that does
  // not exist and the value is gone before the service sees it.
  const route = schedulerHandler();
  const dropped = keys.filter((k) => !route.includes(`body.${k}`));
  assert.deepEqual(dropped, [], `the route never reads these off the body: ${dropped.join(', ')}`);
});

test('every key the page reads off the scheduler status is one the status publishes', async () => {
  // Executed, not quoted: a status() transcribed from the same source the page
  // is compared against would agree with it even while the real one publishes
  // something else — and the two keys this page did read, `bookId` and
  // `profileId`, are exactly the ones the real status has never carried.
  const dataDir = mkdtempSync(join(tmpdir(), 'arbiter-settings-'));
  try {
    const scheduler = new SchedulerService({
      dataDir,
      configPath: join(dataDir, 'scrapers.json'),
      orchestrator: { isRunning: () => false, launch: async () => ({}) },
      logger: () => {},
    });
    const published = Object.keys(await scheduler.status());
    const read = fieldReads(settingsCode, 's');
    assert.ok(read.length > 0, 'the receiver this census reads is not bound anywhere');
    const unpublished = read.filter((k) => !published.includes(k));
    assert.deepEqual(unpublished, [], `the status publishes none of these: ${unpublished.join(', ')}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the profile options come from the route that publishes profiles', () => {
  assert.ok(settingsCode.includes("'/api/profiles'"),
    'the page never asks for the profiles the backend publishes');
  assert.ok(!settingsCode.includes('scrapers.profiles'),
    'GET /api/scrapers publishes jobs and three counters, and no profiles key among them');
  assert.ok(profilesHandler().includes('profiles'), 'the profiles route no longer publishes profiles');
  // The profile list is labelled, not named: scan-profiles.json carries `label`
  // on every entry, and a select that asks for `name` renders the raw id.
  assert.ok(settingsCode.includes('label'), 'the profile select reads a field the profile documents do not carry');
});

test('the guard for a schedule with no book is a sentence both languages have', () => {
  assert.ok(settingsCode.includes('noBookmakersSelected'),
    'the page needs a message for the one case enable() refuses outright');
  const defined = (codeOnly(i18nSource, true).match(/^\s*noBookmakersSelected:/gm) || []).length;
  assert.equal(defined, 2, 'the key must exist in the Romanian dictionary and the English one');
});

test('the form inputs the whole backend never reads are pinned as exactly two', () => {
  // scanOptionsFromForm posts six keys; resolveScanRequest destructures its
  // input and returns nine, clamped. The difference is not empty: `maxStake`
  // and `maxAgeMinutes` were posted on every save and dropped on every save,
  // before this page was ever wired — their values never reached a scanner,
  // a store, or a clamp. Deleting those inputs means editing settings.html,
  // which is its own decision, so the debt is pinned here instead: exactly
  // these two may go unread, and either a third dead input or a backend that
  // starts reading one forces the pin to be restated out loud.
  const posted = [...functionSource(settingsCode, 'scanOptionsFromForm').text.matchAll(/\bout\.(\w+)\s*=/g)]
    .map((m) => m[1]).sort();
  const orchestrator = codeOnly(readFileSync(join(ROOT, 'src/scrape-orchestrator.mjs'), 'utf8'), true);
  const resolved = functionSource(orchestrator, 'resolveScanRequest').text;
  const destructure = resolved.slice(resolved.indexOf('const {'), resolved.indexOf('} = input'));
  const read = [...destructure.matchAll(/^\s{4}(\w+)[\s=,]/gm)].map((m) => m[1]);
  assert.ok(posted.length > 0 && read.length > 0, 'one side of this census read nothing');
  const unread = posted.filter((k) => !read.includes(k)).sort();
  assert.deepEqual(unread, ['maxAgeMinutes', 'maxStake'],
    'the posted-vs-read gap changed — restate the pinned pair, do not let it drift');

  // The same claim, one level wider: not just "this resolver drops them" but
  // "nothing under src/ has ever read either" — comments stripped first, so a
  // comment cannot be credited with a read (the hole that shipped once here
  // already, see helpers/code-only.mjs).
  const offenders = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.mjs'))
    .map((f) => join(f.parentPath, f.name))
    .filter((f) => /\b(maxStake|maxAgeMinutes)\b/.test(codeOnly(readFileSync(f, 'utf8'), true)));
  assert.deepEqual(offenders, [],
    'a pinned key gained a backend reader — move it out of the exception');
});
