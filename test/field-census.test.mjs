/**
 * field-census.test.mjs — the four routes that serve a stored document, field by
 * field, and the pages that read them.
 *
 * The tree already censuses three payloads this way, each with a list of the
 * fields nobody reads and the reason that is allowed: the scan sources
 * (`source-health-list.test.mjs`), the catalog document (`analytics-page.test.mjs`)
 * and the event-detail payload (`event-detail-payload.test.mjs`). Four more
 * routes had none, and they are the ones with the most fields: `/api/scrapers`
 * serves 27 keys per job over 26 jobs and, before this file, not one of the five
 * that describe how a book is collected reached a page.
 *
 * Every number in the exempt list below was measured, not reasoned about, and the
 * measurement is in the reason. Every entry carries one: this file used to hold
 * a single blank, for the one field it could not judge, and that field is read
 * now. The test that enforced the blank enforces the absence of one instead, so
 * a new entry has to arrive with the measurement that justifies it.
 *
 * ── What this census can and cannot see ──────────────────────────────────────
 *
 * A field counts as read when the page reads its name. The search is anchored on
 * the receiver the page binds for that route, and comments are blanked through
 * the shared helper, because a regex over raw source cannot tell a read from a
 * mention — `selection.group` is read by nobody in the whole frontend and its
 * only trace is the word "group:" in a comment in dashboard.js.
 *
 * The anchor is exact for `/api/scrapers` — the chip row plus the two gates that
 * filter the same rows, each cut out of its own function — and for the two run
 * documents' top level (`state`, `run`). It is looser in two places, both stated
 * where they are used: the job rows of `/api/scrape/state` and `/api/scrape-run`
 * are both bound to `j` on the same page, and the profile defaults are read
 * through two different bindings depending on the call site. Both loosenesses can
 * hide a gap. Neither can invent one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, fieldsOn } from './helpers/code-only.mjs';
import { reachableModules } from './helpers/reachability.mjs';
import { resolveScanRequest } from '../src/scrape-orchestrator.mjs';
import { toProgressJob } from '../src/scraper-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

const scrapeCode = codeOnly(readText('public/js/pages/scrape.js'), true);
const scannerCode = codeOnly(readText('public/js/pages/scanner.js'), true);
const settingsCode = codeOnly(readText('public/js/pages/settings.js'), true);
const routerSource = codeOnly(readText('src/router.mjs'), true);
const orchestratorSource = codeOnly(readText('src/scrape-orchestrator.mjs'), true);
const sanitizeSource = codeOnly(readText('src/shared/sanitize.mjs'), true);
const serviceSource = codeOnly(readText('src/scraper-service.mjs'), true);
// The scraper's own error envelope. Nothing here imports it — it is read as text,
// like the rest of the producers, because the object it returns is what the
// state route publishes and that route serves `scrapeState` unsanitized.
const baseSource = codeOnly(readText('src/scrapers/base.mjs'), true);

/* ── instruments ───────────────────────────────────────────────────────────── */

/**
 * A top-level function's body, cut at the lone `}` in column 0 that closes it.
 *
 * The scrape page binds the name `s` for at least three different things — the
 * chip row, a scheduler entry, a profile — so searching the whole file for `s.x`
 * would credit `/api/scrapers`' fields to a scheduler read. Cutting the chip
 * function's own body is what makes that anchor exact.
 *
 * The convention is measured, not assumed: api-surface.test.mjs established over
 * this tree's 70 top-level functions that none nests another and that every body
 * ends on a `}` in column 0. If that stops being true the control below fails
 * here rather than quietly censusing the wrong region.
 */
function functionWindow(source, name) {
  const lines = source.split(/\r?\n/);
  // The signature may carry parameters — `profileLabel(profile, t)` does — so the
  // match is on the name and the opening paren, not on an empty parameter list.
  // `async` is allowed because `refreshLastRun` is declared that way, and the cut
  // has to reach the same body it always did.
  const start = lines.findIndex((line) => new RegExp(`^(?:async\\s+)?function ${name}\\(`).test(line));
  if (start === -1) throw new Error(`scrape.js no longer declares a top-level function ${name}()`);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (end === -1) throw new Error(`${name}() has no lone } in column 0 — the body cut would run away`);
  return lines.slice(start, end + 1).join('\n');
}

const CHIP = functionWindow(scrapeCode, 'renderBookmakerChips');
const PROFILE_LABEL = functionWindow(scrapeCode, 'profileLabel');
const APPLY_PROFILE = functionWindow(scrapeCode, 'applyProfile');
const APPLY_PROFILE_HINT = functionWindow(scrapeCode, 'applyProfileHint');
const SPORT_GATE = functionWindow(scrapeCode, 'jobMatchesSport');
const PROMOTION_GATE = functionWindow(scrapeCode, 'passesPromotionGate');
// The two job tables of the same panel, cut apart. `refreshJobRows` draws
// `state.jobs` and `refreshLastRun` draws `run.jobs`, and both bind the row as
// `j` — so the shared receiver the rest of this census reads cannot tell a read
// on one route from a read on the other. It is the error object where that
// matters: the two tables disagreed about it, so a union would have credited the
// run table's read of `name` to the state table, which is the exact field the
// state table did not read.
const JOB_ROWS = functionWindow(scrapeCode, 'refreshJobRows');
const RUN_ROWS = functionWindow(scrapeCode, 'refreshLastRun');

/**
 * The keys of the object one route sends, read off the router rather than off a
 * stored file.
 *
 * `/api/scrapers`'s job rows have a document to measure against —
 * config/scrapers.json — but its response envelope does not: the four arrays are
 * built at src/router.mjs:200-205 and exist nowhere else. Naming them in this
 * test without a measurement would make the census check a list against itself.
 * The keys are read at the literal's own indent, so a router that changes shape
 * fails here instead of quietly censusing nothing.
 */
function returnedKeys(route) {
  const at = routerSource.indexOf(`'${route}':`);
  if (at === -1) throw new Error(`src/router.mjs no longer serves ${route}`);
  const body = routerSource.slice(at);
  // Bound the handler before looking for its return. The first version took the
  // last `});` in the file, which is the last route's, and the census then
  // collected every 8-space key in the other twenty routes — a census of the
  // whole router wearing one route's name.
  const next = body.slice(1).search(/\n {4}'(?:GET|POST|PUT|DELETE) \//);
  const handler = next === -1 ? body : body.slice(0, next + 1);
  const ret = handler.indexOf('return sendJson(');
  const close = handler.lastIndexOf('});');
  if (ret === -1 || close < ret) throw new Error(`${route} no longer returns sendJson`);
  const keys = [...handler.slice(ret, close).matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]);
  if (!keys.length) throw new Error(`${route} returned an object with no keys at its own indent — the cut moved`);
  return keys.sort();
}

/**
 * The keys of `state.options`, measured from BOTH producers the route has.
 *
 * `GET /api/scrape/state` serves `orchestrator.scrapeState || emptyState()`
 * (src/router.mjs:61), so the document has two producers and they disagree by
 * design: `emptyState()` publishes `options: {}` for the idle state before any
 * run has been launched, and `resolveScanRequest` publishes the eleven keys a
 * run resolved.
 *
 * Neither producer is read out of `data/scrape-state.json`, which is where this
 * census read the list from and why the list was wrong. Four of the eleven are
 * optional inputs normalised to `undefined` when the caller omits them (the
 * optional caps and filters of `resolveScanRequest`), and `JSON.stringify` drops
 * a key whose value is undefined — so the stored document carries between 7 and
 * 11 of them depending on what the last run happened to ask for. Measured on
 * this tree: the committed copy holds 8, with `sport` and no `maxEvents`; the
 * working copy holds 8, with `maxEvents` and no `sport`. A census that reads
 * that file is censusing one machine's last run, and the committed copy failed
 * the pinned comparison on the branch for as long as the drift was there.
 *
 * The producer is called over inputs that exercise the optional keys rather
 * than trusted to have eleven, because the union is the measurement.
 */
const SCAN_REQUESTS = [
  {},                                       // neither optional key
  { sport: 'Football' },                    // the sport filter the form sends
  { maxEvents: 12 },                        // the event cap the form sends
  { sport: 'Football', maxEvents: 'all' },  // both at once
];

/** The idle producer's `options`, read off its own literal in the router. */
function emptyStateOptionKeys() {
  const at = routerSource.indexOf('function emptyState()');
  if (at === -1) throw new Error('src/router.mjs no longer declares emptyState()');
  const lines = routerSource.slice(at).split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && line === '}');
  if (end === -1) throw new Error('emptyState() has no lone } in column 0 — the body cut would run away');
  const literal = lines.slice(1, end + 1).join('\n').match(/^\s*options:\s*\{([^}]*)\}/m);
  if (!literal) throw new Error('emptyState() no longer publishes an `options` object literal');
  const inner = literal[1].trim();
  if (!inner) return [];
  return inner.split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
}

const producedOptionKeys = () => {
  const out = new Set();
  for (const input of SCAN_REQUESTS) {
    for (const k of Object.keys(resolveScanRequest(input))) out.add(k);
  }
  for (const k of emptyStateOptionKeys()) out.add(k);
  return [...out].sort();
};

/**
 * The four leaves of `state.summary`, read off the fold that writes them.
 *
 * Measured from the writer for the same reason as the options above and with the
 * same consequence: the stored copy is a sample, and a run that has not reached
 * the fold yet stores `summary: null`. Reading the file turned that null into a
 * `TypeError` at module load — the census died before it could report, which is
 * the one failure a census is not allowed to have.
 */
function producedSummaryKeys() {
  const at = orchestratorSource.indexOf('this.scrapeState.summary = {');
  if (at === -1) throw new Error('src/scrape-orchestrator.mjs no longer assigns scrapeState.summary');
  const lines = orchestratorSource.slice(at).split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && line === '    };');
  if (end === -1) throw new Error('the summary fold has no lone `};` — the body cut would run away');
  const keys = [...lines.slice(1, end + 1).join('\n').matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
  if (keys.length < 2) throw new Error(`the summary fold yielded ${keys.length} keys — the cut moved`);
  return keys.sort();
}

/**
 * The keys of a `state.jobs` row, from the two producers that fill one.
 *
 * `toProgressJob` builds the row and is exported, so it is called rather than
 * parsed. Its `sourceIds` is a literal empty array and it is marked `[]` here for
 * the same reason `keysOfRows` marks one: the marker is a claim about the shape,
 * and this is the shape the producer declares.
 *
 * The second producer is not a constructor but a fold: `job-complete` and
 * `batch-end` assign onto a `j` that already exists (src/scrape-orchestrator.mjs:
 * 417-424 and 442-447), and `marketDiagnostics` is the one field no constructor
 * sets. Every field those folds assign is collected by name, so a fold that
 * starts writing a new field changes this set without the test being edited.
 *
 * Measured, because a mutation showed the union is more forgiving than the
 * sentence above claims: `job-complete` assigns nine names and `batch-end` six,
 * and `batch-end`'s six are a subset of the first fold's nine. So no field is
 * contributed by exactly one fold — renaming a receiver in either of them, or
 * deleting one of the two `marketDiagnostics` writes, leaves this set identical.
 * The union is still what carries `marketDiagnostics`, since no constructor sets
 * it, but it is not defended twice.
 *
 * Measured: ten fields from the constructor plus `marketDiagnostics` is eleven,
 * and `sourceIds` is in it while being unassignable — see the reason it carries.
 */
function producedStateJobKeys() {
  const out = new Set();
  for (const [k, v] of Object.entries(toProgressJob('census'))) {
    out.add(Array.isArray(v) && !v.length ? `${k}[]` : k);
  }
  const folds = [...orchestratorSource.matchAll(/\bj\.(\w+)\s*=\s*[^=]/g)].map((m) => m[1]);
  if (!folds.length) throw new Error('the orchestrator no longer assigns onto a job row — the fold set is empty');
  for (const k of new Set(folds)) out.add(k);
  return [...out].sort();
}

