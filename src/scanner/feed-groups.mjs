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
 * maxbet is deliberately NOT in the nsoft group, and the reason is measured
 * rather than assumed. It sits on the same NSoft platform under a different
 * company UUID, but a different tenant does not imply a different price: it
 * implies the tenant prices independently. Measured live on 2026-09-26 over
 * the 36 fixtures the two tenants share, 8 carried byte-identical 1X2 prices
 * and 28 differed (e.g. Mallorca v Almeria 2.10/3.30/3.45 at admiral against
 * 2.11/3.35/3.50 at maxbet). Since the two genuinely disagree, pairing them
 * can be real arbitrage, so grouping them would suppress a true opportunity.
 *
 * The earlier note here justified that exclusion by the differing company
 * UUID alone. That reasoning does not hold: a shared UUID would not make two
 * brands one feed if their prices moved independently, and MaxBet's own prices
 * are the evidence that they do. The exclusion stands; the reason for it is
 * now the measurement rather than the tenant id.
 */

/** @type {ReadonlyArray<{ id: string, brand: string, provider: string, members: readonly string[] }>} */
export const FEED_GROUPS = Object.freeze([
  // docs/platform-findings.json: 1,262 shared football fixtures, 1,262
  // identical 1X2 vectors and zero differing across the three public hosts.
  // Tenant parameters do not select different prices. These aliases add no
  // independent price source; never pair them against each other or Winner.
  { id: 'digitain-public', brand: 'Digitain public feed', provider: 'Digitain', members: Object.freeze(['winner', 'mrplay', '888sport', 'bet7', 'eliteslots', 'ladycasino', 'pacanele', 'hotspins']) },
  { id: 'exalogic-xsport', brand: 'Exalogic XSport', provider: 'Exalogic', members: Object.freeze(['excelbet', 'winboss', 'las-vegas', 'magnumbet', 'cashpot']) },
  { id: 'altenar-tenancy', brand: 'Altenar tenancy', provider: 'Altenar', members: Object.freeze(['don', 'topbet', 'million', 'baumbet', 'powerbet', 'winbet', 'frankcasino', 'mrbit', 'slotv', 'betinia', 'win2ro', 'swiper', 'rabona', 'campobet', 'librabet', 'sportaza', 'greatwin', 'fezbet', 'wazamba', 'nomini', 'casinia', 'quickwin', 'stake', 'bcgame', 'sportsbetio', 'duelbits', 'solcasino', 'betriot', 'spinanga', 'powbet', 'sportuna', 'casinoly', 'excitewin', 'cazimbo', 'slotspalace', 'malinacasino', 'zet', 'kingmaker', 'crownplay', '5gringos', 'ohmyspins', 'boomerang', 'goldenbet', 'casombie', 'campeonbet', 'betsamigo', 'betalright', 'fairspin', 'spinight', 'goldspin', 'wildsino', 'betstro', 'evobet', 'svenbet', 'sonsofslots', 'wallacebet', 'betrebels', 'prontobet', 'betovo', 'quickslot', 'betbeast', 'slotparadise', 'joker8', 'betway']) },
  { id: 'nsoft-company', brand: 'NSoft company', provider: 'NSoft', members: Object.freeze(['admiral', 'stanleybet', 'seven', 'gameworld', 'redsevens']) },
  { id: 'fortuna-bff', brand: 'Fortuna BFF', provider: 'Fortuna', members: Object.freeze(['fortuna', 'casa-pariurilor']) },
  { id: 'everymatrix-wamp', brand: 'EveryMatrix WAMP', provider: 'EveryMatrix', members: Object.freeze(['getsbet', 'contibet']) },
  // prowin, ultrabet and vipbet are three EGT Digital brands and ONE upstream
  // feed. This was measured, not assumed, and the first measurement was wrong:
  // it keyed fixtures as `home|away` with no kickoff, so two different matches
  // between the same clubs collapsed into one and a price "difference" could be
  // a different fixture. Re-measured kickoff-keyed, and cross-checked against
  // the provider's own feedProducerId, which is a direct identity signal rather
  // than price correlation:
  //
  //   prowin vs ultrabet  31 shared, 22 SAME feedProducerId
  //   prowin vs vipbet    35 shared, 33 SAME feedProducerId
  //   ultrabet vs vipbet  30 shared, 21 SAME feedProducerId
  //
  // Producer 50 alone covers 83 of prowin's and 64 of ultrabet's events, and 21
  // covers 28 of both. The same producer with different prices is mid-scrape
  // drift, not arbitrage — exactly the failure this file exists to prevent —
  // and it is visible in the data: "Sp. Biblioteca Athens v San Martin de
  // Formosa", producer 21 on both brands, 3.60/2.50/2.35 at prowin against
  // 3.40/2.40/2.57 at ultrabet.
  //
  // Consequence: enabling all three would add three brands and zero independent
  // price sources. The jobs are therefore registered DISABLED. See
  // config/scrapers.json for the measurement that says so.
  { id: 'egt-digital', brand: 'EGT Digital', provider: 'EGT Digital', members: Object.freeze(['prowin', 'ultrabet', 'vipbet', 'fortunapalace', 'maxwin', 'luckyseven', 'onecasino', 'vivabet']) },
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
