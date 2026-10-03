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
import { resolveScanRequest } from '../src/scrape-orchestrator.mjs';
import { toProgressJob } from '../src/scraper-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

const scrapeCode = codeOnly(readText('public/js/pages/scrape.js'), true);
const scannerCode = codeOnly(readText('public/js/pages/scanner.js'), true);
const routerSource = codeOnly(readText('src/router.mjs'), true);
const orchestratorSource = codeOnly(readText('src/scrape-orchestrator.mjs'), true);
const sanitizeSource = codeOnly(readText('src/shared/sanitize.mjs'), true);
const serviceSource = codeOnly(readText('src/scraper-service.mjs'), true);

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
  const start = lines.findIndex((line) => new RegExp(`^function ${name}\\(`).test(line));
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
 * run has been launched, and `resolveScanRequest` publishes the nine keys a run
 * resolved.
 *
 * Neither producer is read out of `data/scrape-state.json`, which is where this
 * census read the list from and why the list was wrong. Two of the nine are
 * optional inputs normalised to `undefined` when the caller omits them
 * (src/scrape-orchestrator.mjs:509-510), and `JSON.stringify` drops a key whose
 * value is undefined — so the stored document carries 7, 8 or 9 of them
 * depending on what the last run happened to ask for. Measured on this tree:
 * the committed copy holds 8, with `sport` and no `maxEvents`; the working copy
 * holds 8, with `maxEvents` and no `sport`. A census that reads that file is
 * censusing one machine's last run, and the committed copy failed the pinned
 * comparison on the branch for as long as the drift was there.
 *
 * The producer is called over inputs that exercise both optional keys rather
 * than trusted to have nine, because the union is the measurement.
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
  'defaults.minMiddleRoiPercent', 'defaults.minRoiPercent', 'description', 'id', 'label', 'mode',
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
 * `sport` is the ninth entry now, and the comparison that fires is between the
 * nine below and the nine `producedOptionKeys` calls out of the producer.
 *
 * The cross-check that keeps the two honest: the scrape page carries the same
 * nine names in its own `SCHEDULER_SCAN_FIELDS` table, `runOptionsText` walks
 * that table, and the control below asserts the table and the producer agree on
 * the count. Two independent lists of nine, written by different code, is a
 * stronger claim than either list alone.
 */