/**
 * The keys of a `latest-scrape-run.json` job row, from the last thing to touch it.
 *
 * `persistRunReport` does not write the batch report; it writes
 * `sanitizeReport(report)`, and that reduction rebuilds each row from a literal
 * (src/shared/sanitize.mjs:67-80). So the literal is the shape the route and the
 * file actually publish, and it is the second thing in a chain that has three:
 * the scraper's envelope, the batch's `{ ...job, ...result }` spread, and this.
 *
 * `sourceIds` is a ternary here rather than a literal array, so it is not marked
 * `[]`, and that is the distinction doing the work: the state row's marker comes
 * from a declared empty array, this one's does not come from one at all.
 */
function producedRunJobKeys() {
  const at = sanitizeSource.indexOf('jobs: Array.isArray(report.jobs)');
  if (at === -1) throw new Error('sanitizeReport no longer reduces report.jobs');
  const lines = sanitizeSource.slice(at).split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '})) : [],');
  if (end === -1) throw new Error('the job reduction has no closing line of its own — the cut would run away');
  const keys = [...lines.slice(1, end + 1).join('\n').matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
  if (keys.length < 2) throw new Error(`the job reduction yielded ${keys.length} keys — the cut moved`);
  return keys.sort();
}

/**
 * The keys of the error object on a STATE job row, from the producer that builds it.
 *
 * This is the gap the census had. `error` was a leaf for `keysOfRows`, because
 * every stored row carries `error: null` and the walk descends one level only —
 * so a five-field object went uncounted on both routes, and the census reported
 * the two tables of the scrape panel as reading a field called `error`.
 *
 * The shape comes from `_shapeError` (src/scrapers/base.mjs), for the same reason
 * `sanitizeReport`'s literal is the shape over on the run row: the state route
 * serves `orchestrator.scrapeState` unsanitized (src/router.mjs) and both folds
 * that fill a row copy `result.error` and `rj.error` by reference
 * (src/scrape-orchestrator.mjs), so what the page receives is exactly what this
 * literal returned. Measured: the route's own expression is a pass-through, with
 * no sanitizer on it.
 */
function producedStateErrorKeys() {
  const lines = baseSource.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*_shapeError\(err\)\s*\{\s*$/.test(l));
  if (start === -1) throw new Error('src/scrapers/base.mjs no longer declares _shapeError');
  const end = lines.findIndex((l, i) => i > start && /^\s*\};\s*$/.test(l));
  if (end === -1) throw new Error('_shapeError has no closing line of its own — the cut would run away');
  // `[ ]{4,}` rather than `\s{4,}`: `\s` matches the newline, so a count that
  // crossed a line boundary would credit a key to the wrong declaration.
  const keys = [...lines.slice(start + 1, end).join('\n').matchAll(/^[ ]{4,}(\w+):/gm)].map((m) => m[1]);
  if (keys.length < 3) throw new Error(`_shapeError yielded ${keys.length} keys — the cut moved`);
  return keys.sort();
}

/**
 * The keys of the error object on a RUN job row: the same measurement taken on
 * the other producer.
 *
 * Two routes, two shapes, and the difference is not a preference — the run row
 * goes through `sanitizeReport` and the state row does not. That is why `code` and
 * `status` are listed on one and absent from the other, and why the exemptions
 * below are written per route rather than once for `error`.
 */
function producedRunErrorKeys() {
  const lines = sanitizeSource.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*error:\s*\w+\.error\s*\?\s*\{\s*$/.test(l));
  if (start === -1) throw new Error('sanitizeReport no longer rebuilds a job row error from a literal');
  const end = lines.findIndex((l, i) => i > start && /^\s*\}\s*:\s*null,?\s*$/.test(l));
  if (end === -1) throw new Error('the job error literal has no closing line of its own — the cut would run away');
  const keys = [...lines.slice(start + 1, end).join('\n').matchAll(/^[ ]{4,}(\w+):/gm)].map((m) => m[1]);
  if (keys.length < 2) throw new Error(`the job error literal yielded ${keys.length} keys — the cut moved`);
  return keys.sort();
}

/**
 * The union of the keys of every element of `arr`, or a marker for the two shapes
 * that are not object rows.
 *
 * The marker matters and it was a bug first: an array of strings must contribute
 * its own key. The first version of this returned nothing for `supportedSports`,
 * `sourceIds` and `unavailableSports` — every string array in the config — and the
 * pinned list it produced agreed with a document those keys were missing from. An
 * instrument that drops keys is worse than one that has none.
 */
function keysOfRows(arr, depth = 0) {
  if (!Array.isArray(arr)) {
    return arr && typeof arr === 'object' ? Object.keys(arr).sort() : { scalar: true };
  }
  if (!arr.length) return { empty: true };
  const rows = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (!rows.length) return { scalar: true };
  const out = new Set();
  for (const item of rows) {
    for (const [k, v] of Object.entries(item)) {
      const nested = keysOfRows(v, depth + 1);
      if (nested.empty) out.add(`${k}[]`);
      else if (nested.scalar) out.add(k);
      else if (depth < 1) for (const nk of nested) out.add(`${k}.${nk}`);
      else out.add(k);
    }
  }
  return [...out].sort();
}

/** The last segment of a key path, minus the markers the walk above added. */
const leafOf = (p) => p.replace(/(\[\]|\.\.\.)$/, '').split('.').pop();

/**
 * Whether a key is exempt on its own route: by exact name, or because an
 * ancestor is.
 *
 * The route is part of the lookup, so an entry written about a run row cannot
 * cover the same field on the chip. `oddsFeed` and `state.options` are whole
 * subtrees, and listing all twelve of one sub-tree's leaves separately would be a
 * list that says the same thing twelve times.
 */
const exempt = (path, label) => {
  const parts = path.split('.');
  return parts.some((_, i) => {
    const prefix = parts.slice(0, i + 1).join('.');
    // Both forms, because the walk marks a key by shape: a job row's `sourceIds`
    // is published as `sourceIds[]` — the array was empty in every stored capture
    // — and the table names the field. Matching only the marked form would have
    // reported a field the table covers, which is the false positive that made
    // this route the last one standing.
    return Object.prototype.hasOwnProperty.call(UNREAD_BY_DESIGN, `${label} › ${prefix}`)
      || Object.prototype.hasOwnProperty.call(UNREAD_BY_DESIGN, `${label} › ${leafOf(prefix)}`);
  });
};

/* ── the documents, and what is pinned about them ──────────────────────────── */

const SCRAPERS = readJson('config/scrapers.json');
const PROFILES = readJson('config/scan-profiles.json');
const STATE = readJson('data/scrape-state.json');
const RUN = readJson('data/latest-scrape-run.json');

/**
 * Measured by union over every job, every profile, every job row and every
 * option, not over a sample. The first version of the walk descended the first
 * two elements of an array, and config/scrapers.json's first two jobs carry
 * neither `minEvents` nor `oddsFeed` — so it pinned a document that was missing
 * fields it has.
 */
const SCRAPERS_JOB = [
  'detailLimit', 'enabled', 'endpointVerifiedAt', 'engine', 'feedStatus', 'fullMarkets', 'id',
  'minEvents', 'name', 'oddsFeed.auth', 'oddsFeed.businessUnit', 'oddsFeed.eventsIn3DayWindow',
  'oddsFeed.eventsWithComplete1x2', 'oddsFeed.footballSportId', 'oddsFeed.measuredAt',
  'oddsFeed.method', 'oddsFeed.priced1x2Found', 'oddsFeed.requiredHeaders', 'oddsFeed.url',
  'platform', 'script', 'sourceIds', 'supportedSports', 'transport', 'unavailableSports',
  'validationReason', 'validationStatus',
  // Not in the config: GET /api/scrapers adds this one per job, from
  // src/scrapers/live-status.mjs. Pinned with the config keys because the page
  // receives them together and the census is about the payload the page gets.
  'liveCapability',
];

const SCRAPERS_ARRAYS = ['jobs', 'enabledJobs', 'validatedJobs', 'experimentalJobs'];

const PROFILES_ROW = [
  'defaults.bankroll', 'defaults.includeLive', 'defaults.includePast', 'defaults.maxMiddleRiskPercent',
  'defaults.minMiddleRoiPercent', 'defaults.minMarginPercent', 'description', 'id', 'label', 'mode',
];

/**
 * `state.jobs`, pinned by hand against the producer rather than against the file.
 *
 * This list used to be compared with `keysOfRows(STATE.jobs)` — the rows stored in
 * data/scrape-state.json — so it was a claim about the last scrape that happened
 * to run on the machine that wrote it. The eleven below were re-measured against
 * `producedStateJobKeys` instead, and they are unchanged, which is the point:
 * the hand-written half and the derived half are now two things written by
 * different code, so the day the producer grows or drops a field this fails
 * instead of agreeing with whatever is on disk.
 *
 * The `[]` on `sourceIds` is part of the claim. The constructor declares a literal
 * empty array (src/scraper-service.mjs:161) and no fold ever fills it, so the
 * wire carries an empty array on every row — a shape the marker records.
 */
const STATE_JOB = [
  'durationMs', 'error', 'events', 'finishedAt', 'id', 'marketDiagnostics', 'name', 'sourceIds[]',
  'startedAt', 'status', 'valid',
];
/**
 * `state.options`, as paths under `options` rather than as bare leaves.
 *
 * The full path is what makes the exempt lookup work the same way it does for the
 * other five censuses: the one entry here is the parent, and an ancestor walk
 * over a bare leaf has no parent to reach. It is also the shape the document
 * really has, so nothing is lost by writing it down.
 *
 * Nine entries, and this list used to hold eight. The eighth was `maxEvents` and
 * the ninth is `sport`; both were published all along, and the list could only
 * see one of them at a time because it was compared against the stored document
 * rather than against the producer that fills it. `sport` was the one it could
 * not see, and the canary that was meant to catch its arrival compared a
 * hand-written list with itself — so the day the producer grew it, nothing fired.
 * Nine entries became eleven: `maxStake` and `maxAgeMinutes` — the two stored
 * caps, published by the same producer and walked by the same page table —
 * joined without a form input of their own, so the comparison that fires is
 * between the eleven below and the eleven `producedOptionKeys` calls out of
 * the producer.
 *
 * The cross-check that keeps the two honest: the scrape page carries the same
 * eleven names in its own `SCHEDULER_SCAN_FIELDS` table, `runOptionsText` walks
 * that table, and the control below asserts the table and the producer agree on
 * the count. Two independent lists of eleven, written by different code, is a
 * stronger claim than either list alone.
 */
const STATE_OPTIONS = [
  'options.bankroll', 'options.includeLive', 'options.includePast', 'options.maxAgeMinutes',
  'options.maxEvents', 'options.maxMiddleRiskPercent', 'options.maxStake', 'options.minEvPercent',
  'options.minMiddleRoiPercent', 'options.minMarginPercent', 'options.sport',
];
const STATE_SUMMARY = ['completed', 'events', 'failed', 'markets'];
/**
 * `latest-scrape-run.json` job rows, pinned the same way and for the same reason.
 *
 * The other side of `sourceIds` from the list above: here the ternary in
 * `sanitizeReport` (src/shared/sanitize.mjs:70) is not a literal empty array, and
 * it is populated on 24 of 24 stored rows because the batch report spreads the
 * adapter result over the job (src/scraper-service.mjs:147). Same field, opposite
 * marker — which is why the two entries are separate keys and not one name with
 * one `WHY` paragraph behind it.
 */
const RUN_JOB = ['durationMs', 'error', 'events', 'id', 'name', 'sourceIds', 'status', 'valid'];

