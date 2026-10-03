/**
 * snapshot-route.test.mjs — `GET /api/snapshot/:sourceId`, field by field.
 *
 * The route serves one book's capture verbatim, so its payload is not a document
 * this repo designs: it is whatever `_serializable` returns. That makes the
 * shape something to measure rather than to pin by hand, and it makes the
 * measurement live in two places — the base writer, and the 13 adapters that
 * override it. The first version of this census read only the base and found 9
 * keys, missing `coverage`, `sourceUrl`, `transport` and `scrapeLimits`
 * entirely, because those are added by the overrides.
 *
 * ── Why the stored captures are not the measurement ──────────────────────────
 *
 * The obvious sample is data-market-run/workspace, and for most of this tree's
 * reasoning it is a good one. It is not a good one here, and this file says so
 * rather than leaning on it: two of the keys those 22 files carry are emitted by
 * no writer in src/scrapers/**. A sample that describes a version of the writer
 * which no longer exists measures that version, and the tree's exemptions would
 * be resting on fields a fresh capture can never hold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/* ── the writer ────────────────────────────────────────────────────────────── */

/**
 * The keys one `_serializable` puts into the document it returns.
 *
 * Both written forms, because the base uses the shorthand and every override
 * uses the explicit one: `dataStatus,` is a key, and an instrument that reads
 * only `key:` calls it a key the files invented. The first version of this did,
 * and reported 6 keys where the base has 9.
 *
 * Bounded twice, both times because getting it wrong is silent rather than loud.
 * The outer bound stops at the next `}` in column 2, which is where the method
 * ends — without it the scan runs into `extractEvents` and credits that method's
 * keys to the document. The inner bound stops at the `};` that closes the
 * returned literal, because a `return { ...spread, key }` can be followed by more
 * code in the same method; without it `promise` came out as an emitted key and
 * was then reported missing on all 22 captures.
 *
 * @param {string} source one adapter's source, comments already blanked
 * @returns {string[]|null} null when the file declares no `_serializable`
 */
function serializableKeys(source) {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /^ {2}_serializable\(/.test(line));
  if (at === -1) return null;
  const close = lines.findIndex((line, i) => i > at && line === '  }');
  const body = lines.slice(at, close === -1 ? undefined : close).join('\n');
  const ret = body.indexOf('return {');
  if (ret === -1) throw new Error('a _serializable with no `return {` — the cut moved');
  const literal = body.slice(ret, body.indexOf('};', ret));
  const keys = new Set([
    ...[...literal.matchAll(/^ {4,6}(\w+):/gm)].map((m) => m[1]),
    ...[...literal.matchAll(/^ {4,6}(\w+),$/gm)].map((m) => m[1]),
  ]);
  if (!keys.size) throw new Error('a _serializable whose returned literal yields no keys — the cut moved');
  return [...keys].sort();
}

