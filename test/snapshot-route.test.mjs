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