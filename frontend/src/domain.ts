export type Sport =
  | 'football'
  | 'tennis'
  | 'basketball'
  | 'hockey'
  | 'handball'
  | 'volleyball'
  | 'american-football'
  | 'boxing'
  | 'mma'
  | 'baseball'
  | 'table-tennis'
  | 'esports'
  | 'darts'
  | 'rugby'
  | 'snooker'
  | 'futsal'
  | 'cricket'
  | 'water-polo'
  | 'badminton'
  | 'other';

export type OpportunityType = 'surebet' | 'middle' | 'positive_ev';
export type TennisRule = 'one_ball' | 'one_set' | 'match_completion';
export type OvertimeRule = 'includes_ot' | 'regulation_only' | 'includes_ot_so';

export interface BookmakerMetadata {
  id: string;
  name: string;
  commission: number;
  color: string;
  rules: { tennis_retirement: TennisRule; basketball_2way: OvertimeRule; hockey_2way: OvertimeRule };
}

export interface ArbLeg {
  bookmakerId: string;
  bookmakerName: string;
  selection: string;
  rawOdds: number;
  effectiveOdds: number;
  marketKey: string;
  marketName: string;
  deepLinkUrl?: string;
  liquidity?: number;
  stake?: number;
  payout?: number;
}

/**
 * A contract's settlement verdict, as the backend reports it.
 *
 * `unverified` is not a synonym for `safe`. The scrape pipeline verifies
 * `scan.opportunities` and nothing else, so every middle and every +EV row
 * arrives with no `verification` object at all — and the shell read that
 * silence as compatibility, so rows nothing had checked wore the safe badge.
 * We asked and it held and we never asked are different claims, and only the
 * first one is money in hand, so the second now has its own verdict.
 */
export type RuleSeverity = 'safe' | 'warning' | 'blocked' | 'unverified';

export interface RuleSafetyResult {
  /** True only when the backend established that the legs settle together. */
  isCompatible: boolean;
  severity: RuleSeverity;
  ruleMismatchReason?: string;
}

export interface ArbitrageOpportunity {
  id: string;
  type: OpportunityType;
  sport: Sport;
  rawSport?: string;
  eventKey?: string;
  marketKey?: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  isLive: boolean;
  profitPercent: number;
  createdAt: number;
  lastUpdatedAt: number;
  legs: [ArbLeg, ArbLeg] | [ArbLeg, ArbLeg, ArbLeg];
  ruleSafety: RuleSafetyResult;
  ttlSeconds: number;
  sourceCount: number;
  /** Human-readable market description, derived from family/line/marketKey. */
  marketName: string;
  /** The scan timestamp this opportunity was published from. */
  scannedAt: number;
  /** Conditional upside on the winning outcome. Middles and +EV only. */
  roiPercent?: number;
  /** Chance the middle loses. Middles only. */
  riskPercent?: number;
  /** Size of the middle window between the two lines. Middles only. */
  gap?: number;
  /** Consensus-implied probability. Positive EV only. */
  consensusProbability?: number;
  /** Expected value against the consensus price. Positive EV only. */
  evPercent?: number;
  /**
   * The consensus sits too far from this leg's own price for the figure to be
   * an expected value. Positive EV only.
   *
   * The backend computes `odds × consensus − 1`, which is correct arithmetic on
   * an assumption it cannot check: that both books mean the same bet. When one
   * book prices an outcome at 1.25 and another at 5.00 the median is still taken
   * at face value, so a keying or line mismatch is published as a four-figure
   * "edge". The engine has no contract check on this family yet, so the figure
   * is surfaced with its doubt attached rather than presented as a number to
   * size a bet on.
   */
  evConsensusSuspect?: boolean;
  /** Whether the middle is also a pure arbitrage. Middles only. */
  isArb?: boolean;
  /** Total stake the backend used to compute the published figures. */
  totalStake?: number;
  /** Guaranteed profit in currency. Surebets only; null for pure middles and +EV. */
  guaranteedProfit?: number | null;
  /** Worst-case payout across outcomes. Surebets only. */
  worstCasePayout?: number;
  /** Original raw payload for targeted re-verification. */
  rawTarget?: unknown;
}

