/**
 * workspace.ts — which workspace is on screen, what that entitles it to
 * render, and the pure filter/sort/grouping rules for the opportunity workstation.
 *
 * These are the shell's decisions, kept as plain functions rather than inline
 * expressions in `App.tsx` so they can be tested directly by `node --test`.
 */
import type { ArbitrageOpportunity, OpportunityType, Sport } from './domain';

/** Workspace slugs double as deep-link hashes, e.g. /app/#/opportunities. */
export const WORKSPACES = {
  Dashboard: 'dashboard',
  Opportunities: 'opportunities',
  Scanner: 'scanner',
  Bookmakers: 'bookmakers',
  Analytics: 'analytics',
  Plans: 'plans',
  Settings: 'settings',
} as const;

export type WorkspaceView = keyof typeof WORKSPACES;

export const DEFAULT_VIEW: WorkspaceView = 'Opportunities';

export function viewFromHash(hash: string): WorkspaceView | null {
  const slug = hash.replace(/^#\/?/, '').trim().toLowerCase();
  if (!slug) return null;
  const match = (Object.entries(WORKSPACES) as [WorkspaceView, string][]).find(([, value]) => value === slug);
  return match ? match[0] : null;
}

export function hashForView(view: WorkspaceView) {
  return `#/${WORKSPACES[view]}`;
}

/**
 * The workspace that owns the virtualized opportunity feed and execution slip.
 *
 * `Opportunities` is the sole terminal workspace now that `Scanner` has its own
 * dedicated Scrape, Verification, Live Polling, and Scheduler control center
 * rather than duplicating the opportunity feed.
 */
export const TERMINAL_VIEWS = ['Opportunities'] as const;

export function isTerminalView(view: WorkspaceView): boolean {
  return (TERMINAL_VIEWS as readonly WorkspaceView[]).includes(view);
}

/**
 * Every workspace in the sidebar is a distinct, functional tool:
 * - Dashboard: Overview, quick actions, top safe surebets & source health
 * - Opportunities: Arbitrage workstation & stake execution slip
 * - Scanner: Collect odds, live scrape pipeline, verification & automation
 * - Bookmakers: Live source matrix, shared feed groups & settlement rules
 * - Analytics: Bet tracker, P&L ledger & market catalog explorer
 * - Plans: Access tier overview (capability-only per spec)
 * - Settings: Default bankroll, rounding, audio/alert thresholds, theme & language
 */
export const NAV_VIEWS: readonly WorkspaceView[] = [
  'Dashboard',
  'Opportunities',
  'Scanner',
  'Bookmakers',
  'Analytics',
  'Plans',
  'Settings',
];

export type SelectionState = {
  /** The workspace on screen. Only a terminal view may hold a selection. */
  view: WorkspaceView;
  /** The trader closed the slip with the X button. */
  dismissed: boolean;
  /** The card currently open in the slip, if any. */
  selectedId: string | null;
  /** Whether that card is still in the feed at all. */
  selectedStillPresent: boolean;
  /** `visible[0]` — the card the slip falls back to. */
  firstCandidateId: string | null;
};

/**
 * Which card the slip should be showing, or `null` for its empty state.
 */
export function desiredSelection(state: SelectionState): string | null {
  if (!isTerminalView(state.view)) return null;
  if (state.dismissed) return state.selectedId;
  if (state.selectedId && state.selectedStillPresent) return state.selectedId;
  return state.firstCandidateId;
}

export type SafetyFilter = 'all' | 'safe_only' | 'hide_blocked';
export type TimingFilter = 'all' | 'prematch' | 'live';
export type SortMode = 'recommended' | 'edge_desc' | 'roi_desc' | 'age_asc' | 'kickoff_asc';
export type FilterPreset = 'all' | 'safe_surebets' | 'middles' | 'verified_ev' | 'live_now';

/**
 * How many legs an opportunity must carry. A surebet of two legs and one of
 * three are different bets, not different sizes of the same bet: the three-leg
 * case needs a third book to move, and its stake split is not the two-way one.
 * `legs` is already a two-or-three tuple, so this filter reads the model rather
 * than a parallel counter that could drift from it.
 */
export type OutcomeCountFilter = 'all' | '2' | '3';

/**
 * How long ago the opportunity was first seen. Distinct from `timing`, which
 * asks whether the match is live; this asks whether the *price* is stale. A
 * surebet found eight hours ago is often already gone at both books, and the
 * published row says so in `createdAt`.
 */
export type AgeWindow = 'all' | '10m' | '2h' | '12h';

/**
 * How soon the event starts. Distinct from `AgeWindow` for the same reason in
 * reverse: a price refreshed a minute ago can still belong to a match a week
 * out, and a bettor with a bankroll to place cares which.
 */
export type EventDuring = 'all' | '12h' | '16h' | '1d' | '2d' | '1w';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YEAR_HOURS = 365 * 24;

/** Upper bounds, in milliseconds, for the age windows the panel offers. */
const AGE_WINDOW_MS: Record<Exclude<AgeWindow, 'all'>, number> = {
  '10m': 10 * MINUTE_MS,
  '2h': 2 * HOUR_MS,
  '12h': 12 * HOUR_MS,
};

/** Upper bounds, in milliseconds, for the kickoff horizons the panel offers. */
const EVENT_DURING_MS: Record<Exclude<EventDuring, 'all'>, number> = {
  '12h': 12 * HOUR_MS,
  '16h': 16 * HOUR_MS,
  '1d': DAY_MS,
  '2d': 2 * DAY_MS,
  '1w': 7 * DAY_MS,
};

export interface HiddenRules {
  opportunityIds: string[];
  eventKeys: string[];
  leagues: string[];
  bookmakers: string[];
}

export const EMPTY_HIDDEN_RULES: HiddenRules = {
  opportunityIds: [],
  eventKeys: [],
  leagues: [],
  bookmakers: [],
};

export interface OpportunityFilterCriteria {
  type: 'all' | OpportunityType;
  sport: 'all' | Sport;
  bookmaker: string;
  safety: SafetyFilter;
  timing: TimingFilter;
  minProfit: number;
  /** Upper profit bound in percent; 0 means uncapped, which is the default. */
  maxProfit: number;
  /** Minimum decimal odds per leg; 0 means uncapped. */
  minOdds: number;
  /** Maximum decimal odds per leg; 0 means uncapped. */
  maxOdds: number;
  outcomeCount: OutcomeCountFilter;
  ageWindow: AgeWindow;
  eventDuring: EventDuring;
  /** Exact `league` match, or 'all'. The label the feed published, not a normalised key. */
  league: string;
  /** Exact `marketKey` match, or 'all'. */
  market: string;
  /** Hide multi-leg positions where 2+ legs share the same bookmaker. */
  crossBookOnly?: boolean;
  /** Exclude push/return-capable lines (DNB, integer/quarter handicaps & totals). */
  noPushOnly?: boolean;
  query: string;
  sortBy: SortMode;
}

export const DEFAULT_FILTER_CRITERIA: OpportunityFilterCriteria = {
  type: 'all',
  sport: 'all',
  bookmaker: 'all',
  safety: 'all',
  timing: 'all',
  minProfit: 0,
  maxProfit: 0,
  minOdds: 0,
  maxOdds: 0,
  outcomeCount: 'all',
  ageWindow: 'all',
  eventDuring: 'all',
  league: 'all',
  market: 'all',
  crossBookOnly: false,
  noPushOnly: false,
  query: '',
  sortBy: 'recommended',
};

export function criteriaForPreset(preset: FilterPreset): Partial<OpportunityFilterCriteria> {
  switch (preset) {
    case 'safe_surebets':
      return { type: 'surebet', safety: 'safe_only', timing: 'all', minProfit: 0, sortBy: 'recommended' };
    case 'middles':
      return { type: 'middle', safety: 'hide_blocked', timing: 'all', minProfit: 0, sortBy: 'edge_desc' };
    case 'verified_ev':
      return { type: 'positive_ev', safety: 'hide_blocked', timing: 'all', minProfit: 1, sortBy: 'recommended' };
    case 'live_now':
      return { type: 'all', safety: 'hide_blocked', timing: 'live', minProfit: 0, sortBy: 'recommended' };
    case 'all':
    default:
      return { ...DEFAULT_FILTER_CRITERIA };
  }
}

export function eventGroupKey(opp: ArbitrageOpportunity): string {
  if (opp.eventKey) return opp.eventKey;
  return `${opp.sport}|${opp.homeTeam.toLowerCase()}|${opp.awayTeam.toLowerCase()}`;
}

/**
 * Simple annualized ROI (% p.a.) assuming capital unlocks ~2h after kickoff
 * (floored at 2.5h for live/imminent events), matching SureBet.com's ROI column.
 */
export function annualizedRoiPercent(
  opp: ArbitrageOpportunity,
  now: number = Date.now(),
): number | null {
  if (!Number.isFinite(opp.profitPercent) || opp.profitPercent <= 0) return null;
  let hoursUntilSettlement: number;
  if (opp.isLive) {
    hoursUntilSettlement = 2.5;
  } else {
    const kickoff = Date.parse(opp.startTime);
    if (!Number.isFinite(kickoff)) return null;
    hoursUntilSettlement = Math.max(2.5, (kickoff - now) / HOUR_MS + 2);
  }
  return Math.round(opp.profitPercent * (YEAR_HOURS / hoursUntilSettlement) * 10) / 10;
}

function isNonHalfLineNumber(val: number): boolean {
  if (!Number.isFinite(val)) return false;
  const frac = Math.abs(val) % 1;
  return Math.abs(frac - 0.5) > 1e-6;
}

/**
 * True when an opportunity includes a stake-refund / push-capable contract
 * (Draw No Bet, AH 0, integer totals/handicaps like 2.0 or -1, or quarter lines .25/.75).
 */
export function isPushCapableOpportunity(opp: ArbitrageOpportunity): boolean {
  const mk = (opp.marketKey ?? '').toUpperCase();
  const mn = opp.marketName ?? '';
  if (mk === 'SYNTHETIC_DNB_AH0' || mk === 'DRAW_NO_BET' || /\bdraw no bet\b/i.test(mn)) {
    return true;
  }
  if (mk.startsWith('SYNTHETIC_')) return false;

  const isLineMarket =
    /(?:OVER_UNDER|HANDICAP|TOTAL|GOALS|POINTS|GAMES|CORNERS|CARDS|FAHC)/i.test(mk) ||
    /(?:Total|Over\/Under|Handicap|Corners|Cards|Points|Games|Goals|Rounds|Legs)/i.test(mn);
  if (!isLineMarket) return false;

  const head = mn.split(' · ')[0] ?? '';
  const trailingLine = /(\d+(?:\.\d+)?)$/.exec(head.trim());
  if (trailingLine && isNonHalfLineNumber(Number(trailingLine[1]))) {
    return true;
  }

  for (const leg of opp.legs) {
    const sel = leg.selection ?? '';
    const ouMatch = /(?:over|under|peste|sub)\s*([+-]?\d+(?:[.,]\d+)?)/i.exec(sel);
    if (ouMatch && isNonHalfLineNumber(Number(ouMatch[1].replace(',', '.')))) {
      return true;
    }
    const hcMatch = /\(([+-]?\d+(?:[.,]\d+)?)\)|(?:^|\s)([+-]\d+(?:[.,]\d+)?)(?:\s|$)/.exec(sel);
    const rawNum = hcMatch?.[1] ?? hcMatch?.[2];
    if (rawNum !== undefined && isNonHalfLineNumber(Number(rawNum.replace(',', '.')))) {
      return true;
    }
  }
  return false;
}

export function isOpportunityHidden(
  opp: ArbitrageOpportunity,
  hidden?: HiddenRules,
): boolean {
  if (!hidden) return false;
  if (hidden.opportunityIds.length > 0 && hidden.opportunityIds.includes(opp.id)) return true;
  if (hidden.eventKeys.length > 0 && hidden.eventKeys.includes(eventGroupKey(opp))) return true;
  if (hidden.leagues.length > 0 && hidden.leagues.includes(opp.league)) return true;
  if (
    hidden.bookmakers.length > 0 &&
    opp.legs.some((leg) => hidden.bookmakers.includes(leg.bookmakerId))
  ) {
    return true;
  }
  return false;
}

export interface OpportunityEventGroup {
  eventKey: string;
  primary: ArbitrageOpportunity;
  siblings: ArbitrageOpportunity[];
}

export function groupOpportunitiesByEvent(
  opportunities: readonly ArbitrageOpportunity[],
): OpportunityEventGroup[] {
  const groups = new Map<string, OpportunityEventGroup>();
  for (const opp of opportunities) {
    const key = eventGroupKey(opp);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { eventKey: key, primary: opp, siblings: [] });
    } else {
      existing.siblings.push(opp);
    }
  }
  return [...groups.values()];
}

