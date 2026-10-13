/**
 * api-gateway-census.test.mjs — the two contracts every page crosses and no
 * other census rules on: the CSRF token of `GET /api/csrf`, and the HTTP error
 * envelope the router serves on every non-2xx.
 *
 * `public/js/api.js` is the only frontend file that touches either. It sits
 * under every read and every mutation a page makes — `arbiterApi.get/post/
 * put/del` are this file's exports — and until this census nothing executed it:
 * alert-ui.test.mjs asserts that a page *lists* it as a script dependency, and
 * scrape-ui.browser.test.mjs observes the token header it produces from a real
 * browser, but no test drove its own branches. A gateway whose CSRF read broke
 * would fail every mutation in the product while every test stayed green, and
 * the error envelope — the one payload shape all 30 served routes share when
 * they fail — had no reader-side check either.
 *
 * Executed, not read. The payload goes through `JSON.parse` inside `parse()`
 * (and through `res.json()` inside `getCsrf()`), so the recording has to happen
 * at those two points — a Proxy handed to the gateway after the fact would be
 * a Proxy of nothing. This is the same rule the SSE census learned: the object
 * a page touches is born at the parse, so that is where the census listens.
 *
 * What this file cannot see: a page that reaches past the thrown Error into
 * `err.data.error.*`. There is no such line today (asserted below by grep over
 * public/ and electron/), which is why the gateway's reads are the whole
 * read-side for these two payloads — if that grep ever finds a line, this file
 * says so rather than silently under-counting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ── the recorder ──────────────────────────────────────────────────────────── */

/**
 * Wrap a payload so every property access lands in `hits`.
 *
 * Arrays go through their own methods with `this` bound to the wrapper, which
 * is what makes element reads visible: `raw.map(fn)` iterates the raw target
 * and the callback never sees a wrapped element, while `fn.call(wrapper)`
 * makes `Get(proxy, i)` record `path[].key` for each item the page touches.
 */
function record(value, path, hits) {
  if (value === null || typeof value !== 'object') return value;
  hits.add(path || '(root)');
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      const child = path ? `${path}.${String(prop)}` : String(prop);
      hits.add(child);
      const raw = target[prop];
      if (typeof raw === 'function') {
        const self = record(target, path, hits);
        return (...args) => raw.apply(self, args);
      }
      return record(raw, child, hits);
    },
  });
}

/** Reads that are artefacts of the harness, not payload leaves. */
const SYNTHETIC = new Set(['(root)', 'then']);

const payloadReads = (hits) => [...hits].filter((k) => !SYNTHETIC.has(k)).sort();

/**
 * Run the real `public/js/api.js` against a scripted fetch.
 *
 * `respond(path, opts)` returns the response stub; `{ json, text, ok, status,
 * statusText }` is all api.js touches. Both parse points record into the same
 * hits set, because the gateway reads both payloads.
 */
