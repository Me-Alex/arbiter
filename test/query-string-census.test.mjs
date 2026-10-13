/**
 * query-string-census.test.mjs — every query key across the GET boundary, both ways.
 *
 * The write side of the request boundary has a census (write-request-census)
 * and the response side has several (the payload and field censuses), but the
 * GET side had none at all: `test/api-surface.test.mjs` strips the query before
 * matching — its `normalize()` cuts the path at `?` — so a route could grow a
 * query parameter no page sends, or a page could send one no route reads, and
 * every check in the tree would still read clean.
 *
 * Both halves are lifted out of the sources rather than remembered, and the two
 * are kept independent on purpose: a table that read itself off the tree would
 * agree with any drift in the tree. The backend half walks the parse tree of
 * src/router.mjs — the dispatch table's handler functions and the `*Route`
 * functions the prefix/eq branches call — and attributes every
 * `params.get/getAll/has('key')` to exactly one route. The frontend half walks
 * public/ (32 files; the only surface that builds query strings — measured:
 * electron/ holds no `/api/…?` URL) and collects, per file, the URLs it names
 * and the keys it can put on a query string. Which file sends to which route is
 * hand-written below, because the pairing is the claim; the keys on both sides
 * come off the tree, because a key list is the thing being checked.
 *
 * Two directions, because each catches what the other cannot:
 *
 *   sent → read   a key a page sends and no route reads is a control the user
 *                 believes is wired while nothing consumes it
 *   read → sent   a key a route reads and no page sends is a parameter nothing
 *                 in the app can ever set
 *
 * ── Where this stops ─────────────────────────────────────────────────────────
 *
 * A query fragment written as a bare literal (`'?type=' + v`) has no path to
 * join it to, so the string reading below would not see it — and the bare
 * fragment control fails loudly the moment one appears instead of staying
 * silent. HTML is read as markup (attribute-shaped values): an inline
 * `<script>` would sit below that reading, and the control asserting none
 * exists makes the day one arrives a red test rather than a blind spot.
 *
 * `new URLSearchParams(name)` is not followed. The one such call,
 * scanner.js:512, parses the href it is about to rewrite, and those keys are
 * counted where they are written — in admin/scanner.html's markup.
 *
 * A `params` binding that is not a URLSearchParams cannot honestly be read as a
 * query key, so such a read is reported as unresolved rather than counted
 * either way.
 *
 * The page channel `/event.html?…` is not an API route: the browser parses the
 * query and public/js/pages/event-detail.js reads it off
 * `window.location.search` — the only such read under public/, and a control
 * below pins that. It is carried as a named exception with both halves checked,
 * rather than dropped, so the exception stays visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { codeOnly } from './helpers/code-only.mjs';
import { sourceFiles } from './helpers/export-readers.mjs';

const { parse } = createRequire(import.meta.url)('espree');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Parse as a module, else as a plain script — the same answer codeOnly gives. */
function parseAny(src) {
  for (const sourceType of ['module', 'script']) {
    try {
      return parse(src, { ecmaVersion: 2023, sourceType, comment: true, range: true, loc: true });
    } catch { /* the other source type */ }
  }
  throw new Error(`could not tokenize ${src.slice(0, 60).replace(/\n/g, ' ')}`);
}

/** Depth-first walk handing every node its ancestor chain. */
function walk(node, fn, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn, ancestors);
    return;
  }
  if (!node.type) return;
  fn(node, ancestors);
  for (const [name, value] of Object.entries(node)) {
    if (name === 'loc' || name === 'range' || name === 'comments') continue;
    walk(value, fn, [...ancestors, node]);
  }
}

/** Every `.js`/`.mjs`/`.html` under public/, repo-relative and forward-slashed. */
function publicFiles(dir = 'public', out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) publicFiles(rel, out);
    else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

// ── backend: which route reads which query key ───────────────────────────────

/**
 * Every query key read in the router, attributed to the route that reads it.
 *
 * A read counts only where the receiver is visible as a URLSearchParams: a
 * chain ending in `.searchParams`, or the `params` binding the covering
 * segment declares from one. A `params.get('…')` whose segment never binds
 * `params` that way cannot honestly be called a query read — a path parameter
 * dressed as one would otherwise pass here as a read nobody performs — so it
 * is reported as unresolved instead of counted either way.
 *
 * @param {string} routerSrc
 * @returns {{keys: Map<string, string[]>, routes: string[], reads: object[],
 *   unattributed: string[], unresolved: string[], ambiguous: string[]}}
 */