/**
 * The error object on a state job row, and the run row's beside it.
 *
 * Two lists because the two routes have two producers: the state row is served
 * raw from `_shapeError` and the run row is rebuilt by `sanitizeReport`, which
 * drops `code` and `status`. `code` is therefore read on one route and published
 * on the other, which is the fact `refreshJobRows`'s comment leans on when it
 * keeps `|| j.error.code` at the end of its chain.
 *
 * These five keys and those three were outside the census entirely while `error`
 * was a leaf, so nothing here had a verdict.
 */
const STATE_JOB_ERROR = ['code', 'field', 'message', 'name', 'status'];
const RUN_JOB_ERROR = ['field', 'message', 'name'];

/* ── who reads what ────────────────────────────────────────────────────────── */

/**
 * `/api/scrapers`: the chip row, and the two gates that filter the same rows.
 *
 * Anchoring on the chip alone was the instrument being wrong, twice over. The
 * chip window is what makes the anchor exact — `s` is also a scheduler entry and
 * a live feed on this page, and a whole-file search for `s.` credits a
 * scheduler read to a book field — but the chip is not the only reader. The page
 * filters the same job objects through `jobMatchesSport` and `passesPromotionGate`,
 * which take their row as `job`, and that is where `supportedSports` and
 * `enabled` are read. Measured: with the chip alone, both reported as unread and
 * the exempt table would have had to grow two entries that were not true.
 *
 * `job` is not searched page-wide for the same reason `s` is not — `isFailedJob`
 * binds `job` to a *state* job row, so a page-wide search would let a run-row
 * read stand in for a scrapers read. The two gate functions are cut instead.
 */
const scrapersJobReads = () => new Set([
  ...fieldsOn(CHIP, 's'),
  ...fieldsOn(SPORT_GATE, 'job'),
  ...fieldsOn(PROMOTION_GATE, 'job'),
]);

/**
 * The response envelope: the four arrays of `/api/scrapers`, read off the one
 * binding the page gives the whole response.
 */
const scrapersEnvelopeReads = () => new Set(fieldsOn(scrapeCode, 'scraperResponse'));

/** `/api/scrape/state`: the page binds the document itself as `state`. */
const stateReads = () => new Set(fieldsOn(scrapeCode, 'state'));

/**
 * `/api/scrape/state`'s summary, through the local binding rather than `state`.
 *
 * The page does not read `state.summary.completed`; it writes
 * `const summary = state.summary || {}` and reads the leaves off that
 * (public/js/pages/scrape.js:884 and :989, rebinding it in both). `fieldsOn`
 * returns the first segment of a dotted read, so searching `state` alone sees
 * the word `summary` and none of the three numbers under it — the census
 * reported `completed`, `events` and `failed` as unread on a page that draws all
 * three on its KPI card.
 */
const summaryReads = () => new Set(fieldsOn(scrapeCode, 'summary'));

/**
 * The field names the page's own scan-option table carries.
 *
 * Read out of `public/js/pages/scrape.js` rather than written down here, because
 * this instrument's whole claim is that the page reads the options *through that
 * table* — a hand-kept copy would let the two drift, and a drifted copy is the
 * instrument lying about the page rather than the page going unread.
 */
function schedulerScanFields() {
  const at = scrapeCode.indexOf('const SCHEDULER_SCAN_FIELDS = [');
  if (at === -1) throw new Error('scrape.js no longer declares SCHEDULER_SCAN_FIELDS');
  const body = scrapeCode.slice(at);
  const end = body.indexOf('];');
  if (end === -1) throw new Error('SCHEDULER_SCAN_FIELDS is no longer a top-level array literal');
  const pairs = [...body.slice(0, end).matchAll(/\['(\w+)',\s*'(\w+)'\]/g)].map((m) => [m[1], m[2]]);
  if (pairs.length < 5) throw new Error(`SCHEDULER_SCAN_FIELDS yielded ${pairs.length} pairs — the cut moved`);
  return pairs;
}

const SCAN_FIELDS = schedulerScanFields();

/**
 * `/api/scrape/state`'s `options`: read through a computed index, which is the
 * one shape `fieldsOn` cannot see.
 *
 * `fieldsOn` matches `state.<name>`, and the page reads the stored options as
 * `options[field]` — `field` being the loop variable of the table above. There
 * is no dotted read of `state.options.bankroll` anywhere, so the nine fields
 * were unread to this census on a page that draws them all. The instrument that
 * fixed it is this one, and it is deliberately built to go quiet rather than to
 * guess: a field counts as read only while four things hold at once — the panel
 * still writes the line, the line's receiver is the state's own options, a
 * function still walks the table indexing an options object by name, and what it
 * walks comes back out. Drop the call and the first fails; rename the receiver
 * and the second fails; gut the function and the third returns nothing; and the
 * fourth is the one this file was wrong about first — computing the nine parts
 * and returning an empty string leaves every marker above in place, so the
 * census reported nine fields read by a page that renders nothing at all. The
 * behavioural test caught it; the census did not, until the return was required.
 *
 * The page's table carries `sport` and the pinned list above carries it too,
 * because the producer publishes it. This paragraph used to say the opposite —
 * that no stored state carries it yet — and to name `censusFor` as the thing
 * that would catch the day one did. That sentence was the canary's own blind
 * spot: the comparison fired on the STORED document, so it could only ever report
 * which optional keys the last run happened to supply.
 */
const optionsReads = () => {
  const out = new Set();
  const sink = /\btextContent\s*=\s*runOptionsText\(/.test(scrapeCode)
    && /\$?\('last-run-options'\)/.test(scrapeCode);
  const receiver = /\b(?:lastState|state)\??\.options\b/.test(scrapeCode);
  if (!sink || !receiver) return out;
  const indexer = functionWindow(scrapeCode, 'runOptionsText');
  const walks = /SCHEDULER_SCAN_FIELDS/.test(indexer) && /\boptions\[field\]/.test(indexer);
  if (walks && /return\s+parts\.join\(/.test(indexer)) {
    for (const [field] of SCAN_FIELDS) out.add(field);
  }
  return out;
};

/**
 * `/api/profiles`, read on two pages, through a receiver each and one alias.
 *
 * `profileLabel` takes the row as `profile` and reads `d.includeLive` out of its
 * defaults; `applyProfile` takes it as `p` and reads `p.defaults.bankroll` in
 * full, matching it first through `x.id`; the hint added for `description` takes
 * it as `found`. Searching one receiver name reported all six defaults and the
 * description as unread, which was the instrument being wrong rather than the
 * page.
 *
 * Then there was a second consumer. `/api/profiles` is fetched by scanner.js as
 * well, at :343, and this census read one page, so a field that only scanner.js
 * reads would have been reported unread by a page that does read it. Measured,
 * scanner.js reads a strict subset of what scrape.js reads — `id`, `label` and
 * four of the six defaults, and neither `mode` nor `description` nor the two
 * scope switches — so widening the set moves no verdict today. It is here
 * because the subset is a fact about today.
 *
 * The receivers and the alias are derived, not written down. They used to be
 * typed into the table below — `rows: ['profile', 'p', 'x', 'found']`, `alias:
 * 'd'` — and a typed list of receiver names fails in the direction that blames
 * the page for the instrument's ignorance: a fifth binding added inside a cut
 * would go unlisted, its reads would never be collected, and a leaf the page
 * does read would be reported as one no page reads. The stale check that
 * guarded the list only caught a name that had VANISHED from the code, never a
 * name missing from the list.
 *
 * So a receiver is whatever reads a published leaf inside a window — the leaf
 * set is the pinned row itself, so a row that gains a field widens the net by
 * itself — and an alias is whatever the page binds from `something.defaults`.
 * Both derivations land on the same set the hand list named: profile, p, x and
 * found on scrape.js, and p, x plus `s` (the sports map's row, inside scanner's
 * own cut) on scanner.js. `s` contributes `id` and `name`; `name` is not a
 * profile leaf and this census weighs only reads the page does NOT have, so an
 * extra name in the read set changes no verdict.
 *
 * What stays typed is where the windows are: the three function names on
 * scrape.js and the fetch-to-listener cut in scanner.js. A function name is a
 * fact a rename can only make LOUD — functionWindow throws on a missing name —
 * while widening the cuts to whatever looks like a profile consumer would sweep
 * in the job tables, which read `id` through `j` and would credit a profile
 * leaf no page reads. Over-crediting is the silent direction, so the cuts stay
 * hand-named and everything inside them is derived.
 *
 * The alias NAME derives too, but its window still starts at the binding line
 * and ends at the first line that closes the statement chain. That cut is what
 * keeps `d` honest: a page-wide search for `d.` on scrape.js returns `ours`,
 * `theirs`, `getTime`, `labelKey` and `toLocaleTimeString`, and on scanner.js
 * `profiles` and `sports` — six names that are not profile rows at all.
 */

/** The windows each consumer reads a profile row in. */
const PROFILE_RECEIVERS = {
  'scrape.js': { scope: () => [PROFILE_LABEL, APPLY_PROFILE, APPLY_PROFILE_HINT] },
  'scanner.js': { scope: () => [scannerProfileBlock()] },
  'settings.js': { scope: () => [settingsProfileBlock()] },
};

/** The bare leaves of the pinned row: `defaults.*` is read through its own two shapes. */
const PROFILE_ROW_LEAVES = PROFILES_ROW
  .filter((key) => !key.startsWith('defaults.'))
  .map(leafOf)
  .sort();

/**
 * The identifiers the windows bind a profile row to, derived from the leaves
 * they read.
 *
 * Derived because the hand list it replaces could only be stale in one
 * direction, and that direction was an accusation against the page: a receiver
 * nobody had written down read a leaf, and the leaf came back reported as
 * unread. Nothing re-checked the list against the code.
 *
 * `s` lands in the scanner set because the sports map sits inside the cut and
 * sports have an `id`. Counting it is deliberate over-collection: the census
 * only ever asks which published leaves are MISSING from the set, so a
 * non-profile name can hide nothing.
 *
 * @param {string[]} cuts the windows a page reads a profile row in
 * @returns {string[]} unique, sorted; empty only if no window reads the row
 */
function profileRowReceivers(cuts) {
  const found = new Set();
  for (const cut of cuts) {
    for (const leaf of PROFILE_ROW_LEAVES) {
      for (const m of cut.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.${leaf}\\b`, 'g'))) found.add(m[1]);
    }
  }
  return [...found].sort();
}

/**
 * The block of scanner.js that consumes a profile row.
 *
 * scanner.js keeps no top-level function for this the way scrape.js does — the
 * rows are used inside the page's nested `init()`, in the `<option>` list it
 * builds and in the change listener that applies a profile's defaults. The cut
 * runs from the fetch (measured :343) to the close of the statement that binds
 * those defaults (measured :362-367), and both ends are loud: a page that stops
 * fetching the route, or stops binding a profile's defaults, fails here rather
 * than reporting every profile field unread.
 *
 * The far end used to be the FIRST `});` after the fetch, which was the profile
 * listener only because nothing else closed a statement in between. A sport
 * listener added there ended the cut before the defaults read, and this
 * function threw "measuring the wrong region" — the tripwire doing its job on
 * a derivation that named a line shape instead of the region it wanted. The
 * defaults binding now picks the end, so a listener inserted between the two
 * ends widens the cut instead of truncating it, and the check that the cut
 * contains a defaults read moved into the finder: it cannot fail here any more,
 * and a check that cannot fail is worse than no check.
 */
function scannerProfileBlock() {
  const lines = scannerCode.split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes("arbiterApi.get('/api/profiles')"));
  if (from === -1) throw new Error('scanner.js no longer fetches /api/profiles');
  const binding = lines.findIndex((l, i) => i > from && l.includes('p.defaults'));
  if (binding === -1) throw new Error('scanner.js no longer binds a profile default after the fetch — it is measuring the wrong region');
  const to = lines.findIndex((l, i) => i > binding && l.trim() === '});');
  if (to === -1) throw new Error('scanner.js no longer closes the profile change listener on its own line — the cut would run away');
  return lines.slice(from, to + 1).join('\n');
}

/**
 * The block of settings.js that consumes a profile row.
 *
 * The page names row fields in exactly one place — the fill of the profile
 * select inside renderFields() — while the fetch itself sits in refresh() and
 * the defaults are consumed wholesale: profileDefaults() spreads
 * `profile.defaults` into the payload, which names no leaf, so this census
 * cannot see it (the defaults' leaves are weighed union-side by scrape.js and
 * scanner.js, which do name them). The cut is the select's own statement, and
 * both ends are loud: a page that stops filling the select, or stops naming a
 * field while filling it, fails here rather than at the floor below.
 *
 * functionWindow() cannot cut this one: its convention is a top-level
 * function's body ending on a `}` in column 0, and every function in
 * settings.js is indented inside the mount IIFE.
 */
function settingsProfileBlock() {
  const lines = settingsCode.split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes("$('set-profile').innerHTML ="));
  if (from === -1) throw new Error('settings.js no longer fills the profile select — it is measuring the wrong region');
  const to = lines.findIndex((l, i) => i > from && l.trimEnd().endsWith(';'));
  if (to === -1) throw new Error('settings.js no longer closes the profile select statement on its own line — the cut would run away');
  return lines.slice(from, to + 1).join('\n');
}

/** Every page that fetches the route, derived rather than written down. */
function profileConsumers() {
  const files = readdirSync(join(ROOT, 'public/js/pages')).filter((f) => f.endsWith('.js')).sort();
  const out = [];
  for (const file of files) {
    const code = codeOnly(readText(`public/js/pages/${file}`), true);
    if (!code.includes("arbiterApi.get('/api/profiles')")) continue;
    const spec = Object.prototype.hasOwnProperty.call(PROFILE_RECEIVERS, file) ? PROFILE_RECEIVERS[file] : null;
    if (!spec) throw new Error(`${file} fetches /api/profiles and this census has no receiver spec for it — write one rather than let its fields count as unread`);
    out.push([file, spec]);
  }
  if (out.length !== Object.keys(PROFILE_RECEIVERS).length) {
    throw new Error(`the receiver spec names ${Object.keys(PROFILE_RECEIVERS).length} pages and ${out.length} fetch the route — a spec outlived its page`);
  }
  return out;
}

/**
 * The reads on every alias this page binds from `something.defaults`, each
 * inside its own window.
 *
 * The alias NAME is derived rather than passed in: the table used to say `alias:
 * 'd'`, and a rename in the page would have thrown "no longer bound" at the
 * instrument while the reads sat right there under the new name — the same
 * accusation against the page that the receiver list above used to make. What
 * stays hand-cut is where a window opens and closes: the binding line opens it,
 * the first line that closes the statement chain ends it. That cut is what keeps
 * the alias honest, because the same name is rebound to other payloads elsewhere
 * on both pages.
 *
 * A page with no such binding simply yields no alias reads here; if its defaults
 * leaves are unread they surface in the census below, which is the loud place
 * for that verdict rather than a probe that fires before the census has looked.
 *
 * @param {string} code comment-blanked page source
 * @returns {Set<string>} fields read on all bindings' windows
 */
function aliasDefaultsReads(code) {
  const lines = code.split(/\r?\n/);
  const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.defaults\b/;
  const out = new Set();
  lines.forEach((line, start) => {
    const match = binding.exec(line);
    if (!match) return;
    const alias = match[1];
    const end = lines.findIndex((l, i) => i > start && ['};', '}', '});'].includes(l.trim()));
    if (end === -1) throw new Error(`${alias} binds a row's .defaults but the window has no closing line — the cut would run away`);
    for (const field of fieldsOn(lines.slice(start, end + 1).join('\n'), alias)) out.add(field);
  });
  return out;
}