/** Every file under a directory that ends in .mjs, recursively. */
function mjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...mjsFiles(rel));
    else if (entry.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

const adapterFiles = mjsFiles('src/scrapers');
const overrides = new Map();
for (const file of adapterFiles) {
  const keys = serializableKeys(codeOnly(read(file), true));
  if (keys) overrides.set(file, keys);
}

/** The base writer's own keys — read by the same instrument, not a second rule. */
const BASE_KEYS = serializableKeys(codeOnly(read('src/scrapers/base.mjs'), true));

/**
 * Every key the route can publish, base included.
 *
 * The union rather than the base, because an override spreads the base's
 * document and adds its own keys — `...super._serializable(events, raw)` is in
 * every one of them, so nothing an override writes is lost, and everything the
 * base writes survives unless an override deletes it. No override does, which is
 * asserted below rather than assumed.
 */
const PUBLISHED = [...new Set([...BASE_KEYS, ...[...overrides.values()].flat()])].sort();

/**
 * What `GET /api/snapshot/:sourceId` publishes, measured.
 *
 * 13 keys. Four of them come from overrides rather than the base: `coverage`
 * from 9 adapters, `sourceUrl` from 7, `transport` from 6, `scrapeLimits` from
 * `favbet.mjs` alone. The route serves the document verbatim — readSnapshotRoute
 * hands the parsed file straight to sendJson — so this list is the payload.
 */
const SNAPSHOT_TOP = [
  'capturedAt', 'coverage', 'dataStatus', 'discovery', 'events', 'extraction',
  'observedAt', 'runId', 'schemaVersion', 'scrapeLimits', 'sourceId', 'sourceUrl', 'transport',
];

/* ── the stored sample ─────────────────────────────────────────────────────── */

const SAMPLE_DIR = 'data-market-run/workspace';
const sampleFiles = readdirSync(join(ROOT, SAMPLE_DIR)).filter((f) => f.endsWith('_events.json'));
const sampleKeys = new Set();
for (const file of sampleFiles) {
  for (const key of Object.keys(readJson(`${SAMPLE_DIR}/${file}`))) sampleKeys.add(key);
}
const unreachable = [...sampleKeys].filter((k) => !PUBLISHED.includes(k)).sort();

/* ── the tests ─────────────────────────────────────────────────────────────── */

/**
 * The route publishes what the writers write, and the list is the measurement.
 *
 * The comparison is the canary: an adapter that starts writing a fourteenth key
 * fails here rather than becoming one more field in a document nobody looks at.
 * It is the same shape as the pinned list in field-census.test.mjs, for the same
 * reason — a hand-kept list is a list that stops being true quietly.
 */
test('the snapshot route publishes exactly the keys the writers write', () => {
  assert.deepEqual(PUBLISHED, SNAPSHOT_TOP,
    'a writer gained or lost a key — re-measure it and decide whether the route still means to serve it verbatim');
  assert.deepEqual(BASE_KEYS,
    ['capturedAt', 'dataStatus', 'discovery', 'events', 'extraction', 'observedAt', 'runId', 'schemaVersion', 'sourceId'],
    'the base writer no longer emits this set — every override spreads it, so a change here lands on all 26 books');
  // The union is only the published shape because no override drops a base key,
  // and every one of them spreads rather than rebuilds. Both are claims about
  // 13 files, and both are cheap to check and impossible to notice by reading.
  assert.ok(overrides.size >= 13, `found ${overrides.size} _serializable overrides — the scan missed some`);
  const rebuilding = [...overrides].filter(([file]) => file !== 'src/scrapers/base.mjs'
    && !/\.\.\.super\._serializable\(/.test(read(file)));
  assert.deepEqual(rebuilding, [],
    'these overrides do not spread the base document, so the union above is not the published shape');
});

/**
 * The stored captures carry two keys no writer produces, so they are not
 * evidence about today's route.
 *
 * This is the reason the file exists. `marketDiagnostics` appears on 16 of the 22
 * captures and `responseEtag` on 7, and neither string occurs anywhere in
 * src/scrapers/** — so a capture written by this tree cannot carry either. The
 * captures are dated: `git log` puts the run that wrote them at 2026-09-26, and
 * the writer has not carried these keys since before it.
 *
 * It matters because `marketDiagnostics` is what two exemptions in
 * field-census.test.mjs were written against. Their conclusion was right and
 * their evidence was wrong: they cited the completeness numbers inside these
 * captures, and the case that no adapter produces the field is a case about the
 * writer. Both reasons are now rebased on the measurement below, which is the
 * point of writing it down — a conclusion reached by reasoning from a sample
 * that turned out to be stale is a conclusion waiting to be re-reached.
 */
test('the stored captures describe a writer this tree no longer has', () => {
  assert.ok(sampleFiles.length >= 20, `only ${sampleFiles.length} captures in ${SAMPLE_DIR} — the measurement would rest on a handful`);
  assert.deepEqual(unreachable, ['marketDiagnostics', 'responseEtag'],
    'a capture key gained or lost a producer — re-read which writer emits it before trusting this set again');
  // And the same claim from the source side, so the finding does not depend on
  // the parse above: neither name occurs in the adapters at all.
  for (const key of unreachable) {
    const inScrapers = mjsFiles('src/scrapers').filter((f) => read(f).includes(key));
    assert.deepEqual(inScrapers, [], `${key} is still written somewhere under src/scrapers — the sample is current again`);
  }
});

/**
 * The excuse the closure check carries for this route names only fields the
 * route can actually serve.
 *
 * `api-surface.test.mjs` holds the only entry that lets `/api/snapshot/` have no
 * consumer, and its reason used to list four "keys nothing else publishes" —
 * two of them (`marketDiagnostics`, `scrapeLimits`) among keys no fresh capture
 * carries, and `marketDiagnostics` among them because it was in 16 of the 22
 * files above. An excuse is only as good as what it claims, so the claim is
 * checked here against the writers this file measures.
 */
test('the closure check\'s excuse for this route names only reachable keys', () => {
  const surface = read('test/api-surface.test.mjs');
  const at = surface.indexOf("route: 'GET /api/snapshot/'");
  assert.notEqual(at, -1, '/api/snapshot/ left BACKEND_ONLY — the census here may be answering a question nothing asks');
  const reason = /reason:\s*'((?:[^'\\]|\\.)*)'/.exec(surface.slice(at))?.[1] ?? '';
  assert.ok(reason.length > 40, 'the entry carries no reason to check');
  const named = [...new Set([...reason.matchAll(/`(\w+)`/g)].map((m) => m[1]))]
    // A leading underscore marks a member of the code, not a field of the
    // document — the reason names `_serializable`, the method that builds the
    // payload, and the check below is about the payload.
    .filter((k) => !k.startsWith('_'));
  assert.ok(named.length >= 3, `the reason names ${named.length} document keys — the check below has nothing to check`);
  const unreachableNamed = named.filter((k) => !PUBLISHED.includes(k));
  assert.deepEqual(unreachableNamed, [],
    `the excuse names keys this route cannot serve: ${unreachableNamed.join(', ')} — measured against the writers above`);
});