/**
 * The one way a test pulls a function out of a source file.
 *
 * Five test files carried their own copy of this and there were two of them
 * doing different things, so "the tests agree" was not a question with an
 * answer. Three copies (connection-status, event-detail-wiring, event-link)
 * located the function with a regex and then counted braces from the first `{`
 * after the name. One copy (event-detail-fallback) did the same with indexOf.
 * The fifth (source-health-list) skipped the parameter list first, and its
 * docstring said why — a default argument like `qualityOptions = {}` opens a
 * brace that closes again before the body begins, so matching from the first
 * `{` returns the signature, calls it the function, and hands the caller a
 * census of zero.
 *
 * That failure is not hypothetical in this tree. Asked for `loadWorkspace` in
 * src/scanner/scanner.mjs, the three-counting-braces-from-the-first-brace copies
 * returned 51 characters:
 *
 *   function loadWorkspace(dataDir, qualityOptions = {}
 *
 * — no parameter list, no body, 7,139 characters short. Only source-health-list
 * ever asked for that function, and only it held the copy that survives it, so
 * nothing was measured wrongly today. A test that asked tomorrow would have
 * measured nothing at all, and would have reported the result as a fact.
 *
 * `test/extract-fn.test.mjs` pins the property that separates the two answers,
 * on every function this tree's tests actually extract.
 *
 * What this still does not handle: braces inside string literals or regular
 * expression literals, which brace counting cannot see. Pass a comment-blanked
 * source (`codeOnly`) and keep such literals out of the functions under
 * inspection, as source-health-list already does for scanner.mjs.
 */
export function extractFn(name, from) {
  const start = from.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} is gone from the file`);
  let parens = 0;
  let bodyStart = -1;
  for (let i = from.indexOf('(', start); i < from.length; i += 1) {
    if (from[i] === '(') parens += 1;
    else if (from[i] === ')') {
      parens -= 1;
      if (parens === 0) { bodyStart = from.indexOf('{', i); break; }
    }
  }
  if (bodyStart === -1) throw new Error(`${name} has no body`);
  let depth = 0;
  for (let i = bodyStart; i < from.length; i += 1) {
    if (from[i] === '{') depth += 1;
    else if (from[i] === '}') {
      depth -= 1;
      if (depth === 0) return from.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed — has its shape changed?`);
}
