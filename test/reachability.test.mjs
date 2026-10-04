/**
 * reachability.test.mjs — measurements of the instrument itself.
 *
 * `reachableModules` is used by another file to decide which error sites count
 * as evidence about the running program, so a defect in it does not fail here in
 * an obvious way: it hands its consumer a smaller program and every measurement
 * built on it still agrees with itself. These are the claims that hold whatever
 * the instrument's own idea of an edge is, checked by naming files whose reach
 * can only come from one of the two forms it reads.
 *
 * Nothing in here counts modules. Every number a census could report is a
 * property of the tree on the day it was taken; the claims below are identities
 * (`this file is reachable`, `this file is not) and properties that either hold
 * for every tree or fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachableModules } from './helpers/reachability.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Every `.mjs` under src/, repo-relative and forward-slashed.
 *
 * The slash convention is not cosmetic: it is how `reachableModules` keys its own
 * answer, and a list built with the platform separator matches nothing on Windows.
 * That is not hypothetical — a first attempt at this file reported all but one
 * module unreachable, the entrypoint included, because it compared a `\`-joined
 * list against a `/`-joined set and read the result as a finding.
 */
function srcModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.mjs')) out.push(relative(ROOT, join(ROOT, dir, entry.name)).split(sep).join('/'));
    }
  };
  walk('src');
  return out;
}

/**
 * The modules `src/server.mjs` cannot reach.
 *
 * Not dead code: the TinyFish subsystem, which `src/scrapers/index.mjs` refuses on
 * sight for any configuration naming it. It is named rather than counted because
 * the claim is a set identity — a module that appears here is a module the
 * running server does not load, and one that stops appearing is a module it now
 * does, which is a change in what ships and not in what a test counts.
 */
const UNREACHABLE_FROM_SERVER = new Set([
  'src/scrapers/tinyfish-scraper.mjs',
  'src/tinyfish/books.mjs',
  'src/tinyfish/browser-discovery.mjs',
  'src/tinyfish/client.mjs',
  'src/tinyfish/discovery.mjs',
  'src/tinyfish/extract.mjs',
  'src/tinyfish/normalize.mjs',
]);

test('reachability walks src/, and answers about what it walked', () => {
  const walked = srcModules();
  const reached = reachableModules({ roots: ['src/server.mjs'] });

  assert.ok(walked.length > 0 && reached.size > 0,
    `the walk read ${walked.length} modules and reachability reached ${reached.size} — `
    + 'a census read off an empty population describes nothing in either direction');
  assert.deepEqual([...reached].filter((r) => !walked.includes(r)), [],
    'reachability returned a path the walk never produced, so the two are not describing one population');
  assert.ok(reached.has('src/server.mjs'),
    'the entrypoint is missing from its own answer — the walk never started where it was told to');

  // Both directions, because a one-sided answer makes every count built on it
  // meaningless: "everything is reachable" is what a scan that found no edges at
  // all also says, and "nothing is reachable" is what a scan whose roots are not
  // in the walked directory also says.
  const dead = walked.filter((m) => !reached.has(m));
  assert.ok(reached.size > 0 && dead.length > 0,
    `the answer is one-sided — ${reached.size} reached, ${dead.length} unreachable — so it cannot tell `
    + 'a scan that read edges from one that read none');
});

test('each edge form the instrument reads is the only route to something', () => {
  const reached = reachableModules({ roots: ['src/server.mjs'] });

  // The dynamic form. `src/router.mjs` loads this one with `await import(…)` on the
  // event-detail arbitrage route, and no other module under src/ names it. The
  // first version of the instrument read only the static form and answered that
  // this file had no importer at all, which is how a live route came to look dead.
  assert.ok(reached.has('src/scanner/event-arbs.mjs'),
    'src/scanner/event-arbs.mjs is unreachable — the dynamic `import(…)` edge form is not being read, '
    + 'and this module is reachable no other way');

  // The static form, on a shared module whose edges are all plain `from '…'`.
  assert.ok(reached.has('src/shared/rate-limit.mjs'),
    'src/shared/rate-limit.mjs is unreachable — the static `from \'…\'` edge form is not being read');
});

test('the unreachable set is the named one, and the named set is still about something', () => {
  const walked = srcModules();
  const reached = reachableModules({ roots: ['src/server.mjs'] });
  const dead = walked.filter((m) => !reached.has(m)).sort();

  assert.deepEqual(dead, [...UNREACHABLE_FROM_SERVER].sort(),
    'the set of modules the server cannot reach changed. One that appeared is a module nothing loads; '
    + 'one that disappeared is a module the running server now loads, which is a change in what ships.');

  // The named set is evidence, so it has to still be about something: an entry
  // naming a file that has left the tree would keep the paragraph above looking
  // corroborated by a module that does not exist.
  const ghosts = [...UNREACHABLE_FROM_SERVER].filter((m) => !walked.includes(m));
  assert.deepEqual(ghosts, [],
    'these entries name a module that is not under src/ any more, so the list corroborates nothing');
  assert.ok(UNREACHABLE_FROM_SERVER.size > 0,
    'the named set is empty — the unreachable modules would be described as none, which is not what this says');
});