export function mergePinnedOpportunities(
  visible: readonly ArbitrageOpportunity[],
  pinnedIds: readonly string[],
  pinnedSnapshots: Record<string, ArbitrageOpportunity>,
): { opportunities: ArbitrageOpportunity[]; stalePinnedIds: Set<string> } {
  if (!pinnedIds.length) {
    return { opportunities: [...visible], stalePinnedIds: new Set() };
  }
  const visibleById = new Map(visible.map((o) => [o.id, o]));
  const pinnedRows: ArbitrageOpportunity[] = [];
  const stalePinnedIds = new Set<string>();
  const pinnedSet = new Set<string>();

  for (const id of pinnedIds) {
    const liveRow = visibleById.get(id);
    if (liveRow) {
      pinnedRows.push(liveRow);
      pinnedSet.add(id);
    } else if (pinnedSnapshots[id]) {
      const snap = pinnedSnapshots[id];
      pinnedRows.push(snap);
      stalePinnedIds.add(snap.id);
      pinnedSet.add(snap.id);
    }
  }

  const remainder = visible.filter((o) => !pinnedSet.has(o.id));
  return {
    opportunities: [...pinnedRows, ...remainder],
    stalePinnedIds,
  };
}

/**
 * Filter and sort an already certainty-ranked opportunity list.
 *
 * When `sortBy === 'recommended'`, the caller's certainty order (`rankOpportunities`)
 * is preserved intact so conditional middles and unreconciled +EV rows never float
 * above guaranteed rule-safe surebets.
 */