const STATE_OPTIONS = [
  'options.bankroll', 'options.includeLive', 'options.includePast', 'options.maxEvents',
  'options.maxMiddleRiskPercent', 'options.minEvPercent', 'options.minMiddleRoiPercent',
  'options.minRoiPercent', 'options.sport',
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
 * were unread to this census on a page that draws all nine. The instrument that
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
 * well, at :339, and this census read one page, so a field that only scanner.js
 * reads would have been reported unread by a page that does read it. Measured,
 * scanner.js reads a strict subset of what scrape.js reads — `id`, `label` and
 * four of the six defaults, and neither `mode` nor `description` nor the two
 * scope switches — so widening the set moves no verdict today. It is here
 * because the subset is a fact about today.
 *
 * The alias is the part that has to stay a cut. `d` is bound to a profile's
 * defaults on both pages and to something else entirely in both: on scrape.js a
 * search for `d.` page-wide returns `ours`, `theirs`, `getTime`, `labelKey` and
 * `toLocaleTimeString`, which are arbitrage and event-detail fields, and on
 * scanner.js it returns `profiles` and `sports`, which are two response
 * envelopes. Six names the page never reads as a profile would have been
 * credited as profile reads. So the defaults are read only inside the window
 * where the alias is bound to `<row>.defaults`, and the window throws if it
 * runs away.
 */

/** Where each consumer binds the row, and where it binds the defaults alias. */
const PROFILE_RECEIVERS = {
  'scrape.js': {
    scope: () => [PROFILE_LABEL, APPLY_PROFILE, APPLY_PROFILE_HINT],
    rows: ['profile', 'p', 'x', 'found'],
    alias: 'd',
  },
  'scanner.js': { scope: () => [scannerProfileBlock()], rows: ['p'], alias: 'd' },
};

/**
 * The block of scanner.js that consumes a profile row.
 *
 * scanner.js keeps no top-level function for this the way scrape.js does — the
 * rows are used inside the page's nested `init()`, in the `<option>` list it
 * builds and in the change listener that applies a profile's defaults. The cut
 * runs from the fetch to the first line that closes that listener, measured at
 * :339-358, and both ends are loud: a page that stops fetching the route, or
 * stops closing the listener on its own line, fails here rather than reporting
 * every profile field unread.
 */
function scannerProfileBlock() {
  const lines = scannerCode.split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes("arbiterApi.get('/api/profiles')"));
  if (from === -1) throw new Error('scanner.js no longer fetches /api/profiles');
  const to = lines.findIndex((l, i) => i > from && l.trim() === '});');
  if (to === -1) throw new Error('scanner.js no longer closes the profile change listener on its own line — the cut would run away');
  const block = lines.slice(from, to + 1).join('\n');
  if (!/\.defaults\b/.test(block)) throw new Error('the cut no longer contains a defaults read — it is measuring the wrong region');
  return block;
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
 * The reads on one alias, inside the window where it is a profile's defaults.
 *
 * The binding is what starts it and the first line that closes the statement
 * chain is what ends it. Both halves are loud: a page that renames the alias, or
 * hoists the reads out of the block, fails here instead of reporting the defaults
 * unread on a page that does read them.
 */
function aliasDefaultsReads(code, alias) {
  const lines = code.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`\\b(?:const|let|var)\\s+${alias}\\s*=\\s*\\w+\\.defaults\\b`).test(l));
  if (start === -1) throw new Error(`${alias} is no longer bound to a row's .defaults on this page`);
  const end = lines.findIndex((l, i) => i > start && ['};', '}', '});'].includes(l.trim()));
  if (end === -1) throw new Error(`${alias} still binds a row's .defaults but the window has no closing line — the cut would run away`);
  return fieldsOn(lines.slice(start, end + 1).join('\n'), alias);
}

