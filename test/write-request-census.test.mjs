/**
 * write-request-census.test.mjs — every write the frontend makes, field by field.
 *
 * The rest of this audit works from the other end: the response side is censused
 * field by field against the pages that read it (api-surface, field-census,
 * alert-ui, analytics-page), and this file is the request side, which had none.
 * Nine write routes were checked by hand across this audit's earlier passes and
 * the hand answers were right — but a hand answer is a memory, and one of them
 * was wrong the moment it was written: `settings.js` posted `bookIds` alone to
 * `POST /api/scrape`, so a launch from the page that owns six scan fields threw
 * all of them away and eight of eight configured options silently reverted to
 * their defaults. Nothing in the suite could see it, because nothing asked what
 * the page sent.
 *
 * So the answer is measured instead: the call sites are read off the parse tree
 * and compared against a table written out by hand. The hand answer stays, but
 * it has to survive a disagreement to do any good — a table that read itself off
 * the tree would agree with any drift in the tree, and would have agreed with
 * the bug above.
 *
 * ── What this pins ───────────────────────────────────────────────────────────
 *
 * Every `arbiterApi.post/put/delete` call in `public/js`: its method, its route,
 * and the keys that reach the wire — read off a body literal, or off the
 * declaration a body name stands for. A page that gains, drops or renames a key
 * fails here instead of at a user, and a key written but never serialized does
 * too.
 *
 * ── What this does not pin, and where it stops ───────────────────────────────
 *
 * A body that is a name is followed. `payload` on the two pages that build one
 * is a local object literal in the scope that holds the call, so the census
 * reads its keys off the declaration and reports where that declaration is —
 * a name this cannot follow comes back as `null`, which is a different answer
 * from "sends nothing", and the test below refuses to confuse them.
 *
 * What stops one level deeper. `scanOptions` is a key on those bodies and an
 * assembled object on the far side of it, `{ ...kept, ...profileDefaults(),
 * ...scanOptionsFromForm() }`, whose members no static reading can list: what
 * `stored` holds depends on what the server last saved. Guessing at them would
 * be a measurement dressed as a claim, so they are executed instead —
 * test/settings-page-wiring.test.mjs fires the scrape launch over the real
 * router and counts the options that survive, and the alert census follows
 * `readAlertForm` to the keys it posts. A spread of a name stays unresolved for
 * the same reason and is named in the table, so the edge is visible rather than
 * absent.
 *
 * The reader half of the table is deliberately blunt: a key counts as read when
 * the named backend file still mentions it in the position it claims. That can
 * only let a key pass, never invent one — the failure this census exists to catch
 * is a key the page sends and nobody reads, which a presence check cannot miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, functionSource, writeCallSites } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const JS_DIR = join(ROOT, 'public/js');

/** Every `.js` under public/js, walked rather than listed. */
function frontendScripts(dir = JS_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) frontendScripts(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const PAGE_DIR = join(JS_DIR, 'pages');

/**
 * The route a call addresses, for matching.
 *
 * A path built by concatenation is not a string literal, so it arrives as the
 * expression it is; the piece in front of the first `+` is the part that names
 * the route, and the argument after it is an id the table has no business
 * pinning. Both trackers write `'/api/tracker/' + encodeURIComponent(id)`, which
 * is one route with two callers, and matching on the literal piece is what keeps
 * them from reading as two routes half of which no route answers.
 */
const routeOf = (site) => (site.path
  ?? site.pathText.split('+')[0].trim().replace(/;$/, '').replace(/['"`]/g, ''));

/** Every write call site, with the path relative to the repo root. */
const CALLS = frontendScripts(PAGE_DIR)
  .map((file) => ({ file: relative(ROOT, file).replace(/\\/g, '/'), sites: writeCallSites(readFileSync(file, 'utf8')) }))
  .flatMap(({ file, sites }) => sites.map((site) => ({ ...site, file })));

const routerCode = codeOnly(read('src/router.mjs'), true);
const orchestratorSource = read('src/scrape-orchestrator.mjs');
const trackerSource = read('src/tracker-service.mjs');
const resolveScanRequest = codeOnly(functionSource(orchestratorSource, 'resolveScanRequest').text, true);
const normalizeBet = codeOnly(functionSource(trackerSource, 'normalizeBet').text, true);

/**
 * Where each key is read on the other side.
 *
 * A key with no entry is not exempt — it is a finding, and the test below says
 * so. That is the difference between this list and the exemption maps the
 * response-side censuses carry: there, a field the page does not read is a
 * deliberate thing the route publishes for someone else. Here, a field the page
 * sends and the backend never reads is a setting the user believes was saved.
 */
const READERS = {
  bookIds: () => /body\.bookIds/.test(routerCode),
  enabled: () => /body\.enabled/.test(routerCode),
  intervalMinutes: () => /body\.intervalMinutes/.test(routerCode),
  intervalSeconds: () => /body\.intervalSeconds/.test(routerCode),
  scanOptions: () => /body\.scanOptions/.test(routerCode),
  preferences: () => /body\.preferences/.test(routerCode),
  csv: () => /body\.csv/.test(routerCode),
  // `POST /api/scan` hands the whole body to the resolver, which is where these
  // names are read.
  bankroll: () => /\bbankroll\b/.test(resolveScanRequest),
  minMarginPercent: () => /\bminMarginPercent\b/.test(resolveScanRequest),
  minMiddleRoiPercent: () => /\bminMiddleRoiPercent\b/.test(resolveScanRequest),
  maxMiddleRiskPercent: () => /\bmaxMiddleRiskPercent\b/.test(resolveScanRequest),
  includeLive: () => /\bincludeLive\b/.test(resolveScanRequest),
  includePast: () => /\bincludePast\b/.test(resolveScanRequest),
  sport: () => /\bsport\b/.test(resolveScanRequest),
  // The tracker normalises the posted object field by field.
  selection: () => /\bselection\b/.test(normalizeBet),
  odds: () => /\bodds\b/.test(normalizeBet),
  stake: () => /\bstake\b/.test(normalizeBet),
  sourceId: () => /\bsourceId\b/.test(normalizeBet),
  marketKey: () => /\bmarketKey\b/.test(normalizeBet),
  status: () => /\bstatus\b/.test(normalizeBet),
  provenance: () => /\bprovenance\b/.test(normalizeBet),
};

/**
 * The keys a call actually puts on the wire.
 *
 * `null` when the body is a name this could not follow, which is deliberately
 * not an empty array: an empty array would satisfy the table below for a send
 * nothing proved about, and `sentKeys` returning `null` is what makes that
 * impossible.
 */
const sentKeys = (site) => (site.bodyName ? site.namedBody?.keys ?? null : site.keys);
const sentDropped = (site) => (site.bodyName ? site.namedBody?.dropped ?? null : site.dropped);

/**
 * What each call site sends, classified.
 *
 * `keys` for what goes on the wire — read off the literal, or off the literal
 * the body name stands for. `body` names that declaration path where the body
 * is a name, so a reader can see where the answer came from instead of having
 * to trust it. Written out here rather than derived, because the derived list
 * is the thing being checked — a table that read itself off the tree would
 * agree with any drift in the tree. The comparison below is what makes the two
 * independent.
 */
const EXPECTED = [
  ['public/js/pages/analytics.js', 'delete', '/api/tracker/', { keys: [] }],
  ['public/js/pages/analytics.js', 'put', '/api/tracker/', { keys: ['status'] }],
  ['public/js/pages/analytics.js', 'post', '/api/tracker', {
    keys: ['marketKey', 'odds', 'provenance', 'selection', 'sourceId', 'stake', 'status'],
  }],
  ['public/js/pages/analytics.js', 'post', '/api/tracker/import', { keys: ['csv'] }],
  ['public/js/pages/live.js', 'post', '/api/live', {
    body: 'payload',
    at: 236,
    keys: ['bookIds', 'enabled', 'intervalSeconds', 'scanOptions'],
  }],
  ['public/js/pages/scanner.js', 'post', '/api/alerts', { keys: ['preferences'] }],
  ['public/js/pages/scanner.js', 'post', '/api/scan', {
    keys: ['bankroll', 'includeLive', 'includePast', 'maxMiddleRiskPercent', 'minMarginPercent', 'minMiddleRoiPercent'],
    // Spread in, and counted: `...(sportVal ? { sport: sportVal } : {})`. Reading
    // the body as a plain key list dropped this, and the page then read as not
    // filtering by sport when the line below it did exactly that.
    spreads: [['sport']],
  }],
  ['public/js/pages/scanner.js', 'post', '/api/verify', { keys: [] }],
  ['public/js/pages/scrape.js', 'post', '/api/scrape', { keys: ['bookIds', 'scanOptions'] }],
  ['public/js/pages/scrape.js', 'post', '/api/scrape/cancel', { keys: [] }],
  ['public/js/pages/scrape.js', 'post', '/api/scheduler', { keys: ['bookIds', 'enabled', 'intervalMinutes', 'scanOptions'] }],
  ['public/js/pages/scrape.js', 'post', '/api/live', { keys: ['bookIds', 'enabled', 'intervalSeconds', 'scanOptions'] }],
  ['public/js/pages/settings.js', 'post', '/api/scheduler', {
    body: 'payload',
    at: 266,
    keys: ['bookIds', 'enabled', 'intervalMinutes', 'scanOptions'],
  }],
  ['public/js/pages/settings.js', 'post', '/api/scrape', { keys: ['bookIds', 'scanOptions'] }],
];

test('the frontend writes exactly the calls this census lists', () => {
  // A new call site is a new route contract, and it arrives here rather than in
  // production. An empty derived list would satisfy the equality below, so the
  // count is checked against the table and not against itself.
  assert.equal(CALLS.length, EXPECTED.length,
    `the tree has ${CALLS.length} write call sites and this file lists ${EXPECTED.length}`);
  assert.ok(CALLS.length > 0, 'no write call site was found at all');
  assert.ok(CALLS.every((c) => routeOf(c).length > 0),
    'a call site whose route could not be reconstructed would match nothing and pass quietly');

  for (const [file, method, path, shape] of EXPECTED) {
    const found = CALLS.filter((c) => c.file === file && c.method === method && routeOf(c) === path);
    assert.equal(found.length, 1, `${file} makes ${found.length} ${method} calls to ${path}, this file lists one`);
    const site = found[0];

    if (shape.body) {
      assert.equal(site.bodyName, shape.body,
        `${file}:${site.line} sends ${site.bodyName ?? 'a literal'}, this file says ${shape.body}`);
      // Following the name is the point of `body`; an unresolved one would leave
      // `keys` empty and the assertion below would pass for the wrong reason.
      assert.ok(site.namedBody,
        `${file}:${site.line} sends the name ${shape.body}, which this census cannot follow to a literal`);
      assert.equal(site.namedBody.line, shape.at,
        `${file}:${site.line} reads ${shape.body} from a declaration this file does not name`);
    } else {
      assert.equal(site.bodyName, null, `${file}:${site.line} sends a named body now`);
    }

    assert.deepEqual(sentKeys(site), shape.keys, `${file}:${site.line} sends these keys`);
    // A key written and never arriving reads as sent to any census of names.
    // `intervalMinutes: Number(…) || undefined` is conditional and not reported
    // here; `x: undefined` is not, and `JSON.stringify` drops it.
    assert.deepEqual(sentDropped(site), [], `${file}:${site.line} writes these keys and they never reach the route`);
    assert.deepEqual(site.spreads.map((s) => s.keys ?? null), (shape.spreads ?? []).map((k) => k),
      `${file}:${site.line} spreads these`);
  }
});

test('every key a page sends is read by the route that receives it', () => {
  const sent = new Map();
  for (const site of CALLS) {
    // `sentKeys` and not `keys`: the two named bodies resolve to their
    // declarations' keys, and those are the ones that go on the wire. Reading
    // `keys` here would leave `intervalMinutes` unchecked by anything — the
    // scheduler's own interval, on the one page that owns it.
    const keys = sentKeys(site);
    assert.ok(keys,
      `${site.file}:${site.line} sends the name ${site.bodyName}, which no reader below accounts for`);
    for (const key of [...keys, ...site.spreads.flatMap((s) => s.keys ?? [])]) {
      const at = sent.get(key) || [];
      at.push(`${site.file}:${site.line}`);
      sent.set(key, at);
    }
  }

  assert.ok(sent.size > 0, 'no key was found on any call site, so nothing below would run');

  const unreadable = [];
  for (const [key, where] of sent) {
    const reader = READERS[key];
    if (!reader) {
      unreadable.push(`${key} (sent from ${where.join(', ')}; no backend reader is named for it)`);
      continue;
    }
    if (!reader()) unreadable.push(`${key} (sent from ${where.join(', ')}; its named reader no longer mentions it)`);
  }
  assert.deepEqual(unreadable, [],
    `the frontend sends keys no backend reader accounts for:\n  ${unreadable.join('\n  ')}`);
});

test('the census can tell a call site that changed from one that did not', () => {
  // Both directions, because a check that cannot fail passes everything.
  const scanner = CALLS.find((c) => c.file === 'public/js/pages/scanner.js' && c.path === '/api/scan');
  assert.ok(scanner, 'the scan launch was not found to compare against');
  assert.deepEqual([...scanner.keys, ...scanner.spreads.flatMap((s) => s.keys)],
    ['bankroll', 'includeLive', 'includePast', 'maxMiddleRiskPercent', 'minMarginPercent',
      'minMiddleRoiPercent', 'sport'],
    'the body really carries these keys, spread included');

  const drop = (keys) => keys.filter((k) => k !== 'sport');
  assert.ok(drop(scanner.spreads.flatMap((s) => s.keys)).length === 0,
    'and dropping the spread really does change the answer');

  // A key nobody reads is rejected by the same rule the census applies.
  assert.equal(READERS.sport(), true,
    'the reader for a key this file routes through the resolver answers true');
  assert.equal(READERS.selectionThatDoesNotExist, undefined,
    'and a key with no named reader is not quietly allowed through');
});

test('following a body name reads the declaration in scope, not the first one', () => {
  // live.js declares `payload` twice: once inside `loadEvents`, where it is a
  // GET result (`outcome.value`, not a literal at all), and once inside the
  // apply-thresholds listener. A lookup by name alone takes the first and the
  // send reads as unresolvable — or, before the reassignment guard was taught by
  // injection, as carrying keys an assignment had already replaced.
  const live = CALLS.find((c) => c.file === 'public/js/pages/live.js' && c.path === '/api/live');
  assert.ok(live, 'the live save was not found to resolve a body for');
  assert.equal(live.namedBody.line, 236,
    'the live payload resolved to the declaration in its own scope');
  assert.notEqual(live.namedBody.line, 160,
    'and not to the unrelated `payload` that loadEvents binds first');

  const settings = CALLS.find((c) => c.file === 'public/js/pages/settings.js'
    && c.method === 'post' && c.path === '/api/scheduler');
  assert.ok(settings, 'the scheduler save was not found to resolve a body for');
  assert.deepEqual(sentKeys(settings), ['bookIds', 'enabled', 'intervalMinutes', 'scanOptions'],
    'the settings payload resolves to the four keys the scheduler route reads');

  // Unfollowable is not empty: a name this cannot resolve reports `null`, which
  // the table above treats as a failure rather than as a body carrying nothing.
  const unfollowable = writeCallSites('async function p() {\n'
    + '  let payload = { a: 1 };\n'
    + '  payload = { b: 2 };\n'
    + "  await arbiterApi.post('/api/x', payload);\n"
    + '}');
  assert.equal(unfollowable[0].namedBody, null,
    'a name reassigned before the call resolves to nothing rather than to a guess');
  assert.deepEqual(unfollowable[0].keys, [],
    'and it is still not reported as an empty body');
});