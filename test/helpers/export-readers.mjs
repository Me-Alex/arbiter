/**
 * export-readers.mjs — which exports of a module something in the running program
 * actually mentions.
 *
 * Importing a module is not reading an export. `src/scrapers/index.mjs` is
 * imported by the server, by five scripts and by eight test files, and none of
 * that says anything about any one name: a reachable module can carry exports that
 * no production code ever mentions. Those are the interesting ones, because they
 * are backend surface with no consumer, and that is a question no import census
 * answers.
 *
 * Reads as a whole-word identifier in code, comments blanked through the same
 * helper the rest of this tree uses, so a name written in a docstring is not a
 * reader. It over-reports in the other direction — an identifier can appear as an
 * object key or a bare word — so every hit is reported with its file and line for
 * reading rather than counted into a verdict.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './code-only.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Source files under `dirs`, repo-relative and forward-slashed. */
function walk(dirs, exts) {
  const out = [];
  let walkDir;
  try {
    walkDir = (d) => {
      for (const entry of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (entry.isDirectory()) walkDir(`${d}/${entry.name}`);
        else if (exts.some((x) => entry.name.endsWith(x))) out.push(`${d}/${entry.name}`.split(sep).join('/'));
      }
    };
    for (const d of dirs) walkDir(d);
  } catch {
    return [];
  }
  return out;
}

/**
 * The source files under `dirs` this tree would read.
 *
 * Public because a census of readers says nothing about which files were read, and
 * a list of production directories that quietly contributes one of them is a
 * scanned surface narrower than the one the census talks about.
 *
 * @param {string[]} dirs repo-relative directories
 * @param {string[]} [exts] file suffixes to include
 * @returns {string[]}
 */
export function sourceFiles(dirs, exts = ['.mjs', '.js']) {
  return walk(dirs, exts);
}

const blanked = new Map();
function codeOf(rel) {
  if (!blanked.has(rel)) {
    blanked.set(rel, codeOnly(readFileSync(join(ROOT, rel), 'utf8'), true));
  }
  return blanked.get(rel);
}
function linesOf(rel) {
  return codeOf(rel).split('\n');
}

/**
 * The names `rel` exports.
 *
 * Four forms are read: a named declaration, a list, and — because a name can be
 * exported under a different one — the part after `as` in either. Which of them a
 * given module uses is not something this helper can afford to depend on, because
 * a form it stopped reading would drop names from the census with no other trace.
 * `importedNames` below exists so the test file can check the result against a
 * different mechanism.
 */
export function exportedNames(rel) {
  const names = new Set();
  for (const line of linesOf(rel)) {
    for (const m of line.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(m[1]);
    }
    for (const m of line.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/**
 * Where `name` is mentioned, as `file:line`, outside the module that exports it.
 *
 * @param {string} name the exported identifier
 * @param {string[]} files repo-relative paths to search
 * @param {string} [exclude] a path whose own mentions are the export, not a read
 * @returns {string[]} hits, in scan order
 */
export function readersOf(name, files, exclude) {
  const re = new RegExp(`\\b${name}\\b`);
  const out = [];
  for (const f of files) {
    if (f === exclude) continue;
    linesOf(f).forEach((line, i) => {
      if (re.test(line)) out.push(`${f}:${i + 1}`);
    });
  }
  return out;
}

/**
 * The export names `files` import from `rel`.
 *
 * A different mechanism from `exportedNames` on purpose, which is the only reason
 * it is worth having: it reads the import clause rather than the declaration, so a
 * name the census lost is a name production asks for and the census does not have.
 *
 * Only a named clause enumerates anything. A default or `* as ns` import reads
 * every export of the module, which says nothing about which, so it contributes
 * no name here rather than a wrong one.
 *
 * @param {string} rel repo-relative module, forward-slashed
 * @param {string[]} files repo-relative paths to search
 * @returns {string[]} the imported names, deduplicated, in first-seen order
 */
export function importedNames(rel, files) {
  const names = [];
  const wanted = rel.split(sep).join('/');
  const STATIC = /\bimport\s+([^;]*?)\s+from\s*(['"])([^'"]+)\2/g;
  for (const f of files) {
    if (f === rel) continue;
    const base = dirname(f);
    for (const m of codeOf(f).matchAll(STATIC)) {
      const target = resolve(ROOT, base, m[3]).split(sep).join('/').slice(ROOT.length + 1);
      if (target !== wanted) continue;
      const clause = m[1];
      const braces = clause.match(/\{([^}]*)\}/);
      if (!braces) continue;
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/**
 * Every export of `rel` with where it is read.
 *
 * @param {string} rel repo-relative module
 * @param {{ prodDirs?: string[], testDirs?: string[], exts?: string[] }} [options]
 * @returns {{ name: string, prod: string[], test: string[] }[]}
 */
export function exportCensus(rel, { prodDirs = ['src'], testDirs = ['test'], exts = ['.mjs', '.js'] } = {}) {
  const prod = sourceFiles(prodDirs, exts);
  const test = sourceFiles(testDirs, exts);
  return [...exportedNames(rel)].map((name) => ({
    name,
    prod: readersOf(name, prod, rel),
    test: readersOf(name, test),
  }));
}