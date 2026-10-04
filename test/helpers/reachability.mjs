/**
 * reachability.mjs — which modules the running program can actually get to, and
 * which file each edge comes from.
 *
 * The question is reachability, not "does anybody import this". A module imported
 * only by another unreachable module is as dead as one nobody imports, and
 * counting importers answers a different and weaker thing. A census that counts
 * unreachable files as if they were live is worse than one that does not count
 * them at all: it reports a number, the number is read as a property of the
 * running system, and it is a property of the directory listing.
 *
 * Two forms of import are edges here, and the second one is not optional. A
 * first version of this reported `src/scanner/event-arbs.mjs` as having no
 * importer at all, because it read only the static form; `src/router.mjs` loads
 * it with `await import(…)`, on the route that serves event-detail arbitrage.
 * Comments are blanked through the same helper the rest of this tree uses, so a
 * path written in a docstring is not an edge either.
 *
 * The edge index is built once and both answers come from it. Two independent
 * scans of the same rule would be two chances to disagree, and a disagreement
 * between "nothing imports this" and "this is unreachable" is exactly the kind
 * of contradiction that gets read as a finding instead of as a bug in the
 * instrument.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** Every file under `dirs` that the instrument reads, repo-relative, slash-flashed. */
function filesUnder(dirs, exts) {
  const out = [];
  for (const dir of dirs) {
    const walk = (d) => {
      for (const entry of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (entry.isDirectory()) walk(`${d}/${entry.name}`);
        else if (exts.some((x) => entry.name.endsWith(x))) {
          out.push(`${d}/${entry.name}`.split(sep).join('/'));
        }
      }
    };
    walk(dir);
  }
  return out;
}

/**
 * The import edges out of every file under `dirs`, as `Map<file, Set<target>>`.
 *
 * `dirs` is plural and it matters: the set of resolvable targets has to span
 * every directory being scanned, or an edge leaving one is silently dropped. A
 * single-directory index answers the question wrongly and confidently — scanning
 * `scripts/` alone, `import … from '../src/tinyfish/client.mjs'` resolves to
 * nothing, so the importer disappears. That version was shipped into this file
 * and then caught by a measurement taken a second way: the first one found the
 * importer, the second found none, and the disagreement was the bug.
 *
 * And the target set is what is on disk, not what this scan happened to read.
 * Checking against the scanned list instead is the same bug wearing a hat: under
 * `dirs: ['scripts', 'test']` the target is still absent, because a src/ module is
 * not in either directory. Existence is asked of the filesystem, which is the only
 * place that knows.
 *
 * `asRepoPath` matters for the same reason: what `resolve` hands back is absolute
 * and, on Windows, separator-flipped. Comparing that against a repo-relative path
 * finds no edges at all and reports only the roots as reachable, which is how the
 * first version of this helper answered.
 */
function edgeIndex({ dirs, exts }) {
  const files = filesUnder(dirs, exts);
  const asRepoPath = (abs) => relative(ROOT, abs).split(sep).join('/');
  const resolveSpec = (spec, from) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(join(ROOT, dirname(from)), spec);
    for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')]) {
      const key = asRepoPath(cand);
      if (existsSync(join(ROOT, key))) return key;
    }
    return null;
  };

  const edges = new Map();
  for (const file of files) {
    const code = codeOnly(readFileSync(join(ROOT, file), 'utf8'), true);
    const set = new Set();
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of code.matchAll(pattern)) {
        const target = resolveSpec(m[1], file);
        if (target && target !== file) set.add(target);
      }
    }
    edges.set(file, set);
  }
  return edges;
}

/**
 * Every module `roots` can reach.
 *
 * @param {{ roots: string[], dirs?: string[], exts?: string[] }} options
 *   `roots` are repo-relative entrypoints, e.g. `['src/server.mjs']`.
 * @returns {Set<string>} repo-relative paths that were reached
 */
export function reachableModules({ roots, dirs = ['src'], exts = ['.mjs'] }) {
  const edges = edgeIndex({ dirs, exts });
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

/**
 * The files under `dirs` that import `target`.
 *
 * The other half of the same index, and the one that answers "why". A reachability
 * answer says a module is out of the program's hands; this says who reaches for it,
 * which is a different fact with different consequences. The TinyFish subsystem is
 * the case in point: it is unreachable from the server because no module the server
 * reaches imports it, not because a gate refuses it — a gate that refuses a
 * configuration never gets the chance to load anything, and saying otherwise
 * attributes the outcome to code that was never on the path. The cluster does import
 * itself, so a caller that wants "unreachable" has to intersect this with the
 * reachability answer rather than read emptiness here as a verdict.
 *
 * @param {string} target repo-relative path, e.g. `'src/tinyfish/client.mjs'`
 * @param {{ dirs?: string[], exts?: string[] }} [options]
 * @returns {Set<string>} repo-relative importers
 */
export function importersOf(target, { dirs = ['src'], exts = ['.mjs', '.js'] } = {}) {
  const out = new Set();
  for (const [file, targets] of edgeIndex({ dirs, exts })) {
    if (targets.has(target)) out.add(file);
  }
  return out;
}