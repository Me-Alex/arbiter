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

  /**
   * The receiver a member expression reads through, seeing past a fallback.
   *
   * `(scan.options || {}).liveMaxAgeMs` is a read of `scan.options` and of
   * nothing new, but its object is a LogicalExpression, so a matcher written on
   * the object's own text cannot see it. Without this, `options.liveMaxAgeMs`
   * — read by public/js/pages/scanner.js:286, on the one page whose whole job is
   * to show the window a scan applied — is reported as unread by a census being
   * run over that very page. The blindness is in the direction that invents a
   * gap, which is the direction a census must not be wrong in.
   *
   * The fallback is not scored as a guard: `x || {}` chooses what to read
   * *through*, and nothing stands between the read and a missing receiver, so
   * `guard: 'none'` below still describes it honestly.
   */
  const receiverText = (object) => {
    const text = src.slice(object.range[0], object.range[1]);
    if (receivers.includes(text)) return text;
    if (object.type === 'LogicalExpression' && (object.operator === '||' || object.operator === '??')) {
      const left = src.slice(object.left.range[0], object.left.range[1]);
      if (receivers.includes(left)) return left;
    }
    return null;
  };

  const membersIn = (node) => {
    const found = [];
    visit(node, (n) => {
      if (n.type !== 'MemberExpression') return;
      if (!receiverText(n.object)) return;
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
    if (!receiverText(n.object)) return;
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
 * Properties one receiver is ASSIGNED, with the operator it was assigned by.
 *
 * A census needs the other half of this: `guardedPropertyReads` answers which
 * keys a consumer reads, and a producer's published set is not the same question
 * — it is which keys get WRITTEN. Reads cannot stand in for it, and the reason
 * is not subtle. On `src/scrape-orchestrator.mjs` the read instrument answers
 * twenty-two member expressions on `this.scrapeState`, and eighteen of them are
 * assignments: `this.scrapeState.status = 'cancelling'` is a write that the read
 * instrument happily reports as a read. That direction happens to be harmless on
 * a page, where everything on the receiver is a read; on the producer it is the
 * whole census. A key the backend only ever READS — `this.scrapeState.runId ===
 * runId` in three guards — would be counted as published, and a field nobody
 * writes would be excused as if something did.
 *
 * The reverse blindness is the one that costs a field: a key that is written and
 * never read looks identical to a key that is only read, if you measure the
 * wrong one of the two.
 *
 * `==`, `===` and `!=` are not assignments and are not reported, which is the
 * whole reason this walks the tree: a regular expression for `\.\w+\s*=` cannot
 * tell `state.runId = x` from `state.runId === runId` without also forbidding
 * `==`, and the guards in this tree are full of the second form written with one
 * `=` of slack. `x?.y = ` is not valid syntax, so optional chaining never
 * reaches here, and a destructuring target (`({ runId } = next)`) is a pattern
 * rather than a member expression and is likewise not reported — a census that
 * wanted those has to say so.
 *
 * @param {string} src whole source file
 * @param {string[]} [receivers] dotted receiver names
 * @param {boolean} [isJs]
 * @returns {{key: string, line: number, op: string, text: string, value: string|null}[]}
 */
export function propertyWrites(src, receivers = ['window.arbiterFormat'], isJs = true) {
  for (const r of receivers) {
    if (!/^[\w$.]+$/.test(r)) throw new Error(`receiver must be a dotted identifier, got ${r}`);
  }
  const keyOf = (member) => (member.computed
    ? (member.property.type === 'Literal' ? member.property.value : null)
    : member.property.name);
  const writes = [];
  const take = (left, op, node) => {
    if (!left || left.type !== 'MemberExpression') return;
    if (!receivers.includes(src.slice(left.object.range[0], left.object.range[1]))) return;
    const key = keyOf(left);
    if (typeof key !== 'string') return;
    writes.push({
      key,
      line: node.loc.start.line,
      op,
      text: (src.split('\n')[node.loc.start.line - 1] || '').trim(),
      // The right-hand side as source text, so a caller asking "which values does
      // this key ever hold" reads them off the tree instead of pulling a quoted
      // run out of `text` with a regular expression — which is how a probe for
      // the scrape status vocabulary found four of seven and reported the rest
      // as unreachable. `null` for an update expression, which has no right-hand
      // side rather than an empty one.
      value: node.type === 'AssignmentExpression' ? src.slice(node.right.range[0], node.right.range[1]).trim() : null,
    });
  };
  visit(parseAny(src, isJs), (n) => {
    if (n.type === 'AssignmentExpression') take(n.left, n.operator, n);
    else if (n.type === 'UpdateExpression') take(n.argument, n.operator, n);
  });
  return writes;
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
 * A class method counts, and not because it is a nicety: asked for
 * `restoreState` on src/scrape-orchestrator.mjs, the version that matched
 * FunctionDeclaration only threw — and the method is right there, on line 40,
 * holding the one assignment that decides what a dead process leaves behind.
 * The throw is correct behaviour for a name that is absent and wrong for one
 * that is a method, and the caller cannot tell the two apart: both are "no
 * function declaration named X". A method is found by its key, computed keys
 * excluded, since `[name]() {}` has a name no identifier can be compared to.
 *
 * A declaration wins over a method of the same name, because that is the one a
 * caller naming a bare function almost always means, and the file is searched
 * for declarations before methods rather than taking whichever came first.
 *
 * @param {string} src whole source file
 * @param {string} name the function's own name
 * @param {boolean} [isJs]
 * @returns {{text: string, line: number, endLine: number}}
 * @throws when no function or method of that name is in the file — a census
 *   over an empty fragment reports every published field as unread, which is the
 *   one answer this instrument must not be able to give.
 */
export function functionSource(src, name, isJs = true) {
  if (!/^\w+$/.test(name)) throw new Error(`function name must be an identifier, got ${name}`);
  let declaration = null;
  let method = null;
  visit(parseAny(src, isJs), (n) => {
    if (n.type === 'FunctionDeclaration' && !declaration && n.id && n.id.name === name) declaration = n;
    else if (n.type === 'MethodDefinition' && !method && !n.computed
      && n.key?.type === 'Identifier' && n.key.name === name) method = n;
  });
  const found = declaration || method;
  if (!found) throw new Error(`no function or method named ${name} is in this source`);
  const raw = src.slice(found.range[0], found.range[1]);
  // A method is not a statement: `async restoreState() { … }` fails to parse on
  // its own, because `async` there is a modifier only in front of `function`.
  // Put the keyword back so the fragment is a function declaration of the same
  // name, which parses and means the same thing. This shifts every offset in
  // the fragment by a constant — already true of any fragment's own line
  // numbers, and the file's line comes from `found.loc` either way.
  const text = declaration ? raw
    : (/^async\s/.test(raw) ? `async function ${raw.replace(/^async\s+/, '')}` : `function ${raw}`);
  // Checked rather than assumed. `static foo() {}` and `get foo() {}` do not
  // parse even after this, and handing one back would fail later inside
  // somebody else's `propertyWrites`, naming the wrong file.
  parseAny(text, isJs);
  return { text, line: found.loc.start.line, endLine: found.loc.end.line };
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

/**
 * Every write a page makes through the API client: method, path, and the keys of
 * the body.
 *
 * The answer to "what does this page actually send the server" was being worked
 * out by hand, one call site at a time, and the hand answers were right every
 * time — which is exactly why they were a liability. A census that is read off
 * the tree stops being true quietly when a page adds a key, and the audit this
 * file exists for is the one that has to notice.
 *
 * A brace counter cannot do this. The bodies are nested literals
 * (`{ selection, odds, … }` beside `{ …, scanOptions: { … } }`), and the first
 * version of this walked the file with a regex over `[{,]\s*(\w+)` and reported
 * forty-one keys for a five-key body, having run past the closing brace into the
 * rest of the file. Nesting is the parser's job — the same argument that put
 * `fieldsOn` here instead of in a line scanner.
 *
 * A body that is a name rather than a literal is reported as that name with no
 * keys in `keys`, never as an empty body. `{ preferences: wanted }` and
 * `payload` are both ordinary here, and the settings defect this census was
 * written after lived inside one of them: `assembledScanOptions()` returning
 * the wrong thing was invisible from the call site and obvious only after
 * following the name. So the name is followed too, into `namedBody`, which is
 * that declaration's line and its keys when the declaration is an object
 * literal in the scope holding the call — and `null` when it is not, which is a
 * different answer from "sends nothing" and a caller can tell the two apart.
 *
 * That `null` is load-bearing and is why the two are separate fields. An empty
 * `keys` says the body is empty; a null `namedBody` says the body is a name
 * this cannot follow, and the two need different sentences — one is a defect,
 * the other is the edge of the instrument. Folding them would have made every
 * unfollowable name read as a deliberate empty body.
 *
 * Spread properties are reported separately and never folded into `keys`, because
 * silently dropping them is how this first reported a page as not sending `sport`
 * when the very next line spread it in. `...(cond ? { sport: v } : {})` is a
 * `SpreadElement`, not a `Property`; reading the object as a key list left it out
 * and the omission read as a finding. An unresolved spread is named, so the
 * caller is told there is something here it cannot see.
 *
 * A spread of a conditional is resolved as the union of its branches, which is
 * the honest answer to "can this call send `sport`" — yes, on the arm where the
 * control holds. A spread of a name stays `null`, because those keys are
 * whatever the function returns at the time and only running it would say.
 *
 * @param {string} src whole source file
 * @param {string} [client] the API client identifier
 * @returns {{method: string, path: string|null, pathText: string, line: number,
 *            keys: string[], dropped: string[], spreads: {keys: string[]|null, text: string}[],
 *            bodyName: string|null, namedBody: {line: number, keys: string[], dropped: string[]}|null}[]}
 */
export function writeCallSites(src, client = 'arbiterApi') {
  if (!/^\w+$/.test(client)) throw new Error(`client must be an identifier, got ${client}`);

  /** The keys a spread could contribute, or null when only running it would say. */
  const spreadKeys = (node) => {
    if (!node) return null;
    if (node.type === 'ObjectExpression') return entriesOf(src, node).map((e) => e.key);
    if (node.type === 'ConditionalExpression') {
      const yes = spreadKeys(node.consequent);
      const no = spreadKeys(node.alternate);
      return yes === null || no === null ? null : [...new Set([...yes, ...no])];
    }
    if (node.type === 'LogicalExpression') {
      const left = spreadKeys(node.left);
      const right = spreadKeys(node.right);
      return left === null || right === null ? null : [...new Set([...left, ...right])];
    }
    if (node.type === 'ParenthesizedExpression') return spreadKeys(node.expression);
    return null;
  };

  /**
   * Properties that are written and never arrive.
   *
   * `{ scanOptions: undefined }` reads as a body that carries the key, and a
   * census of key names calls it sent. `JSON.stringify` does not: an undefined
   * value is omitted, so the route receives the body without it — which is the
   * exact shape of the settings scrape bug, one layer down from the missing key
   * it started as. A function or a class is dropped the same way.
   */
  const droppedKeys = (literal) => literal.properties.flatMap((p) => {
    if (p.type !== 'Property' || p.computed) return [];
    const key = p.key.type === 'Identifier' ? p.key.name
      : (p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null);
    if (key === null) return [];
    const v = p.value;
    const gone = (v.type === 'Identifier' && v.name === 'undefined')
      || (v.type === 'UnaryExpression' && v.operator === 'void')
      || ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(v.type);
    return gone ? [key] : [];
  }).sort();

  /**
   * The nearest function, or the file, around a node — the only thing that
   * decides which `payload` a call means.
   */
  const scopeOf = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const a = ancestors[i];
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'Program'].includes(a.type)) return a;
    }
    return null;
  };

  /**
   * The literal a named body stands for, in the scope that holds the call.
   *
   * By scope, not by name across the file. `public/js/pages/live.js` declares
   * `payload` twice — once inside `loadEvents`, for a GET result that is
   * `outcome.value` and not a literal at all, and once inside the apply
   * listener — and a file-wide lookup by name picks the first declaration. It
   * would then either report the send as unresolvable or, once the lookup grew
   * a fallback, credit it with a body it does not carry. Both are the kind of
   * false clean this file exists to delete, and both are silent.
   *
   * `null` when the name has no literal in that scope, and also when two
   * declarations of it in the SAME scope would answer — a name rebound before
   * the call is not this instrument's to resolve, and only running the page
   * would say which one is sent.
   *
   * A reassignment counts as a second declaration here, which it did not in the
   * first version of this and had to be taught by injection: `let payload =
   * { a: 1 }; payload = { b: 2 };` has exactly ONE `VariableDeclarator`, so the
   * declarator count said "unambiguous" and the answer was `{ a: 1 }` — the
   * literal the second assignment had already replaced, reported as if it were
   * the one on the wire. The instrument only looks for declarators because that
   * is the shape it was written for, and a hole shaped like the thing it was
   * written for is the kind that passes review. An assignment to the bare name
   * in the call's scope therefore refuses the resolution.
   */
  const resolveNamedBody = (name, siteRange) => {
    const hits = [];
    let reassigned = false;
    visit(ast, (n, ancestors) => {
      if (n.type !== 'VariableDeclarator' && n.type !== 'AssignmentExpression') return;
      const bound = n.type === 'VariableDeclarator' ? n.id : n.left;
      if (bound?.type !== 'Identifier' || bound.name !== name) return;
      const scope = scopeOf(ancestors);
      if (!scope || !(scope.range[0] <= siteRange[0] && siteRange[1] <= scope.range[1])) return;
      if (n.type === 'AssignmentExpression') reassigned = true;
      else hits.push(n);
    });
    if (reassigned || hits.length !== 1 || hits[0].init?.type !== 'ObjectExpression') return null;
    return {
      line: hits[0].loc.start.line,
      keys: entriesOf(src, hits[0].init).map((e) => e.key).sort(),
      dropped: droppedKeys(hits[0].init),
    };
  };

  const ast = parseAny(src, true);
  const out = [];
  visit(ast, (n, ancestors) => {
    if (n.type !== 'CallExpression') return;
    const callee = n.callee;
    if (callee?.type !== 'MemberExpression' || callee.computed) return;
    if (callee.object?.type !== 'Identifier' || callee.object.name !== client) return;
    if (callee.property?.type !== 'Identifier') return;
    if (!['post', 'put', 'del', 'delete', 'patch'].includes(callee.property.name)) return;

    const [first, second] = n.arguments;
    const body = second ?? null;
    const literal = body?.type === 'ObjectExpression' ? body : null;
    const spreads = literal
      ? literal.properties
        .filter((p) => p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty')
        .map((p) => ({
          keys: spreadKeys(p.argument)?.sort() ?? null,
          text: src.slice(p.range[0], p.range[1]).replace(/\s+/g, ' ').slice(0, 80),
        }))
      : [];
    out.push({
      method: callee.property.name === 'del' ? 'delete' : callee.property.name,
      path: first?.type === 'Literal' && typeof first.value === 'string' ? first.value : null,
      pathText: first ? src.slice(first.range[0], first.range[1]) : '',
      line: n.loc.start.line,
      keys: literal ? entriesOf(src, literal).map((e) => e.key).sort() : [],
      dropped: literal ? droppedKeys(literal) : [],
      spreads,
      bodyName: literal ? null
        : (body?.type === 'Identifier' ? body.name
          : body ? src.slice(body.range[0], body.range[1]).split('\n')[0].trim() : null),
      namedBody: literal || body?.type !== 'Identifier' ? null : resolveNamedBody(body.name, n.range),
    });
  });
  return out.sort((a, b) => a.line - b.line);
}
