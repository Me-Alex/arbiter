/**
 * claims.ts — what a number is allowed to say about itself.
 *
 * The three opportunity families are not the same claim and must not wear the
 * same label. A surebet's number is money in hand, a middle's is money only if
 * it lands, and a +EV figure is an expectation over many repetitions. This rule
 * decides which of those a row may assert, and it used to live inside the
 * React component — the one file in the shell that no test could reach, because
 * rendering it needs React.
 *
 * Nothing here touches the DOM or the network, so `test/frontend-normalize.test.mjs`
 * imports it directly through Node's native type stripping. That matters more
 * than the usual "extract for readability" reason: every string below typechecks
 * regardless of whether it is *true*, so these are claims the type checker will
 * never report and only a test can pin.
 */
import type { ArbitrageOpportunity } from './domain';

/**
 * How a percentage is spelled. `Intl` owns the decimal separator — `ro-RO`
 * writes `3,17%` and `en-GB` writes `3.17%` — so it cannot be baked in here.
 * Same reason `formatMoney` is a parameter: this module decides what a number
 * may claim, never how it is written, and it stays importable by a DOM-less
 * test that has no locale at all.
 */
export type PercentFormat = (value: number, digits?: number) => string;

/**
 * The order the trader sees, which the toolbar describes as "actionable first".
 *
 * There was no sort at all: the stream rendered `opportunities.filter(...)` in
 * whatever order the payload arrived, so the claim on screen described an
 * ordering that did not happen. Ranking lives here rather than inline so the
 * rule can be tested.
 *
 * Rows are ordered by certainty, then ranked *within* their own family. They are
 * deliberately never compared across families on `profitPercent`: a surebet's
 * 4% is a guaranteed margin while a middle's 511% is a conditional ROI, and
 * sorting one column by both would rank the least certain money in the feed
 * above the most certain — the same error as reading all three families off one
 * field. Within a family the figures mean the same thing and are comparable.
 *
 * Unreconcilable +EV rows and blocked contracts sink to the bottom whatever
 * their figure, so the rows nobody can act on cannot lead the list.
 */
const FAMILY_CERTAINTY: Record<string, number> = { surebet: 0, middle: 1, positive_ev: 2 };

export function rankOpportunities(rows: ArbitrageOpportunity[]): ArbitrageOpportunity[] {
  const tier = (row: ArbitrageOpportunity) => (row.evConsensusSuspect || row.ruleSafety.severity === 'blocked' ? 1 : 0);
  // Ties break on id so the list cannot reshuffle under the trader between two
  // renders that contain the same rows.
  return [...rows].sort((a, b) => tier(a) - tier(b)
    || (FAMILY_CERTAINTY[a.type] ?? 3) - (FAMILY_CERTAINTY[b.type] ?? 3)
    || b.profitPercent - a.profitPercent
    || a.id.localeCompare(b.id));
}

/**
 * What the execution slip claims about a position.
 *
 * The slip is the half of the screen that talks the trader into staking money,
 * so its wording has to match the card's. It used to assert "Expected profit"
 * and "Model probability" for +EV rows the card was simultaneously flagging as
 * unreconcilable, and it computed expected profit from the bankroll the trader
 * typed while listing the rounded stake two lines above — two different
 * positions, described by one set of numbers.
 */
export interface SlipSummary {
  /** Dictionary keys, not sentences — see the note above `slipSummary`. */
  aLabel: string; aValue: string; bLabel: string; bValue: string;
  /** A dictionary key qualifying `bValue` (`unreconciled`, `not established`), or null. */
  bQualifier: string | null;
  /** True when the slip is quoting a figure it cannot call an expectation. */
  unreconciled: boolean;
  /** True when the backend refused this contract and it is not placeable. */
  blocked: boolean;
}

/**
 * The labels this returns are dictionary keys, and the one word that used to be
 * welded onto a value — "unreconciled" — is a separate field, because a
 * translated word appended inside a number is a sentence this module is not
 * allowed to write.
 *
 * @param placedStake the stake the slip actually lists per leg — the rounded
 *   one, never the typed bankroll, so the quoted profit describes the position
 *   that would really be placed.
 * @param worstCase   the worker's worst-case figures for a multi-leg position.
 */
