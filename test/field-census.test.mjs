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

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

const scrapeCode = codeOnly(readText('public/js/pages/scrape.js'), true);
const routerSource = codeOnly(readText('src/router.mjs'), true);

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
 */
const STATE_OPTIONS = [
  'options.bankroll', 'options.includeLive', 'options.includePast', 'options.maxEvents',
  'options.maxMiddleRiskPercent', 'options.minEvPercent', 'options.minMiddleRoiPercent',
  'options.minRoiPercent',
];
const STATE_SUMMARY = ['completed', 'events', 'failed', 'markets'];
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
 * `sport` is in the page's table and not in the pinned list below, because no
 * stored state carries it yet. The day one does, the comparison in `censusFor`
 * fires on `options.sport` and the answer is already written down here: the page
 * reads it.
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
 * `/api/profiles`, read through three bindings rather than one.
 *
 * `profileLabel` takes the row as `profile` and reads `d.includeLive` out of its
 * defaults; `applyProfile` takes it as `p` and reads `p.defaults.bankroll` in
 * full; the hint added for `description` takes it as `found`. Searching one
 * receiver name reported all six defaults and the description as unread, which
 * was the instrument being wrong rather than the page.
 */
const profileReads = () => {
  const out = new Set([
    ...fieldsOn(scrapeCode, 'profile'),
    ...fieldsOn(scrapeCode, 'p'),
    ...fieldsOn(scrapeCode, 'found'),
  ]);
  // `defaults` is read as an object through two different names at two depths, so
  // its leaves are searched as the dotted expressions the two functions write —
  // not through `fieldsOn`, which only ever returns the first segment.
  const defaultsCode = `${PROFILE_LABEL}\n${APPLY_PROFILE}`;
  for (const key of PROFILES_ROW) {
    if (!key.startsWith('defaults.')) continue;
    const leaf = key.slice('defaults.'.length);
    if (new RegExp(`\\.defaults\\.${leaf}\\b|\\bd\\.${leaf}\\b`).test(defaultsCode)) out.add(leaf);
  }
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
    'The capture ids a run row wrote, and no page on either route shows them.',
    'Measured: every adapter declares them (src/scrapers/*.mjs),',
    'src/scrape-orchestrator.mjs:141 expands the enabled set with them, and each',
    'extracted event is stamped with one — so the field is the join between a job',
    'and the capture files under the data directory. The page reads those files',
    'through GET /api/odds/:book instead, which is keyed by book rather than by',
    'the capture ids this field carries.',
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
    'A constant, measured over the 22 captures in data-market-run/workspace:',
    '`mergeMarketDiagnostics` folds 12 market keys and every one of them reads',
    'completeCount == eventCount, with incompleteCount 0 throughout, and',
    '`rejectionReasons` is empty on all 22 captures. The completeness diagnostic',
    'exists to say which markets came out short, and it has never once said so.',
  ].join(' '),

  markets: [
    'The same measurement as `marketDiagnostics`, one level up: this is the field',
    'that summary.markets holds. The stored data/scrape-state.json has it empty,',
    'and the fold that fills it has never produced an incomplete row to show.',
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
  [`${R_STATE_JOB} › sourceIds`]: WHY.sourceIds,
  [`${R_STATE_SUMMARY} › markets`]: WHY.markets,
  [`${R_RUN_JOB} › sourceIds`]: WHY.sourceIds,
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
  { label: R_STATE_JOB, published: keysOfRows(STATE.jobs), pinned: STATE_JOB, reads: () => stateReadSet },
  { label: R_STATE_OPTIONS, published: Object.keys(STATE.options).map((k) => `options.${k}`).sort(), pinned: STATE_OPTIONS, reads: optionsReads },
  { label: R_STATE_SUMMARY, published: Object.keys(STATE.summary).sort(), pinned: STATE_SUMMARY, reads: summaryReads },
  { label: R_RUN_JOB, published: keysOfRows(RUN.jobs), pinned: RUN_JOB, reads: runReads },
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
 * `WHY.sourceIds` covers three routes and `WHY.filterArray` two, because the
 * claim is one claim about one field. What makes that safe is the route being
 * part of the key — a shared paragraph cannot exempt a field nobody measured,
 * because the census still asks whether the page reads it.
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
  assert.ok(optionsReads().has('sport') && STATE_OPTIONS.every((k) => !k.endsWith('.sport')),
    'the table carries sport and no stored state does yet — the canary above is what catches that day');
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