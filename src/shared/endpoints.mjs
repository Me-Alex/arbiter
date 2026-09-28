/**
 * endpoints.mjs — the single endpoint registry.
 *
 * data/endpoints/endpoints.json records, for every bookmaker the project has
 * looked at: which upstream platform serves it, whether that feed was verified
 * to carry public odds, the saved capture that proves it, and the sports that
 * were probed and found dead.
 *
 * This replaces two older, divergent artefacts:
 *   - data/endpoints/       — per-book captures, but its index knew only
 *                             platform/feedStatus and duplicated the crawl
 *   - data/endpoints-all/   — the original browser crawl, with a different
 *                             schema and its own index
 * Both were reference-only: nothing in src/ read them, so the platform a book
 * runs on — the single most load-bearing fact about a feed — was duplicated by
 * hand in src/scanner/feed-groups.mjs and had no check against reality.
 *
 * The registry is data, not behaviour. It is read here so feed-group
 * declarations can be validated against recorded evidence rather than trusted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, '..', '..', 'data', 'endpoints', 'endpoints.json');

let cached = null;

/**
 * Read the registry, or null when it is absent. A missing registry is not an
 * error: the scanner runs fine without it, and the checks that consume it are
 * diagnostics rather than gates.
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
 * Books the registry has a capture for but the scraper config has no job for.
 * These are the additive candidates: the evidence already exists, only an
 * adapter is missing.
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