export function slipSummary(
  opportunity: ArbitrageOpportunity,
  placedStake: number,
  worstCase: { worstCaseProfit: number; worstCaseRoi: number; totalStaked: number },
  formatMoney: (value: number) => string,
  formatPercent: PercentFormat,
): SlipSummary {
  const isSingle = opportunity.type === 'positive_ev';
  const blocked = opportunity.ruleSafety.severity === 'blocked';
  if (isSingle) {
    const unreconciled = Boolean(opportunity.evConsensusSuspect);
    const expectedProfit = placedStake * ((opportunity.evPercent ?? opportunity.profitPercent) / 100);
    const probability = opportunity.consensusProbability != null ? formatPercent(opportunity.consensusProbability * 100, 1) : '—';
    return {
      // A consensus that cannot be reconciled with the leg's own price is not an
      // expectation, so it is quoted as what the payload claimed and nothing more.
      aLabel: unreconciled ? 'appClaimQuotedEdge' : 'appClaimExpectedProfit',
      aValue: formatMoney(expectedProfit),
      bLabel: 'appClaimModelProbability',
      bValue: probability,
      bQualifier: unreconciled ? 'appClaimUnreconciled' : null,
      unreconciled,
      blocked,
    };
  }
  if (opportunity.type === 'middle') {
    return {
      aLabel: 'appClaimUpsideIfLands',
      aValue: `+${formatPercent(opportunity.roiPercent ?? opportunity.profitPercent, 2)}`,
      bLabel: 'appClaimLossIfMisses',
      bValue: opportunity.riskPercent != null ? `-${formatPercent(opportunity.riskPercent, 2)}` : '—',
      bQualifier: null,
      unreconciled: false,
      blocked,
    };
  }
  // A blocked surebet has no worst case to state: the backend could not
  // establish that the legs settle together, so the payout if they do not is
  // unknown rather than zero.
  if (blocked) {
    // The worst case is not zero and not the arithmetic margin; it is unknown,
    // so the value is a dash and the reason is the translated qualifier.
    return { aLabel: 'appClaimStaked', aValue: formatMoney(worstCase.totalStaked), bLabel: 'appClaimWorstCase', bValue: '—', bQualifier: 'appClaimNotEstablished', unreconciled: false, blocked };
  }
  return {
    aLabel: 'appClaimWorstCase',
    aValue: `${worstCase.worstCaseProfit >= 0 ? '+' : ''}${formatMoney(worstCase.worstCaseProfit)}`,
    bLabel: 'appClaimRoiAfterRounding',
    bValue: formatPercent(worstCase.worstCaseRoi, 2),
    bQualifier: null,
    unreconciled: false,
    blocked,
  };
}

/**
 * The rows allowed to interrupt the trader with a sound.
 *
 * The chime is the loudest claim the shell makes: it says "stop and look". Only a
 * rule-safe surebet earns that, because it is the one row whose profit is money in
 * hand. Middles and +EV are priced and conditional, and a middle's ROI is routinely
 * two orders of magnitude larger than a surebet's guaranteed margin — a live scan
 * had middles at 128% against a best guaranteed 3.17%. Ranking a middle's
 * conditional ROI against that margin is the same category error as ranking the
 * two in the feed, and here it would fire the high-value tone for money nobody can
 * count on. A blocked contract is excluded too: its arithmetic looks fine and its
 * settlement guarantee is exactly what the backend refused.
 *
 * The filter used to live inline in the store, where the DOM made it untestable —
 * and the two constants it depends on (`HIGH_VALUE_PERCENT`, the guaranteed-only
 * rule) are exactly the kind of claim that typechecks whether or not it is true.
 */
export function alertable(rows: ArbitrageOpportunity[]): ArbitrageOpportunity[] {
  return rows.filter((row) => row.type === 'surebet' && row.ruleSafety.severity === 'safe');
}

/**
 * The two best figures the feed can stand behind, kept apart.
 *
 * This was one number: `Math.max(bestSurebet, bestEdge)`, printed as "Best
 * verified figures" in Analytics and as "Best +X%" in the browser tab title.
 * Taking the maximum of a guaranteed margin and an expected edge lets the larger
 * family lend its figure to the smaller one's label. With middles and +EV rows
 * routinely out-sizing surebets, the tab read "Best +5.00%" while the KPI strip
 * one screen below said "Best guaranteed +3.17%" — the borrowed figure is the
 * dangerous direction, because a surebet's number is the one a trader reads as
 * money in hand.
 *
 * Each figure now reads `profitPercent`, which `normalize` already sets to the
 * per-family headline (`roiPercent` for a middle, `evPercent` for +EV), so this
 * summary cannot disagree with the rows it describes.
 * Blocked contracts and unreconciled +EV rows are excluded: both are visible in
 * the feed and neither is a figure anyone can back. An unverified surebet is
 * excluded from the guaranteed figure for the same reason: its margin is the
 * arithmetic, and the guarantee is exactly the part nothing established.
 */
export interface VerifiedFigures {
  /** Largest guaranteed margin among rule-safe surebets. */
  guaranteed: number;
  /** Largest reconciled expected edge among +EV rows. */
  expectedEdge: number;
}

export function verifiedFigures(rows: ArbitrageOpportunity[]): VerifiedFigures {
  // A guaranteed figure is a claim about settlement, so only a contract the
  // backend confirmed may supply one.
  const settled = rows.filter((row) => row.ruleSafety.severity === 'safe');
  // An expected edge is not a settlement claim: it needs its two prices to
  // describe the same bet, not a verified contract. A rejected one still
  // contributes nothing, because its prices belong to a bet the backend refused.
  const credible = rows.filter((row) => row.ruleSafety.severity !== 'blocked' && !row.evConsensusSuspect);
  const best = (population: ArbitrageOpportunity[], type: string) => {
    const figures = population.filter((row) => row.type === type).map((row) => row.profitPercent);
    return figures.length ? Math.max(...figures) : 0;
  };
  return { guaranteed: best(settled, 'surebet'), expectedEdge: best(credible, 'positive_ev') };
}