export interface LowHoldRow {
  id: string;
  sport: Sport;
  rawSport?: string;
  eventKey?: string;
  marketKey?: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  isLive: boolean;
  marketName: string;
  holdPercent: number;
  legs: ArbLeg[];
}

export interface ScanSource {
  sourceId: string;
  count?: number;
  dataStatus?: string;
  ageMs?: number | null;
  capturedAt?: string | null;
  feedGroup?: string | null;
  sharedFeedWith?: string[];
  transport?: string | null;
  validationStatus?: string | null;
}

export interface ScraperJob {
  id: string;
  name: string;
  enabled?: boolean;
  validationStatus?: string;
  validationReason?: string;
  supportedSports?: string[];
  platform?: string;
  feedStatus?: string;
  endpointVerifiedAt?: string;
  sourceIds?: string[];
  liveCapability?: {
    inPlay?: string;
    detail?: string;
    verifiedAt?: string;
  } | null;
}

export interface ScrapeJobProgress {
  id: string;
  name?: string;
  status?: string;
  eventsCount?: number;
  durationMs?: number;
  error?: string | null;
}

export interface ScrapeState {
  status: string;
  runId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  currentStep?: string | null;
  currentActivity?: string | null;
  books?: string[];
  jobs?: ScrapeJobProgress[];
  options?: Record<string, unknown>;
  summary?: {
    totalJobs?: number;
    completedJobs?: number;
    failedJobs?: number;
    eventsCollected?: number;
  } | null;
}

export interface ScrapeRunReport {
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  jobs: ScrapeJobProgress[];
}

export interface ScanProfile {
  id: string;
  label: string;
  mode: string;
  description: string;
  defaults: {
    bankroll?: number;
    minMarginPercent?: number;
    maxMiddleRiskPercent?: number;
    minMiddleRoiPercent?: number;
    includeLive?: boolean;
    includePast?: boolean;
  };
}

export interface SportOption {
  id: string;
  name: string;
  hasDraw?: boolean;
  markets?: string[];
}

export interface TrackedBet {
  id: string;
  createdAt: string;
  updatedAt?: string;
  eventKey: string;
  marketKey: string;
  selection: string;
  sourceId: string;
  odds: number;
  stake: number;
  status: 'pending' | 'won' | 'lost' | 'void';
  notes: string;
  provenance?: 'scan' | 'import' | 'manual';
}

export interface TrackerPayload {
  schemaVersion: number;
  updatedAt: string | null;
  items: TrackedBet[];
}

export interface SchedulerStatus {
  enabled: boolean;
  intervalMinutes: number;
  bookIds?: string[];
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  scanOptions?: Record<string, unknown>;
}

export interface LivePollStatus {
  enabled: boolean;
  intervalSeconds: number;
  bookIds?: string[];
  running?: boolean;
  lastPollAt?: string | null;
  scanOptions?: Record<string, unknown>;
}

export interface AlertPreferences {
  enabled: boolean;
  minMarginPercent: number;
  minMiddleRoiPercent: number;
  minEvPercent: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  channels: {
    sound: boolean;
    desktop: boolean;
    telegram?: boolean;
    webhook?: boolean;
  };
}

export interface AlertPayload {
  schemaVersion: number;
  published: boolean;
  scan: { id?: string; scrapedAt?: string; eventCount?: number };
  preferences: AlertPreferences;
  alerts?: unknown[];
  suppressedByQuietHours?: boolean;
}

export interface EventDetailSelection {
  id?: string;
  name: string;
  odds: number;
  group?: string;
  handicap?: number | string | null;
}

export interface EventDetailArbLeg {
  sourceId: string;
  selection: string;
  odds: number;
  stake?: number;
  payout?: number;
  eventUrl?: string | null;
}

export interface EventDetailMarket {
  key: string;
  name: string;
  period?: string;
  team?: string;
  subject?: string;
  live?: boolean;
  selections: EventDetailSelection[];
  arb?: {
    marginPercent?: number;
    guaranteedProfit?: number;
    totalStake?: number;
    legs?: EventDetailArbLeg[];
  };
}

