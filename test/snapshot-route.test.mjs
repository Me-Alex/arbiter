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
import { createRequire } from 'node:module';
const { parse } = createRequire(import.meta.url)('espree');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ── the writer ────────────────────────────────────────────────────────────── */

/** Read returned object keys by syntax, including spreads and local aliases.
 * Unknown shapes fail explicitly; nested value keys are not document keys.
 */
function serializableKeys(source, inherited = []) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const methods = [];
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
    visit(node);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, visit);
  }
  walk(tree, (node) => {
    if (node.type === 'MethodDefinition' && (node.key.name || node.key.value) === '_serializable') methods.push(node);
  });
  if (!methods.length) return null;
  const keys = new Set();
  for (const method of methods) {
    const bindings = new Map();
    const writes = new Map();
    const returns = [];
    walk(method.value.body, (node) => {
      if (node.type === 'VariableDeclarator') bindings.set(node.id.name, node.init);
      if (node.type === 'ReturnStatement') returns.push(node.argument);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        let member = node.left;
        while (member.object.type === 'MemberExpression') member = member.object;
        if (member.object.type === 'Identifier') {
          const key = member.computed ? member.property.value : member.property.name;
          assert.equal(typeof key, 'string', 'unresolved computed serializer property');
          const name = member.object.name;
          if (!writes.has(name)) writes.set(name, new Set());
          writes.get(name).add(key);
        }
      }
      assert.ok(!(node.type === 'UnaryExpression' && node.operator === 'delete'),
        'a serializer deletes a key; its returned shape needs explicit analysis');
    });
    function returned(node, seen = new Set()) {
      assert.ok(node, 'a serializer returns no document');
      if (node.type === 'ObjectExpression') return node.properties.flatMap((p) => {
        if (p.type === 'SpreadElement') return returned(p.argument, seen);
        const key = p.computed ? p.key.value : p.key.name ?? p.key.value;
        assert.equal(typeof key, 'string', 'unresolved serializer key');
        return [key];
      });
      if (node.type === 'Identifier') {
        assert.ok(!seen.has(node.name) && bindings.has(node.name), `unresolved serializer alias: ${node.name}`);
        return [...returned(bindings.get(node.name), new Set([...seen, node.name])), ...(writes.get(node.name) || [])];
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        if (node.callee.object.type === 'Super' && node.callee.property.name === '_serializable') return inherited;
        if (node.callee.object.name === 'Object' && node.callee.property.name === 'assign') {
          return node.arguments.flatMap((arg) => returned(arg, seen));
        }
      }
      if (node.type === 'ConditionalExpression') return [...returned(node.consequent, seen), ...returned(node.alternate, seen)];
      throw new Error(`unresolved serializer return shape: ${node.type}`);
    }
    assert.ok(returns.length > 0, 'a serializer has no return');
    for (const value of returns) for (const key of returned(value)) keys.add(key);
  }
  assert.ok(keys.size > 0, 'a serializer yielded no document keys');
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
const BASE_KEYS = serializableKeys(read('src/scrapers/base.mjs'));
const overrides = new Map();
for (const file of adapterFiles) {
  const keys = serializableKeys(read(file), BASE_KEYS);
  if (keys) overrides.set(file, keys);
}

// Parent serializers also join this union, so forwarding an inherited
// document does not lose keys introduced between an adapter and the base.
const PUBLISHED = [...new Set([...overrides.values()].flat())].sort();

const SAMPLE_DIR = 'data-market-run/workspace';
const sampleFiles = readdirSync(join(ROOT, SAMPLE_DIR)).filter((f) => f.endsWith('_events.json'));
const sampleKeys = new Set();

/**
 * What the captures hold below the top-level keys, measured in the same pass.
 *
 * Three exemptions elsewhere in this tree are written against numbers taken from
 * these files — `selection.group` in event-detail-payload.test.mjs, the board's
 * event `id` in scrape-page.test.mjs, and the byte argument behind the
 * `/api/snapshot` excuse in api-surface.test.mjs. All three were transcribed by
 * hand, which makes them true until someone edits a capture, at which point they
 * are wrong and silent: the excuse still carries the old figure and nothing
 * recomputes it. So they are computed here instead, next to the parse that
 * already paid for them, and asserted below as claims rather than as figures.
 *
 * This is not the file arguing that the sample is evidence. The header says the
 * opposite: two of the top-level keys are evidence of a writer this tree lacks.
 * These are measurements of rows the writers still produce, and each one is
 * stated as the property the excuse rests on, so a capture set that stopped
 * supporting it fails here instead of leaving the prose behind.
 */