const profileReadsOn = (file, spec) => {
  const code = codeOnly(readText(`public/js/pages/${file}`), true);
  const out = new Set();
  const cuts = spec.scope();
  const rows = profileRowReceivers(cuts);
  // Derived, so an unbound name cannot happen — but a window that reads no row
  // field at all can: it means the cut moved to a region that is not the profile
  // consumer, and every leaf would come back unread for pages that read them.
  if (!rows.length) throw new Error(`${file}: none of its profile windows reads a published row field — the cut moved, so it is no longer measuring the consumer`);
  for (const r of rows) {
    // Only the row's own published leaves belong in a profile read set. The
    // derivation hands back every receiver that touches one — including `s`, the
    // sports row inside scanner's cut — and a field like `name` that the sports
    // map reads through it is not coverage of a profile row. The census only
    // weighs what is missing, but the floor and the union control below weigh
    // the set itself, and they are counting profile leaves.
    for (const cut of cuts) for (const f of fieldsOn(cut, r)) if (PROFILE_ROW_LEAVES.includes(f)) out.add(f);
  }
  // Dotted (`p.defaults.bankroll`) and aliased (`d.includeLive`) are the two
  // shapes the tree uses; both are collected, and only over the leaves the
  // config actually publishes — `applyProfile` also reads `p.defaults.maxEvents`,
  // which no shipped profile carries, so that read is a guard and not a field.
  const dotted = cuts.flatMap((cut) => [...cut.matchAll(/\b\w+\.defaults\.(\w+)\b/g)].map((m) => m[1]));
  const aliased = [...aliasDefaultsReads(code)];
  for (const key of PROFILES_ROW) {
    if (!key.startsWith('defaults.')) continue;
    const leaf = key.slice('defaults.'.length);
    if (dotted.includes(leaf) || aliased.includes(leaf)) out.add(leaf);
  }
  return out;
};

const profileReads = () => {
  const out = new Set();
  for (const [file, spec] of profileConsumers()) for (const f of profileReadsOn(file, spec)) out.add(f);
  return out;
};

/**
 * `/api/scrape-run`: `run` for the document, `j` for its rows — and `j` is also
 * the scrape state's rows, so a read here counts for both documents. Counted
 * rather than resolved, because separating them would mean guessing which of the
 * two tables a given `j` came from.
 */
const runReads = () => new Set([...fieldsOn(scrapeCode, 'run'), ...fieldsOn(scrapeCode, 'j')]);

/**
 * The job rows of both run documents.
 *
 * Two bindings, because the page hands the row to a helper: the render and the
 * filters take it as `j`, and `isFailedJob` — which is what decides whether a
 * row counts as failed — takes it as `job` and is the only reader of `valid`.
 * Counting `j` alone reported a field the page reads as unread.
 *
 * `j` is bound for both documents, so a read here counts for both. Counted
 * rather than resolved: separating the two would mean guessing which table a
 * given row came from, and a census that guesses is a census that can be made
 * to pass.
 */
const jobRowReads = () => new Set([...fieldsOn(scrapeCode, 'j'), ...fieldsOn(scrapeCode, 'job')]);

/**
 * The error object's own fields, read inside one table's body.
 *
 * `fieldsOn` returns the first segment of a dotted read, so it answers `error`
 * and stops. This asks for the second: `j.error.message` is a read of `message`
 * and `j.error` on its own is not. Both tables also test `typeof j.error ===
 * 'string'`, which is a shape check and must not be counted as a field read — the
 * anchor requires a dot and a name after it, so that line contributes nothing.
 *
 * The `j` anchor is the reason this takes a window and not the whole page. Both
 * tables bind `j`, and so does `renderRequoteProgress` — on a different payload,
 * the per-book requote result, which is neither of these two routes.
 */
const errorFieldsOn = (window, receiver) => [...new Set(
  [...window.matchAll(new RegExp(`\\b${receiver}\\.error\\.(\\w+)`, 'g'))].map((m) => m[1]),
)].sort();

/** `/api/scrape/state`'s error object: read by the live job table only. */
const stateErrorReads = () => new Set(errorFieldsOn(JOB_ROWS, 'j'));

/** `/api/scrape-run`'s error object: read by the run-report table only. */
const runErrorReads = () => new Set(errorFieldsOn(RUN_ROWS, 'j'));

/* ── the exempt list, every reason measured ────────────────────────────────── */

/** Route labels, spelled once so a key and its census cannot drift apart. */
const R_SCRAPERS_JOB = 'GET /api/scrapers · job';
const R_SCRAPERS_ARRAYS = 'GET /api/scrapers · arrays';
const R_PROFILES = 'GET /api/profiles · row';
const R_STATE_JOB = 'GET /api/scrape/state · job';
const R_STATE_OPTIONS = 'GET /api/scrape/state · options';
const R_STATE_SUMMARY = 'GET /api/scrape/state · summary';
const R_RUN_JOB = 'GET /api/scrape-run · job';
// The error object is censused on its own, under its own label, because the
// producer differs per route and an exemption written about one of them would
// otherwise be borrowed onto the other. That is the `sourceIds` lesson again:
// the route has to be part of the key before two rows can both be true.
const R_STATE_ERROR = 'GET /api/scrape/state · job.error';
const R_RUN_ERROR = 'GET /api/scrape-run · job.error';

/**
 * The reasons, written once each. An entry's rule is that it names a
 * measurement. "Nobody needs this" is not a reason; "26 of 26 jobs read
 * `verified`, so it is a constant today" is, and it is falsifiable — the day the
 * value moves, the measurement behind this reason stops being true and the
 * reason has to be rewritten in the same commit as the field that moved.
 */
