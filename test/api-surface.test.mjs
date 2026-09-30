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
    reason: 'Diagnostic: one book\'s workspace snapshot verbatim, no matching involved. README "Diagnostic routes".',
  },
  {
    route: 'GET /api/odds/',
    reason: 'Diagnostic: the same file projected to prices with the per-market `live` flag. When /api/event-detail\'s heuristic matcher is itself under suspicion, a view built on that matcher cannot be the evidence. README "Diagnostic routes".',
  },
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
  for (const channel of CHANNELS) {
    for (const m of text.matchAll(channel.re)) {
      found.push({
        verb: channel.verb(m),
        path: normalize(m[channel.name === 'arbiterApi' ? 3 : 2]),
        file: relPath,
        line: lines[0, src.slice(0, m.index).split(/\r?\n/).length - 1],
        channel: channel.name,
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

test('every route the backend serves has a consumer on the frontend', () => {
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

  const detail = orphans.map(({ route, called }) => {
    const near = called.filter((c) => c.includes(route.split(' ')[1].split('/').pop()));
    return `  ${route}  (frontend paths seen: ${called.length}${near.length ? `, closest: ${near.join(', ')}` : ''})`;
  });
  assert.deepEqual(orphans.map((o) => o.route), [], `routes with no frontend consumer:\n${detail.join('\n')}`);
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