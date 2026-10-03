/**
 * code-only.mjs — the one place a test decides "does this code read this
 * field", so it cannot decide it four different ways.
 *
 * The audit this repo keeps running asks the same shape of question in several
 * files: which fields of a payload does the page read, which names does the
 * loader write, which routes does the frontend call. Every answer was a regex
 * over raw source text, and a regex over raw source text cannot tell a read
 * from a mention. It is not a theoretical gap — it shipped. `selection.group`
 * is read by nobody in the whole frontend, and the only mention of it anywhere
 * is the word "group:" inside a comment in dashboard.js. A census that counts
 * comments credits a comment with a read, and the field it was built to find
 * reads clean.
 *
 * Three instruments had that hole (analytics-page twice, source-health-list,
 * and api-surface, fixed earlier). The fix is not four fixes: it is one
 * function, imported everywhere, so the next census written in this tree starts
 * from the honest version by default.
 *
 * `espree` is used because it is the tokenizer ESLint already runs over these
 * files. A hand-written scanner was tried first in api-surface and got a
 * backtick wrong, blanking the rest of a 700-line file from one line on — an
 * instrument that can be broken by ordinary code is not an instrument.
 */
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('espree');

/**
 * Parse as a module, else as a plain script.
 *
 * One place, because the two callers that need a tree must not disagree about
 * what "parseable" means — and `codeOnly` already answered that question for
 * itself, so this is its answer moved up rather than a second one.
 *
 * @param {string} src
 * @param {boolean} [isJs] false for HTML, where there is nothing to parse.
 * @returns {object} the parse tree
 */
function parseAny(src, isJs = true) {
  if (!isJs) throw new Error('there is no parse tree for a non-JS source');
  for (const sourceType of ['module', 'script']) {
    try {
      return parse(src, { ecmaVersion: 2023, sourceType, comment: true, range: true, loc: true });
    } catch { /* try the other source type */ }
  }
  throw new Error(`could not tokenize ${src.slice(0, 60).replace(/\n/g, ' ')}`);
}

/**
 * Depth-first walk that hands every node to `fn` with its ancestor chain.
 *
 * The chain is what lets a caller answer "what is this read guarded by" — the
 * guard is an ancestor's condition, not a neighbour in the text.
 *
 * @param {object} node
 * @param {(node: object, ancestors: object[]) => void} fn
 * @param {object[]} [ancestors]
 */
function visit(node, fn, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, fn, ancestors);
    return;
  }
  fn(node, ancestors);
  for (const [name, value] of Object.entries(node)) {
    // `loc` and `range` hold positions, not code, and `parent` would make the
    // walk circular if a tree ever carried links back up.
    if (name === 'loc' || name === 'range' || name === 'parent') continue;
    visit(value, fn, [...ancestors, node]);
  }
}

/**
 * Blank the ranges the tokenizer calls comments, keeping every offset.
 *
 * Offsets are preserved deliberately: only non-newline characters become
 * spaces, so `codeOnly(src).slice(a, b)` is the same region as `src.slice(a, b)`
 * and a caller that finds its bounds on the raw text can take the same bounds
 * here. Every extraction below depends on that, so it is asserted rather than
 * assumed.
 *
 * A file that tokenizes as neither a module nor a script throws instead of
 * falling back to raw text. Silently keeping the comments is exactly the false
 * pass this exists to remove, so an unparseable input is a loud failure.
 *
 * @param {string} src
 * @param {boolean} [isJs] false for HTML, where `<!-- -->` is the comment form.
 * @returns {string} the same text with comments blanked, same length.
 */
export function codeOnly(src, isJs = true) {
  if (!isJs) {
    const out = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n\r]/g, ' '));
    if (out.length !== src.length) throw new Error('HTML comment blanking changed the length');
    return out;
  }
  let comments = null;
  // Files under public/ are a mix of ES modules and plain scripts, so both
  // source types are tried before giving up.
  comments = parseAny(src, isJs).comments;
  const out = src.split('');
  for (const c of comments) {
    for (let i = c.range[0]; i < c.range[1]; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  }
  const text = out.join('');
  if (text.length !== src.length) throw new Error('comment blanking changed the length');
  return text;
}

/**
 * Field names read off one receiver, from text that is already blanked.
 *
 * The receiver is boundary-anchored on purpose. `source.includes('b.odds')` is
 * satisfied by `db.odds` and `tb.odds` — and `analytics.js` really does have a
 * `tb`, the table body element — so the looser form credits a read on an object
 * that is not the one being asked about, and a field can look read for a reason
 * unrelated to the page reading it.
 *
 * @param {string} text source or already-blanked source
 * @param {string} receiver a plain identifier
 * @returns {string[]} unique, sorted
 */
