/**
 * api-surface.test.mjs — is every route the backend serves actually reachable
 * from the frontend?
 *
 * The goal this repo keeps auditing is that no backend capability sits behind a
 * UI that was never wired. That failure is invisible to every other test in the
 * tree: an adapter can be perfect, a scan can be published, a route can answer,
 * and the page still never asks for it. Nothing goes red. The capability is
 * simply unreachable, and the only symptom is a feature that "does not work".
 *
 * So this file is a closure check, not a behaviour check. Both sides are lifted
 * out of the sources — a hand-kept route list is the same duplication this
 * audit keeps finding out of date, and it would drift in the one direction
 * that hides the bug.
 *
 * Four consumption channels, because the frontend does not only speak through
 * one of them, and a check that assumed it did would report four false orphans:
 *
 *   arbiterApi.get/post/put/del  — the usual one
 *   fetch / EventSource          — CSRF token, the health probe, the SSE stream
 *   href="..." download          — the CSV exports
 *   location.href = '...'        — the tracker CSV export
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = new URL('..', import.meta.url);
// `new URL(...).pathname` is percent-encoded and gains a leading slash on
// Windows, so it is not a filesystem path. Nothing below resolves against it
// directly — that failure is silent, it just yields zero files.
const ROOT_DIR = fileURLToPath(ROOT);
const read = (rel) => readFileSync(join(ROOT_DIR, rel), 'utf8');

/**
 * Routes that are deliberately not on the frontend, each with the reason.
 *
 * Not an escape hatch: an entry here is a decision someone already made in
 * writing, and the reason is the point. Without it the difference between "this
 * capability has no UI" — the defect this file exists for — and "this capability
 * is not meant to have one" is invisible, and the list becomes a place to hide
 * a third route nobody thought about.
 */
const BACKEND_ONLY = [
  {
    route: 'GET /api/snapshot/',
    reason: 'Diagnostic: one book\'s workspace capture verbatim, no matching involved. README "Diagnostic routes". Measured on the writers rather than on a stored sample — the route hands the parsed file straight to sendJson, so the payload is whatever `_serializable` returns: BaseScraper emits 9 keys and 13 adapters override it adding `coverage` (9 of them), `sourceUrl` (7), `transport` (6) and `scrapeLimits` (favbet alone), 13 in all. See test/snapshot-route.test.mjs, which measures that union and pins it. The size argument holds and is measured on the 22 captures in data-market-run: `events` is 99.93% of what these documents hold (22 KiB of metadata against 31.1 MiB, largest single document 3.12 MiB, largest metadata 1.8 KiB), so a page reading this route for provenance alone would pull about 1400 times the bytes it displays. That byte count is the one number here taken from the sample rather than the writers, and it survives the sample\'s age: `events` is passed into the document whole, and nothing else in the writer approaches it.',
  },
  // `GET /api/odds/` used to sit here: "the same file projected to prices …
  // when /api/event-detail's heuristic matcher is itself under suspicion, a
  // view built on that matcher cannot be the evidence." That was true when the
  // list was written and stopped being true when the price board shipped. The
  // excuse kept passing, because an excuse is skipped rather than checked —
  // the file reported full closure while its own record of why a route had no
  // UI was wrong. It is removed so the closure check verifies the consumer
  // instead of taking the word of a comment.
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(full);
  }
  return out;
}

// ── served ───────────────────────────────────────────────────────────────────

const router = read('src/router.mjs');

/** Every exact entry of the dispatch table, keyed "VERB /path". */
const served = new Map();
// Line-anchored, because a bare `'GET /x':` pattern also occurs elsewhere in a
// 300-line router. The cost is that an entry written mid-line is invisible — so
// `tableEntriesAreAllExtracted` below makes that cost visible instead of silent.
for (const m of router.matchAll(/^\s*'(GET|POST|PUT|DELETE|PATCH|HEAD) ([^']+)'\s*:/gm)) {
  served.set(`${m[1]} ${m[2]}`, { source: 'handler table' });
}

/** Anything that looks like a table entry, wherever on the line it sits. */
const rawTableKeys = new Set(
  [...router.matchAll(/'(GET|POST|PUT|DELETE|PATCH|HEAD) ([^']+)'\s*:/g)].map((m) => `${m[1]} ${m[2]}`)
);

