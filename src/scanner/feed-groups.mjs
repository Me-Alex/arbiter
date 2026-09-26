/**
 * feed-groups.mjs — which bookmakers share one upstream odds feed.
 *
 * An arbitrage is only real if the two legs come from sources that can
 * disagree. When several brands are resold from a single provider, their
 * prices are the same feed counted twice: pairing them is not arbitrage, it is
 * one bookmaker quoted under two names. Worse, the two "prices" can drift
 * mid-scrape purely because one response was captured earlier, which produces
 * a plausible-looking but fictitious opportunity.
 *
 * The groups below are declared, not inferred at runtime. Inference is already
 * done for byte-identical Altenar payloads in scanner.mjs; that cannot see
 * brands whose prices have drifted apart, and it cannot see a pair that
 * simply never overlapped in a given capture. A declared group is stable,
 * reviewable, and cheap.
 *
 * Evidence for each group (measured on data-market-run, 22 snapshots):
 * markets shared by two or more brands in the group, split by whether the
 * prices were byte-identical:
 *
 *   exalogic (excelbet, winboss, las-vegas, magnumbet)  1638 identical, 0 differing
 *   altenar  (don, topbet, million, baumbet, powerbet, winbet)  1960 identical, 0 differing
 *   nsoft    (admiral, stanleybet)                         314 identical, 0 differing
 *   fortuna  (fortuna, casa-pariurilor)                    1958 identical, 0 differing
 *   wamp     (getsbet, contibet)                              0 identical, 188 differing
 *
 * The WAMP pair is grouped too, but on different evidence: both sit behind the
 * same EveryMatrix transport and are the same company. Their prices currently
 * differ, which is exactly the case the identical-payload check misses — the
 * grouping is what stops that drift from being reported as arbitrage.
 *
 * maxbet is deliberately NOT in the nsoft group: it shares the NSoft platform
 * but runs on a different company UUID, and its catalogue is separate (the
 * historical captures show a different football sportId/marketId). Same
 * platform, different tenant, different prices.
 */

/** @type {ReadonlyArray<{ id: string, brand: string, provider: string, members: readonly string[] }>} */
export const FEED_GROUPS = Object.freeze([
  { id: 'exalogic-xsport', brand: 'Exalogic XSport', provider: 'Exalogic', members: Object.freeze(['excelbet', 'winboss', 'las-vegas', 'magnumbet']) },
  { id: 'altenar-tenancy', brand: 'Altenar tenancy', provider: 'Altenar', members: Object.freeze(['don', 'topbet', 'million', 'baumbet', 'powerbet', 'winbet']) },
  { id: 'nsoft-company', brand: 'NSoft company', provider: 'NSoft', members: Object.freeze(['admiral', 'stanleybet']) },
  { id: 'fortuna-bff', brand: 'Fortuna BFF', provider: 'Fortuna', members: Object.freeze(['fortuna', 'casa-pariurilor']) },
  { id: 'everymatrix-wamp', brand: 'EveryMatrix WAMP', provider: 'EveryMatrix', members: Object.freeze(['getsbet', 'contibet']) },
]);

/** @type {Map<string, string>} sourceId → group id */
const GROUP_OF = new Map();
for (const group of FEED_GROUPS) {
  for (const member of group.members) GROUP_OF.set(member, group.id);
}

/**
 * The shared-feed group a source belongs to, or null when it stands alone.
 *
 * @param {string} sourceId
 * @returns {string|null}
 */
export function feedGroupOf(sourceId) {
  return GROUP_OF.get(sourceId) || null;
}

/**
 * True when two sources are the same upstream feed under different brands, so
 * a leg from one and a leg from the other cannot form a real arbitrage.
 *
 * A source with no declared group is independent by default: an unrecognised
 * provider is treated as its own feed rather than silently assumed to be a
 * clone of something else.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSharedFeed(a, b) {
  if (!a || !b || a === b) return false;
  const group = GROUP_OF.get(a);
  return group !== undefined && group === GROUP_OF.get(b);
}

/**
 * Every other member of `sourceId`'s group, excluding itself. Used to annotate
 * a source with the brands it shares a feed with, so the UI can say why a
 * pairing was not considered.
 *
 * @param {string} sourceId
 * @returns {string[]}
 */
export function sharedFeedPeers(sourceId) {
  const group = FEED_GROUPS.find((g) => g.members.includes(sourceId));
  if (!group) return [];
  return group.members.filter((m) => m !== sourceId);
}