export interface EventDetailBookEvent {
  sourceId: string;
  sourceUrl: string | null;
  sport: string;
  league: string;
  kickoff: string;
  homeTeam: string;
  awayTeam: string;
  live: boolean;
  markets: EventDetailMarket[];
}

export interface StakeCalculation {
  legStakes: number[];
  roundedStakes: number[];
  localStakes?: number[];
  totalStakedBase?: number;
  individualReturns: number[];
  legProfits?: number[];
  effectiveNetOdds?: number[];
  worstCaseProfit: number;
  worstCaseRoi: number;
  isRounded: boolean;
}

const BOOKMAKER_COLOR_PALETTE: Record<string, string> = {
  superbet: '#ef4444',
  'superbet-pl': '#f87171',
  betano: '#f97316',
  favbet: '#ec4899',
  unibet: '#84cc16',
  maxbet: '#eab308',
  '888sport': '#fb923c',
  admiral: '#3b82f6',
  'admiralbet-pl': '#60a5fa',
  stanleybet: '#dc2626',
  betmen: '#14b8a6',
  fortuna: '#facc15',
  'casa-pariurilor': '#22c55e',
  casa: '#22c55e',
  winner: '#a855f7',
  netbet: '#06b6d4',
  getsbet: '#10b981',
  contibet: '#6366f1',
  excelbet: '#0ea5e9',
  winboss: '#d946ef',
  'las-vegas': '#f59e0b',
  magnumbet: '#8b5cf6',
  don: '#f43f5e',
  topbet: '#2dd4bf',
  million: '#c084fc',
  baumbet: '#4ade80',
  powerbet: '#38bdf8',
  winbet: '#fb7185',
  vipbet: '#fbbf24',
  winmasters: '#34d399',
  pariuriplus: '#818cf8',
  totalbet: '#22d3ee',
  etoto: '#a3e635',
  fuksiarz: '#f472b6',
  '5gringos': '#fdba74',
  betfair: '#8b5cf6',
};

const FALLBACK_COLORS = ['#38bdf8', '#34d399', '#f59e0b', '#a78bfa', '#fb7185', '#2dd4bf', '#facc15', '#60a5fa'];

export function bookmakerColor(id: string): string {
  const key = (id || '').toLowerCase();
  if (BOOKMAKER_COLOR_PALETTE[key]) return BOOKMAKER_COLOR_PALETTE[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export const BOOKMAKERS: BookmakerMetadata[] = [
  { id: 'superbet', name: 'Superbet', commission: 0, color: '#ef4444', rules: { tennis_retirement: 'one_set', basketball_2way: 'includes_ot', hockey_2way: 'includes_ot' } },
  { id: 'betano', name: 'Betano', commission: 0, color: '#f97316', rules: { tennis_retirement: 'one_set', basketball_2way: 'includes_ot', hockey_2way: 'includes_ot' } },
  { id: 'favbet', name: 'Favbet', commission: 0, color: '#ec4899', rules: { tennis_retirement: 'one_ball', basketball_2way: 'regulation_only', hockey_2way: 'regulation_only' } },
  { id: 'unibet', name: 'Unibet', commission: 0, color: '#84cc16', rules: { tennis_retirement: 'one_set', basketball_2way: 'includes_ot', hockey_2way: 'includes_ot_so' } },
  { id: 'maxbet', name: 'MaxBet', commission: 0, color: '#eab308', rules: { tennis_retirement: 'one_set', basketball_2way: 'includes_ot', hockey_2way: 'regulation_only' } },
  { id: 'fortuna', name: 'Fortuna', commission: 0, color: '#facc15', rules: { tennis_retirement: 'one_ball', basketball_2way: 'includes_ot', hockey_2way: 'regulation_only' } },
  { id: 'casa-pariurilor', name: 'Casa Pariurilor', commission: 0, color: '#22c55e', rules: { tennis_retirement: 'one_ball', basketball_2way: 'includes_ot', hockey_2way: 'regulation_only' } },
  { id: 'betfair', name: 'Betfair', commission: 6.5, color: '#8b5cf6', rules: { tennis_retirement: 'one_set', basketball_2way: 'includes_ot', hockey_2way: 'includes_ot' } },
];