const sample = {
  events: 0,
  markets: 0,
  selections: 0,
  selectionsWithoutGroup: 0,
  groupValues: new Set(),
  /** markets holding two selections that share a name under different groups */
  nameCollisions: 0,
  distinctIds: new Set(),
  /** ids seen in more than one file of the same book */
  idsAcrossFiles: 0,
  /** ids shared by two or more books */
  idsAcrossBooks: 0,
  /** (book, eventKey) pairs carrying more than one id */
  pairsWithTwoIds: 0,
  bookPairs: 0,
  /** bytes the captures occupy on disk, in the writer's pretty-printed encoding */
  bytesOnDisk: 0,
  /** bytes the route actually sends for those same documents */
  bytesServed: 0,
  bytesServedEvents: 0,
  /** smallest single-document share of served bytes spent on `events` */
  minShare: 1,
  minShareFile: '',
  /** documents whose stored file is larger than the response the route sends */
  filesBiggerThanServed: 0,
};

{
  const filesSeenById = new Map();
  const booksById = new Map();
  const idsByPair = new Map();
  for (const file of sampleFiles) {
    const raw = read(join(SAMPLE_DIR, file));
    const doc = JSON.parse(raw);
    for (const key of Object.keys(doc)) sampleKeys.add(key);
    // "metadata" is the document with its events array emptied, which is the
    // same split api-surface.test.mjs quotes and the only way to compare the two
    // without holding both in memory.
    //
    // Both halves are measured in the encoding the route SENDS, not the one the
    // writer stored, and that distinction is the whole point of the split.
    // `writeJsonAtomicSync` stores `JSON.stringify(value, null, 2)` — pretty-
    // printed — while `readSnapshotRoute` parses the file and hands the object to
    // `sendJson`, which ends with `res.end(JSON.stringify(body))`, with no
    // indentation at all. The first version of this pass subtracted compact
    // metadata from the pretty-printed file, which charged the indentation to
    // `events` and reported the share as 99.93% — the figure the excuse then
    // transcribed, along with the on-disk totals around it. A page does not
    // receive the whitespace, so neither may the argument about its bytes.
    const served = Buffer.byteLength(JSON.stringify(doc));
    const servedMeta = Buffer.byteLength(JSON.stringify({ ...doc, events: [] }));
    const disk = Buffer.byteLength(raw);
    sample.bytesOnDisk += disk;
    sample.bytesServed += served;
    sample.bytesServedEvents += served - servedMeta;
    if (disk > served) sample.filesBiggerThanServed += 1;
    const share = served === 0 ? 0 : (served - servedMeta) / served;
    if (share < sample.minShare) {
      sample.minShare = share;
      sample.minShareFile = file;
    }
    for (const event of doc.events || []) {
      sample.events += 1;
      if (!filesSeenById.has(event.id)) filesSeenById.set(event.id, new Set());
      filesSeenById.get(event.id).add(`${doc.sourceId}:${file}`);
      if (!booksById.has(event.id)) booksById.set(event.id, new Set());
      booksById.get(event.id).add(doc.sourceId);
      const pair = `${doc.sourceId}:${event.eventKey}`;
      if (!idsByPair.has(pair)) idsByPair.set(pair, new Set());
      idsByPair.get(pair).add(event.id);
      for (const market of event.markets || []) {
        sample.markets += 1;
        const byName = new Map();
        for (const sel of market.selections || []) {
          sample.selections += 1;
          if (!('group' in sel)) { sample.selectionsWithoutGroup += 1; continue; }
          sample.groupValues.add(sel.group);
          if (!byName.has(sel.name)) byName.set(sel.name, new Set());
          byName.get(sel.name).add(sel.group);
        }
        for (const groups of byName.values()) if (groups.size > 1) sample.nameCollisions += 1;
      }
    }
  }
  sample.distinctIds = new Set(filesSeenById.keys());
  sample.idsAcrossFiles = [...filesSeenById.values()].filter((tags) => new Set([...tags].map((t) => t.split(':')[0])).size === 1 && tags.size > 1).length;
  sample.idsAcrossBooks = [...booksById.values()].filter((books) => books.size > 1).length;
  sample.pairsWithTwoIds = [...idsByPair.values()].filter((ids) => ids.size > 1).length;
  sample.bookPairs = idsByPair.size;
}