async function runGateway(respond) {
  const src = read('public/js/api.js');
  const hits = new Set();
  const fetches = [];
  const realParse = JSON.parse;
  const context = {
    console,
    JSON: {
      parse: (s) => record(realParse(s), '', hits),
      stringify: (v) => JSON.stringify(v),
    },
    fetch: async (path, opts) => {
      fetches.push({
        path: String(path),
        method: opts?.method ?? 'GET',
        headers: { ...(opts?.headers ?? {}) },
      });
      const r = respond(String(path), opts);
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        statusText: r.statusText ?? '',
        json: async () => record(realParse(JSON.stringify(r.body)), '', hits),
        text: async () => JSON.stringify(r.body),
      };
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(src, context);
  return { api: context.arbiterApi, hits, fetches };
}

/* ── the producers, derived ────────────────────────────────────────────────── */

/** Every `error: { … }` block the router serves — the co-located HTTP surface. */
const routerSource = codeOnly(read('src/router.mjs'), true);
const ENVELOPE_BLOCKS = [...routerSource.matchAll(/error:\s*\{([^{}]+)\}/g)].map((m) => m[1]);

/** The union of keys any of those blocks can put on the wire. */
const ENVELOPE_KEYS = [...new Set(
  ENVELOPE_BLOCKS.flatMap((b) => [...b.matchAll(/\b(\w+):\s/g)].map((m) => m[1])),
)].sort();

const staticValue = (block, key) => {
  const m = new RegExp(`\\b${key}:\\s*('[^']*'|"[^"]*")`).exec(block);
  return m ? m[1].slice(1, -1) : null;
};

const NAMES = ENVELOPE_BLOCKS.map((b) => staticValue(b, 'name')).filter(Boolean);
const CODES = ENVELOPE_BLOCKS.map((b) => staticValue(b, 'code')).filter(Boolean);

/* ── the excuses ───────────────────────────────────────────────────────────── */

/**
 * The one envelope leaf no frontend line reads, with the measurement.
 *
 * The gateway maps the envelope onto a local Error — `message` becomes
 * `err.message`, `code` becomes `err.code` — and those two are the whole
 * contract a page discriminates on: scanner.js branches on
 * `err.code === 'ENOSCAN'`, and no line anywhere reads a response's
 * `error.name` (the grep test below keeps that count at zero). The name the
 * server writes is either a class echo (`err.name || 'Error'`, router catch)
 * or a literal coarser than its code: measured over the router's own blocks,
 * 6 distinct name literals against 9 distinct code literals, so a page that
 * branched on name could not tell apart any pair the code already separates.
 *
 * It is listed rather than wired because wiring it would mean renaming the
 * local Error class (`err.name = data.error.name`) — scrape.js:1171 already
 * prints `err.name` as *the error object's own class*, and that line is about
 * the error the gateway threw, not about a string from the server.
 */
const EXCUSES = [
  {
    id: 'server-error-class',
    covers: ['error.name'],
    reason: [
      'The server-side error class. The gateway carries message and code onto the thrown',
      'Error and nothing else does; no frontend line reads a response error.name (grep test',
      'below), the only branch a page makes on an error keys a code (err.code === ENOSCAN),',
      'and the router writes 6 distinct name literals against 9 distinct code literals — name',
      'is the coarser label, so a name-branch could separate fewer pairs than the code already',
      'does. Copying it into err.name would overwrite the class of the local error that',
      'scrape.js:1171 prints.',
    ].join(' '),
    measuredBy: 'the router writes 6 distinct name literals against 9 distinct code literals, and no frontend line reads error.name off a response',
  },
];

const unaccounted = (reads, keys) => keys.filter((k) => !reads.includes(k));

/* ── tests ─────────────────────────────────────────────────────────────────── */

test('the gateway reads the token the csrf route sends, and the mutation carries it', async () => {
  const TOKEN = 'tok-census-123';
  const { api, hits, fetches } = await runGateway((path) => {
    if (path === '/api/csrf') return { ok: true, body: { token: TOKEN } };
    return { ok: true, body: { accepted: true } };
  });

  await api.getCsrf();
  const reads = payloadReads(hits);
  assert.ok(reads.includes('token'),
    `GET /api/csrf serves { token } and the gateway read none of it: ${reads.join(', ')}`);
  assert.equal(fetches[0].path, '/api/csrf', 'the first thing the gateway asks for is the token');

  // The material half: the token off the wire is the token on the header, and
  // the cached value is what every later mutation attaches.
  hits.clear();
  await api.post('/api/anything', { a: 1 });
  const post = fetches.find((f) => f.path === '/api/anything');
  assert.equal(post.headers['x-arbiter-token'], TOKEN,
    'the token the route served is not the token the mutation sends');
  assert.equal(fetches.filter((f) => f.path === '/api/csrf').length, 1,
    'the token was refetched instead of cached');

  // The door, demonstrated: a key the route could gain is reported unread by
  // the same closure rule the assertion above passes on.
  const augmented = await runGateway((path) => (path === '/api/csrf'
    ? { ok: true, body: { token: TOKEN, ttlSeconds: 300 } }
    : { ok: true, body: {} }));
  await augmented.api.getCsrf();
  assert.deepEqual(unaccounted(payloadReads(augmented.hits), ['token', 'ttlSeconds']), ['ttlSeconds'],
    'a key the route gained was not reported unread — the closure rule this test stands on cannot fail');
});

test('the error envelope the router serves is fully accounted: read or excused', async () => {
  assert.ok(ENVELOPE_BLOCKS.length >= 10,
    `only ${ENVELOPE_BLOCKS.length} error blocks were extracted from router.mjs — the derivation stopped seeing them`);
  assert.deepEqual(ENVELOPE_KEYS, ['code', 'message', 'name'],
    `the router's error envelopes changed shape — a new key arrives read or with an excuse: ${ENVELOPE_KEYS.join(', ')}`);

  const { api, hits } = await runGateway((path) => {
    if (path === '/api/csrf') return { ok: true, body: { token: 't' } };
    return {
      ok: false, status: 409, statusText: 'Conflict',
      body: { error: { name: 'Error', message: 'another scrape is running', code: 'EBUSY' } },
    };
  });
  let thrown = null;
  try {
    await api.post('/api/whatever', { a: 1 });
  } catch (err) {
    thrown = err;
  }
  // The mapping itself, asserted on the object a page actually catches: the
  // server's message and code survive the trip, which is what makes them the
  // read half of this contract rather than two keys nobody can reach.
  // (Cross-realm: the Error is constructed inside the vm, so `instanceof`
  // answers false against this realm's Error — the tag is the realm-safe test.)
  assert.equal(Object.prototype.toString.call(thrown), '[object Error]',
    'a 409 envelope did not become a thrown Error');
  assert.equal(thrown.message, 'another scrape is running', 'the message did not survive the gateway');
  assert.equal(thrown.code, 'EBUSY', 'the code did not survive the gateway');
  const reads = payloadReads(hits);
  assert.ok(reads.includes('error.message') && reads.includes('error.code'),
    `the gateway stopped mapping the envelope: ${reads.join(', ')}`);

  const unread = unaccounted(reads, ENVELOPE_KEYS.map((k) => `error.${k}`));
  const excused = EXCUSES.flatMap((e) => e.covers);
  const dropped = unread.filter((u) => !excused.includes(u));
  assert.deepEqual(dropped, [],
    `published by the router, read by nobody, excused by nothing: ${dropped.join(', ')}`);

  // An excuse must stay tied to the reason it was written for: every leaf it
  // names has to still be unread. If a page starts reading error.name, this
  // fails and the group is deleted, not widened.
  for (const excuse of EXCUSES) {
    const nowRead = excuse.covers.filter((c) => reads.includes(c));
    assert.deepEqual(nowRead, [],
      `${excuse.id ?? excuse.covers.join('/')} now covers a leaf the gateway reads: ${nowRead.join(', ')}`);
  }

  // The door, same direction as the csrf one: an envelope key the router could
  // gain is flagged by the same closure rule.
  const augmented = await runGateway((path) => (path === '/api/csrf'
    ? { ok: true, body: { token: 't' } }
    : { ok: false, status: 400, body: { error: { name: 'BadRequest', message: 'x', code: 'EY', at: '2030-01-01' } } }));
  const flagged = unaccounted(payloadReads(augmented.hits), ['error.at']);
  assert.deepEqual(flagged, ['error.at'],
    'a new envelope key was not reported unread — the closure rule cannot fail');
});

test('the measurements the envelope excuse quotes are the ones this file measured', () => {
  // The two counts, re-derived here from the same blocks the excuse was
  // written against. If the router's vocabulary moves, this fails and the
  // reason is re-measured instead of quietly going stale.
  const names = [...new Set(NAMES)];
  const codes = [...new Set(CODES)];
  assert.ok(names.length >= 3, `only ${names.length} distinct name literals — extraction broke`);
  assert.ok(codes.length >= 4, `only ${codes.length} distinct code literals — extraction broke`);
  assert.ok(names.length < codes.length,
    `the excuse claims name is the coarser label: ${names.length} names vs ${codes.length} codes`);

  // The branch that makes code the discriminator. Pinned to the file and the
  // comparison, not to a line number, so refactors that keep the branch keep
  // the reason.
  const scanner = read('public/js/pages/scanner.js');
  assert.match(codeOnly(scanner, true), /err\.code\s*===\s*'ENOSCAN'/,
    'the page no longer branches on a code — the excuse measured the wrong discriminator');

  // No reader of the envelope's name may exist anywhere; err.data.* is the
  // escape hatch a page would use to reach past the thrown Error.
  const offenders = [];
  for (const dir of ['public', 'electron']) {
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|mjs|html)$/.test(entry.name)) continue;
        const text = codeOnly(readFileSync(full, 'utf8'), /\.(js|mjs)$/.test(full));
        if (/(?:data|res|body|err\.data)\??\.error\??\.name\b/.test(text)) offenders.push(full);
      }
    };
    walk(join(ROOT, dir));
  }
  assert.deepEqual(offenders, [],
    'a line reads a response error.name — the envelope excuse is stale, delete it from the group');
});