const WHY = {
  constant: [
    'A constant, measured: every job in config/scrapers.json reads one `feedStatus`,',
    'and data/endpoints/endpoints.json records the same value for every one of',
    'them. A chip would gain a word and say nothing. The page writes down where',
    'this belongs — the note above `chipTitle` in public/js/pages/scrape.js says',
    'it earns a line when it starts to vary — and the control below re-derives both',
    'halves instead of trusting this paragraph.',
  ].join(' '),

  transport: [
    'Redundant with `engine`, measured: across the 13 engine families in',
    'config/scrapers.json, 12 map to exactly one transport. The exception is the',
    'nsoft family, whose three jobs split across two transports, and the tooltip',
    'already distinguishes all three by `script`.',
  ].join(' '),

  platform: [
    'A coarser partition of the same fact, measured: no engine family in',
    'config/scrapers.json spans more than one `platform`, and `platform` takes 12',
    'values where `engine` takes 13. The chip shows the finer one.',
  ].join(' '),

  oddsFeed: [
    'The discovery record kept in config for three books, and its date is already',
    'on the chip: betmen, prowin and ultrabet all read `endpointVerifiedAt`',
    '2026-09-27, the same day as their `oddsFeed.measuredAt`. What is left is the',
    'endpoint URL and the tenant identifiers behind it, which are what the',
    'validation reason already explains in prose.',
  ].join(' '),

  unavailableSports: [
    'Read by nothing in src/, scripts/ or public/ — the field is inert rather than',
    'merely unrendered, and it carries one book (betano). The same caveat is',
    'recorded in data/endpoints/endpoints.json, which is the document that owns',
    'endpoint caveats; a page rendering it would be the second place to keep it.',
  ].join(' '),

  sourceIds: [
    'The capture ids a scraper writes, and no page shows them. Measured: every',
    'adapter declares them (src/scrapers/*.mjs), src/scrape-orchestrator.mjs:141',
    'expands the enabled set with them, and each extracted event is stamped with',
    'one — so the field is the join between a job and the capture files under the',
    'data directory. The page reads those files through GET /api/odds/:book',
    'instead, which is keyed by book rather than by the capture ids this field',
    'carries. The two other routes publish the same name with different facts',
    'behind them, and each carries its own paragraph rather than borrowing this',
    'one: `stateSourceIds` and `runSourceIds`.',
  ].join(' '),

  // One field, two routes, two opposite facts — so two reasons, not one shared
  // paragraph. The paragraph they used to share was written about a run row, and
  // it was applied to the state row as well because the route was the only part
  // of the key that differed. That borrowed a true statement onto a row where it
  // is false in a stronger way: on the run row the field is populated, and on the
  // state row it never has been.
  stateSourceIds: [
    'Published and never filled — measured on the writers, not on the file: 0 of',
    'the 24 rows in data/scrape-state.json carry an id, while 24 of 24 rows of',
    'data/latest-scrape-run.json do, written 31 seconds apart by one run. The',
    'cause is src/scraper-service.mjs:147, where the batch report spreads the',
    'adapter result (which carries `sourceIds` from src/scrapers/base.mjs:209) over',
    'the job, against the fold at src/scrape-orchestrator.mjs:417-424 and 442-447,',
    'which copies seven fields by name and omits this one. `j.sourceIds =` appears',
    '0 times in that file and `job.sourceIds =` 0 times in the service. So the row',
    'on the wire carries an array that is empty on every scrape, forever, and the',
    'page is right not to draw it — there is nothing there to draw. The control',
    'below pins the measurement, and the day a fold starts writing it, that control',
    'fails and this reason has to be rewritten.',
  ].join(' '),

  runSourceIds: [
    'The capture ids a run row wrote, and no page on the run route shows them.',
    'Measured: every adapter declares them (src/scrapers/*.mjs),',
    'src/scrape-orchestrator.mjs:141 expands the enabled set with them, and each',
    'extracted event is stamped with one — so the field is the join between a job',
    'and the capture files under the data directory. Populated on 24 of 24 stored',
    'rows, e.g. `admiral: ["admiral"]`, so this exemption is about the row being',
    'drawn and not the field being empty. The page reads those capture files',
    'through GET /api/odds/:book instead, which is keyed by book rather than by',
    'the capture ids this field carries. The two frontend reads of the name are on',
    'alert rows, not job rows: public/js/pages/scanner.js:148 and',
    'public/js/pages/alerts.js:180.',
  ].join(' '),

  // `name` is no longer on this list, and that is the list working. It was
  // exempt twice, on both run documents, with a reason that said the row
  // resolves its label through GET /api/scrapers. Then the panel gained a
  // `bookCell` and both tables began drawing the name the row already carries —
  // the live job table above the panel had been doing it all along, so the two
  // halves of one panel were naming the same book two different ways. An
  // exemption is a statement about today; the day a page starts reading the
  // field, the statement is false and the entry has to go in the same commit as
  // the read. The test below enforces that from the other side.

  // `label` was on this list once and the test below removed it, which is the
  // list working. It belongs to a category this table does not hold: the page
  // does read it, in profileLabel's fallback for a profile with no mode, and both
  // shipped profiles carry a mode so that branch never runs. Read-but-currently-
  // unreachable is not unread, and writing it down as unread would have been a
  // claim the page contradicts. The measurement is pinned as a control instead.
  valid: [
    'Redundant with `status` at every producer that can write it, measured rather',
    'than assumed: every reachable site in src/ that writes `valid: false` sets an',
    'explicit status beside it, and those sites use six words between them — cancelled,',
    'skipped, pending, failed, timeout, unknown. isFailedJob (public/js/pages/',
    'scrape.js:51) decides each of those six by status alone, with or without',
    '`valid`, so the row the run table draws is already the whole verdict; the',
    'control below runs the page\'s own predicate over the set to keep that true.',
    'Scoped to the run document on purpose — the state rows are read, because',
    'isFailedJob is what counts the failed jobs on the KPI card, and a global',
    'entry would have exempted it there too.',
  ].join(' '),

  filterArray: [
    'A filter of `jobs`, which the page already has: `job.enabled !== false` and',
    '`validationStatus !== \'validated\'` are one predicate each, applied to 26',
    'objects the route has already sent. The page takes `jobs` and',
    '`validatedJobs` and derives the rest itself.',
  ].join(' '),

  marketDiagnostics: [
    'Produced by nothing in this tree, measured on the writers rather than on a',
    'stored sample: BaseScraper._serializable (src/scrapers/base.mjs:348) emits 9',
    'keys and 13 adapters override it adding four more — coverage, sourceUrl,',
    'transport and scrapeLimits — for 13 in all, and this name is in neither list.',
    'So `result.marketDiagnostics` is undefined on every job, the orchestrator',
    'stores null (src/scrape-orchestrator.mjs:422), and the fold below has nothing',
    'to fold. The 16 of 22 captures in data-market-run/workspace that carry it were',
    'written by a version that no longer exists; test/snapshot-route.test.mjs',
    'measures that too, from the writer side.',
  ].join(' '),

  markets: [
    'The same measurement as `marketDiagnostics`, one level up: mergeMarketDiagnostics',
    'reads `job.marketDiagnostics.markets` (src/scrape-orchestrator.mjs:463) and',
    'every job\'s copy is null, so the array is empty on every run. The stored',
    'data/scrape-state.json measures it as `[]`, which is what an unfilled fold',
    'looks like rather than what a complete one looks like.',
  ].join(' '),

  // `options` is no longer on this list, and the reason it used to carry is gone
  // with it. That reason said the field could not be judged, because the tree
  // keeps one sample of a run's parameters and one sample cannot tell a field
  // that varies from one that does not. The judgeability was never the problem:
  // the nine fields the form collects were on the page, on the state's `options`
  // and on nothing in between. `runOptionsText` walks the same table
  // `schedulerScanDiff` walks, in the form's own labels, so the panel above the
  // last run's results now says what that run was looking for.
  //
  // It was also the only reason in this table that nothing referenced. The entry
  // below had been blanked to keep it out of the exemption while the prose stayed
  // here, so `WHY.options` was dead weight that still read like a live argument.
  // An unreferenced reason is worse than none: the next author would have read it
  // as the standing justification for the gap it describes.

  // The next two are the error object's own fields, and they are the first
  // exemptions here written about a field nobody had looked at: `error` was a
  // leaf, so its five keys were outside the census until this lot gave them their
  // own rows. That is also why these two read differently from the rest of the
  // table. Every reason above answers "why is this field not drawn", and this one
  // answers a sharper question — would drawing it say anything the sentence above
  // it does not already say — because the answer decides whether connecting it
  // helps or only lengthens the row.
  errorField: [
    'A machine-readable restatement of the sentence beside it. Measured over the',
    'modules the running program can reach from src/server.mjs, not over every',
    'file under src/ — a file nothing imports still scans as a site, and the',
    'total that comes out describes the directory rather than the program. At',
    'most of those the field sits inside the message itself (`id` on "event',
    'missing id", `events` on "no favbet events"), which is the strongest form',
    'of restating it. At the rest it is the same fact in other words —',
    '`response.size` on "response exceeds … MB", `markets.selections.odds` on',
    '"selection has invalid odds" — and those are judgements no regex can make,',
    'so each is named in the control below instead of being counted. The sites',
    'that propagate an inner error\'s field are the wrapper in',
    'src/scrapers/base.mjs, and they need no separate paragraph: the error they',
    're-throw is a ValidationError whose own message carries the field. A path',
    'built for a machine to match on is not a second thing to show a person',
    'already reading the sentence that carries it.',
  ].join(' '),

  errorStatus: [
    'The HTTP status the message already spells out, measured site by site over',
    'every place under src/ that the server can reach and that sets one: at all',
    'but one the message carries the same value — interpolated, as an HTTP error',
    'message does, or as the digits a rate-limit sentence carries. The exception is',
    'src/scrapers/everymatrix-wamp.mjs, which rejects a dealer protocol frame as a',
    'bad gateway and says only what the frame was. No configured job id names it, so',
    'no job row this page draws can carry the status, and the control below checks',
    'both halves — that the exception is still the only one, and that no WAMP job',
    'appeared to make it reachable. Scoped to the state route: the run route does not',
    'publish `status` at all, and says nothing about `code` beside it, which that',
    'route drops and this one reads.',
  ].join(' '),
};

/**
 * Published by these routes, read by no page, with the reason it is allowed.
 *
 * Every key is `route › field`, and the route is part of the key on purpose. A
 * bare field name would exempt that field on every route at once, and `valid` is
 * the case that still makes the rule: `isFailedJob` reads it on a STATE job —
 * that is what counts the failed jobs on the KPI card — while a RUN job's copy
 * is a second word beside a status the page already draws. A global entry would
 * have exempted the first behind a reason written about the second. The test
 * below checks the other direction — nothing here may name a field its own route
 * reads.
 *
 * A field or any of its ancestors may be named, so `oddsFeed` covers its twelve
 * leaves without a list that says the same thing twelve times over.
 *
 * Three entries left this table in this lot, and each one left it because a page
 * started reading the field: `name` on both run documents (the `bookCell` both
 * job tables draw) and `options` on `/api/scrape/state` (`runOptionsText`). The
 * test that names those fields is the test that catches a stale entry, so a
 * reason left behind is a failing test rather than a stale paragraph.
 */
const UNREAD_BY_DESIGN = {
  [`${R_SCRAPERS_JOB} › feedStatus`]: WHY.constant,
  [`${R_SCRAPERS_JOB} › transport`]: WHY.transport,
  [`${R_SCRAPERS_JOB} › platform`]: WHY.platform,
  [`${R_SCRAPERS_JOB} › oddsFeed`]: WHY.oddsFeed,
  [`${R_SCRAPERS_JOB} › unavailableSports`]: WHY.unavailableSports,
  [`${R_SCRAPERS_JOB} › sourceIds`]: WHY.sourceIds,
  [`${R_SCRAPERS_ARRAYS} › enabledJobs`]: WHY.filterArray,
  [`${R_SCRAPERS_ARRAYS} › experimentalJobs`]: WHY.filterArray,
  [`${R_STATE_JOB} › marketDiagnostics`]: WHY.marketDiagnostics,
  [`${R_STATE_JOB} › sourceIds`]: WHY.stateSourceIds,
  [`${R_STATE_SUMMARY} › markets`]: WHY.markets,
  [`${R_RUN_JOB} › sourceIds`]: WHY.runSourceIds,
  [`${R_RUN_JOB} › valid`]: WHY.valid,
  // `errorField` covers two routes on purpose: the claim is one claim about one
  // field — both routes publish the same `_shapeError` literal, the run one
  // through `sanitizeReport` — so there is nothing per-route to keep apart. The
  // rule that forbids sharing is about fields whose facts DIFFER per route, and
  // `status` is the one where they do, which is why it is written once and only
  // against the route that publishes it.
  [`${R_STATE_ERROR} › field`]: WHY.errorField,
  [`${R_STATE_ERROR} › status`]: WHY.errorStatus,
  [`${R_RUN_ERROR} › field`]: WHY.errorField,
};

/* ── the censuses ──────────────────────────────────────────────────────────── */

const chipReadSet = scrapersJobReads();
const envelopeReadSet = scrapersEnvelopeReads();
const stateReadSet = new Set([...stateReads(), ...jobRowReads()]);