export function filterOpportunities(
  ranked: readonly ArbitrageOpportunity[],
  criteria: OpportunityFilterCriteria,
  now: number = Date.now(),
  hidden?: HiddenRules,
): ArbitrageOpportunity[] {
  const q = criteria.query.trim().toLowerCase();
  const minProfit = Number.isFinite(criteria.minProfit) && criteria.minProfit > 0 ? criteria.minProfit : 0;
  const maxProfit = Number.isFinite(criteria.maxProfit) && criteria.maxProfit > 0 ? criteria.maxProfit : 0;
  const minOdds = Number.isFinite(criteria.minOdds) && criteria.minOdds > 0 ? criteria.minOdds : 0;
  const maxOdds = Number.isFinite(criteria.maxOdds) && criteria.maxOdds > 0 ? criteria.maxOdds : 0;
  const ageWindow = criteria.ageWindow === 'all' ? null : AGE_WINDOW_MS[criteria.ageWindow] ?? null;
  const eventDuring = criteria.eventDuring === 'all' ? null : EVENT_DURING_MS[criteria.eventDuring] ?? null;
  const wantsTwoLegs = criteria.outcomeCount === '2';
  const wantsThreeLegs = criteria.outcomeCount === '3';
  const wantsLeague = typeof criteria.league === 'string' && criteria.league !== '' && criteria.league !== 'all';
  const wantsMarket = typeof criteria.market === 'string' && criteria.market !== '' && criteria.market !== 'all';

  const filtered = ranked.filter((item) => {
    if (hidden && isOpportunityHidden(item, hidden)) return false;
    if (criteria.type !== 'all' && item.type !== criteria.type) return false;
    if (criteria.sport !== 'all' && item.sport !== criteria.sport) return false;
    if (criteria.bookmaker !== 'all' && !item.legs.some((leg) => leg.bookmakerId === criteria.bookmaker)) return false;
    if (criteria.safety === 'safe_only') {
      if (item.ruleSafety.severity !== 'safe') return false;
      if (item.evConsensusSuspect) return false;
    } else if (criteria.safety === 'hide_blocked') {
      if (item.ruleSafety.severity === 'blocked') return false;
      if (item.evConsensusSuspect) return false;
    }
    if (criteria.timing === 'live' && !item.isLive) return false;
    if (criteria.timing === 'prematch' && item.isLive) return false;
    if (minProfit > 0 && item.profitPercent < minProfit) return false;
    if (maxProfit > 0 && item.profitPercent > maxProfit) return false;
    if (minOdds > 0 && item.legs.some((leg) => leg.rawOdds < minOdds)) return false;
    if (maxOdds > 0 && item.legs.some((leg) => leg.rawOdds > maxOdds)) return false;
    if (wantsTwoLegs && item.legs.length !== 2) return false;
    if (wantsThreeLegs && item.legs.length !== 3) return false;
    if (ageWindow !== null) {
      const age = now - item.createdAt;
      if (!Number.isFinite(age) || age > ageWindow) return false;
    }
    if (eventDuring !== null) {
      const kickoff = Date.parse(item.startTime);
      if (!Number.isFinite(kickoff) || kickoff - now > eventDuring) return false;
    }
    if (wantsLeague && item.league !== criteria.league) return false;
    if (wantsMarket && (item.marketKey || item.marketName) !== criteria.market) return false;
    if (
      criteria.crossBookOnly &&
      item.legs.length > 1 &&
      new Set(item.legs.map((leg) => leg.bookmakerId)).size < item.legs.length
    ) {
      return false;
    }
    if (criteria.noPushOnly && isPushCapableOpportunity(item)) {
      return false;
    }
    if (q) {
      const haystack = `${item.homeTeam} ${item.awayTeam} ${item.league} ${item.marketName} ${item.legs.map((l) => `${l.bookmakerName} ${l.selection}`).join(' ')}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (criteria.sortBy === 'edge_desc') {
    return [...filtered].sort((a, b) => b.profitPercent - a.profitPercent || a.id.localeCompare(b.id));
  }
  if (criteria.sortBy === 'roi_desc') {
    return [...filtered].sort((a, b) => {
      const ra = annualizedRoiPercent(a, now) ?? Number.NEGATIVE_INFINITY;
      const rb = annualizedRoiPercent(b, now) ?? Number.NEGATIVE_INFINITY;
      return rb - ra || b.profitPercent - a.profitPercent || a.id.localeCompare(b.id);
    });
  }
  if (criteria.sortBy === 'age_asc') {
    return [...filtered].sort((a, b) => {
      const ca = Number.isFinite(a.createdAt) ? a.createdAt : 0;
      const cb = Number.isFinite(b.createdAt) ? b.createdAt : 0;
      return cb - ca || b.profitPercent - a.profitPercent || a.id.localeCompare(b.id);
    });
  }
  if (criteria.sortBy === 'kickoff_asc') {
    return [...filtered].sort((a, b) => {
      const ta = Date.parse(a.startTime) || Number.MAX_SAFE_INTEGER;
      const tb = Date.parse(b.startTime) || Number.MAX_SAFE_INTEGER;
      return ta - tb || b.profitPercent - a.profitPercent || a.id.localeCompare(b.id);
    });
  }
  return filtered;
}
