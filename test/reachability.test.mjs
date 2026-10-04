/**
 * reachability.test.mjs — measurements of the instrument itself, and of what its
 * answers mean.
 *
 * `reachableModules` is used by another file to decide which error sites count as
 * evidence about the running program, so a defect in it does not fail here in an
 * obvious way: it hands its consumer a smaller program and every measurement built
 * on it still agrees with itself. These are the claims that hold whatever the
 * instrument's own idea of an edge is, checked by naming files whose reach can
 * only come from one of the two forms it reads.
 *
 * Nothing in here counts modules. Every number a census could report is a property
 * of the tree on the day it was taken; the claims below are identities (`this file
 * is reachable`, `this file is not`) and properties that either hold for every tree
 * or fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importersOf, reachableModules } from './helpers/reachability.mjs';

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
 * Not dead code, and not because a gate refuses them — that is the claim this list
 * replaced, and it was wrong. Nothing the server *reaches* imports any of them,
 * so the server never loads them; `src/scrapers/index.mjs` separately refuses any
 * *configuration* that names TinyFish, and a gate on configuration is not what keeps
 * a module out of a process. The cluster imports itself, so "no importer" would be
 * the wrong claim even as prose; what holds is that no live module reaches into it.
 * Each one still has importers outside src/, which is what makes them
 * reachable-from-somewhere rather than unused, and both halves of that are checked
 * below rather than asserted here.
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

/**
 * The modules the server reaches that are not under src/ at all.
 *
 * One, and it is not a mistake in the scan: `src/cron-service.mjs` imports
 * `runCleanup` from `../scripts/cleanup.mjs`, so a backend function lives in a
 * directory the rest of the tree reads as tooling. Naming it here is not a
 * complaint — an import edge is an import edge — but it is the kind of thing that
 * has to be written down, because "the server only uses src/" was an assumption
 * rather than a measurement, and the measurement says otherwise.
 */
const REACHED_OUTSIDE_SRC = new Set([
  'scripts/cleanup.mjs',
]);

test('reachability walks src/, and the answer is split', () => {
  const walked = srcModules();
  const reached = reachableModules({ roots: ['src/server.mjs'] });

  assert.ok(walked.length > 0 && reached.size > 0,
    `the walk read ${walked.length} modules and reachability reached ${reached.size} — `
    + 'a census read off an empty population describes nothing in either direction');
  assert.ok(reached.has('src/server.mjs'),
    'the entrypoint is missing from its own answer — the walk never started where it was told to');

  // Both directions, because a one-sided answer makes every count built on it
  // meaningless: "everything is reachable" is what a scan that found no edges at
  // all also says, and "nothing is reachable" is what a scan whose roots are not
  // resolvable also says.
  const dead = walked.filter((m) => !reached.has(m));
  assert.ok(dead.length > 0 && dead.length < walked.length,
    `the split is one-sided — ${dead.length} unreachable of ${walked.length} walked — so the answer cannot `
    + 'tell a scan that read edges from one that read none');
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

test('the unreachable set is the named one, and nothing under src/ imports it', () => {
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

  // The reason, which is not the one the list used to be introduced with. Each is
  // unreachable because nothing the server reaches imports it — the cluster does
  // import itself, which is why the test asks about reached importers and not about
  // importers: an internal edge cannot reach anything, and a new one from a live
  // module would change the outcome for a cause that has nothing to do with a gate.
  for (const m of UNREACHABLE_FROM_SERVER) {
    const live = [...importersOf(m, { dirs: ['src'], exts: ['.mjs'] })].filter((f) => reached.has(f));
    assert.deepEqual(live, [],
      `${m} is imported by ${live.join(', ')}, which the server reaches — so it is in the program, and `
      + 'listing it as unreachable would be naming a module the server loads');
  }

  // …and unreachable from the server is not the same claim as unused. Every one of
  // them is still imported from scripts/ or test/, which is what "closed subsystem"
  // means; a module with no importer anywhere would be a different, stronger thing
  // to say, and this is where the two get told apart.
  const unused = [...UNREACHABLE_FROM_SERVER]
    .filter((m) => importersOf(m, { dirs: ['scripts', 'test'], exts: ['.mjs', '.js'] }).size === 0);
  assert.deepEqual(unused, [],
    'these modules have no importer outside src/ either — that is a different claim from unreachable, '
    + 'and this is the check that tells the two apart instead of assuming they are the same');
});

test('the only thing reached outside src/ is the named one, and src/ really imports it', () => {
  const reached = reachableModules({ roots: ['src/server.mjs'] });
  const outside = [...reached].filter((r) => !r.startsWith('src/')).sort();

  assert.deepEqual(outside, [...REACHED_OUTSIDE_SRC].sort(),
    'the set of modules the server reaches outside src/ changed. One that appeared is a backend feature '
    + 'living outside the tree this test reads, and one that disappeared is a move nobody would notice.');
  assert.ok(REACHED_OUTSIDE_SRC.size > 0,
    'the named set is empty, so the comparison above would pass on an answer of "nothing" that says nothing');

  // Both halves for each entry, so the entry cannot be a coincidence. Being in the
  // reached set proves an edge exists; proving an importer exists under src/ says
  // where that edge starts. Only the second makes the name a description.
  for (const m of REACHED_OUTSIDE_SRC) {
    assert.ok(reached.has(m), `${m} is named as reached but the answer does not contain it`);
    const inside = [...importersOf(m, { dirs: ['src'], exts: ['.mjs'] })];
    assert.ok(inside.length > 0,
      `${m} is named as reached but nothing under src/ imports it — the entry would describe a coincidence `
      + 'rather than a connection');
  }
});