/** Every census in one list, so the two tests below can walk all of them. */
const CENSUS = [
  {
    label: R_SCRAPERS_JOB,
    published: [...keysOfRows(SCRAPERS.jobs), 'liveCapability'].sort(),
    pinned: SCRAPERS_JOB,
    reads: () => chipReadSet,
  },
  {
    label: R_SCRAPERS_ARRAYS,
    published: returnedKeys('GET /api/scrapers'),
    pinned: SCRAPERS_ARRAYS,
    reads: () => envelopeReadSet,
  },
  { label: R_PROFILES, published: keysOfRows(PROFILES.profiles), pinned: PROFILES_ROW, reads: profileReads },
  // The two job rows take their published set from the producer, like the options
  // and summary rows above. They used to take it from the stored documents, which
  // made the census a report on the last scrape run on this machine rather than a
  // report on the backend — the file is now only a subset control, below.
  { label: R_STATE_JOB, published: producedStateJobKeys(), pinned: STATE_JOB, reads: () => stateReadSet },
  { label: R_STATE_OPTIONS, published: producedOptionKeys().map((k) => `options.${k}`), pinned: STATE_OPTIONS, reads: optionsReads },
  { label: R_STATE_SUMMARY, published: producedSummaryKeys(), pinned: STATE_SUMMARY, reads: summaryReads },
  { label: R_RUN_JOB, published: producedRunJobKeys(), pinned: RUN_JOB, reads: runReads },
  // The error object, on its own rows and under its own labels. Splitting the two
  // tables is what makes these two censuses say something: both bind the row as
  // `j`, so a shared receiver would report the run table's read of `name` as a
  // read on the state table too, and the state table is precisely the one that
  // did not read it until this lot connected it.
  { label: R_STATE_ERROR, published: producedStateErrorKeys(), pinned: STATE_JOB_ERROR, reads: stateErrorReads },
  { label: R_RUN_ERROR, published: producedRunErrorKeys(), pinned: RUN_JOB_ERROR, reads: runErrorReads },
];

/* ── the tests ─────────────────────────────────────────────────────────────── */

/**
 * The census: every published key is read by the page, or named above with a
 * reason.
 *
 * The list handed in is compared against what the document really holds, so a
 * field added to any of these documents fails here instead of becoming one more
 * thing nobody sees. That comparison is the canary; the exempt table is the
 * ledger.
 */
function censusFor({ label, published, pinned, reads }) {
  assert.deepEqual(published, [...pinned].sort(),
    `${label} gained or lost a field — re-measure it and decide whether a page reads it`);
  const unread = published.filter((k) => !reads().has(leafOf(k)) && !exempt(k, label));
  assert.deepEqual(unread, [], `${label}: no page reads these, and they carry no reason above`);
}

test('every published field of these four documents is read, or has a measured reason', () => {
  for (const census of CENSUS) censusFor(census);
});

/**
 * The stored state is a sample of the producer, not a second definition of it.
 *
 * This is the half that keeps the derived census honest about the file it no
 * longer reads. `censusFor` compares the producer against a list written by hand,
 * which says the two agree; it says nothing about the document a running server
 * would serve, and that document is written from the same producer. So the file
 * has to stay inside it: a stored key the producer cannot build means the state
 * on disk was written by a build that no longer exists, and every claim this
 * census makes about the served document would be about that build instead.
 *
 * The converse is not asserted, and the reason is the measurement above: the
 * stored copy carries between 7 and 11 of the eleven depending on the last run's
 * optional inputs, so demanding all eleven would demand that someone had run a
 * scrape with every switch on. What is demanded is the direction that can catch
 * a defect.
 */
test('the stored state carries no option the producer cannot build', () => {
  const built = new Set(producedOptionKeys());
  const stored = Object.keys(STATE.options || {});
  const foreign = stored.filter((k) => !built.has(k));
  assert.deepEqual(foreign, [],
    `data/scrape-state.json carries option keys nothing builds any more: ${foreign.join(', ')} — the file is from a build this branch does not have`);
  // Named so the subset control cannot be mistaken for "the file agrees": it is
  // measured how much of the producer the last run happened to exercise.
  assert.ok(stored.length > 0 && stored.length <= built.size,
    `data/scrape-state.json carries ${stored.length} of the ${built.size} fields the producer builds — the direction of this control moved`);
});

/**
 * Every consumer is really being read, each over its own window.
 *
 * Widening the reader set moves no verdict today: scanner.js reads a strict
 * subset of what scrape.js reads — six of the ten leaves, and neither `mode`,
 * nor `description`, nor the two scope switches — and settings.js, the third
 * consumer, names `id` and `label`, a subset of both. A change that moves no
 * verdict cannot be shown by breaking a page, so the thing that has to be
 * pinned instead is that each consumer still contributes at all.
 *
 * The floors are measured per page, not shared, because a shared floor is a
 * floor on the union and the union is what never moved. The numbers come from
 * the same run of `profileReadsOn` this census calls: scrape.js touches ten
 * leaves, scanner.js six — the four defaults its alias window can see, plus
 * `id` and `label` (a search for `d.` page-wide would have added `profiles`
 * and `sports`, which are two response envelopes and not profile rows) — and
 * settings.js two, all it names while filling its select.
 */
const PROFILE_READ_FLOOR = { 'scrape.js': 10, 'scanner.js': 6, 'settings.js': 2 };

test('all three consumers of /api/profiles are read, each over its own window', () => {
  for (const [file, spec] of profileConsumers()) {
    const found = profileReadsOn(file, spec);
    const floor = PROFILE_READ_FLOOR[file];
    assert.ok(found.size >= floor,
      `${file} contributes ${found.size} profile leaves, under its floor of ${floor} — its window stopped seeing the reads`);
  }
  // The consumers overlap, and the overlap is a measurement rather than an
  // assumption: it is why the union is ten and not the sum. Stated as "read by
  // exactly one of them" so the assertion does not depend on which of them the
  // derived list happens to return first.
  const sets = profileConsumers().map(([file, spec]) => profileReadsOn(file, spec));
  const byExactlyOne = [...new Set(sets.flatMap((s) => [...s]))]
    .filter((f) => sets.filter((s) => s.has(f)).length === 1).sort();
  assert.deepEqual(byExactlyOne, ['description', 'includeLive', 'includePast', 'mode'],
    'the consumers no longer read the same set — a field moved between pages');
  assert.equal(PROFILES_ROW.length, new Set(sets.flatMap((s) => [...s])).size,
    'the consumers no longer cover every leaf the config publishes between them');
});

test('the scraper route still publishes what the census names', () => {
  // The arrays census above already compares the route's own returned keys
  // against the pinned list, so this covers the one field that is added to every
  // job by the route and is in no stored document: naming it is a claim that the
  // route builds it, so the route is checked rather than trusted.
  assert.match(routerSource, /liveCapability: liveCapabilityFor\(job\.id\)/,
    'GET /api/scrapers must still publish liveCapability on every job');
  assert.deepEqual([...envelopeReadSet].sort(), ['jobs', 'validatedJobs'],
    'the page binds exactly these two; the other two are filters of jobs, not new information');
});

/**
 * Both stored job documents are samples of their producer, like the options above.
 *
 * The census stopped reading these two files as its definition of what the routes
 * publish, and they did not stop being checked: a key on disk that the producer
 * cannot build means the file was written by a build this branch does not have,
 * and every claim the census makes about the served document would then be about
 * that build. Measured: both files carry exactly their producer's key set on
 * disk right now — 24 rows of 11 keys and 24 rows of 8 — so the subset control
 * has no slack today, and it is still written as a subset because that is the
 * direction that can catch the defect. `sourceIds` is why: a row whose arrays
 * happened to be non-empty would arrive marked, and a marked key is not a foreign
 * key, so the markers are compared on their leaves.
 */
test('neither stored job document carries a key its producer cannot build', () => {
  for (const [file, doc, produced] of [
    ['data/scrape-state.json', STATE, producedStateJobKeys()],
    ['data/latest-scrape-run.json', RUN, producedRunJobKeys()],
  ]) {
    const built = new Set(produced.map((k) => leafOf(k)));
    const stored = keysOfRows(doc.jobs);
    const foreign = stored.filter((k) => !built.has(leafOf(k)));
    assert.deepEqual(foreign, [],
      `${file} carries job keys nothing builds any more: ${foreign.join(', ')} — the file is from a build this branch does not have`);
    assert.ok(stored.length > 0 && stored.length <= built.size,
      `${file} carries ${stored.length} of the ${built.size} job keys the producer builds — the direction of this control moved`);
  }
});

/**
 * The two `sourceIds` rows are opposites, and the measurement behind them is the
 * writers, not the file.
 *
 * One exemption used to cover all three routes, and the paragraph it carried was
 * true of one of them. On the run row the field is populated — 24 of 24 stored
 * rows, `admiral: ["admiral"]` — so "no page draws it" is the whole claim. On the
 * state row it has never been populated at all: 0 of 24, written 31 seconds after
 * the run file by the same scrape. The cause is that the batch report spreads the
 * adapter result over the job while the orchestrator's folds copy seven fields by
 * name, so the two documents disagree about the same field and both are right.
 *
 * So this pins the writers rather than the sample. A stored-file reading would
 * still hold on this machine, and would go quiet on the next scrape that filled
 * the field, which is the one moment the reason stops being true. The assertions
 * below fire in that moment, and the day they do the paragraph is rewritten
 * instead of left to become a second stale one.
 */
test('the state row publishes sourceIds that no writer ever fills, and the run row does', () => {
  assert.ok(producedStateJobKeys().includes('sourceIds[]'),
    'the state job row no longer publishes sourceIds — drop its exemption and say whether a page reads it');
  assert.ok(!producedRunJobKeys().includes('sourceIds[]'),
    'the run job row marks sourceIds as a declared empty array — re-measure which of the two documents this exemption describes');

  const filled = (src, receiver) => [...src.matchAll(new RegExp(`\\b${receiver}\\.sourceIds\\s*=`, 'g'))].length;
  assert.equal(filled(orchestratorSource, 'j'), 0,
    'an orchestrator fold now writes j.sourceIds — the state row fills it, so WHY.stateSourceIds is no longer true');
  assert.equal(filled(serviceSource, 'job'), 0,
    'the scraper service now writes job.sourceIds — the state row fills it, so WHY.stateSourceIds is no longer true');

  // The other half of the contrast, because a control that only says "the one
  // exemption is still true" would pass just as happily if the run row stopped
  // being filled too. The run row is filled by a spread, not by a named
  // assignment, so that is what has to be there.
  assert.match(serviceSource, /jobs:\s*jobs\.map\(\s*\(job\)\s*=>\s*\(\{\s*\.\.\.job,\s*\.\.\.results\.get\(job\.id\)\s*\}\)\s*\)/,
    'the batch report no longer spreads the adapter result over the job — WHY.runSourceIds no longer describes a populated field');
});

/**
 * The other direction of the exempt table: nothing may name a field its own
 * route actually reads.
 *
 * An exemption is a statement about today. The day a page starts reading one of
 * these, the statement is false, and a census that cannot notice has stopped
 * being an audit. This is why the entries are route-scoped rather than bare
 * names — `valid` is read on a state job and exempt on a run job, and only the
 * scope lets both be true at once.
 */
test('no exemption names a field its own route reads', () => {
  for (const key of Object.keys(UNREAD_BY_DESIGN)) {
    const [route, ...rest] = key.split(' › ');
    const field = rest.join(' › ');
    const census = CENSUS.find((c) => c.label === route);
    assert.ok(census, `${route} is exempted from but is not one of the censuses above`);
    assert.ok(!census.reads().has(field),
      `${key} is exempt, but the page reads it — remove the entry and say why in the same commit`);
  }
});

/**
 * Every entry carries a reason, and the reason is a measurement, not an opinion.
 *
 * This file used to hold one deliberate blank — `options`, the field it could not
 * judge — checked from both sides so the blank could not become a way to smuggle
 * an unreasoned entry past the census above. The field is read now, so the blank
 * went with it and nothing is excepted without a reason: an entry carrying none
 * is a field nobody looked at, and it fails as loudly as an unread one.
 *
 * The second half is the part the census above cannot check, so it is checked
 * here: a reason is only worth carrying if it contains a number or names a file
 * to check against, and if it is an argument rather than a stub. "Nobody needs
 * this" passes a `.trim()` and would have been allowed to stand in the place of
 * the paragraph it replaced. The floor is 150 characters, which the shortest
 * live reason (`platform`, 206) clears and a one-line excuse does not.
 *
 * Sharing a paragraph between entries is allowed and is not checked against:
 * `WHY.filterArray` covers two routes, because the claim is one claim about one
 * field. What makes that safe is the route being part of the key — a shared
 * paragraph cannot exempt a field nobody measured, because the census still asks
 * whether the page reads it.
 *
 * What sharing is not safe for is a field whose facts differ per route, and that
 * is what `sourceIds` turned out to be: one paragraph had covered all three of
 * its routes and was true of one. The route being in the key is what let the
 * borrow happen, so the rule is now narrower — a name that appears on more than
 * one route with its own paragraph beside each one keeps them apart.
 */