function routeQueryKeys(routerSrc) {
  const src = codeOnly(routerSrc);
  const ast = parseAny(src);
  const lineAt = (idx) => src.slice(0, idx).split(/\r?\n/).length;

  const reads = [];
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression') return;
    const method = n.callee.property.name;
    if (!['get', 'getAll', 'has'].includes(method)) return;
    const object = n.callee.object;
    const chain = object?.type === 'MemberExpression' && object.property?.name === 'searchParams';
    const named = object?.type === 'Identifier' && object.name === 'params';
    if (!chain && !named) return;
    const arg = n.arguments[0];
    if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
    reads.push({
      key: arg.value,
      method,
      chain,
      line: lineAt(n.range[0]),
      start: n.range[0],
      end: n.range[1],
    });
  });

  /**
   * The route a dispatch condition names, or null when it is not one.
   *
   * Both branch forms are read here rather than assumed: a prefix branch calls
   * `pathname.startsWith('…')` while an equality branch compares straight to a
   * literal — one regex written for the first silently skips the second, and
   * the two pages calling `/api/event-detail` would then read as calling a
   * route that does not exist.
   */
  const dispatchRoute = (cond) => {
    if (cond?.type !== 'LogicalExpression' || cond.operator !== '&&') return null;
    const verbNode = cond.left;
    if (verbNode?.type !== 'BinaryExpression' || verbNode.operator !== '===') return null;
    const recv = verbNode.left;
    if (recv?.type !== 'MemberExpression' || recv.object?.name !== 'req' || recv.property?.name !== 'method') return null;
    if (verbNode.right?.type !== 'Literal' || typeof verbNode.right.value !== 'string') return null;
    const verb = verbNode.right.value;
    const pathNode = cond.right;
    if (pathNode?.type === 'BinaryExpression' && pathNode.operator === '===') {
      const p = pathNode.left;
      if (p?.type !== 'MemberExpression' || p.object?.name !== 'parsedUrl' || p.property?.name !== 'pathname') return null;
      if (pathNode.right?.type !== 'Literal' || typeof pathNode.right.value !== 'string') return null;
      return `${verb} ${pathNode.right.value}`;
    }
    if (pathNode?.type === 'CallExpression' && pathNode.callee?.type === 'MemberExpression'
      && pathNode.callee.property?.name === 'startsWith') {
      const p = pathNode.callee.object;
      if (p?.type !== 'MemberExpression' || p.object?.name !== 'parsedUrl' || p.property?.name !== 'pathname') return null;
      const arg = pathNode.arguments[0];
      if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return null;
      return `${verb} ${arg.value.endsWith('/') ? arg.value : `${arg.value}/`}`;
    }
    return null;
  };

  // The ranges a query read is allowed to live in: each handler-table function,
  // each dispatch branch's consequent, and the *Route bodies those branches call.
  const segments = [];
  const branches = [];
  const declarations = new Map();
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id?.name) declarations.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id?.name === 'handlers') {
      for (const p of n.init?.properties ?? []) {
        const label = p.key?.type === 'Literal' ? p.key.value : null;
        if (typeof label !== 'string' || !/^(GET|POST|PUT|DELETE|PATCH|HEAD) /.test(label)) continue;
        if (!/Function/.test(p.value?.type ?? '')) continue;
        segments.push({ route: label, start: p.value.range[0], end: p.value.range[1] });
      }
    }
    if (n.type !== 'IfStatement') return;
    const route = dispatchRoute(n.test);
    if (!route) return;
    segments.push({ route, start: n.consequent.range[0], end: n.consequent.range[1] });
    const called = [];
    walk(n.consequent, (c) => {
      if (c.type === 'CallExpression' && c.callee?.type === 'Identifier' && /Route$/.test(c.callee.name)) {
        called.push(c.callee.name);
      }
    });
    branches.push({ route, called });
  });
  for (const { route, called } of branches) {
    for (const name of called) {
      const decl = declarations.get(name);
      if (decl) segments.push({ route, start: decl.range[0], end: decl.range[1] });
    }
  }

  const routes = [...new Set(segments.map((s) => s.route))].sort();
  const keys = new Map(routes.map((r) => [r, []]));
  const unattributed = [];
  const unresolved = [];
  const ambiguous = [];
  for (const r of reads) {
    const covering = segments.filter((s) => s.start <= r.start && r.end <= s.end);
    if (!covering.length) {
      unattributed.push(`${r.line}: ${r.method}('${r.key}') sits outside every route`);
      continue;
    }
    if (covering.length > 1) {
      ambiguous.push(`${r.line}: '${r.key}' sits in ${covering.length} routes at once`);
      continue;
    }
    const seg = covering[0];
    const boundToUrl = /\bparams\s*=\s*[^\n;]*searchParams/.test(src.slice(seg.start, seg.end));
    if (!r.chain && !boundToUrl) {
      unresolved.push(`${r.line}: params.${r.method}('${r.key}') in ${seg.route}, whose \`params\` is not a searchParams`);
      continue;
    }
    const list = keys.get(seg.route);
    if (!list.includes(r.key)) list.push(r.key);
  }
  return { keys, routes, reads, unattributed, unresolved, ambiguous };
}

