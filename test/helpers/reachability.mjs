/**
 * reachability.mjs — which modules under a directory the running program can
 * actually get to, from an entrypoint.
 *
 * The question is reachability, not "does anybody import this". A module
 * imported only by another unreachable module is as dead as one nobody imports,
 * and counting importers answers a different and weaker thing. A census that
 * counts unreachable files as if they were live is worse than one that does not
 * count them at all: it reports a number, the number is read as a property of
 * the running system, and it is a property of the directory listing.
 *
 * Two forms of import are edges here, and the second one is not optional. A
 * first version of this reported `src/scanner/event-arbs.mjs` as having no
 * importer at all, because it read only the static form; `src/router.mjs` loads
 * it with `await import(…)`, on the route that serves event-detail arbitrage.
 * Comments are blanked through the same helper the rest of this tree uses, so a
 * path written in a docstring is not an edge either.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './code-only.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Static `from '…'` and dynamic `import('…')`.
 *
 * A third form — the bare `import '…'`, which loads a module for its side effects
 * and names none of its exports — was in here and has been removed. Measured over
 * src/, that form carries no edge at all: not one module under src/ is loaded that
 * way. It could therefore not change any answer, and it could not be caught not
 * changing one either, which is the condition for taking it out rather than
 * leaving it: a form nothing reaches is a form that reads like coverage and is
 * not. If a side-effect import appears, the honest move is to add it back with a
 * test that fails without it, not to have kept it on faith.
 */
const IMPORT_PATTERNS = [
  /(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Every module under `dir` that `roots` can reach.
 *
 * @param {{ roots: string[], dir?: string, exts?: string[] }} options
 *   `roots` are repo-relative entrypoints, e.g. `['src/server.mjs']`.
 * @returns {Set<string>} repo-relative paths that were reached
 */
export function reachableModules({ roots, dir = 'src', exts = ['.mjs'] }) {
  const modules = [];
  const walk = (d) => {
    for (const entry of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const next = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (exts.some((x) => entry.name.endsWith(x))) modules.push(next);
    }
  };
  walk(dir);

  const known = new Set(modules);
  // `known` holds repo-relative paths with forward slashes, because that is how
  // the walk built them. What `resolve` hands back is absolute and, on Windows,
  // separator-flipped — comparing the two directly finds no edges at all and
  // reports only the roots as reachable, which is how the first version of this
  // helper answered.
  const asRepoPath = (abs) => relative(ROOT, abs).split(sep).join('/');
  const resolveSpec = (spec, from) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(join(ROOT, dirname(from)), spec);
    for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')]) {
      const key = asRepoPath(cand);
      if (known.has(key)) return key;
    }
    return null;
  };

  const edges = new Map();
  for (const mod of modules) {
    const code = codeOnly(readFileSync(join(ROOT, mod), 'utf8'), true);
    const set = new Set();
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of code.matchAll(pattern)) {
        const target = resolveSpec(m[1], mod);
        if (target && target !== mod) set.add(target);
      }
    }
    edges.set(mod, set);
  }

  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.pop();
    if (reached.has(cur)) continue;
    reached.add(cur);
    for (const next of edges.get(cur) ?? []) if (!reached.has(next)) queue.push(next);
  }
  return reached;
}