test('no exemption is unreasoned, and every reason names what was measured', () => {
  const unreasoned = Object.keys(UNREAD_BY_DESIGN).filter((k) => !UNREAD_BY_DESIGN[k].trim());
  assert.deepEqual(unreasoned, [], 'every exemption must carry a written reason');
  const unreasonedProse = Object.entries(UNREAD_BY_DESIGN)
    .filter(([, why]) => !/\d/.test(why) && !/[\w/]+\.(?:mjs|json|js)\b/.test(why))
    .map(([k]) => k);
  assert.deepEqual(unreasonedProse, [],
    'these reasons assert a state of the world without naming a count or a file to check it against');
  const stubs = Object.entries(UNREAD_BY_DESIGN)
    .filter(([, why]) => why.length < 150)
    .map(([k, why]) => `${k} (${why.length} chars)`);
  assert.deepEqual(stubs, [], 'these reasons are stubs — a claim too short to be checkable is not a reason');
});

test('the `feedStatus` exemption rests on one value, and the recorded evidence agrees', () => {
  // The reason above is a claim about config/scrapers.json and about
  // data/endpoints/endpoints.json, so both are read here rather than asserted.
  // Nothing else in this file could catch it going false: the exemption's only
  // other guard is "a page started reading the field", which is the opposite
  // direction, and the test in scrape-page.test.mjs that renders a synthetic
  // `host-down` job passes whether or not the real config still agrees — which
  // is not a guess. With superbet set to `host-down` against a registry that
  // says `verified`, the whole suite was green.
  //
  // Both halves, in order. A sweep that found no jobs would leave the set of
  // values empty — technically a constant, and the reading under which this
  // exemption would look justified forever. So the census has to be seen to have
  // read the document before its shape is allowed to mean anything.
  const jobs = SCRAPERS.jobs || SCRAPERS;
  // What is pinned is the shape of the rows that exist, not how many there are.
  // A total goes stale the moment a book is added and trains the reader to bump
  // it without reading the claim. An unreadable job list is not guarded from
  // here either, and deliberately so: rename the `jobs` key and this file stops
  // loading at all — `keysOfRows` is handed undefined and the censuses above it
  // throw before any exemption is evaluated. That failure is louder than any
  // assertion in a test, so adding one here would be a guard that cannot fire.
  const missing = jobs.filter((j) => !('feedStatus' in j)).map((j) => j.id);
  assert.deepEqual(missing, [],
    'these registered jobs carry no feedStatus at all, so "every job reads one value" is no longer what the chip was told');
  const values = [...new Set(jobs.map((j) => j.feedStatus))].sort();
  assert.deepEqual(values, ['verified'],
    `feedStatus is no longer one value across config/scrapers.json — it now reads ${values.join(', ')}. `
    + 'That is the moment it starts to mean something, so chipTitle in public/js/pages/scrape.js earns a line '
    + 'and WHY.constant above has to be rewritten in the same commit that moved the field');

  // The half that was vacuous before this lot. "None disagrees with its own
  // validationStatus" held for a trivial reason — a constant agrees with
  // everything, and it would have gone on agreeing if every job in the file were
  // reclassified. The registry is independent data, recorded from what each
  // book's feed was measured to do, so a comparison against it can actually fail.
  // test/helpers/endpoints.mjs reconciles the two; its only caller is
  // test/endpoints-registry.test.mjs, so this reads the document directly.
  const registry = readJson('data/endpoints/endpoints.json');
  assert.ok(registry.books && Object.keys(registry.books).length > 0,
    'data/endpoints/endpoints.json carries no books, so the agreement below proves nothing');
  // Every job has to be compared, or the list below is silent about the ones it
  // dropped: `registry.books[j.id]?.feedStatus` is undefined for a book the
  // registry has never heard of, the filter skips it, and a registry that had
  // quietly stopped describing a book would read as agreement. The comparison
  // says how many rows it stood on, or it says nothing.
  const uncompared = jobs.filter((j) => !registry.books[j.id]?.feedStatus).map((j) => j.id);
  assert.deepEqual(uncompared, [],
    'the registry has no recorded feed status for these registered jobs, so the agreement below is not measuring them');
  const drifted = jobs
    .filter((j) => registry.books[j.id]?.feedStatus)
    .filter((j) => registry.books[j.id].feedStatus !== j.feedStatus)
    .map((j) => `${j.id}: config ${j.feedStatus}, registry ${registry.books[j.id].feedStatus}`);
  assert.deepEqual(drifted, [],
    'the recorded evidence no longer agrees with config/scrapers.json — a job now claims a feed status the '
    + 'captures contradict, which is the disagreement src/shared/endpoints.mjs was written to catch');
});

test('every field the page reads off a scrapers job is one the route publishes', () => {
  const carried = new Set(SCRAPERS_JOB.map(leafOf));
  const readButAbsent = [...chipReadSet].filter((f) => !carried.has(f));
  assert.deepEqual(readButAbsent, [],
    `the page reads fields no job carries: ${readButAbsent.join(', ')}`);
});

test('the run row\'s `valid` exemption rests on the producers, and they are checked', () => {
  // The reason above claims `valid` is redundant with `status`. That is a claim
  // about src/, not about the payload, so it is measured against src/ here rather
  // than asserted: every site that writes `valid: false` is read, the status it
  // writes beside it is collected, and the page's own predicate is run over that
  // set. A producer that ever pairs `valid: false` with a status isFailedJob
  // would otherwise call a non-failure — `ok`, `completed` — fails this, which is
  // the day the exemption stops being true and the run table has to show it.
  // Reachable, not present. Sweeping src/ flat counts producers no request can
  // reach, and a producer nothing can run cannot have written the `valid` the
  // page is being asked not to show. This sweep used to find four such rows in an
  // Altenar adapter that nothing imports — which is where its floor came from.
  // Deleting that module made the floor fire, and the floor firing was the
  // correct answer about a measurement that had been counting a dead file.
  const reached = reachableModules({ roots: ['src/server.mjs'] });
  assert.ok(reached.size > 0, 'reachability returned no module, so the sweep below read nothing');
  const sites = [];
  for (const file of readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.mjs')) continue;
    const rel = relative(ROOT, join(file.parentPath, file.name)).split(/[\\/]/).join('/');
    if (!reached.has(rel)) continue;
    const lines = codeOnly(readFileSync(join(ROOT, rel), 'utf8'), true).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/valid:\s*false\b/.test(line)) return;
      // The status is not always on the next line — one site writes
      // `valid: false, status: 'cancelled'` on a single line — so the same line is
      // searched first. The value is cut at the first comma rather than the end of
      // the line, so the `reason:` that follows it on that line is not read as a
      // status.
      const withStatus = [line, ...lines.slice(i + 1, i + 5)].find((l) => /\bstatus:/.test(l));
      assert.ok(withStatus,
        `${rel}:${i + 1} writes \`valid: false\` with no status beside it — the reason above assumes one`);
      const value = withStatus.match(/status:\s*([^,\n]*)/)[1];
      // A ternary status hides an error code in its condition:
      // `status: lastErr.code === 'ETIMEOUT' ? 'timeout' : 'failed'` writes two
      // statuses and compares against a third string that is not one. Reading
      // every quoted word in the expression reported ETIMEOUT as a status, which
      // is not a verdict any row can carry. Only the result positions are statuses.
      const results = value.includes(' ? ') ? value.slice(value.indexOf(' ? ') + 3) : value;
      for (const word of results.match(/'([^']*)'/g) || []) sites.push(word.slice(1, -1));
    });
  }
  // No floor on how large this set is. The number moves every time a producer is
  // added or removed, and a floor set at today's value says nothing except that
  // someone measured it once — the floor this replaced was doing exactly that,
  // and it went on holding a count four of whose rows could never run. What has
  // to hold is below, and that is the claim the reason actually makes.
  assert.ok(sites.length > 0,
    'no reachable producer writes `valid: false`, so the sweep found nothing and the claim below is vacuous');
  const statuses = [...new Set(sites)].sort();

  // isFailedJob, transcribed from public/js/pages/scrape.js:51-54.
  const ignored = new Set(['pending', 'running', 'skipped', 'cancelled']);
  const failing = new Set(['failed', 'timeout', 'locked', 'unknown']);
  const isFailed = (status, valid) => !ignored.has(status) && (valid === false || failing.has(status));

  const loadBearing = statuses.filter((s) => isFailed(s, false) !== isFailed(s, true));
  assert.deepEqual(loadBearing, [],
    `a producer pairs \`valid: false\` with ${loadBearing.join(', ')}, where the run table's row would look right and be wrong`);
});

test('the census instruments are the ones they claim to be', () => {
  // A census whose instrument reads nothing passes everything. Each of these
  // fails if the thing it measures stops being measurable — the controls the
  // probe in scratch/ was missing and this file is not.
  assert.ok(SCRAPERS_JOB.includes('supportedSports') && SCRAPERS_JOB.includes('sourceIds'),
    'a string array still contributes its key');
  assert.ok(SCRAPERS_JOB.includes('minEvents') && SCRAPERS_JOB.includes('oddsFeed.url'),
    'the walk descends every element, not the first two');
  assert.ok(chipReadSet.has('id') && chipReadSet.has('liveCapability'),
    'the chip window really contains the chip code');
  assert.ok(chipReadSet.has('script') && chipReadSet.has('detailLimit'),
    'and it contains the adapter lines this lot added');
  assert.ok(chipReadSet.has('supportedSports') && chipReadSet.has('enabled'),
    'and the two gate windows, which are where those two are actually read');
  assert.ok(!chipReadSet.has('bookIds') && !chipReadSet.has('intervalMinutes'),
    'and it really excludes the other things this page binds `s` to');
  // The same cut, proved from the other side: a page-wide search for `job` would
  // have picked up `valid` and `status` from isFailedJob, which take a *state*
  // job row, and no scrapers job carries either. Their absence is what shows the
  // gates were cut out rather than the page searched.
  assert.ok(!chipReadSet.has('valid'),
    'a state-only field reached the scrapers read set — the gates were not cut');
  assert.ok(stateReadSet.has('summary') && !stateReads().has('options'),
    'the state receiver separates summary from options, which is the finding');
  // …and the reason that cut is still the right one: `options` is read through a
  // computed index, so the state receiver cannot see it, and the instrument below
  // has to see it on its own. These two controls together are what make the
  // options census honest — one proves the fields are not visible to `fieldsOn`,
  // the other proves they are visible to `optionsReads`, so the eight cannot be
  // unread on both counts at once. An instrument that reported zero would pass
  // the census by making the page look blind.
  assert.ok(!stateReads().has('bankroll') && optionsReads().has('bankroll'),
    'the options fields are unread to fieldsOn and read to optionsReads — both halves hold');
  assert.equal(optionsReads().size, SCAN_FIELDS.length,
    `optionsReads reported ${optionsReads().size} of ${SCAN_FIELDS.length} table fields — the gate moved`);
  // The canary that replaced the one this file used to carry. That one asked
  // `STATE_OPTIONS` — a list written here — whether it held `sport`, so it
  // compared the hand with itself and could not fail. This one asks the producer
  // and the page's own table, two pieces of code that have to name the same nine
  // fields for the panel above the last run's results to say anything true.
  assert.deepEqual(
    [...new Set(SCAN_FIELDS.map(([field]) => field))].sort(),
    producedOptionKeys(),
    'the scrape page\'s option table and the producer of state.options no longer name the same fields — one of the two moved',
  );
  assert.ok(optionsReads().has('sport') && STATE_OPTIONS.includes('options.sport'),
    'sport is published, pinned and read — the day the old canary was waiting for has arrived');
  assert.ok(!fieldsOn(scrapeCode, 'state').includes('options')
    && /\blastState\??\.options\b/.test(scrapeCode),
    'and the page reads the state document\'s options through its module binding, not a dotted `state.` read');
  assert.ok(profileReads().has('description'),
    'the profile receiver sees the description the hint now reads');
  // `label` is read, so it is not an exempt field and is not in the table above.
  // What is worth pinning is the measurement that once made it look exempt: the
  // fallback branch in profileLabel is reachable only for a profile with no mode,
  // and every shipped profile has one. A new profile without a mode starts using
  // that branch, and this is the assertion that says so.
  assert.ok(profileReads().has('label'), 'the profile label fallback still reads label');
  assert.ok(PROFILES.profiles.every((p) => p.mode),
    'and no shipped profile reaches it — every one carries a mode');
  assert.ok(PROFILES.profiles.every((p) => typeof p.description === 'string' && p.description),
    'every shipped profile still carries the sentence the hint shows');
});