// Derived after the pass, not before it: the first version of this read the
// sample keys out of the set above before the walk had put anything in it, and
// reported an empty `unreachable` — which is the vacuous direction, the one that
// passes while measuring nothing.
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
test('the snapshot route publishes exactly the keys the writers write', async () => {
  const runtimeKeys = new Set();
  const measuredFiles = new Set();
  for (const file of adapterFiles) {
    const exports = await import(new URL(`../${file}`, import.meta.url));
    for (const value of Object.values(exports)) {
      if (typeof value?.prototype?._serializable !== 'function') continue;
      // Serialization needs no constructor, browser, network or persisted data.
      const receiver = Object.assign(Object.create(value.prototype), {
        id: 'census', runId: 'census', sports: ['football'], maxEvents: 1,
      });
      const doc = receiver._serializable([], {});
      assert.ok(doc && Object.keys(doc).length > 0, `${file}: serializer returned no keys`);
      for (const key of BASE_KEYS) assert.ok(Object.hasOwn(doc, key), `${file}: lost base key ${key}`);
      Object.keys(doc).forEach((key) => runtimeKeys.add(key));
      if (Object.hasOwn(value.prototype, '_serializable')) measuredFiles.add(file);
    }
  }
  assert.ok(measuredFiles.size > 0, 'no serializer exports were exercised');
  assert.deepEqual([...measuredFiles].sort(), [...overrides.keys()].sort(), 'a declared serializer was not exercised');
  assert.deepEqual(PUBLISHED, [...runtimeKeys].sort(), 'the parser missed a key returned by a real serializer');
});