// Routes the dispatch handles outside the table, matched by prefix or equality
// on a specific verb. Read out of the dispatch itself so a route added there
// is picked up without touching this file.
// The two forms are written differently, and it matters. A prefix branch calls
// the method — `pathname.startsWith('/api/odds/')` — while an equality branch
// compares straight to a literal — `pathname === '/api/event-detail'` — with no
// parentheses at all. One regex written for the first form silently skips the
// second, and the two pages that call `/api/event-detail` then read as calling
// a route that does not exist.
for (const m of router.matchAll(/parsedUrl\.pathname\s*(?:\.startsWith\('([^']+)'\)|===\s*'([^']+)')/g)) {
  const before = router.slice(Math.max(0, m.index - 200), m.index);
  const verb = /req\.method === '([A-Z]+)'/.exec(before)?.[1];
  if (!verb) continue;
  const isPrefix = m[1] !== undefined;
  const raw = m[1] ?? m[2];
  served.set(`${verb} ${isPrefix && !raw.endsWith('/') ? `${raw}/` : raw}`, {
    source: isPrefix ? 'prefix branch' : 'dispatch branch',
  });
}

// ── called ───────────────────────────────────────────────────────────────────

const VERB = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE', patch: 'PATCH' };

/** Strip the query, an interpolation tail, and a trailing slash. */
function normalize(path) {
  return path.split('?')[0].split('${')[0].replace(/\/+$/, '');
}

const CHANNELS = [
  { name: 'arbiterApi', re: /arbiterApi\.(get|post|put|del|patch)\(\s*(['"`])([^'"`]+)\2/g, verb: (m) => VERB[m[1]] },
  { name: 'fetch', re: /\b(?:window\.)?fetch\(\s*(['"`])([^'"`]+)\1/g, verb: () => 'GET' },
  { name: 'EventSource', re: /new EventSource\(\s*(['"`])([^'"`]+)\1/g, verb: () => 'GET' },
  { name: 'href', re: /\bhref\s*=\s*(['"`])([^'"`]+)\1/g, verb: () => 'GET' },
  { name: 'location', re: /\blocation\.href\s*=\s*(['"`])([^'"`]+)\1/g, verb: () => 'GET' },
];

/**
 * A call whose argument is a local binding instead of a literal.
 *
 * Measured before this existed: the price board asks for `/api/odds/:book` and
 * the closure check could not see it. `loadPriceBoard` reads
 * `const url = priceBoardUrl();` and calls `arbiterApi.get(url)`, so the regexes
 * above — which want a quoted path at the call site — matched nothing, and the
 * route was only holding because a hand-written excuse covered it. That is the
 * mirror image of the hole `every table entry is extracted` closes on the route
 * side: there, a route added mid-line was invisible; here, a consumer that
 * composes its own URL is invisible. Both let the check report closure over
 * something it did not actually read.
 */
const CHANNELS_BY_BINDING = [
  { name: 'arbiterApi', re: /arbiterApi\.(get|post|put|del|patch)\(\s*([A-Za-z_$][\w$]*)\s*\)/g, verb: (m) => VERB[m[1]], at: 2 },
];

/**
 * The source of one function declaration, bounded by its own closing brace.
 *
 * Bounded because the alternative is wrong in a way that looks like an absence
 * of consumers: scanning from the declaration to the end of the file collects
 * the `return` of every function written after it. Measured on scrape.js, that
 * is 23 returns across 30 later functions, so "the literal this function
 * returns" can never be a single value and every such call resolves to nothing.
 *
 * The bound is the codebase's own shape rather than a parser: 70 of 70
 * top-level declarations in public/js and electron close with a `}` in column
 * 0, none of them contains a nested declaration, and
 * `function bodies are bounded by their own brace` below fails if that ever
 * stops being true.
 */
function functionWindow(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^function\\s+${name}\\s*\\(`).test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, j) => j > start
    && (l === '}' || /^function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)));
  return end === -1 ? null : lines.slice(start, end + 1).join('\n');
}

/**
 * The path literal behind an expression, followed through local `const`
 * bindings and one function call.
 *
 * Deliberately narrow, and narrow in the direction that fails safe. It reads
 * `const NAME = <expr>` and never `let`/`var`, because a reassigned binding is
 * not a constant and a value that cannot be pinned down is not evidence; for a
 * call it accepts a function only when every string it can return normalises
 * to one and the same route; and every step that finds nothing returns null,
 * which leaves the route reading as uncovered rather than covered. A resolver
 * that guessed would turn this file's purpose — noticing a capability nobody
 * wired — into a machine for not noticing it.
 */
function literalBehind(text, expr, depth = 0) {
  if (depth > 3) return null;
  const trimmed = expr.trim();
  const literal = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
  if (literal) return literal[2];

  const binding = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (binding) {
    const decl = new RegExp(`^\\s*const\\s+${binding[1]}\\s*=\\s*([^;]+);`, 'm').exec(text);
    return decl ? literalBehind(text, decl[1], depth + 1) : null;
  }

  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
  if (call) {
    const body = functionWindow(text, call[1]);
    if (body === null) return null;
    // Every string this function can return, and only a single non-empty one
    // counts. `priceBoardUrl` opens with `if (!book) return '';` and closes with
    // the route template, so "the first literal it returns" is the empty one and
    // resolves to nothing at all. Two different routes on two branches is a
    // function whose consumer cannot be read, and that reads as uncovered.
    const returned = [...body.matchAll(/return\s+([^;]+);/g)]
      .map((m) => literalBehind(text, m[1], depth + 1))
      .filter((v) => v !== null)
      .map((v) => normalize(v))
      .filter(Boolean);
    const distinct = [...new Set(returned)];
    return distinct.length === 1 ? distinct[0] : null;
  }
  return null;
}

/**
 * Blank the ranges the tokenizer calls comments, so a route NAMED in a comment
 * does not read as a route that is called.
 *
 * This is the same hole the event-detail census walked into: `selection.group`
 * is read by nobody in the whole frontend, and the only mention of it is the
 * word "group:" inside a comment. A search that counts comments credits a
 * comment with a read. Here it would credit a comment with a consumer, and the
 * closure check would report a route as reachable when no page ever asks for
 * it — the precise failure this file exists to prevent, arriving through the
 * file that was supposed to prevent it.
 *
 * Measured on the tree as it stands: stripping comments changes nothing, so
 * nothing currently rides on this. It is here because the alternative is a
 * check that a one-line comment can switch off.
 *
 * The masker itself now lives in helpers/code-only.mjs, because this hole was
 * not unique to this file: analytics-page.test.mjs and source-health-list.test.mjs
 * decide readership the same way, in both directions — which fields the page
 * reads, and which names the loader writes. One implementation, imported
 * everywhere, so the next census in this tree does not reinvent the loose one.
 */

/** Every call in one file, with the line it sits on, comments excluded. */
function extractConsumers(src, relPath, isJs) {
  const found = [];
  const text = codeOnly(src, isJs);
  const lines = src.split(/\r?\n/);
  const at = (m) => lines[0, src.slice(0, m.index).split(/\r?\n/).length - 1];
  for (const channel of CHANNELS) {
    for (const m of text.matchAll(channel.re)) {
      found.push({
        verb: channel.verb(m),
        path: normalize(m[channel.name === 'arbiterApi' ? 3 : 2]),
        file: relPath,
        line: at(m),
        channel: channel.name,
        via: 'literal',
      });
    }
  }
  // A consumer that composes its own URL is only a consumer if the composition
  // can be read. When it cannot, the call is not recorded at all — the route
  // then reads as uncovered, which is the answer that sends someone to look.
  for (const channel of CHANNELS_BY_BINDING) {
    for (const m of text.matchAll(channel.re)) {
      const literal = literalBehind(text, m[channel.at]);
      if (literal === null) continue;
      found.push({
        verb: channel.verb(m),
        path: normalize(literal),
        file: relPath,
        line: at(m),
        channel: channel.name,
        via: `resolved from \`${m[channel.at]}\``,
      });
    }
  }
  return found;
}

const sources = [...walk(join(ROOT_DIR, 'public')), ...walk(join(ROOT_DIR, 'electron'))];

/** path -> [{ file, line, channel }] */
const consumers = new Map();
for (const file of sources) {
  const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
  for (const c of extractConsumers(readFileSync(file, 'utf8'), rel, /\.(js|mjs)$/.test(file))) {
    if (!consumers.has(c.path)) consumers.set(c.path, []);
    consumers.get(c.path).push(c);
  }
}

// ── the check ────────────────────────────────────────────────────────────────

/** Does a served route answer to a path the frontend actually asks for? */
function isCovered(servedRoute, calledPath) {
  const [verb, path] = servedRoute.split(' ');
  if (calledPath === path) return true;
  // A prefix branch answers for itself and everything under it. The caller's
  // own path arrives normalized without its trailing slash, so `/api/tracker/`
  // has to answer for a bare `/api/tracker` too.
  if (path.endsWith('/')) {
    const bare = path.slice(0, -1);
    if (calledPath === bare || calledPath.startsWith(path)) return true;
  }
  // A sub-resource route answers for the ids built on top of it.
  if (calledPath.startsWith(`${path}/`)) return true;
  return false;
}

test('every route the backend serves has a consumer on the frontend, and no excuse covers one that does', () => {
  const orphans = [];
  for (const route of served.keys()) {
    if (BACKEND_ONLY.some((b) => b.route.startsWith(route) || route.startsWith(b.route))) continue;
    const [verb, path] = route.split(' ');
    const hits = [...consumers.entries()].filter(([called]) => isCovered(route, called));
    // A verb mismatch is not a hit: `POST /api/scan` with a GET link on it is
    // precisely the kind of near-miss this file is meant to notice.
    const matched = hits.flatMap(([, list]) => list.filter((c) => c.verb === verb));
    if (matched.length === 0) orphans.push({ route, verb, path, called: [...consumers.keys()] });
  }

  // The same claim read from the other side, in this test rather than beside
  // it. An entry in BACKEND_ONLY asserts that nothing calls the route, and that
  // assertion is as checkable as the orphan list — the excuse is a statement
  // about the frontend, so it gets compared against the frontend. Kept inside
  // this test rather than as a second one on purpose: when the price board
  // shipped and started calling `GET /api/odds/`, the excuse stayed, the reason
  // stayed, and the file reported full closure over a record that had stopped
  // being true. A check that can be switched off without the audit going red is
  // not part of the audit.
  const stale = [];
  for (const { route } of BACKEND_ONLY) {
    const [verb] = route.split(' ');
    const matched = [...consumers.entries()]
      .filter(([called]) => isCovered(route, called))
      .flatMap(([, list]) => list.filter((c) => c.verb === verb));
    if (matched.length) stale.push(`${route} — ${matched[0].file}:${matched[0].line} calls it, so the excuse is not true`);
  }

  const detail = orphans.map(({ route, called }) => {
    const near = called.filter((c) => c.includes(route.split(' ')[1].split('/').pop()));
    return `  ${route}  (frontend paths seen: ${called.length}${near.length ? `, closest: ${near.join(', ')}` : ''})`;
  });
  assert.deepEqual(orphans.map((o) => o.route), [], `routes with no frontend consumer:\n${detail.join('\n')}`);
  assert.deepEqual(stale, [], `excuses over routes the frontend calls:\n  ${stale.join('\n  ')}`);
});

test('a consumer that builds its own URL is found, and one that cannot is not', () => {
  // The live case, in the shape the price board actually has it: a `const`
  // bound to a helper call, the helper opening with `return ''` and closing
  // with the route template. Before the resolver existed this call matched no
  // channel at all, which is why `GET /api/odds/` sat in BACKEND_ONLY with a
  // reason that had stopped being true.
  const composed = [
    'function priceBoardUrl() {',
    "  if (!book) return '';",
    '  return `/api/odds/${encodeURIComponent(book)}?${params}`;',
    '}',
    'async function load() {',
    '  const url = priceBoardUrl();',
    '  return arbiterApi.get(url);',
    '}',
  ].join('\n');
  const found = extractConsumers(composed, 'probe.js', true);
  assert.deepEqual(found.map((c) => c.path), ['/api/odds'],
    'a URL assembled in a helper is the consumer it is');
  assert.equal(found[0].verb, 'GET', 'and the verb comes from the call, not from the literal');
  assert.match(found[0].via, /resolved/, 'the record says it was resolved, so it is not mistaken for a literal');

  // The controls, each of which must read as NO consumer. A resolver that
  // guessed would turn this file's purpose into a machine for not noticing a
  // capability nobody wired, so every ambiguous shape has to fail closed.
  const controls = {
    'two routes on two branches': [
      'function pick() {',
      "  if (a) return '/api/one';",
      "  return '/api/two';",
      '}',
      'async function load() {',
      '  const url = pick();',
      '  return arbiterApi.get(url);',
      '}',
    ].join('\n'),
    'a let binding, which can be reassigned': [
      'async function load() {',
      "  let url = '/api/here';",
      '  url = somewhereElse(url);',
      '  return arbiterApi.get(url);',
      '}',
    ].join('\n'),
    'a helper that is not in this file': [
      'async function load() {',
      '  const url = buildFromConfig();',
      '  return arbiterApi.get(url);',
      '}',
    ].join('\n'),
    'a helper that returns nothing but a number': [
      'function size() {',
      '  return 42;',
      '}',
      'async function load() {',
      '  const n = size();',
      '  return arbiterApi.get(n);',
      '}',
    ].join('\n'),
  };
  for (const [what, src] of Object.entries(controls)) {
    assert.deepEqual(extractConsumers(src, 'probe.js', true).map((c) => c.path), [],
      `${what} must not be counted as a consumer of anything`);
  }

  // And the last control is the one that keeps the controls honest: the same
  // shape with a single returned route does resolve, so the four above are
  // refused for their own reasons and not because the resolver finds nothing.
  const single = [
    'function pick() {',
    "  return '/api/one';",
    '}',
    'async function load() {',
    '  const url = pick();',
    '  return arbiterApi.get(url);',
    '}',
  ].join('\n');
  assert.deepEqual(extractConsumers(single, 'probe.js', true).map((c) => c.path), ['/api/one'],
    'a helper with one returned route does resolve');
});

test('function bodies are bounded by their own brace, as the resolver assumes', () => {
  // The resolver reads a function's returns out of the lines between its
  // declaration and the next `}` in column 0. Measured over public/js and
  // electron: 70 of 70 top-level declarations close that way, with no nested
  // declaration inside any of them. This is the check that makes the bound a
  // fact about the tree rather than a hope — a nested declaration would
  // truncate the window, and the truncation must be visible here rather than
  // showing up later as a route that mysteriously lost its consumer.
  const offenders = [];
  for (const file of [...walk(join(ROOT_DIR, 'public', 'js')), ...walk(join(ROOT_DIR, 'electron'))]) {
    const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
    const lines = codeOnly(readFileSync(file, 'utf8'), true).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[i])) continue;
      const end = lines.findIndex((l, j) => j > i && (l === '}' || /^function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)));
      if (end === -1) offenders.push(`${rel}:${i + 1} never closes`);
      else if (lines[end] !== '}') offenders.push(`${rel}:${i + 1} holds a nested declaration at line ${end + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `functions the resolver would misread:\n  ${offenders.join('\n  ')}`);
});

test('the price board is what keeps the odds route covered, and the check sees it', () => {
  // The reason `GET /api/odds/` left BACKEND_ONLY. The closure check only
  // verifies a consumer if it can read one, so this asserts both halves: the
  // route has no literal call anywhere in the frontend, and it is covered
  // anyway through the URL the page composes. If the page ever stops composing
  // it, the first assertion here stops being true and this is the test that
  // says so, rather than the route quietly returning to an excuse nobody
  // re-reads.
  const literalOdds = [...consumers.entries()].filter(([path, list]) => path === '/api/odds'
    && list.some((c) => c.via === 'literal'));
  assert.deepEqual(literalOdds, [], 'no page calls the odds route with a literal — it is composed, not written out');

  const composedOdds = [...consumers.entries()].filter(([path, list]) => path === '/api/odds'
    && list.some((c) => c.via.startsWith('resolved')));
  assert.deepEqual(composedOdds.map(([, list]) => list.map((c) => c.file)), [['public/js/pages/scrape.js']],
    'and the price board is the page that reaches it');
  assert.ok(served.has('GET /api/odds/'), 'the odds route is in the served set it is being checked against');
});

test('every backend-only route still carries the reason it has no UI', () => {
  // The list above is the only place a route can be excused, so an excuse with
  // no explanation behind it is a silent hole. Point the reason at something
  // checkable: the file that documents the decision must still mention it.
  for (const { route, reason } of BACKEND_ONLY) {
    const name = route.split(' ')[1].replace(/\/$/, '');
    assert.ok(reason && reason.length > 40, `${route} has no recorded reason`);
    assert.ok(read('README.md').includes(name), `README no longer documents ${name}`);
  }
});

test('the frontend asks for nothing the backend does not serve', () => {
  const wrong = [];
  for (const [calledPath, list] of consumers) {
    for (const c of list) {
      if (!calledPath.startsWith('/api/')) continue;
      const route = `${c.verb} ${calledPath}`;
      const servedSomehow = [...served.keys()].some((s) => isCovered(s, calledPath)
        && (s.split(' ')[0] === c.verb || calledPath.split('/').pop() === 'export.csv'));
      if (!servedSomehow) wrong.push(`${route} at ${c.file}:${c.line} (${c.channel})`);
    }
  }
  assert.deepEqual(wrong, [], `frontend calls with no matching route:\n  ${wrong.join('\n  ')}`);
});

test('the route table is read from the router, not hard-coded here', () => {
  // If the extraction silently stopped matching, both checks above would pass
  // against an empty set and prove nothing. Anchor it to the real source.
  assert.ok(served.size >= 25, `only ${served.size} routes extracted from src/router.mjs`);
  assert.ok(served.has('GET /api/alerts'), 'the alerts route is missing from the extraction');
  assert.ok(served.has('GET /api/event-detail'), 'the event-detail dispatch branch is missing');
  assert.ok(served.has('PUT /api/tracker/'), 'the tracker sub-resource branch is missing');
});

test('every table entry is extracted, whatever line it sits on', () => {
  // Found the hard way: a route added mid-line was invisible to the closure
  // check, which then reported perfect closure over a table that was not the
  // real one. Anything shaped like a table entry has to be in `served`.
  const missed = [...rawTableKeys].filter((k) => !served.has(k));
  assert.deepEqual(missed, [], `table entries the extractor skipped: ${missed.join(', ')}`);
});

test('a route named in a comment is not a consumer', () => {
  // The negative control for the comment-blindness this file just fixed. Both
  // channels are checked, because a route can be named in a comment in either
  // kind of file: `fetch(...)` in a script, an href in markup. If either one
  // still matched inside a comment, the closure check above could be satisfied
  // by a sentence.
  const inJsComment = extractConsumers(
    "// the page used to call fetch('/api/ghost') here\nconst x = 1;\n",
    'probe.js', true,
  );
  assert.deepEqual(inJsComment, [], 'a fetch() named only inside a JS comment was counted as a consumer');

  const inHtmlComment = extractConsumers(
    "<!-- <a href=\"/api/ghost\">old</a> -->\n<p>hi</p>\n",
    'probe.html', false,
  );
  assert.deepEqual(inHtmlComment, [], 'an href named only inside an HTML comment was counted as a consumer');

  // The same calls, uncommented, must still be found. Without this the two
  // assertions above would also pass on an extractor that simply finds nothing.
  const live = extractConsumers("fetch('/api/real');\n", 'probe.js', true);
  assert.deepEqual(live.map((c) => c.path), ['/api/real'], 'a real call stopped being detected');
  const liveHtml = extractConsumers('<a href="/api/real">x</a>\n', 'probe.html', false);
  assert.deepEqual(liveHtml.map((c) => c.path), ['/api/real'], 'a real href stopped being detected');
});

test('the scan and tracker CSV exports are reachable from a page, not only from a script', () => {
  // The two exports are the classic case of a backend capability that exists,
  // is tested, is documented — and has no control in the UI. Assert the control
  // exists in the shipped markup, by path, rather than trusting a comment.
  //
  // Which is what this now actually does. It used to grep the raw text, so the
  // sentence right above it could have been the thing that satisfied it — a
  // comment saying the path is enough to make the assertion pass with no
  // control in the page at all.
  const files = sources.filter((f) => /\.(html|js|mjs)$/.test(f));
  const has = (needle) => files.filter((f) => needle.test(codeOnly(readFileSync(f, 'utf8'), /\.(js|mjs)$/.test(f))));
  const scanExport = has(/\/api\/scan\/export\.csv/);
  const trackerExport = has(/\/api\/tracker\/export\.csv/);
  assert.ok(scanExport.length > 0, 'no frontend file references /api/scan/export.csv outside a comment');
  assert.ok(trackerExport.length > 0, 'no frontend file references /api/tracker/export.csv outside a comment');
});