/* ── the error object's own fields, and the measurements behind the exemptions ── */

/** Every `.mjs` under src/, comments blanked — a `throw` in a comment is not a site. */
function srcSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.mjs')) out.push(rel);
    }
  };
  walk('src');
  return out.map((rel) => [rel, codeOnly(readText(rel), true)]);
}

/** The text between the parens of a call that starts at `open`, up to its match. */
function argList(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Every `throw new X(` in src/, with the class, the message and the option object.
 *
 * `message` is the first quoted literal in the argument list, and it is null when
 * there is none — a site whose message is built before the throw is reported as
 * unparsed rather than silently counted as agreeing with its own field, which is
 * what a guess would have done. `opts` is the LAST brace group, because the
 * convention at every one of these sites is `(message, { ...options })`.
 */
function throwSites() {
  return constructionSites(/throw\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g);
}

/**
 * Every capitalised construction in src/, thrown or not.
 *
 * A throw-only scan is the wrong instrument for `status`, and the test below
 * measures why instead of asserting it here: it finds sites that set a status
 * without throwing, so a scanner that looked only at `throw` would report the
 * exception the exemption is written around as invisible, and an excuse whose
 * exception the instrument cannot see is not a checked excuse. So the pattern is
 * the wider one, and the class list is filtered back to what is actually thrown
 * where a class matters.
 */
function constructionSites(pattern) {
  const out = [];
  for (const [rel, src] of srcSources()) {
    for (const m of src.matchAll(pattern)) {
      const args = argList(src, m.index + m[0].length - 1);
      if (!args) continue;
      const msg = args.match(/(['"`])([\s\S]*?)\1/);
      const groups = args.match(/\{[^}]*\}/g);
      out.push({ rel, cls: m[1], msg: msg ? msg[2] : null, opts: groups ? groups[groups.length - 1] : '' });
    }
  }
  return out;
}

const allErrorSites = () => constructionSites(/\bnew\s+([A-Z][\w$]*)\s*\(/g);

/**
 * The reachable `field` sites whose message does not carry the literal.
 *
 * Each is the same fact in other words — `response.size` on "response exceeds
 * … MB", `markets.selections.odds` on "selection has invalid odds" — and whether
 * it is the same fact is a judgement, not something a regex can settle. A
 * judgement kept only in the paragraph is a judgement the next reader cannot
 * check and cannot update, so it is written here instead: keyed `module|field`,
 * and checked in the control below against the sites that actually exist, so an
 * entry that outlives its site is reported rather than believed.
 */
const FIELD_RESTATED_ELSEWHERE = new Set([
  'src/scrapers/base.mjs|markets.selections.odds',
  'src/scrapers/favbet.mjs|markets',
  'src/shared/bounded-json.mjs|response.size',
  'src/shared/bounded-json.mjs|response.body',
]);

/**
 * The exemptions on the error object rest on three numbers, and this re-derives
 * all three from the source rather than trusting the paragraphs.
 *
 * The paragraphs are allowed to state a measurement — that is the rule this file
 * holds every reason to — but a stated measurement is prose until something
 * recomputes it, and a reason that goes stale is worse than no reason: it keeps
 * its exemption while the world it described has moved. So each claim below is
 * checked against the tree, and each failure names the paragraph it invalidates.
 *
 * The three are deliberately different kinds of claim. `field` and `status` are
 * claims about redundancy, and redundancy is a floor — a new site that restates
 * its message does not weaken the reason, so those two are floors and not
 * equalities. `name` is a claim of absence, and absence has no floor: one site
 * whose message names its own class would make the field decorative, which is
 * the one thing it is exempt-free for.
 */
test('the error-field measurements the exemptions rest on are still this tree\'s', () => {
  const thrown = throwSites();
  const constructed = allErrorSites();
  // A receipt, not a threshold. No number is written down here, because a number
  // here is a reading of this tree taken at one moment. All it has to say is that
  // the scan read something: an empty walk leaves every list below empty and every
  // measurement passes silently on empty sets. The property that says the two
  // lists differ is checked further down, beside the measurement that depends on
  // it, so that it can fail on its own instead of being pre-empted by a check that
  // happens to notice the same change first.
  assert.ok(thrown.length > 0 && constructed.length > 0,
    `the scan found ${thrown.length} throw sites and ${constructed.length} constructions — `
    + 'an empty walk makes every measurement below pass on empty sets');

  // Reachable, not present. The paragraphs below used to count the places under
  // src/, and one of the modules holding those places — the Altenar adapter that
  // nothing imports — is gone. That does not change what these fields are for; it
  // changes what the sentences are allowed to be evidence about. A count taken
  // over the directory reads as a property of the program and is not one: the
  // program cannot reach every line under src/, and the sites it cannot reach are
  // exactly the ones that never put this field on a response anybody reads.
  const reached = reachableModules({ roots: ['src/server.mjs'] });
  assert.ok(reached.size > 0,
    'reachability returned no module at all, so the population below is being read off an empty set');

  // WHY.errorStatus: the status is in the message at all but one site.
  //
  // Reachable for the same reason the sweep is, and the ceiling this block used
  // to carry is gone with the same reasoning: it was a number written down while a
  // module nothing imported still held sites of its own, so it measured the tree
  // at one moment instead of the program. What replaces it says the population
  // has to exist, and — the part that makes it say anything — that it splits. A
  // set where every site carries its status leaves the exemption with nothing to
  // exempt and the paragraph with nothing to be an exception to; a set where none
  // does leaves no redundancy to rest on.
  const statusSites = allErrorSites().filter((s) => reached.has(s.rel) && /\bstatus:\s*[^,}]/.test(s.opts));
  assert.ok(statusSites.length > 0,
    'no module the server can reach sets a `status`, so WHY.errorStatus describes nothing');
  const statusValue = (s) => s.opts.match(/\bstatus:\s*([^,}]+)/)[1].trim();

  // The measurement the wider scan exists for, and it is ahead of the two below
  // it on purpose. Narrowing the scan to `throw` makes all three fail at once,
  // and a control that can never be the first to notice is a control nobody is
  // told failed — so the check that exists because of the scan's width is the one
  // that reports the scan losing its width.
  const thrownKeys = new Set(thrown.map((s) => `${s.rel}|${s.cls}|${s.opts}`));
  const notThrown = statusSites.filter((s) => !thrownKeys.has(`${s.rel}|${s.cls}|${s.opts}`));
  assert.ok(notThrown.length > 0,
    'every reachable `status` site is a throw now, so `allErrorSites` is wider than it needs to be for this reason');

  const inMessage = statusSites.filter((s) => {
    // A literal status reaches the message as its digits; a computed one only if
    // the message interpolates the same expression.
    return s.msg !== null && s.msg.includes(statusValue(s));
  });
  assert.ok(inMessage.length > 0 && inMessage.length < statusSites.length,
    `of ${statusSites.length} reachable \`status\` sites, ${inMessage.length} carry it in their message — `
    + 'a set that is all one way describes no redundancy, and one with nothing silent has no exception to name');
  const silent = statusSites.filter((s) => !inMessage.includes(s));
  // Identified by the value, not by a line number: the exception is a property of
  // what the site does, and a position recorded next to it reads like a location
  // that can be verified and cannot be.
  assert.deepEqual(silent.map((s) => `${s.rel}: ${statusValue(s)}`),
    ['src/scrapers/everymatrix-wamp.mjs: 502'],
    'the set of `status` sites whose message does not carry the status changed — WHY.errorStatus allows exactly one and names it');

  // …and that one cannot reach a row, which is the measurement that closes it.
  const ids = SCRAPERS.jobs.map((j) => j.id);
  assert.ok(!ids.some((id) => /wamp/i.test(id)),
    'a WAMP job is configured now, so the everymatrix site is reachable and WHY.errorStatus must be re-measured');

  // WHY.errorField: the field restates its own message.
  const fieldSites = allErrorSites().filter((s) => reached.has(s.rel) && /\bfield:/.test(s.opts));
  assert.ok(fieldSites.length > 0,
    'no module the server can reach builds an error with a `field`, so WHY.errorField describes nothing');

  // Every one of them is accounted for, and the three ways are different kinds
  // of claim. A literal inside its own message is checked mechanically. A site
  // that propagates an inner error's field restates nothing of its own — the
  // message it carries is the inner error's — and is covered by that shape. A
  // site whose field says the same thing in other words is a judgement, and a
  // judgement held only in prose is one the next reader cannot check, so those
  // are named below rather than counted.
  const unaccounted = [];
  for (const s of fieldSites) {
    const lit = s.opts.match(/\bfield:\s*(?:'([^']*)'|"([^"]*)")/);
    if (!lit) {
      if (!/\.field\b/.test(s.opts)) unaccounted.push(`${s.rel} ${s.cls}: field is neither a literal nor an inner one`);
      continue;
    }
    const value = lit[1] ?? lit[2];
    if (s.msg !== null && s.msg.includes(value)) continue;
    if (!FIELD_RESTATED_ELSEWHERE.has(`${s.rel}|${value}`)) {
      unaccounted.push(`${s.rel} ${s.cls}: field ${JSON.stringify(value)} is not in its message, `
        + `and nobody has recorded that it restates it in other words`);
    }
  }
  assert.deepEqual(unaccounted, [],
    'these reachable `field` sites say something their message does not, which is the one thing this exemption is for');
  // The named list is evidence, so it has to still be about something. A site
  // that left the tree would otherwise keep its entry and keep the paragraph
  // looking corroborated.
  const stale = [...FIELD_RESTATED_ELSEWHERE].filter((key) => !fieldSites.some((s) => key.startsWith(`${s.rel}|`)));
  assert.deepEqual(stale, [],
    'these entries name a site that no longer exists, so the paragraph is being corroborated by a list of ghosts');

  // Why `name` is connected rather than excused: no message names its own class.
  const classes = new Set(thrown.map((s) => s.cls));
  assert.ok(classes.size >= 2,
    `only ${classes.size} error class is thrown under src/ — with one class \`name\` says nothing, and refreshJobRows prints it for nothing`);
  const selfNaming = thrown.filter((s) => s.msg !== null && new RegExp(`\\b${s.cls}\\b`).test(s.msg));
  assert.deepEqual(selfNaming.map((s) => `${s.rel}: ${s.cls}`), [],
    'a throw site now names its own error class in the message — `name` has become decoration, and the two job tables print it for nothing');
});