const profileReadsOn = (file, spec) => {
  const code = codeOnly(readText(`public/js/pages/${file}`), true);
  const out = new Set();
  const cuts = spec.scope();
  // Each receiver has to be bound on its page, or `fieldsOn` finds nothing and
  // the census reports a field unread for a page that does read it.
  for (const r of spec.rows) {
    if (!new RegExp(`\\b${r}\\b`).test(code)) throw new Error(`${file} no longer binds a profile row as \`${r}\` — the receiver table is stale`);
    for (const cut of cuts) for (const f of fieldsOn(cut, r)) if (f !== 'defaults') out.add(f);
  }
  // Dotted (`p.defaults.bankroll`) and aliased (`d.includeLive`) are the two
  // shapes the tree uses; both are collected, and only over the leaves the
  // config actually publishes — `applyProfile` also reads `p.defaults.maxEvents`,
  // which no shipped profile carries, so that read is a guard and not a field.
  const dotted = cuts.flatMap((cut) => [...cut.matchAll(/\b\w+\.defaults\.(\w+)\b/g)].map((m) => m[1]));
  const aliased = [...aliasDefaultsReads(code, spec.alias)];
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

/* ── the exempt list, every reason measured ────────────────────────────────── */

/** Route labels, spelled once so a key and its census cannot drift apart. */
const R_SCRAPERS_JOB = 'GET /api/scrapers · job';
const R_SCRAPERS_ARRAYS = 'GET /api/scrapers · arrays';
const R_PROFILES = 'GET /api/profiles · row';
const R_STATE_JOB = 'GET /api/scrape/state · job';
const R_STATE_OPTIONS = 'GET /api/scrape/state · options';
const R_STATE_SUMMARY = 'GET /api/scrape/state · summary';
const R_RUN_JOB = 'GET /api/scrape-run · job';

/**
 * The reasons, written once each. An entry's rule is that it names a
 * measurement. "Nobody needs this" is not a reason; "26 of 26 jobs read
 * `verified`, so it is a constant today" is, and it is falsifiable — the day the
 * value moves, the measurement behind this reason stops being true and the
 * reason has to be rewritten in the same commit as the field that moved.
 */
const WHY = {
  constant: [
    'A constant, measured: all 26 jobs in config/scrapers.json read `verified` and',
    'none disagrees with its own `validationStatus`. A chip would gain a word and',
    'say nothing. The page already writes down where this belongs — the note above',
    '`chipTitle` in public/js/pages/scrape.js says it earns a line when it starts to',
    'vary.',
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
    'than assumed: all 13 sites in src/ that write `valid: false` set an explicit',
    'status beside it, and those sites use six words between them — cancelled,',
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
 * stored copy carries 7, 8 or 9 of the nine depending on the last run's optional
 * inputs, so demanding all nine would demand that someone had run a scrape with
 * every switch on. What is demanded is the direction that can catch a defect.
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
 * Both consumers are really being read, each over its own window.
 *
 * Widening the reader set from one page to two moves no verdict today, because
 * scanner.js reads a strict subset of what scrape.js reads — six of the ten
 * leaves, and neither `mode`, nor `description`, nor the two scope switches. A
 * change that moves no verdict cannot be shown by breaking a page, so the thing
 * that has to be pinned instead is that each consumer still contributes at all.
 *
 * The floors are measured per page, not shared, because a shared floor is a
 * floor on the union and the union is what never moved. Both numbers come from
 * the same run of `profileReadsOn` this census calls: scrape.js touches ten
 * leaves, scanner.js six, and the four defaults scanner.js reads are the ones its
 * alias window can see and no more — a search for `d.` page-wide would have added
 * `profiles` and `sports`, which are two response envelopes and not profile rows.
 */
const PROFILE_READ_FLOOR = { 'scrape.js': 10, 'scanner.js': 6 };

test('both consumers of /api/profiles are read, each over its own window', () => {
  for (const [file, spec] of profileConsumers()) {
    const found = profileReadsOn(file, spec);
    const floor = PROFILE_READ_FLOOR[file];
    assert.ok(found.size >= floor,
      `${file} contributes ${found.size} profile leaves, under its floor of ${floor} — its window stopped seeing the reads`);
  }
  // The two consumers overlap, and the overlap is a measurement rather than an
  // assumption: it is why the union is ten and not sixteen. Stated as "read by
  // exactly one of them" so the assertion does not depend on which of the two
  // the derived list happens to return first.
  const sets = profileConsumers().map(([file, spec]) => profileReadsOn(file, spec));
  const byExactlyOne = [...new Set(sets.flatMap((s) => [...s]))]
    .filter((f) => sets.filter((s) => s.has(f)).length === 1).sort();
  assert.deepEqual(byExactlyOne, ['description', 'includeLive', 'includePast', 'mode'],
    'the two consumers no longer read the same set — a field moved between pages');
  assert.equal(PROFILES_ROW.length, new Set(sets.flatMap((s) => [...s])).size,
    'the two consumers no longer cover every leaf the config publishes between them');
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
  const sites = [];
  for (const file of readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.mjs')) continue;
    const rel = relative(ROOT, join(file.parentPath, file.name));
    const lines = codeOnly(readFileSync(join(ROOT, rel), 'utf8'), true).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/valid:\s*false\b/.test(line)) return;
      // The status is not always on the next line — altenar-provider.mjs:243
      // writes `valid: false, status: 'cancelled'` on one — so the same line is
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
  assert.ok(sites.length >= 13, `found only ${sites.length} \`valid: false\` sites in src/ — the sweep missed some`);
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