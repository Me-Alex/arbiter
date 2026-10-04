/**
 * export-use.test.mjs — every export the server loads has a user.
 *
 * `test/reachability.test.mjs` answers whether a module is in the program and
 * `test/export-readers.test.mjs` asks the same of one registry. This is the
 * question over the whole reached set: of every name every loaded module exports,
 * is anyone using it?
 *
 * Two ways to count as used, and the difference is the whole point. A production
 * file mentions it — the case this axis is about. Or its own module does, which
 * means the code is live and only the `export` keyword is unasked-for; counting
 * that as unused would have named six working functions of scripts/cleanup.mjs as
 * dead. A test file mentioning it is neither: that is a function whose only reader
 * is the test that exercises it, and eight of those were found and removed.
 *
 * Nothing here is a count. The population moves as the tree moves; the claim is an
 * identity plus a named exception, so what fails is a name nothing uses, not a
 * number that drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachableModules } from './helpers/reachability.mjs';
import { useCensus } from './helpers/export-readers.mjs';

const PROD_DIRS = ['src', 'electron', 'scripts', 'public'];

const reached = () => [...reachableModules({ roots: ['src/server.mjs'] })].sort();
const census = () => useCensus(reached(), { prodDirs: PROD_DIRS });

/**
 * Exports no production file reads and no code in their own module calls.
 *
 * One entry. `ALL_SCRAPERS` is `Object.keys(DIRECT)` — the registry the server
 * routes on, re-exported for callers that want to iterate it rather than look one
 * job up. test/export-readers.test.mjs carries the reasons and checks them
 * mechanically (that it is a non-empty array, and that tests really do read it), so
 * this list is a pointer, not the argument.
 */
const USED_BY_NOBODY = new Map([
  ['src/scrapers/index.mjs', 'ALL_SCRAPERS'],
]);

const label = (r) => `${r.module}  ${r.name}`;

test('every export of every loaded module is read by production code or used by its own module', () => {
  const rows = census();

  assert.ok(rows.length > 0, 'the scan read no exports at all, so the comparison below would pass on nothing');
  assert.ok(rows.some((r) => r.prod.length > 0),
    'no export in the whole program has a production reader — the scan is not reading the production tree');
  assert.ok(rows.some((r) => r.uses.length > 0),
    'no export is used by its own module either, so the two ways of counting as used have both come back empty');

  const unused = rows.filter((r) => r.prod.length === 0 && r.uses.length === 0)
    .map(label).sort();
  const named = [...USED_BY_NOBODY].map(([module, name]) => `${module}  ${name}`).sort();
  assert.deepEqual(unused, named,
    'an export appeared that nobody reads and nothing calls. That is backend surface with no consumer: '
    + 'wire it to a caller, or delete it and this line with it. A name that left this list without a reader '
    + 'is the same fault in the other direction.');
});

test('the own-use reading really drops the declaring line', () => {
  const rows = census();

  // Every export is declared on exactly one line, so its own mentions are that
  // line plus its uses. A reading that forgot to drop the declaration would report
  // every export as used by its own module, and the test above would go green on
  // a census that finds nothing unused because it counts a function as evidence
  // that it is called.
  const off = rows.filter((r) => r.mentions.length - r.uses.length !== 1).map(label);
  assert.deepEqual(off, [],
    'these exports are not declared on exactly one line, so the declaration is not being counted the way '
    + 'the own-use reading assumes');
});

test('the production scan reaches past src/', () => {
  const rows = census();

  // Narrows silently: a shorter PROD_DIRS changes nothing about the answer above,
  // because the one unused export has no reader in any directory. So the claim is
  // checked where it would show up — a reader the wide scan found and a narrow one
  // cannot.
  assert.ok(rows.some((r) => r.prod.some((hit) => !hit.startsWith('src/'))),
    'every production reader in this census is under src/, so the scan is narrower than the production tree '
    + 'and a reader elsewhere would be invisible here');
});