export function fieldsOn(text, receiver) {
  if (!/^\w+$/.test(receiver)) throw new Error(`receiver must be an identifier, got ${receiver}`);
  return [...new Set([...text.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();
}

/**
 * Field names one receiver reads, comments already excluded.
 *
 * @param {string} src whole source file
 * @param {string} receiver
 * @param {boolean} [isJs]
 * @returns {string[]}
 */
export function fieldReads(src, receiver, isJs = true) {
  return fieldsOn(codeOnly(src, isJs), receiver);
}

/**
 * Property reads off one or more receivers, each with the guard in front of it.
 *
 * `fieldReads` answers WHICH names a file reads. It cannot answer whether the
 * read is safe, and the answer to that is not a matter of taste: `window.
 * arbiterFormat.fmtOdds(n)` throws a TypeError on a page that never loaded
 * format.js, while `window.arbiterFormat?.fmtOdds(n)` cannot. A census that
 * counts both as "reads arbiterFormat" reports the same number either way.
 *
 * Four shapes of guard are distinguished, because they are not equally strong —
 * and they are not even a ranking, which is why they are not reported as one:
 *
 *   guard=key       the condition names the same key — `if (window.arbiterFormat
 *                   && window.arbiterFormat.fmtOdds) { … window.arbiterFormat
 *                   .fmtOdds(n) }`. Safe against a missing object AND a missing
 *                   key, because the condition short-circuits on the receiver
 *                   before it reads the key.
 *   guard=receiver  the condition names only the object — `window.arbiterFormat
 *                   && window.arbiterFormat.fmtOdds(n)`. Enough to survive a
 *                   missing object, NOT enough to survive a missing key, which
 *                   is the case that matters for a key only one of two files
 *                   defines.
 *   guard=none      nothing stands in front of it.
 *   optional=true   the read goes through `?.`, which short-circuits, so it
 *                   cannot throw whatever the receiver holds.
 *
 * `optional` is a flag and not a fourth level because it is not on the same
 * scale: a read can be both optional-chained and condition-guarded, and neither
 * one implies the other. Collapsing them into one "strength" was wrong in a way
 * a mutation caught here — `receiver` overwrote `optional` on dashboard.js:228,
 * which would have turned "cannot throw" into "throws if the key is missing".
 * Two facts, or the second one lies about the first.
 *
 * The guard is decided by walking the parse tree, and each read is scored from
 * the outermost condition that covers it. Three versions of this existed in the
 * tree first, all built on "look N characters to the left of the match", and all
 * three got the same family of reads wrong: a guard sitting in the condition of
 * an enclosing `if` while the call sits after the closing paren
 * (`if (f && f.key) return f.key(x)`), or two lines below inside the block that
 * `if` opened. A character window cannot see either, so it reports them bare. It
 * also cannot see `?.`, which is why a regex over this same tree found 18 reads
 * where the tree has 22 — the four it missed are exactly the optional-chained
 * ones, and an instrument whose misses are all the interesting cases is the
 * failure this repo keeps re-making.
 *
 * Receivers are dotted paths compared against the source text of the member
 * expression's object, so an alias counts: `helpers.arbiterFormat` is the same
 * object as `window.arbiterFormat` on the pages that wire it up, and a read
 * through it is a read of the real one.
 *
 * @param {string} src whole source file
 * @param {string[]} [receivers] dotted receiver names
 * @param {boolean} [isJs]
 * @returns {{key: string, line: number, guard: 'key'|'receiver'|'none', optional: boolean, text: string}[]}
 */
export function guardedPropertyReads(src, receivers = ['window.arbiterFormat'], isJs = true) {
  for (const r of receivers) {
    if (!/^[\w$.]+$/.test(r)) throw new Error(`receiver must be a dotted identifier, got ${r}`);
  }
  const ast = parseAny(src, isJs);

  const membersIn = (node) => {
    const found = [];
    visit(node, (n) => {
      if (n.type !== 'MemberExpression') return;
      if (!receivers.includes(src.slice(n.object.range[0], n.object.range[1]))) return;
      const key = n.computed
        ? (n.property.type === 'Literal' ? n.property.value : null)
        : n.property.name;
      if (typeof key === 'string') found.push({ node: n, key });
    });
    return found;
  };

  /**
   * Whether a subtree tests the receiver itself.
   *
   * Matched on node text, not on shape: `window.arbiterFormat` on its own is a
   * MemberExpression whose object is `window`, so a receiver matcher written
   * like `membersIn` cannot see it — and that bare `x && x.key` form is the most
   * common guard in this tree. Reading it as "no guard at all" is the specific
   * mistake this function exists to stop.
   */
  const mentionsReceiver = (node) => {
    let seen = false;
    visit(node, (n) => {
      if (!seen && receivers.includes(src.slice(n.range[0], n.range[1]))) seen = true;
    });
    return seen;
  };

  /** True when `region` lexically contains `node`. */
  const inside = (node, region) =>
    Boolean(region) && typeof region === 'object' && region.range
    && region.range[0] <= node.range[0] && node.range[1] <= region.range[1];

  const reads = [];
  visit(ast, (n, ancestors) => {
    if (n.type !== 'MemberExpression') return;
    if (!receivers.includes(src.slice(n.object.range[0], n.object.range[1]))) return;
    const key = n.computed
      ? (n.property.type === 'Literal' ? n.property.value : null)
      : n.property.name;
    if (typeof key !== 'string') return;

    // The condition guard and the `?.` flag are decided independently: neither
    // one implies the other, and folding them into a single "strength" is what
    // let `receiver` overwrite `optional` here.
    let guard = 'none';
    for (const a of ancestors) {
      let condition = null;
      if (a.type === 'IfStatement' && inside(n, a.consequent)) condition = a.test;
      else if (a.type === 'ConditionalExpression' && inside(n, a.consequent)) condition = a.test;
      else if (a.type === 'LogicalExpression' && (a.operator === '&&' || a.operator === '||')
        && inside(n, a.right)) condition = a.left;
      if (!condition) continue;
      const tested = membersIn(condition);
      if (tested.some((m) => m.key === key)) { guard = 'key'; break; }
      if (tested.length || mentionsReceiver(condition)) guard = 'receiver';
    }
    reads.push({
      key,
      line: n.loc.start.line,
      guard,
      optional: Boolean(n.optional),
      text: (src.split('\n')[n.loc.start.line - 1] || '').trim(),
    });
  });
  return reads;
}

/**
 * The object literal a source file hands to `marker`, as entries with values.
 *
 * `marker` is a piece of the source that ends on the line opening the literal,
 * so the literal is LOCATED from text and then READ from the parse tree.
 * Locating it from text is unavoidable — a caller knows the name it is looking
 * for, not an offset — but everything after that is the parser's answer rather
 * than a counter's, because two hand-written versions of this got two different
 * things wrong and both wrongnesses showed up as a *clean* census:
 *
 *   - The LAST brace on the marker's line, not the first. common.js writes
 *     `Object.assign(Object.create(null), window.arbiterFormat || {}, { … })`,
 *     so the first brace belongs to that `|| {}` and slicing from it yields a
 *     body with no keys in it. The version that took the first brace reported
 *     common.js as defining nothing — the one answer a census of this shape
 *     exists to rule out.
 *   - Keys at their own nesting level only. A line scan counted the `if (` that
 *     opens a method body as a key, putting a key named `if` on format.js's
 *     list, which would have let a call to `arbiterFormat.if(…)` pass as a
 *     known key. Nesting is the parser's job, and asking a brace counter for
 *     it is how that key got there.
 *
 * `literal` is the fact a field excuse needs. `{ ok: true }` publishes a
 * constant, and a constant nobody reads is not a lost feature — it is a
 * deliberate one. `{ ok: probe() }` is a signal the page may be ignoring, and
 * that is a defect. The two need different sentences, and a census reporting
 * only the key name cannot tell them apart.
 *
 * @param {string} src whole source file
 * @param {string} marker text ending on the line that opens the literal
 * @param {boolean} [isJs]
 * @returns {{key: string, value: string, literal: boolean}[]} in source order
 */
export function objectEntries(src, marker, isJs = true) {
  const text = codeOnly(src, isJs);
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`${marker} is no longer in the source`);
  const lineEnd = text.indexOf('\n', at);
  const braceAt = lineEnd === -1 ? text.length : text.lastIndexOf('{', lineEnd);
  if (braceAt === -1) throw new Error(`${marker} names no object literal on its line`);

  let found = null;
  visit(parseAny(text, isJs), (n) => {
    if (!found && n.type === 'ObjectExpression' && n.range[0] === braceAt) found = n;
  });
  if (!found) throw new Error(`no object literal opens at the brace ${marker} names`);
  return entriesOf(src, found);
}

/**
 * The properties of one object literal, in source order.
 *
 * Shared by the two instruments that read literals so that "which keys does this
 * object have" is answered by one piece of code. Two copies of this loop existed
 * for a few minutes while the second instrument was written; the thing they both
 * have to get right — that a spread, a computed key and a nested object are not
 * keys of the object being asked about — is exactly the kind of detail that goes
 * stale in a copy.
 *
 * @param {string} src
 * @param {object} found an ObjectExpression node
 * @returns {{key: string, value: string, literal: boolean}[]}
 */
function entriesOf(src, found) {
  const keyName = (p) => {
    if (p.key.type === 'Identifier') return p.key.name;
    if (p.key.type === 'Literal' && typeof p.key.value === 'string') return p.key.value;
    return null;
  };
  return found.properties.flatMap((p) => {
    if (p.type !== 'Property' || p.computed) return [];
    const key = keyName(p);
    if (key === null) return [];
    return [{
      key,
      value: src.slice(p.value.range[0], p.value.range[1]).trim(),
      literal: p.value.type === 'Literal',
    }];
  });
}

/**
 * Every object literal in a file that carries a given key, with all of its keys.
 *
 * `objectEntries` answers "which keys does THIS literal have", and a field
 * census needs the question one level up: "everywhere the producer writes this
 * key, what does it put beside it?" That is what turns a sentence like "`valid`
 * is true exactly when the status the page prints is `ok`" from a claim about
 * the code into a measurement of it — and it is what makes the sentence expire
 * instead of quietly becoming false when a producer starts pairing them
 * differently.
 *
 * Derived from the tree, like everything else here: nesting is the parser's
 * job, so the `valid: false` inside a method body is found on its own literal
 * rather than as a line of its own, and a commented-out `valid:` is not found at
 * all.
 *
 * @param {string} src whole source file
 * @param {string} key a plain key name
 * @param {boolean} [isJs]
 * @returns {{line: number, entries: {key: string, value: string, literal: boolean}[]}[]}
 */
export function objectsWithKey(src, key, isJs = true) {
  if (!/^\w+$/.test(key)) throw new Error(`key must be an identifier, got ${key}`);
  const out = [];
  visit(parseAny(src, isJs), (n) => {
    if (n.type !== 'ObjectExpression') return;
    const entries = entriesOf(src, n);
    if (!entries.some((e) => e.key === key)) return;
    out.push({ line: n.loc.start.line, entries });
  });
  return out;
}

/**
 * One named function, cut out of a source file, with the span it occupies.
 *
 * A census of a payload's reader has to ask about one function and not about the
 * file that happens to contain it. `run` is a common name: measured over
 * public/js/pages/scrape.js, twenty-two reads of `run.*` and `j.*` sit outside
 * `refreshLastRun`, every one of them on a different payload's jobs — so a
 * census that scanned the file would answer with the union of the two and report
 * fields as read that this route does not publish.
 *
 * The span comes back too, because a line number has to be one a human can go
 * and look at and the tree's own line numbers belong to the fragment: measured
 * while writing that test, `loc` from the extracted text said line 5 where the
 * file says 158.
 *
 * Sliced by the node's own range rather than by counting braces. A brace counter
 * does not know about a brace inside a string, a template literal or a regular
 * expression, and the hand-written scanner in api-surface that did it that way
 * blanked the rest of a 700-line file over one backtick.
 *
 * @param {string} src whole source file
 * @param {string} name the function's own name
 * @param {boolean} [isJs]
 * @returns {{text: string, line: number, endLine: number}}
 * @throws when no function declaration of that name is in the file — a census
 *   over an empty fragment reports every published field as unread, which is the
 *   one answer this instrument must not be able to give.
 */
export function functionSource(src, name, isJs = true) {
  if (!/^\w+$/.test(name)) throw new Error(`function name must be an identifier, got ${name}`);
  let found = null;
  visit(parseAny(src, isJs), (n) => {
    if (!found && n.type === 'FunctionDeclaration' && n.id && n.id.name === name) found = n;
  });
  if (!found) throw new Error(`no function declaration named ${name} is in this source`);
  return {
    text: src.slice(found.range[0], found.range[1]),
    line: found.loc.start.line,
    endLine: found.loc.end.line,
  };
}

/**
 * The keys of that literal, unique and sorted — what a caller wants when it is
 * asking only which names exist.
 *
 * @param {string} src
 * @param {string} marker
 * @param {boolean} [isJs]
 * @returns {string[]}
 */
export function objectKeys(src, marker, isJs = true) {
  return [...new Set(objectEntries(src, marker, isJs).map((e) => e.key))].sort();
}