/**
 * The window title may only state the guaranteed figure.
 *
 * The title is read before the table, so it cannot qualify a number the way a
 * card can. If there is no rule-safe surebet it says so outright rather than
 * quoting an expected edge with no word attached, because a bare "+5.00%" in a
 * tab is read as the guaranteed one.
 */
export interface TitleClaim {
  /** Dictionary key, or null when the title has nothing to add. */
  key: string | null;
  /** The figure the key's `{value}` token takes, when the claim carries one. */
  value?: number;
}

export function titleClaim(figures: VerifiedFigures): TitleClaim {
  // The sentence is the dictionary's, but the rule is this module's: only the
  // guaranteed figure may be quoted, because a bare percentage in a tab is read
  // as the guaranteed one.
  if (figures.guaranteed > 0) return { key: 'appTitleBestGuaranteed', value: figures.guaranteed };
  if (figures.expectedEdge > 0) return { key: 'appTitleNoSurebets' };
  return { key: null };
}

export interface SurebetCounts { total: number; actionable: number; blocked: number; hazard: number; unverified: number; }

/**
 * The surebet KPI splits into three verdicts, and all three have to be named.
 *
 * The backend does not answer "can I back this?" with a yes/no. It can reject a
 * contract outright, attach a settlement reason without rejecting it, or say
 * nothing at all. The KPI used to count the first and third and print a total
 * that neither of them reached: 0 actionable and 54 blocked against 69 surebets,
 * with the remaining 15 unaccounted for on screen. A trader reading that cannot
 * tell whether the feed is lying or the split is incomplete.
 *
 * The counts are returned together precisely so the sum can be asserted. That
 * invariant is the only thing stopping the next bucket from being invented and
 * silently dropped.
 */
export function surebetCounts(rows: ArbitrageOpportunity[]): SurebetCounts {
  const surebets = rows.filter((row) => row.type === 'surebet');
  return {
    total: surebets.length,
    actionable: surebets.filter((row) => row.ruleSafety.severity === 'safe').length,
    blocked: surebets.filter((row) => row.ruleSafety.severity === 'blocked').length,
    hazard: surebets.filter((row) => row.ruleSafety.severity === 'warning').length,
    // The fourth bucket. A surebet reaches the board with a verdict or with no
    // verdict at all, and the second case used to be counted as actionable by
    // default — which is how the breakdown reached its total while still
    // overstating what a trader could back.
    unverified: surebets.filter((row) => row.ruleSafety.severity === 'unverified').length,
  };
}

export interface ProfitLabel { value: string; qualifier: string; tone: string; }

/** The qualifier is a dictionary key; the figure is the figure. */
export function profitLabel(opportunity: ArbitrageOpportunity, formatPercent: PercentFormat): ProfitLabel {
  // A +EV figure whose consensus cannot be reconciled with the leg's own price
  // is not an expected value. It is quoted as a claim of "expected edge" only
  // when the two prices it multiplies could describe the same bet; otherwise the
  // number stays visible but stops asserting that anyone could expect it.
  if (opportunity.type === 'positive_ev') {
    const edge = opportunity.evPercent ?? opportunity.profitPercent;
    return opportunity.evConsensusSuspect
      ? { value: `+${formatPercent(edge, 2)}`, qualifier: 'appClaimUnverifiedConsensus', tone: 'muted' }
      : { value: `+${formatPercent(edge, 2)}`, qualifier: 'appClaimExpectedEdge', tone: 'amber' };
  }
  // A middle's figure is its ROI — what it returns against the stake actually at
  // risk. It reads the same field the headline does, so the corner of the card
  // and the slip below it can never disagree.
  if (opportunity.type === 'middle') {
    const upside = opportunity.roiPercent ?? opportunity.profitPercent;
    return { value: `+${formatPercent(upside, 2)}`, qualifier: 'appClaimUpsideIfLands', tone: 'purple' };
  }
  // "Guaranteed" is a claim about settlement, not about arithmetic. When the
  // backend could not establish that two legs settle the same way, the margin
  // is still the arithmetic it computed but the guarantee is exactly the part
  // that is missing — so the label stops asserting it and the number steps
  // back to the muted tone used for figures nobody can defend yet.
  if (opportunity.ruleSafety.severity === 'blocked') return { value: `+${formatPercent(opportunity.profitPercent, 2)}`, qualifier: 'appClaimBlockedContract', tone: 'muted' };
  if (opportunity.ruleSafety.severity === 'warning') return { value: `+${formatPercent(opportunity.profitPercent, 2)}`, qualifier: 'appClaimRuleHazard', tone: 'muted' };
  // Nothing checked this contract, so its figure is quoted rather than asserted,
  // and the one word it may not borrow is the one the label exists to carry.
  if (opportunity.ruleSafety.severity === 'unverified') return { value: `+${formatPercent(opportunity.profitPercent, 2)}`, qualifier: 'appClaimUnverifiedContract', tone: 'muted' };
  return { value: `+${formatPercent(opportunity.profitPercent, 2)}`, qualifier: 'appClaimGuaranteed', tone: '' };
}