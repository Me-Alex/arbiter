/**
 * export-readers.test.mjs — backend surface with no consumer, named.
 *
 * Reachability answers whether a module is in the program. It says nothing about
 * the names that module exports: a reachable module can carry functions and
 * constants that no production code mentions, and those are questions the axis
 * this file serves has to be able to answer. One was found this way and removed —
 * `isKnownJob` from the scraper registry, which had no production reader and one
 * branch that answered "known" for an id the registry refuses to build.
 *
 * The reading is the weaker half of the claim, and that is stated rather than
 * hidden: a whole-word identifier match over reports, because a name can appear as
 * an object key. What it never under-reports is a reader that exists, so a false
 * "nothing reads this" would need the scan to miss a real mention, and the census
 * instruments below are what that would have to get wrong.
 *
 * The other half is the population itself. A census built by reading declarations
 * can quietly stop reading one form and answer with a smaller, greener list, so
 * the last test checks the result against a mechanism that does not share its
 * regexes: the names the production tree imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportCensus, importedNames, sourceFiles } from './helpers/export-readers.mjs';

const REGISTRY = 'src/scrapers/index.mjs';

/** Where production code for the server lives, beyond `src/`. */
const PROD_DIRS = ['src', 'electron', 'scripts', 'public'];

/**
 * The registry's exports that no file under src/, electron/, scripts/ or public/
 * mentions.
 *
 * `ALL_SCRAPERS` is here because it is a derived list of a registry that does have
 * production readers, not an unreachable feature: `DIRECT` is what the server
 * routes on, and this is the same key set named for consumers that want to iterate
 * it. The tests that read it use it as the population for their own checks, which
 * is a real use and a different thing from a code path nothing takes. Both halves
 * of that are verified below rather than left as prose: it is non-empty as a list,
 * and the tests do read it.
 */
const EXPORT_WITHOUT_PRODUCTION_READER = new Set([
  'ALL_SCRAPERS',
]);

const census = () => exportCensus(REGISTRY, { prodDirs: PROD_DIRS });

test('every export of the scraper registry is either read in production or named as unclaimed', () => {
  const rows = census();

  assert.ok(rows.length > 0,
    'the scan found no exports in the registry, so the comparison below would pass on an empty population');
  assert.ok(rows.some((r) => r.prod.length > 0),
    'no export of the registry has a production reader at all — the scan is not reading the production tree, '
    + 'and the "unclaimed" set would describe everything');

  const unclaimed = rows.filter((r) => r.prod.length === 0).map((r) => r.name).sort();
  assert.deepEqual(unclaimed, [...EXPORT_WITHOUT_PRODUCTION_READER].sort(),
    'the set of registry exports nothing in production reads changed. One that appeared is backend surface with '
    + 'no consumer — either wire it up or say here why it stands. One that disappeared is a move nobody was '
    + 'told about.');

  // The named set is evidence, so it has to still be about something: an entry
  // naming an export that is gone keeps the list looking corroborated by nothing.
  const ghosts = [...EXPORT_WITHOUT_PRODUCTION_READER]
    .filter((name) => !rows.some((r) => r.name === name));
  assert.deepEqual(ghosts, [],
    'these entries name an export the registry no longer has, so the list corroborates nothing');
  assert.ok(EXPORT_WITHOUT_PRODUCTION_READER.size > 0,
    'the named set is empty, which would say "nothing is unclaimed" without having checked that anything is read');
});

test('the one unclaimed export is a value the tests really iterate', async () => {
  const { ALL_SCRAPERS } = await import('../src/scrapers/index.mjs');

  assert.ok(Array.isArray(ALL_SCRAPERS) && ALL_SCRAPERS.length > 0,
    'ALL_SCRAPERS is not a non-empty array — the "derived list of a registry that does have readers" claim is gone');
  const reads = census().find((r) => r.name === 'ALL_SCRAPERS');
  assert.ok(reads.test.length > 0,
    'no test reads ALL_SCRAPERS any more, so it is neither a production path nor a measuring instrument, '
    + 'and the entry in the list above has lost its reason');
});

test('the census is not narrower than the production surface it names', () => {
  const rows = census();
  const found = new Set(rows.map((r) => r.name));

  // Names production asks for, read from import clauses. A census that lost a
  // declaration form drops rows here rather than turning red on its own.
  const imported = importedNames(REGISTRY, sourceFiles(PROD_DIRS));
  assert.ok(imported.length > 0,
    'no production file imports from the registry, so the coverage check below would pass on an empty list');
  assert.deepEqual(imported.filter((name) => !found.has(name)), [],
    'production imports these names from the registry and the census has no row for them, so it is missing '
    + 'exports rather than reporting them as unclaimed');

  // And the directories themselves. The first of these two reads the tree, the
  // second reads the result: a name the tree has but the scan never walked is a
  // reader this census cannot see, which is the one direction it must not fail in.
  // Only the second can fall when the scan narrows — filtering the list by itself
  // is satisfied by any shorter list, including the one that dropped the files.
  const scanned = sourceFiles(PROD_DIRS);
  assert.deepEqual(PROD_DIRS.filter((d) => !scanned.some((f) => f.startsWith(`${d}/`))), [],
    'these production directories contributed no file to the scan, so the census is narrower than it reports');
  assert.ok(rows.some((r) => r.prod.some((hit) => !hit.startsWith('src/'))),
    'every production reader the census found is under src/, so the scan is not reaching the rest of the '
    + 'production tree — a reader there would be invisible and an export could be called unclaimed wrongly');
});