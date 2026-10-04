/**
 * endpoints.mjs — readers over the endpoint registry, for the test beside them.
 *
 * data/endpoints/endpoints.json records, for every bookmaker the project has
 * looked at: which upstream platform serves it, whether that feed was verified
 * to carry public odds, the saved capture that proves it, and the sports that
 * were probed and found dead.
 *
 * This file was in src/shared/ until it moved here, and the move is the
 * correction rather than a tidiness. Nothing in src/ imported it: the checks it
 * holds are diagnostics, and no runtime path called them. A reader with no
 * caller, sitting in the shipped tree, reads as load-bearing code — while the
 * registry itself, the most load-bearing fact about a feed, stayed unreadable
 * by the running program. It is here now because its only consumer is
 * test/endpoints-registry.test.mjs, which is what the move made true.
 *
 * Two claims this file used to make were false, and are recorded rather than
 * quietly dropped:
 *
 *   - "the platform a book runs on was duplicated by hand in
 *     src/scanner/feed-groups.mjs". It was not. feed-groups.mjs declares a group
 *     by provider and membership and holds no per-book platform map. The
 *     hand-written copy is the `platform` field on each job in
 *     config/scrapers.json — and that one is checked against the registry, in
 *     the test named above.
 *   - "It is read here so feed-group declarations can be validated against
 *     recorded evidence rather than trusted." Nothing is read here for that.
 *     The reconciliation lives in the test, and it was missing the direction in
 *     which a group stops being true, which the test now covers.
 *
 * The registry is data, not behaviour, and the running program does not read it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, '..', '..', 'data', 'endpoints', 'endpoints.json');

let cached = null;

/**
 * Read the registry, or null when it is absent. A missing registry is not an
 * error: every check that consumes it is a diagnostic, and a diagnostic that
 * cannot run has nothing to report.
 *
 * @param {string} [path]
 * @returns {object|null}
 */
export function loadEndpointRegistry(path = DEFAULT_PATH) {
  if (path === DEFAULT_PATH && cached) return cached;
  if (!existsSync(path)) return null;
  const reg = JSON.parse(readFileSync(path, 'utf8'));
  if (path === DEFAULT_PATH) cached = reg;
  return reg;
}

/** The registry's record for one book, or null. */
export function endpointRecord(book, registry = loadEndpointRegistry()) {
  return registry?.books?.[book] || null;
}

/** The upstream platform serving a book, or null when unknown. */
export function platformOf(book, registry = loadEndpointRegistry()) {
  return endpointRecord(book, registry)?.platform || null;
}

/** Every book the registry says runs on one platform. */
export function booksOnPlatform(platform, registry = loadEndpointRegistry()) {
  if (!registry?.books || !platform) return [];
  return Object.values(registry.books)
    .filter((b) => b.platform === platform)
    .map((b) => b.book)
    .sort();
}

/**
 * Books that share a platform but are not in the same declared feed group.
 *
 * A shared platform is a prompt to check, not proof of a shared feed: tenants
 * on one platform price independently, and maxbet is the measured case — same
 * NSoft company platform as admiral and stanleybet, different company UUID, and
 * prices that genuinely differ. So this returns candidates for review; the
 * grouping itself stays declared in feed-groups.mjs where the evidence lives.
 *
 * @param {string[]} groupedBooks  members already declared in one feed group
 * @returns {Array<{ platform: string, ungrouped: string[] }>}
 */
export function ungroupedPlatformPeers(groupedBooks, registry = loadEndpointRegistry()) {
  if (!registry?.books) return [];
  const grouped = new Set(groupedBooks);
  const byPlatform = new Map();
  for (const rec of Object.values(registry.books)) {
    if (!rec.platform || !rec.scraped) continue;
    const list = byPlatform.get(rec.platform) || [];
    list.push(rec.book);
    byPlatform.set(rec.platform, list);
  }
  const out = [];
  for (const [platform, members] of byPlatform) {
    if (members.length < 2) continue;
    // Only interesting when the platform has a partially-declared group: some
    // members grouped, some not. That is the case worth a human look.
    const inGroup = members.filter((m) => grouped.has(m));
    const outOfGroup = members.filter((m) => !grouped.has(m));
    if (inGroup.length > 0 && outOfGroup.length > 0) {
      out.push({ platform, inGroup: inGroup.sort(), ungrouped: outOfGroup.sort() });
    }
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform));
}

/**
 * Books the registry knows about that carry no scraper job.
 *
 * This is a list of names, not a worklist, and the note that used to sit above
 * it overclaimed twice. It called these "the additive candidates: the evidence
 * already exists, only an adapter is missing", but the capture files do not say
 * that — most of the rows carry a platform string and no capture at all, and
 * sport-suffixed rows for books already configured under their base name are in
 * the same list. `realCapture` on each row is what separates the two, and it is
 * the flag to read. The split is measured where it is meaningful, in
 * test/endpoints-registry.test.mjs.
 */
export function unscrapedBooks(registry = loadEndpointRegistry()) {
  if (!registry?.books) return [];
  return Object.values(registry.books)
    .filter((b) => !b.scraped && (b.platform || b.captureFiles?.some((f) => f.real)))
    .map((b) => ({ book: b.book, platform: b.platform, feedStatus: b.feedStatus, realCapture: Boolean(b.captureFiles?.some((f) => f.real)) }))
    .sort((a, b) => a.book.localeCompare(b.book));
}

/**
 * Config jobs whose recorded feed status contradicts the registry.
 *
 * Only one shape of disagreement is a defect: the registry says the feed cannot
 * carry public odds, and the config still claims the job is validated. unibet
 * was the live case for months — the endpoint crawl recorded `browser-only`
 * with zero captured endpoints while config/scrapers.json said `validated` —
 * and it is the reason this check exists. Its feed was recovered on 2026-09-28
 * (the Kindred sports BFF), so the pair is now clean; see
 * test/endpoints-registry.test.mjs, which feeds the old state back in so the
 * check cannot quietly stop firing.
 *
 * The opposite direction is NOT a conflict. `prowin` and `ultrabet` are
 * `verified` in the registry (the EGT Digital endpoint answers and returns
 * priced 1X2) and `experimental` in config (the adapter is not trusted enough
 * to enable). Endpoint reachability and scraper trust are separate axes, and
 * collapsing them would flag every disabled-but-working job as a problem.
 */
const UNUSABLE_FEED_STATUS = new Set([
  'browser-only', 'host-down', 'no-sports-feed', 'no-public-odds-feed',
]);

export function feedStatusConflicts(jobs, registry = loadEndpointRegistry()) {
  if (!registry?.books) return [];
  const out = [];
  for (const job of jobs || []) {
    const rec = registry.books[job.id];
    if (!rec?.feedStatus) continue;
    if (job.validationStatus !== 'validated') continue;
    if (!UNUSABLE_FEED_STATUS.has(rec.feedStatus)) continue;
    out.push({
      book: job.id,
      registry: rec.feedStatus,
      config: job.validationStatus,
      enabled: job.enabled,
    });
  }
  return out;
}