test('the serializer census handles returned aliases and compact objects', () => {
  const inherited = ['events', 'sourceId'];
  for (const body of [
    'return { ...super._serializable(events, raw), coverage: { nested: true }, sourceUrl: this.url };',
    'const doc = super._serializable(events, raw); doc.coverage = {}; doc.sourceUrl = this.url; return doc;',
    'const doc = { ...super._serializable(events, raw), coverage: {} }; const alias = doc; return Object.assign(alias, { sourceUrl: this.url });',
  ]) {
    assert.deepEqual(serializableKeys(`class Writer { _serializable(events, raw) { ${body} } }`, inherited),
      [...inherited, 'coverage', 'sourceUrl'].sort());
  }
  assert.throws(() => serializableKeys('class Writer { _serializable() { return {}; } }'), /no document keys/);
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
 * The route is wired to a page, and what that page receives is the union above.
 *
 * This used to audit an excuse: `/api/snapshot/` sat in api-surface's
 * BACKEND_ONLY with a reason describing the payload, and the claim was checked
 * here against the writers this file measures. It was a check on a sentence.
 *
 * The sentence was wrong, and wrong in the direction this file exists to
 * prevent: the dashboard has shipped a link to this route for longer than the
 * excuse existed — one download icon per source in the source-health rows,
 * `href="/api/snapshot/${…sourceId…}"`. So the route was never diagnostic-only;
 * a page reads it, by name, per click. The excuse is gone from
 * api-surface.test.mjs and the closure check verifies the consumer instead.
 *
 * What replaces the audit is the two facts that make the consumer safe, both
 * measured here rather than asserted from a paragraph: the route is not excused
 * (so the check cannot be switched off again by re-adding a sentence), and the
 * document the link receives is the whole capture — no column list between the
 * read and the send, because the payload is whatever `_serializable` returned.
 */
test('the snapshot route is wired to the page that links to it, unfiltered', () => {
  // The forward guard, in the direction the old file could not check. If the
  // entry comes back, the closure check skips this route again while the
  // dashboard still links to it — the census reporting full closure over a
  // route it is no longer reading. That is the same hole twice, and this is
  // where it is seen rather than nowhere.
  const surface = read('test/api-surface.test.mjs');
  assert.equal(surface.includes("route: 'GET /api/snapshot/'"), false,
    '/api/snapshot/ is excused again — the closure check will skip the link the dashboard ships, and the two files disagree');

  // The link itself, read out of the page rather than out of this paragraph.
  const dashboard = read('public/js/pages/dashboard.js');
  assert.match(dashboard, /href="\/api\/snapshot\/\$\{[^"]*sourceId[^"]*}"[^>]*\bdownload\b/,
    'the dashboard no longer offers a snapshot download');

  // And the payload that link receives. `readSnapshotRoute` reads the parsed
  // capture and hands it straight to sendJson, so the union this file measures
  // is the contract; a column list appearing between the two would make every
  // key above unreachable through the route the page calls.
  const router = read('src/router.mjs');
  const start = router.indexOf('async function readSnapshotRoute');
  assert.notEqual(start, -1, 'readSnapshotRoute is gone — the dashboard link has nothing to call');
  const body = router.slice(start, router.indexOf('\n}', start));
  assert.match(body, /sendJson\(res, 200, snapshot\)/,
    'the snapshot route no longer answers with the capture it read');
  assert.doesNotMatch(body.slice(body.indexOf('readJson'), body.indexOf('sendJson')), /\bmap\(|\.filter\(|\[[^\]]*(?:coverage|sourceUrl|transport)\b/,
    'a column list appeared between the read and the send — the writers\' union above is no longer what the page receives');
  assert.ok(PUBLISHED.length >= 9, `the measured union has ${PUBLISHED.length} keys, so the guards above would pass on a payload with none`);
  for (const key of BASE_KEYS) assert.ok(PUBLISHED.includes(key), `base key ${key} is not in the measured union`);
});

/**
 * The three sample measurements other files quote, recomputed rather than trusted.
 *
 * Each of these was a figure typed into a paragraph: 93600 selections all saying
 * "Main", 12390 distinct ids, "99.93% of what these documents hold". A figure in
 * a paragraph is true until somebody edits a capture, and then it is wrong in
 * silence — the excuse keeps the old number, the number is nobody's claim, and
 * the suite stays green. So they are computed in the pass above and asserted
 * here as the property the excuse rests on, with the freshly measured figure in
 * the message so a failure tells you what it is now rather than what it was.
 *
 * The byte figure was a second thing wrong with the same sentence, and this is
 * where that gets recorded. It was not merely stale: it had been measured in the
 * wrong encoding, and recomputing it correctly would not have brought it back.
 * The captures are stored pretty-printed and served compact, so a byte count read
 * off a file is not a byte count a page ever receives. The measurement above was
 * corrected to the served encoding for that reason; the paragraph that quoted it
 * dropped the numbers instead of replacing them.
 *
 * The assertions are claims, not figures, on purpose. "12390 distinct ids" is a
 * transcription that goes stale on the next scrape; "every (book, eventKey) pair
 * carries exactly one id, no id appears in two files of one book, and some ids do
 * appear under more than one book" are three properties that survive a rescrape
 * and still pin the excuse, which is what the excuse is actually for.
 *
 * The guards are the point where this file is unusual: every measurement below
 * is a count over the captures, and a count over an empty directory is 0, which
 * is the value most of these claims want. So the pass is checked to have read
 * something first, and each claim that would otherwise pass vacuously is stated
 * with a floor on what it was measured over.
 */
test('the sample measurements the other files quote are still true', () => {
  const floor = `measured over ${sampleFiles.length} captures / ${sample.events} events —`;
  assert.ok(sample.events > 0 && sample.selections > 0 && sample.distinctIds.size > 0 && sample.bytesServed > 0,
    `${floor} the pass above read nothing, so every count below is 0 and passes for the wrong reason`);

  // (a) The `selection.group` exemption in event-detail-payload.test.mjs: the field
  // separates nothing, because every selection carries it and it separates nothing
  // between two outcomes that share a name.
  assert.equal(sample.selectionsWithoutGroup, 0,
    `${floor} ${sample.selectionsWithoutGroup} of ${sample.selections} selections no longer carry \`group\` — re-read the selection exemption`);
  assert.deepEqual([...sample.groupValues].sort(), ['Main'],
    `the group values in the captures are now ${JSON.stringify([...sample.groupValues].sort())}, not just "Main" — the field separates something and the exemption has to be re-argued`);
  assert.equal(sample.nameCollisions, 0,
    `${floor} ${sample.nameCollisions} markets hold two same-named selections under different groups — \`group\` now disambiguates a name, which is what it exists for`);

  // (b) The board's event `id` exemption in scrape-page.test.mjs. Both halves are
  // needed: the id being useless follows from it being ambiguous ACROSS books and
  // absent ACROSS files, and an excuse that only said one of those would be right
  // for the wrong reason.
  assert.equal(sample.pairsWithTwoIds, 0,
    `${floor} ${sample.pairsWithTwoIds} of ${sample.bookPairs} (book, eventKey) pairs carry more than one id — the id is no longer a stand-in for eventKey`);
  assert.equal(sample.bookPairs, sample.events,
    `${floor} ${sample.bookPairs} (book, eventKey) pairs over ${sample.events} events — eventKey is no longer unique inside a book, so the id cannot stand in for it`);
  assert.equal(sample.idsAcrossFiles, 0,
    `${floor} ${sample.idsAcrossFiles} ids appear in more than one file of the same book — the id IS stable across captures, and the board exemption's wording about it is wrong`);
  assert.ok(sample.idsAcrossBooks > 0,
    `${floor} no id is shared by two books, so "an address inside one book" would hold and the id would be a usable handle — re-argue the exemption`);

  // (c) The byte argument behind the `/api/snapshot` excuse in api-surface.test.mjs:
  // serving a capture for provenance alone would pull orders of magnitude more
  // than the page shows. The ratio is the claim; the percentage was the figure.
  //
  // Stated over the whole capture set, which is where it holds. It does NOT hold
  // per document, and saying so would be the same error in a new coat: 19 of the
  // 22 are over 99%, but one sits far below that and the weakest case is pinned
  // separately below so the aggregate cannot quietly stand in for it.
  const servedEvents = sample.bytesServedEvents;
  const servedMeta = sample.bytesServed - servedEvents;
  const share = servedEvents / sample.bytesServed;
  assert.ok(share > 0.99,
    `${floor} \`events\` is now ${(share * 100).toFixed(2)}% of what the route sends (was quoted as 99.93%, and that number measured the stored file rather than the response) — a page reading this route for provenance is no longer pulling orders of magnitude more than it displays`);
  assert.ok(servedEvents / servedMeta > 100,
    `${floor} metadata is no longer 100x smaller than the events array — the size argument in the api-surface excuse has lost its order of magnitude`);

  // The weakest single document, so the aggregate above cannot be read as "every
  // response is 99% events". Measured, not assumed: this is the floor the
  // per-document claim actually has.
  assert.ok(sample.minShare > 0.5,
    `${floor} \`events\` is no longer the majority of the response for ${sample.minShareFile} (${(sample.minShare * 100).toFixed(2)}%) — a book whose capture is mostly metadata is not the argument the excuse makes, and the aggregate above is hiding it`);

  // The encoding distinction itself. Every capture is stored pretty-printed and
  // served compact, so the stored files are strictly larger than any response
  // they can produce. This is the fact that made the transcribed figures wrong,
  // and it is cheap to keep: if a future writer stores compact JSON the two
  // encodings converge and this fails, which is the moment a byte count read off
  // a file starts meaning what the excuse has always claimed it means.
  assert.equal(sample.filesBiggerThanServed, sampleFiles.length,
    `${floor} only ${sample.filesBiggerThanServed} of ${sampleFiles.length} captures are larger on disk than the response they serve — the stored and served encodings have converged, so a byte count taken from a file is no longer an overstatement and this argument needs re-deriving rather than restating`);
});