// ── frontend: which file puts which key on the wire ──────────────────────────

const MARK = String.fromCharCode(0); // where an interpolation sat inside a template literal

/**
 * The URLs one public file names, the query keys it can put on one, and the
 * page-query keys it reads.
 *
 * Strings come off the parse tree with comments already blanked through the
 * shared helper — a regex over raw text would credit a commented-out link with
 * a key. A template literal is rebuilt with MARK in place of each
 * interpolation, so the path head that decides "this is an API URL" stays
 * visible. Keys are read only from a string whose head mentions a path
 * (`/api/…` or `….html`), which is what joins a fragment to the route that
 * receives it.
 *
 * @param {string} src
 * @param {boolean} isJs false for HTML, which is read as markup
 * @returns {{urls: Set<string>, keys: Set<string>, readKeys: Set<string>, bareFragments: string[]}}
 */
function frontendQueries(src, isJs) {
  const text = codeOnly(src, isJs);
  const strings = [];
  const bareFragments = [];
  const urls = new Set();
  const keys = new Set();
  const readKeys = new Set();
  // Names bound to the page's own query string: `const input = new
  // URLSearchParams(window.location.search)`. `.get` on one of these reads the
  // page rather than the API, and that is the receiver half of the page
  // channel. Populated in source order, so a use after the declaration sees it.
  const locationParams = new Set();

  if (isJs) {
    walk(parseAny(text), (n) => {
      if (n.type === 'Literal' && typeof n.value === 'string') {
        strings.push(n.value);
        return;
      }
      if (n.type === 'TemplateLiteral') {
        strings.push(n.quasis.map((q) => q.value.cooked ?? '').join(MARK));
        return;
      }
      if (n.type === 'VariableDeclarator' && n.init?.type === 'NewExpression'
        && n.init.callee?.name === 'URLSearchParams'
        && n.init.arguments[0]?.type === 'MemberExpression'
        && n.init.arguments[0].property?.name === 'search'
        && n.id?.type === 'Identifier') {
        locationParams.add(n.id.name);
        return;
      }
      if (n.type === 'NewExpression' && n.callee?.name === 'URLSearchParams') {
        // `new URLSearchParams({ a, b })` or `new URLSearchParams('a=1&b=2')`.
        // A name (`new URLSearchParams(query)`, scanner.js:512) is not followed:
        // it parses the href it is about to rewrite, and those keys are counted
        // where they are written — in admin/scanner.html's markup.
        const arg = n.arguments[0];
        if (arg?.type === 'ObjectExpression') {
          for (const p of arg.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const k = p.key?.type === 'Identifier' ? p.key.name
              : p.key?.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null;
            if (k) keys.add(k);
          }
        } else if (arg?.type === 'Literal' && typeof arg.value === 'string') {
          for (const part of arg.value.split('&')) {
            const name = part.split('=')[0];
            if (/^\w+$/.test(name)) keys.add(name);
          }
        }
        return;
      }
      if (n.type === 'ForOfStatement' && n.right?.type === 'ArrayExpression'
        && n.left?.type === 'VariableDeclaration') {
        // The keep-list form: `for (const key of ['sport', …]) params.set(key,
        // input.get(key))`. The array is the list in both directions — what the
        // page puts on the link and, where the same loop reads the page's own
        // query, what it accepts. A loop that merely iterates element ids
        // (scrape.js:805) sets nothing on a URLSearchParams and contributes
        // nothing here.
        const elements = n.right.elements;
        const v = n.left.declarations[0]?.id?.name;
        if (!v || !elements.length
          || !elements.every((e) => e.type === 'Literal' && typeof e.value === 'string')) return;
        let sets = false;
        let getsFromPage = false;
        walk(n.body, (m) => {
          if (m.type !== 'CallExpression' || m.callee?.type !== 'MemberExpression') return;
          if (m.arguments[0]?.type !== 'Identifier' || m.arguments[0].name !== v) return;
          if (m.callee.property.name === 'set') sets = true;
          if (m.callee.property.name === 'get' && m.callee.object?.type === 'Identifier'
            && locationParams.has(m.callee.object.name)) getsFromPage = true;
        });
        if (sets) for (const e of elements) keys.add(e.value);
        if (getsFromPage) for (const e of elements) readKeys.add(e.value);
        return;
      }
      if (n.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression') return;
      const member = n.callee;
      const arg = n.arguments[0];
      // `params.set('key', …)` / `.append` / `.delete` — the receiver is not
      // checked: measured, only URLSearchParams receives these under public/,
      // and an unknown receiver that starts doing so fails the per-file union
      // below rather than slipping through silently.
      if (['set', 'append', 'delete'].includes(member.property.name)
        && arg?.type === 'Literal' && typeof arg.value === 'string') {
        keys.add(arg.value);
        return;
      }
      // The literal form of a page read: `input.get('sport')`.
      if (member.property.name === 'get' && arg?.type === 'Literal'
        && typeof arg.value === 'string' && /^\w+$/.test(arg.value)
        && member.object?.type === 'Identifier' && locationParams.has(member.object.name)) {
        readKeys.add(arg.value);
      }
    });
  } else {
    // Attribute-shaped values only (`href="…"`): an apostrophe in prose is not
    // a string, and treating it as one would put invented keys in the census.
    for (const m of text.matchAll(/\s[\w-]+\s*=\s*("[^"]*"|'[^']*')/g)) {
      strings.push(m[1].slice(1, -1));
    }
  }

  for (const s of strings) {
    // A bare fragment has no path to join it to; it is reported rather than
    // silently missed — a control below fails the day one appears.
    if (s.length > 1 && s.startsWith('?')) bareFragments.push(s);
    // URLs this file names, as substrings: a path sits inside a larger string
    // too (`a[href*="/api/scan/export.csv"]` names the route it rewrites).
    for (const m of s.matchAll(/\/api\/[\w./-]*/g)) urls.add(m[0]);
    for (const m of s.matchAll(/\/?[\w.-]*\.html/g)) urls.add(m[0]);
    const at = s.indexOf('?');
    if (at === -1) continue;
    const before = s.slice(0, at);
    if (!before.includes('/api/') && !before.includes('.html')) continue;
    const tail = s.slice(at + 1).split(MARK).join('');
    for (const part of tail.split('&')) {
      const name = part.split('=')[0];
      if (/^\w+$/.test(name)) keys.add(name);
    }
  }

  return { urls, keys, readKeys, bareFragments };
}

// ── the census, written out by hand on both sides ────────────────────────────

/**
 * The routes that read query keys, and the keys they read.
 *
 * Written out rather than derived, because the derived list is the thing being
 * checked — a table that read itself off the tree would agree with any drift in
 * the tree. `QUERYLESS_ROUTE` sits here with an empty list on purpose: it is
 * served, it answers, and it reads only the pathname — an empty list that means
 * "measured: nothing", which is a different answer from a route this file
 * forgot.
 */
const ROUTE_QUERY_KEYS = [
  ['GET /api/scan/export.csv', ['confirmed', 'q', 'sport', 'type']],
  ['GET /api/event-detail', ['away', 'home', 'kickoff', 'sport']],
  ['GET /api/odds/', ['eventKey', 'limit', 'marketKey']],
];
const QUERYLESS_ROUTE = 'GET /api/snapshot/';

/**
 * Which file sends which keys to which route.
 *
 * The pairing is the hand half: the keys themselves are read off the tree
 * below and compared against these rows, so a page that gains, drops or renames
 * a key fails here instead of at a user — at a download that came back with the
 * wrong rows, or a control that quietly stopped filtering.
 *
 * `/event.html` is a page channel, not an API route — see PAGE_CHANNELS.
 */
const SENDERS = [
  ['public/admin/scanner.html', 'GET /api/scan/export.csv', ['type']],
  ['public/index.html', 'GET /api/scan/export.csv', []],
  ['public/js/pages/arbitrage.js', 'GET /api/scan/export.csv', ['confirmed', 'q', 'sport']],
  ['public/js/pages/arbitrage.js', '/event.html', ['away', 'home', 'kickoff', 'sport']],
  ['public/js/pages/dashboard.js', '/event.html', ['away', 'home', 'kickoff', 'sport']],
  ['public/js/pages/event-detail-modal.js', 'GET /api/event-detail', ['away', 'home', 'kickoff', 'sport']],
  ['public/js/pages/event-detail.js', 'GET /api/event-detail', ['away', 'home', 'kickoff', 'sport']],
  ['public/js/pages/live.js', 'GET /api/odds/', ['limit']],
  ['public/js/pages/scrape.js', 'GET /api/odds/', ['eventKey', 'limit', 'marketKey']],
  ['public/js/pages/scanner.js', 'GET /api/scan/export.csv', ['sport']],
];

/** Links the browser parses itself: no route reads these keys, a page does. */
const PAGE_CHANNELS = ['/event.html'];
/** The one file that reads `window.location.search`, measured by grep over public/. */
const PAGE_READER = 'public/js/pages/event-detail.js';

/** The path part of a row's target: `GET /api/x` → `/api/x`; a channel is already a path. */
const pathOf = (route) => (route.includes(' ') ? route.slice(route.indexOf(' ') + 1) : route);

/**
 * sent → read: rows whose keys the receiving route does not read.
 *
 * @param {[string, string, string[]][]} rows
 * @param {Map<string, string[]>} routeKeys the backend's derived reads
 * @returns {string[]} one finding per offending key or missing route
 */
function sendsWithoutReads(rows, routeKeys) {
  const findings = [];
  for (const [file, route, keys] of rows) {
    if (PAGE_CHANNELS.includes(route)) continue;
    const read = routeKeys.get(route);
    if (!read) {
      findings.push(`${file} targets ${route}, which the router does not serve`);
      continue;
    }
    for (const key of keys) {
      if (!read.includes(key)) findings.push(`${file} sends ?${key} to ${route}, which reads [${read.join(', ')}]`);
    }
  }
  return findings;
}

/**
 * read → sent: keys a route reads that no listed sender puts on the wire.
 *
 * A route whose list is empty produces no finding — the list is the
 * measurement, and "reads nothing" needs nothing sent.
 *
 * @param {Map<string, string[]>} routeKeys
 * @param {[string, string, string[]][]} rows
 * @returns {string[]}
 */
function readsWithoutSenders(routeKeys, rows) {
  const findings = [];
  for (const [route, read] of routeKeys) {
    const sent = new Set(rows.filter((r) => r[1] === route).flatMap((r) => r[2]));
    for (const key of read) {
      if (!sent.has(key)) findings.push(`${route} reads ?${key}, which no page sends`);
    }
  }
  return findings;
}

/**
 * The two halves of every page-channel link: what the senders put on the URL
 * and what the page reads back off it.
 *
 * @param {[string, string, string[]][]} rows
 * @param {string[]} readKeys the keys PAGE_READER keeps
 * @returns {string[]}
 */
function pageChannelFindings(rows, readKeys) {
  const findings = [];
  const sent = new Set(rows.filter((r) => PAGE_CHANNELS.includes(r[1])).flatMap((r) => r[2]));
  for (const key of sent) {
    if (!readKeys.includes(key)) findings.push(`?${key} is sent to the page channel, which ${PAGE_READER} does not read`);
  }
  for (const key of readKeys) {
    if (!sent.has(key)) findings.push(`${PAGE_READER} reads ?${key} off the page, which no link sends`);
  }
  return findings;
}

// Both halves, off the tree.
const ROUTER = routeQueryKeys(read('src/router.mjs'));
const FRONT = new Map(
  publicFiles().map((f) => [f, frontendQueries(read(f), /\.(js|mjs)$/.test(f))])
);

test("the router's query reads all belong to a route, and only these routes read query keys", () => {
  // The instrument first: with no read found at all, every check below would
  // pass over an empty set, which is the failure this file exists to prevent.
  assert.ok(ROUTER.reads.length > 0, 'no query read was found in the router at all');
  // Measured: 4 in the export.csv handler, 3 in readOddsRoute, 4 in
  // readEventDetailRoute. The count is pinned so a fifth read arrives as a red
  // line here rather than as an unreviewed edit to the key lists above.
  assert.equal(ROUTER.reads.length, 11, 'the router reads eleven query keys (measured)');
  assert.deepEqual(ROUTER.unattributed, [],
    'a query read outside every route is a read this census cannot place:\n  '
    + ROUTER.unattributed.join('\n  '));
  assert.deepEqual(ROUTER.unresolved, [],
    'a `params` that is not a searchParams cannot pass as a query read:\n  '
    + ROUTER.unresolved.join('\n  '));
  assert.deepEqual(ROUTER.ambiguous, [],
    'a query read belongs to exactly one route:\n  ' + ROUTER.ambiguous.join('\n  '));

  const nonEmpty = ROUTER.routes.filter((r) => ROUTER.keys.get(r).length > 0);
  assert.deepEqual(nonEmpty.sort(), ROUTE_QUERY_KEYS.map(([r]) => r).sort(),
    'exactly these routes read query keys — a new reader appears here, a dropped one disappears');
  assert.ok(ROUTER.routes.length > 0, 'the derived route inventory is not empty');
  for (const [route, expected] of ROUTE_QUERY_KEYS) {
    assert.deepEqual([...(ROUTER.keys.get(route) ?? [])].sort(), [...expected].sort(),
      `${route} reads these keys`);
  }
  assert.deepEqual(ROUTER.keys.get(QUERYLESS_ROUTE), [],
    `${QUERYLESS_ROUTE} is served and reads no query at all — pathname only, `
    + 'and an empty list here is a measurement rather than an omission');

  // A query reader outside the router would be invisible to a route census:
  // the only file in src/ that mentions searchParams is the router itself.
  const elsewhere = sourceFiles(['src']).filter((f) => /searchParams/.test(codeOnly(read(f), true)));
  assert.deepEqual(elsewhere, ['src/router.mjs'],
    'src/router.mjs is the only file under src/ that touches a query string');
});

test('the frontend can put exactly these query keys on the wire, file by file', () => {
  assert.equal(FRONT.size, 32, 'public/ holds 32 js/html files and the walk reads every one');
  assert.ok(SENDERS.length > 0, 'the sender table is empty, so nothing below would run');
  const rowFiles = new Set(SENDERS.map((r) => r[0]));
  for (const file of rowFiles) {
    assert.ok(FRONT.has(file), `${file} is listed in this census but not present under public/`);
  }

  // A file that builds query keys without a row here is a sender nobody
  // censused — the direction a hand table drifts when a page starts filtering.
  const unlisted = [...FRONT]
    .filter(([file, q]) => q.keys.size > 0 && !rowFiles.has(file))
    .map(([file, q]) => `${file}: ${[...q.keys].sort().join(', ')}`);
  assert.deepEqual(unlisted, [],
    'these files put query keys on the wire without a row in this census:\n  '
    + unlisted.join('\n  '));

  // Per file: the rows' union is exactly what the tree says the file can send,
  // so a key added to a censused page or dropped from one fails here.
  for (const file of rowFiles) {
    const union = [...new Set(SENDERS.filter((r) => r[0] === file).flatMap((r) => r[2]))].sort();
    assert.deepEqual([...FRONT.get(file).keys].sort(), union, `${file} puts these keys on a query string`);
  }

  // Each row's target must still be named by the file it is attributed to:
  // a pairing row pointing at a URL the file no longer builds is stale.
  for (const [file, route] of SENDERS) {
    assert.ok(FRONT.get(file).urls.has(pathOf(route)), `${file} no longer names ${pathOf(route)}`);
  }

  // A bare fragment has no path to join it to; report it instead of missing it.
  const bare = [...FRONT].flatMap(([file, q]) => q.bareFragments.map((s) => `${file}: ${s}`));
  assert.deepEqual(bare, [],
    'a bare query fragment is below this census resolution and must be upgraded, not ignored:\n  '
    + bare.join('\n  '));

  // HTML is read as markup: an inline <script> would sit below that reading,
  // so the day one arrives it must arrive as a red line.
  const inline = publicFiles().filter((f) => f.endsWith('.html'))
    .flatMap((f) => [...read(f).matchAll(/<script[^>]*>/g)].map((m) => m[0])
      .filter((tag) => !/\ssrc=/.test(tag)).map((tag) => `${f}: ${tag}`));
  assert.deepEqual(inline, [],
    'an inline script in HTML would be invisible to the markup reading above:\n  '
    + inline.join('\n  '));
});

test('every query key a page sends is read by the route that receives it', () => {
  const findings = sendsWithoutReads(SENDERS, ROUTER.keys);
  assert.deepEqual(findings, [],
    'the frontend sends keys no route reads:\n  ' + findings.join('\n  '));

  // The rule can go red — a check that cannot fail passes everything.
  assert.equal(
    sendsWithoutReads(
      [...SENDERS, ['public/js/pages/ghost.js', 'GET /api/scan/export.csv', ['ghost']]],
      ROUTER.keys,
    ).length,
    1,
    'a key the receiving route does not read is a finding',
  );
  assert.equal(
    sendsWithoutReads([['public/js/pages/ghost.js', 'GET /api/nope', []]], ROUTER.keys).length,
    1,
    'a target the router does not serve is a finding',
  );
  const nonChannelRows = SENDERS.filter((r) => !PAGE_CHANNELS.includes(r[1])).length;
  assert.equal(sendsWithoutReads(SENDERS, new Map()).length, nonChannelRows,
    'with no routes at all every non-channel row is a finding, so an empty route map cannot pass quietly');
});

test('every query key a route reads is sent by at least one page', () => {
  const findings = readsWithoutSenders(ROUTER.keys, SENDERS);
  assert.deepEqual(findings, [],
    'the router reads keys no page sends:\n  ' + findings.join('\n  '));

  // The rule can go red, in both directions of emptiness.
  const ghost = new Map(ROUTER.keys);
  ghost.set('GET /api/scan/export.csv', [...ghost.get('GET /api/scan/export.csv'), 'ghost']);
  assert.equal(readsWithoutSenders(ghost, SENDERS).length, 1,
    'a read key nothing sends is a finding');
  assert.equal(readsWithoutSenders(new Map([['GET /api/x', ['a']]]), []).length, 1,
    'the rule is not vacuous: with no rows every read key is a finding');
});

test('the page channel carries exactly the keys event-detail.js reads', () => {
  // window.location.search is read in exactly one file, measured by grep over
  // public/ and pinned here: a second reader would be a second half of a
  // channel nothing checks.
  assert.deepEqual([...FRONT].filter(([, q]) => q.readKeys.size > 0).map(([f]) => f), [PAGE_READER],
    'the page query string is read in exactly one file');

  const readKeys = [...FRONT.get(PAGE_READER).readKeys].sort();
  assert.ok(readKeys.length > 0,
    'the page reads no keys at all, so the receiver half of the channel would read as absent');

  const findings = pageChannelFindings(SENDERS, readKeys);
  assert.deepEqual(findings, [],
    'the deep link and the page disagree:\n  ' + findings.join('\n  '));

  // The rule can go red on either side.
  assert.equal(
    pageChannelFindings([...SENDERS, ['public/js/pages/ghost.js', '/event.html', ['ghost']]], readKeys).length,
    1,
    'a key the page does not read is a finding',
  );
  assert.equal(pageChannelFindings(SENDERS, [...readKeys, 'ghost']).length, 1,
    'a key the page reads that no link sends is a finding');

  // The exception stays an exception: the router holds no route for the page.
  assert.deepEqual(ROUTER.routes.filter((r) => pathOf(r) === '/event.html'), [],
    '/event.html is a static page, not an API route — if the router ever serves it, it leaves PAGE_CHANNELS');
});

test('the extractors answer the same way on sources they have never seen', () => {
  // Backend: a table handler's read lands on that route; a *Route body's read
  // lands on the route of the branch that calls it.
  const fakeRouter = [
    'function buildRouter() {',
    '  const handlers = {',
    "    'GET /api/x': async (req) => {",
    "      const params = new URL(req.url, 'http://localhost').searchParams;",
    "      const ghost = params.get('ghost');",
    '      return sendJson(null, 200, ghost);',
    '    },',
    '  };',
    '  return async function route(req, res, parsedUrl) {',
    "    if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/y/')) {",
    '      return await yRoute(res, parsedUrl);',
    '    }',
    '    return null;',
    '  };',
    '}',
    'async function yRoute(res, parsedUrl) {',
    '  const params = parsedUrl.searchParams;',
    "  return sendJson(res, 200, params.get('ghost2'));",
    '}',
  ].join('\n');
  const got = routeQueryKeys(fakeRouter);
  assert.deepEqual(got.keys.get('GET /api/x'), ['ghost'],
    'a read inside a table handler is attributed to that route');
  assert.deepEqual(got.keys.get('GET /api/y/'), ['ghost2'],
    'a read inside a *Route body is attributed through the branch that calls it');
  assert.deepEqual(got.unattributed, []);
  assert.deepEqual(got.unresolved, []);
  assert.deepEqual(got.ambiguous, []);

  // Red: a read outside every route is reported, not dropped.
  const stray = routeQueryKeys("const found = params.get('stray');");
  assert.equal(stray.unattributed.length, 1, 'a query read outside every route is a finding');
  assert.equal(stray.keys.size, 0, 'and it is attributed to no route');

  // Red: a `params` that is not a searchParams cannot pass as a query read.
  const notParams = routeQueryKeys([
    'const handlers = {',
    "  'GET /api/z': async (req) => {",
    '    const params = req.params;',
    "    const id = params.get('id');",
    '    return id;',
    '  },',
    '};',
  ].join('\n'));
  assert.equal(notParams.unresolved.length, 1,
    'a `params` binding that is not a searchParams is unresolved');
  assert.deepEqual(notParams.keys.get('GET /api/z'), [],
    'and it counts as neither a read nor an absence');

  // Frontend: keys and URLs off an unseen source, in all three shapes.
  const fq = frontendQueries([
    'const u = `/api/odds/${book}?limit=2&ghost=1`;',
    'const p = new URLSearchParams({ fromObject: 1 });',
    "p.set('fromSet', 2);",
    'const link = `/event.html?${p}`;',
  ].join('\n'), true);
  assert.deepEqual([...fq.keys].sort(), ['fromObject', 'fromSet', 'ghost', 'limit'],
    'every shape contributes its keys');
  assert.ok(fq.urls.has('/api/odds/'), 'the path head survives the interpolation');
  assert.ok(fq.urls.has('/event.html'), 'and the page channel is named too');

  // Red: a bare fragment is reported instead of silently counted or missed.
  const bare = frontendQueries("const q = '?ghost=1';", true);
  assert.deepEqual(bare.bareFragments, ['?ghost=1'], 'a bare fragment is reported');
  assert.deepEqual([...bare.keys], [], 'and it is not silently counted as a key');

  // The receiver half of the page channel, in both forms it is written.
  const pageRead = frontendQueries([
    'const input = new URLSearchParams(window.location.search);',
    'const out = [];',
    "for (const key of ['sport', 'home']) out.push(input.get(key));",
  ].join('\n'), true);
  assert.deepEqual([...pageRead.readKeys].sort(), ['home', 'sport'],
    'a keep-list read off location.search is collected as the receiver half');
  assert.deepEqual([...pageRead.keys], [], 'reading the page does not count as sending it');

  const directRead = frontendQueries([
    'const input = new URLSearchParams(window.location.search);',
    "const a = input.get('sport');",
  ].join('\n'), true);
  assert.deepEqual([...directRead.readKeys], ['sport'],
    'the literal form of a page read is collected too');
});