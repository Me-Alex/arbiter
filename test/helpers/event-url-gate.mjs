// test/helpers/event-url-gate.mjs — the browseable-event-URL gate, loaded from
// the one file that ships it.
//
// The gate used to exist twice. `src/shared/event-url.mjs` called itself the
// single source of truth and the modal kept a copy with the instruction "keep
// this copy in sync with that file". Nothing measured that instruction, and the
// copy is what the browser actually loads — `src/shared/` is server-side code the
// page never fetches, so a rule added there changed nothing a bettor could see.
// Worse, the file's docstring claimed the denylist made "scrapers, the modal,
// and tests all agree". Not one scraper referenced it: `grep isEventUrl src/`
// answered with the definition alone. Two lists, one comment tying them
// together, and no way for either test suite to see a divergence.
//
// Three test files answered this the same way — by reading whichever copy was
// convenient — so each was pinned to its own and none compared them. The
// divergence those comments were reasoning about was live in the tree the whole
// time; what was missing was the comparison, not the copy.
//
// There is now one definition, in the file the page loads, and this helper is
// how the tests reach it. `definitionsInShippedTree()` is the measurement that
// keeps it one: a second denylist or a second predicate anywhere in the shipped
// tree is now a failure rather than a comment.

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { extractFn } from './extract-fn.mjs';

export const ROOT = join(import.meta.dirname, '..', '..');

/** The shipped copy, and the only one. */
export const GATE_FILE = 'public/js/pages/event-detail-modal.js';

/**
 * Directories whose contents run in the product. `test/` is deliberately out of
 * scope: this is a census of what ships, and a test quoting the denylist is not
 * a second gate — it cannot render a link. Keeping the boundary here is what
 * stops the census from being made to pass by widening or narrowing its own
 * search.
 */
const SHIPPED_ROOTS = ['src', 'public', 'electron', 'scripts'];

const EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);

const modalSrc = readFileSync(join(ROOT, GATE_FILE), 'utf8');

/**
 * Slice the denylist declaration out of the modal.
 *
 * Bracket counting, not `indexOf('];')`: the closing bracket of the literal and
 * the semicolon after it are both found by walking depth, so a pattern whose
 * text contains `]` cannot end the slice early and silently hand the caller a
 * truncated denylist. The regexes in this list contain no `[` or `]` of their
 * own, which is the same limitation `extract-fn.mjs` documents for braces.
 * A plain `throw` — this runs during module setup, and an extraction that
 * yielded nothing would hand the caller a gate that passes every URL, which is
 * exactly the reading the tests using it would report as a finding.
 */
function sliceDenylist(src) {
  const from = src.indexOf('const API_URL_PATTERNS = [');
  if (from === -1) throw new Error(`${GATE_FILE} no longer declares API_URL_PATTERNS`);
  const open = src.indexOf('[', from);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        const semi = src.indexOf(';', i);
        if (semi === -1) throw new Error(`${GATE_FILE} declares API_URL_PATTERNS without ending it`);
        return src.slice(from, semi + 1);
      }
    }
  }
  throw new Error(`${GATE_FILE} declares API_URL_PATTERNS but never closes the list`);
}

/** The denylist as written, for tests that need to wrap it lexically. */
export const patternsSrc = sliceDenylist(modalSrc);

/** The predicate as written, for tests that need to wrap it lexically. */
export const fnSrc = extractFn('isEventUrl', modalSrc);

// One compile, shared by every importer: `patternsSrc` and `fnSrc` are the two
// halves the modal closes over, and the predicate cannot be evaluated alone —
// it reads API_URL_PATTERNS.
const compiled = new Function(
  `${patternsSrc}\n${fnSrc}\nreturn { API_URL_PATTERNS, isEventUrl };`,
)();

/** The live denylist, as RegExp objects. */
export const API_URL_PATTERNS = compiled.API_URL_PATTERNS;

/** The live gate, from the file the page loads. */
export const isEventUrl = compiled.isEventUrl;

// A declaration is counted on its line, so a re-introduced copy is named by file
// and line in the failure rather than as a bare count.
const DECLARATIONS = [
  { kind: 'denylist', re: /(?:export\s+)?(?:const|let|var)\s+API_URL_PATTERNS\s*=/ },
  { kind: 'predicate', re: /(?:export\s+)?function\s+isEventUrl\s*\(/ },
];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Every declaration of the gate in the shipped tree.
 *
 * `byRoot` travels with the result on purpose. A walk that hit a renamed
 * directory returns no declarations, and no declarations is the reading under
 * which "there is exactly one" holds trivially. Counting per root lets a caller
 * see that the search reached all four directories rather than trusting a total
 * it cannot check the provenance of — and lets it notice a root that was dropped
 * from `SHIPPED_ROOTS`, which is the shape a narrowed search takes.
 *
 * @returns {{ filesScanned: number, byRoot: Record<string, number>, defs: Array<{file:string,line:number,kind:string,text:string}> }}
 */
export function definitionsInShippedTree() {
  const byRoot = {};
  const files = [];
  for (const root of SHIPPED_ROOTS) {
    const found = collect(join(ROOT, root));
    byRoot[root] = found.length;
    files.push(...found);
  }
  const defs = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      for (const { kind, re } of DECLARATIONS) {
        if (re.test(line)) {
          defs.push({
            file: relative(ROOT, file).split(sep).join('/'),
            line: index + 1,
            kind,
            text: line.trim(),
          });
        }
      }
    }
  }
  return { filesScanned: files.length, byRoot, defs };
}
