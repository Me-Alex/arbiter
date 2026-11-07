import type {
  AlertPayload,
  AlertPreferences,
  ArbLeg,
  ArbitrageOpportunity,
  EventDetailBookEvent,
  LivePollStatus,
  LowHoldRow,
  OpportunityType,
  RuleSafetyResult,
  ScanProfile,
  ScanSource,
  ScraperJob,
  ScrapeRunReport,
  ScrapeState,
  SchedulerStatus,
  Sport,
  SportOption,
  TrackedBet,
  TrackerPayload,
} from './domain';

interface RawLeg {
  sourceId?: string;
  selection?: string;
  odds?: number;
  eventUrl?: string;
  marketKey?: string;
  handicap?: number | string;
  stake?: number;
  payout?: number;
  liquidity?: number;
}

interface RawOpportunity {
  type?: string;
  sport?: string;
  league?: string;
  homeTeam?: string;
  awayTeam?: string;
  kickoff?: string;
  live?: boolean;
  marginPercent?: number;
  holdPercent?: number;
  guaranteedProfit?: number;
  worstCasePayout?: number;
  totalStake?: number;
  eventKey?: string;
  marketKey?: string;
  family?: string;
  period?: string;
  line?: string;
  subject?: string;
  team?: string;
  legs?: RawLeg[];
  verification?: { status?: string; reason?: string };
  roiPercent?: number;
  riskPercent?: number;
  gap?: number;
  evPercent?: number;
  consensusProbability?: number;
  odds?: number;
  selection?: string;
  arb?: boolean;
}

export interface ScanPayload {
  id?: string;
  scrapedAt?: string;
  eventCount?: number;
  published?: boolean;
  options?: Record<string, unknown>;
  verificationSummary?: {
    confirmed?: number;
    rejected?: number;
    expired?: number;
    unconfirmed?: number;
  };
  dataHealth?: {
    actionableSourceCount?: number;
    status?: string;
    sources?: Record<string, number>;
  };
  sources?: ScanSource[];
  opportunities?: RawOpportunity[];
  middles?: RawOpportunity[];
  positiveEv?: RawOpportunity[];
  lowHold?: RawOpportunity[];
}

const sportMap: Record<string, Sport> = {
  football: 'football',
  fotbal: 'football',
  soccer: 'football',
  piłka: 'football',
  'pilka nozna': 'football',
  tennis: 'tennis',
  tenis: 'tennis',
  basketball: 'basketball',
  baschet: 'basketball',
  koszykowka: 'basketball',
  hockey: 'hockey',
  'ice hockey': 'hockey',
  'ice-hockey': 'hockey',
  hochei: 'hockey',
  'hochei pe gheata': 'hockey',
  'hochei pe gheață': 'hockey',
  handball: 'handball',
  handbal: 'handball',
  volleyball: 'volleyball',
  volei: 'volleyball',
  'american football': 'american-football',
  'american-football': 'american-football',
  'fotbal american': 'american-football',
  boxing: 'boxing',
  box: 'boxing',
  mma: 'mma',
  baseball: 'baseball',
  'table tennis': 'table-tennis',
  'table-tennis': 'table-tennis',
  'tenis de masa': 'table-tennis',
  'tenis de masă': 'table-tennis',
  esports: 'esports',
  'e-sports': 'esports',
  'counter-strike-2': 'esports',
  'counter-strike': 'esports',
  'dota-2': 'esports',
  'league-of-legends': 'esports',
  overwatch: 'esports',
  'rainbow-six': 'esports',
  darts: 'darts',
  rugby: 'rugby',
  snooker: 'snooker',
  futsal: 'futsal',
  cricket: 'cricket',
  'water polo': 'water-polo',
  'water-polo': 'water-polo',
  polo: 'water-polo',
  badminton: 'badminton',
};

const bookmakerNames: Record<string, string> = {
  superbet: 'Superbet',
  'superbet-pl': 'Superbet PL',
  betano: 'Betano',
  favbet: 'Favbet',
  fortuna: 'Fortuna',
  efortuna: 'eFortuna',
  unibet: 'Unibet',
  betfair: 'Betfair Exchange',
  casa: 'Casa Pariurilor',
  'casa-pariurilor': 'Casa Pariurilor',
  winner: 'Winner',
  netbet: 'NetBet',
  maxbet: 'MaxBet',
  '888sport': '888sport',
  admiral: 'Admiral',
  'admiralbet-pl': 'AdmiralBet PL',
  stanleybet: 'Stanleybet',
  betmen: 'BetMen',
  getsbet: 'GetsBet',
  contibet: 'ContiBet',
  excelbet: 'ExcelBet',
  winboss: 'WinBoss',
  'las-vegas': 'Las Vegas',
  magnumbet: 'MagnumBet',
  don: 'Don.ro',
  topbet: 'TopBet',
  million: 'Million',
  baumbet: 'BaumBet',
  powerbet: 'PowerBet',
  winbet: 'WinBet',
  vipbet: 'VipBet',
  winmasters: 'Winmasters',
  pariuriplus: 'PariuriPlus',
  totalbet: 'TotalBet',
  etoto: 'ETOTO',
  fuksiarz: 'Fuksiarz',
  '5gringos': '5Gringos',
  mozzart: 'Mozzart',
  publicwin: 'PublicWin',
  mrbit: 'MrBit',
  slotv: 'SlotV',
  frank: 'Frank',
};

export function normalizeSport(value?: string): Sport {
  const cleaned = (value ?? '').trim().toLowerCase();
  if (!cleaned) return 'football';
  return sportMap[cleaned] ?? 'other';
}

export function formatBookmakerName(sourceId?: string): string {
  const raw = (sourceId ?? '').trim();
  if (!raw) return 'Unknown';
  const direct = bookmakerNames[raw] ?? bookmakerNames[raw.toLowerCase()];
  if (direct) return direct;
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(' ');
}

/**
 * Bookmaker and scanner market codes are internal identifiers. A trader cannot
 * act on `HCTG` or `OVER_UNDER_2_5`, so every opportunity carries a readable
 * label derived from the family, the line, and the market key.
 */
/*
 * A key whose words disagree with what the backend measured is a market the
 * trader is told is something it is not, and nothing on either side can see
 * the disagreement: the engine pairs the right contracts while the row is
 * titled the wrong bet. So every key here is the backend table spelling
 * (`SUBJECT_BY_KEY` in `src/scanner/market-contracts.mjs`), and
 * `test/market-vocabulary.test.mjs` drives this map from that table rather
 * than restating it here.
 *
 * Two of these were wrong, and both were live. TCOU read "Total Goals" while
 * the backend measured it as cards — betano publishes it as "Total cartonașe
 * Peste/Sub" — so a cards line was titled a goals line, and the two can never
 * settle against each other. FTGO read "Full Time Goals" while the backend
 * measured it as games, the key betano publishes on Tennis as "Game-uri".
 */
const marketNames: Record<string, string> = {
  '1x2': 'Match Result', MATCH_ODDS: 'Match Odds', '1': 'Match Result', MR12: 'Match Result',
  DOUBLE_CHANCE: 'Double Chance', ASIAN_HANDICAP: 'Asian Handicap', BTTS: 'Both Teams to Score',
  BOTH_TEAMS_SCORE: 'Both Teams to Score', SET_WINNER: 'Set Winner',
  TOTAL_GOALS: 'Total Goals', HCTG: 'Total Goals', TOTAL: 'Total Goals',
  CNOU: 'Corners Over/Under',
  TCOU: 'Total Cards', TSMF: 'Total Cards',
  FTPO: 'Total Points', FOUT: 'Total Points', TOTAL_POINTS: 'Total Points',
  FTGO: 'Total Games', TOTAL_GAMES: 'Total Games',
};
const familyNames: Record<string, string> = { OVER_UNDER: 'Total Goals', TOTAL_GOALS: 'Total Goals', MATCH_ODDS: 'Match Odds', SYNTHETIC_EQUIVALENCE: 'Equivalent Market' };
/**
 * The subject a total counts, as the word the row is titled with.
 *
 * `cards` is spelled with its "Total" because that is the one phrase the
 * dictionary defines for it: `Corners` carries `marketTotalCorners`, which
 * is itself "Total cornere" in Romanian, so the prefix is already there in
 * one language. Writing cards the same way reuses that phrase instead of
 * adding a second word for the same market — and it keeps `Cards` from
 * collapsing onto `Total Cards` in `labels.ts`, where a second collapse
 * would be a decision rather than a tidy-up.
 */
const subjectLabels: Record<string, string> = {
  goals: 'Goals', corners: 'Corners', points: 'Points', games: 'Games', cards: 'Total Cards',
  // Derived by the engine from the text the books publish, never stamped by
  // an adapter: `rounds` from "Total runde 21.5", `legs` from "Total
  // Leg-uri". A subject with no entry here survives the `?? raw.subject`
  // fallback and is promoted over the market name, so the card was titled
  // "rounds 21.5" - the backend token, not a word a trader reads.
  rounds: 'Rounds', legs: 'Legs',
};

/**
 * The engine's derived two-sided contracts, named the way a trader would.
 *
 * These are not markets any book publishes. `X2_VS_HOME` is the engine pairing
 * "draw or away" (priced as Away +0.5) against "home wins" to find an
 * equivalence surebet, and it publishes the pair under that slug as both the
 * market key and the line. Rendered raw it reached the trader as
 * "Equivalent Market X2_VS_HOME", which names nothing they can place.
 */
const syntheticNames: Record<string, string> = {
  X2_VS_HOME: 'Draw or Away vs Home Win',
  '1X_VS_AWAY': 'Home or Draw vs Away Win',
  '12_VS_DRAW': 'Home or Away vs Draw',
  DNB_AH0: 'Draw No Bet (level)',
  '1X2_AH05': 'Match Result + AH (±0.5)',
};
const SYNTHETIC_PREFIX = 'SYNTHETIC_';
/** True for the derived equivalence contracts, whose `line` is a slug, not a line. */
function isSynthetic(key?: string): boolean { return Boolean(key?.startsWith(SYNTHETIC_PREFIX)); }

function readMarketKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (isSynthetic(key)) {
    const name = syntheticNames[key.slice(SYNTHETIC_PREFIX.length)];
    // An unrecognised synthetic still has to read as derived rather than as a slug.
    return name ?? 'Derived equivalence contract';
  }
  const direct = marketNames[key] ?? marketNames[key.toUpperCase()];
  if (direct) return direct;
  // Threshold keys carry their own line. The underscore stands in for the
  // decimal point, so `OVER_UNDER_2_5` is the 2.5 line, not the 2–5 band.
  const decimal = key.match(/^(OVER_UNDER|GAMES_OVER_UNDER)_(\d+)(?:_(\d+))?$/i);
  if (decimal) {
    const line = decimal[3] ? `${decimal[2]}.${decimal[3]}` : decimal[2];
    return decimal[1].toUpperCase().startsWith('GAMES') ? `Games ${line}` : `Total Goals ${line}`;
  }
  // Nothing else is guessable, and guessing is the failure this function was
  // written to remove. `ufo:mtyp:<sportId>-<marketType>` is a FEG key whose
  // numbers are a sport and a market type, not a line: reading them as a
  // corner band labelled a live MATCH_ODDS position `Cornere 00–00 · FT`,
  // a market nobody was betting on. The backend resolves those keys into
  // `family` (`src/scanner/market-contracts.mjs`), so returning nothing here is
  // what lets the authoritative name through.
  return undefined;
}

function baseMarketName(raw: RawOpportunity): string {
  return readMarketKey(raw.marketKey) ?? (raw.family ? familyNames[raw.family] : undefined) ?? 'Market';
}

/**
 * The market's name without its period suffix — the line applied, and the
 * subject allowed to overrule a key that disagrees with it.
 */
function subjectCorrectedBase(raw: RawOpportunity): string {
  const subject = raw.subject ? (subjectLabels[raw.subject.toLowerCase()] ?? raw.subject) : undefined;
  const base = baseMarketName(raw);
  const subjectKey = subject?.toLowerCase() ?? '';
  const subjectWins = Boolean(subject) && !base.toLowerCase().split(' ')[0].includes(subjectKey) && subjectKey !== 'goals';
  return subjectWins ? (subject as string) : base;
}

/**
 * Attach a line to a market name that may already carry one.
 */
function withLine(base: string, line?: string | number): string {
  if (line == null || line === '') return base;
  const text = String(line).trim();
  if (!text) return base;
  if (base.endsWith(` ${text}`)) return base;
  return `${base.replace(/\s+\d+(?:\.\d+)?$/, '')} ${text}`;
}

function labelledBase(raw: RawOpportunity): string {
  if (isSynthetic(raw.marketKey)) return subjectCorrectedBase(raw);
  return withLine(subjectCorrectedBase(raw), raw.line ?? undefined);
}

const teamSides: Record<string, string> = { home: 'Home', away: 'Away' };
function teamScope(raw: RawOpportunity): string | undefined {
  return raw.team ? teamSides[raw.team.toLowerCase()] : undefined;
}

function formatMarketName(raw: RawOpportunity): string {
  const period = raw.period === 'halftime' ? '1H' : raw.period === 'fulltime' ? 'FT' : raw.period?.toUpperCase();
  const scope = teamScope(raw);
  const labelled = scope ? `${scope} ${labelledBase(raw)}` : labelledBase(raw);
  return period ? `${labelled} · ${period}` : labelled;
}

/**
 * Clean raw bookmaker/catalog market labels into the canonical English phrases
 * recognised by `localizeMarketLabel`, without altering normalized scan contracts.
 */
export function canonicalizeRawMarketLabel(marketKey?: string, rawName?: string): string {
  const fromKey = readMarketKey(marketKey);
  const candidate = (rawName || marketKey || '').replace(/^(?:sb:\d+:|ufo:[a-z]+:)/i, '').trim();
  const isOutcomeCode = /^(?:1x2|12|1-2)$/i.test(candidate);
  const lineMatch = isOutcomeCode ? null : candidate.match(/(?:^|[\s_:])([+-]?\d+(?:\.\d+)?)\s*$/);
  const trailingLine = lineMatch ? lineMatch[1] : undefined;

  if (fromKey) {
    return trailingLine ? withLine(fromKey, trailingLine) : fromKey;
  }
  if (!candidate) return 'Market';

  const keyUpper = (marketKey || '')
    .replace(/^(?:sb:\d+:|ufo:[a-z]+:)/i, '')
    .toUpperCase()
    .trim();
  const upper = candidate
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (
    keyUpper === 'MRES' ||
    keyUpper === 'MR12' ||
    keyUpper === 'MRH1' ||
    keyUpper === 'MRH2' ||
    keyUpper === '547' ||
    keyUpper === 'DEFAULT' ||
    keyUpper === '00-00' ||
    keyUpper === 'MONEYLINE' ||
    keyUpper === 'MATCH_WINNER' ||
    keyUpper === 'HEAD_TO_HEAD' ||
    keyUpper === 'WINNER' ||
    keyUpper === 'WINNER_2WAY' ||
    keyUpper === 'HALF_WINNER' ||
    keyUpper === 'QUARTER_WINNER' ||
    keyUpper === 'PERIOD_WINNER' ||
    upper === '1X2' ||
    upper === 'FINAL' ||
    upper === 'REZULTAT FINAL' ||
    upper.startsWith('REZULTAT ') ||
    upper.includes('HALF RESULT') ||
    upper.includes('WYNIK POLOWY') ||
    upper === '12' ||
    upper === 'MRES' ||
    upper === 'MR12' ||
    upper === 'DEFAULT' ||
    upper === '547' ||
    upper === '1' ||
    upper === '00-00' ||
    upper === 'MONEYLINE' ||
    upper === 'MONEY LINE' ||
    upper === 'WINNER' ||
    upper.includes('CASTIGATOR MECI') ||
    upper.includes('WYNIK MECZU') ||
    upper.includes('ZWYCIEZCA')
  ) {
    return 'Match Result';
  }
  if (
    keyUpper === 'BTSC' ||
    keyUpper === 'BTH1' ||
    keyUpper === 'BTH2' ||
    keyUpper === 'BOTH_TEAMS_TO_SCORE' ||
    keyUpper === '00-1C' ||
    upper.includes('AMBELE ECHIPE') ||
    upper.includes('AMBELE MARCHEAZA') ||
    upper.includes('OBIE DRUZYNY') ||
    upper.includes('BOTH TEAMS') ||
    upper === 'GG/NG' ||
    upper === 'GG' ||
    upper === 'BTTS'
  ) {
    return 'Both Teams to Score';
  }
  if (
    keyUpper === 'DBLC' ||
    keyUpper === 'DCH1' ||
    keyUpper === 'DCH2' ||
    upper.includes('SANSA DUBLA') ||
    upper.includes('PODWOJNA SZANSA') ||
    upper.includes('DOUBLE CHANCE') ||
    upper === 'DC'
  ) {
    return 'Double Chance';
  }
  if (
    keyUpper === 'DNB' ||
    keyUpper === 'DNOB' ||
    keyUpper === 'DNH1' ||
    keyUpper === 'DNH2' ||
    keyUpper === 'DRAW_NO_BET' ||
    keyUpper === 'DRAW_NO_BET_2WAY' ||
    keyUpper === '00-03' ||
    upper.includes('FARA EGAL') ||
    upper.includes('BEZ REMISU') ||
    upper === 'DNB' ||
    upper.includes('DRAW NO BET')
  ) {
    return 'Draw No Bet (level)';
  }
  if (upper.includes('HANDICAP')) {
    return trailingLine ? `Asian Handicap ${trailingLine}` : 'Asian Handicap';
  }
  if (upper.includes('CORNERE') || upper.includes('CORNERS') || upper.includes('ROZNYCH')) {
    return trailingLine ? `Corners ${trailingLine}` : 'Corners';
  }
  if (upper.includes('CARTONASE') || upper.includes('CARDS') || upper.includes('KARTEK')) {
    return trailingLine ? `Total Cards ${trailingLine}` : 'Total Cards';
  }
  if (upper.includes('PUNCTE') || upper.includes('POINTS') || upper.includes('PUNKTOW')) {
    return trailingLine ? `Total Points ${trailingLine}` : 'Total Points';
  }
  if (upper.includes('GOLURI') || upper.includes('GOALS') || upper.includes('LICZBA GOLI') || upper.includes('SUMA GOLI')) {
    return trailingLine ? `Total Goals ${trailingLine}` : 'Total Goals';
  }
  if (upper.includes('GAME-URI') || upper.includes('GAMEURI') || upper.includes('GAMES') || upper.includes('GEMOW')) {
    return trailingLine ? `Total Games ${trailingLine}` : 'Total Games';
  }
  if (upper.includes('CASTIGATOR SET') || upper.includes('SET WINNER') || upper.includes('ZWYCIEZCA SETA')) {
    return 'Set Winner';
  }
  return candidate;
}

function inferType(raw: RawOpportunity, family: 'arb' | 'middle' | 'positive_ev'): OpportunityType {
  if (family === 'middle' || raw.type === 'middle') return 'middle';
  if (family === 'positive_ev' || raw.type === 'positive_ev') return 'positive_ev';
  return 'surebet';
}

function safety(raw: RawOpportunity): RuleSafetyResult {
  const status = raw.verification?.status;
  if (status === 'rejected') {
    return {
      isCompatible: false,
      severity: 'blocked',
      ruleMismatchReason: raw.verification?.reason ?? 'Backend verification rejected this contract.',
    };
  }
  if (status === 'confirmed') return { isCompatible: true, severity: 'safe' };
  if (raw.verification?.reason) {
    return { isCompatible: false, severity: 'warning', ruleMismatchReason: raw.verification.reason };
  }
  return { isCompatible: false, severity: 'unverified' };
}

function legLabel(leg: RawLeg, baseName: string, fallbackLine?: string | number, preferBase = false): string {
  const resolved = preferBase ? baseName : readMarketKey(leg.marketKey) ?? baseName;
  return withLine(resolved, leg.handicap ?? fallbackLine);
}

const acronyms = new Set(['fc', 'sc', 'afc', 'un', 'ut', 'cd', 'sd', 'ac', 'as', 'rc', 'ss', 'sk', 'if', 'bk', 'fk', 'gz', 'msk', 'sp', 'us', 'ud', 'sv', 'vfl', 'tsv', 'fsv', 'bsc', 'ce', 'nk', 'ol', 'ml']);
function titleTeam(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (acronyms.has(word.toLowerCase()) ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(' ');
}

function eventIdentity(eventKey?: string): { sportSlug?: string; homeTeam?: string; awayTeam?: string; kickoff?: string } {
  if (!eventKey) return {};
  const parts = eventKey.split('#')[0].split('|');
  if (parts.length < 4) return {};
  const [sportSlug, kickoff, home, away] = parts;
  return { sportSlug, kickoff, homeTeam: titleTeam(home), awayTeam: titleTeam(away) };
}

function normalize(raw: RawOpportunity, family: 'arb' | 'middle' | 'positive_ev', index: number, scannedAt?: string): ArbitrageOpportunity {
  const marketName = formatMarketName(raw);
  const baseName = subjectCorrectedBase(raw);
  const preferBase = !isSynthetic(raw.marketKey) && ((raw.legs ?? []).length > 1 || baseName !== baseMarketName(raw));
  const fallbackLine = isSynthetic(raw.marketKey) ? undefined : raw.line;
  const scope = teamScope(raw);
  const scopedBase = scope ? `${scope} ${baseName}` : baseName;
  const legs = (raw.legs ?? []).slice(0, 3).map((leg) => ({
    bookmakerId: leg.sourceId ?? 'unknown',
    bookmakerName: formatBookmakerName(leg.sourceId),
    selection: leg.selection ?? 'Selection',
    rawOdds: Number(leg.odds ?? 0),
    effectiveOdds: Number(leg.odds ?? 0),
    marketKey: leg.marketKey ?? raw.marketKey ?? 'unknown',
    marketName: legLabel(leg, scopedBase, fallbackLine, preferBase),
    deepLinkUrl: leg.eventUrl,
    liquidity: leg.liquidity,
    stake: leg.stake,
    payout: leg.payout,
  })) as ArbitrageOpportunity['legs'];

  const selection = raw.selection ?? raw.legs?.[0]?.selection;
  const id = raw.eventKey
    ? `${family}:${raw.eventKey}:${raw.marketKey ?? 'na'}:${selection ?? 'na'}:${index}`
    : `${family}:${index}`;
  const scannedAtMs = scannedAt ? Date.parse(scannedAt) : Date.now();
  const type = inferType(raw, family);
  const headline = type === 'positive_ev'
    ? (raw.evPercent ?? raw.marginPercent ?? 0)
    : type === 'middle'
      ? (raw.roiPercent ?? raw.marginPercent ?? 0)
      : (raw.marginPercent ?? 0);
  const identity = eventIdentity(raw.eventKey);
  const legImplied = Number(raw.odds) > 0 ? 1 / Number(raw.odds) : null;
  const consensus = raw.consensusProbability == null ? null : Number(raw.consensusProbability);
  const consensusRatio = legImplied && consensus && legImplied > 0 ? consensus / legImplied : null;
  const evConsensusSuspect = consensusRatio != null && (consensusRatio > 1.25 || consensusRatio < 1 / 1.25);
  const sportInput = raw.sport ?? identity.sportSlug;
  return {
    id,
    type,
    sport: normalizeSport(sportInput),
    rawSport: raw.sport ?? identity.sportSlug,
    eventKey: raw.eventKey,
    marketKey: raw.marketKey ?? raw.legs?.[0]?.marketKey,
    league: raw.league ?? '',
    homeTeam: raw.homeTeam ?? identity.homeTeam ?? 'Home',
    awayTeam: raw.awayTeam ?? identity.awayTeam ?? 'Away',
    startTime: raw.kickoff ?? identity.kickoff ?? new Date().toISOString(),
    isLive: Boolean(raw.live),
    profitPercent: Number(headline ?? 0),
    createdAt: scannedAtMs,
    lastUpdatedAt: scannedAtMs,
    legs,
    ruleSafety: safety(raw),
    ttlSeconds: raw.live ? 90 : 600,
    sourceCount: legs.length,
    marketName,
    scannedAt: scannedAtMs,
    roiPercent: raw.roiPercent,
    riskPercent: raw.riskPercent,
    gap: raw.gap,
    consensusProbability: raw.consensusProbability,
    evPercent: raw.evPercent,
    evConsensusSuspect,
    isArb: raw.arb,
    totalStake: raw.totalStake,
    guaranteedProfit: raw.guaranteedProfit,
    worstCasePayout: raw.worstCasePayout,
    rawTarget: raw,
  };
}

export function normalizeScan(scan: ScanPayload): ArbitrageOpportunity[] {
  return [
    ...(scan.opportunities ?? []).map((item, i) => normalize(item, 'arb', i, scan.scrapedAt)),
    ...(scan.middles ?? []).map((item, i) => normalize(item, 'middle', i, scan.scrapedAt)),
    ...(scan.positiveEv ?? []).map((item, i) => normalize(item, 'positive_ev', i, scan.scrapedAt)),
  ];
}

export function normalizeLowHold(scan: ScanPayload): LowHoldRow[] {
  return (scan.lowHold ?? []).map((raw, index) => {
    const marketName = formatMarketName(raw);
    const baseName = subjectCorrectedBase(raw);
    const identity = eventIdentity(raw.eventKey);
    const sportInput = raw.sport ?? identity.sportSlug;
    const legs: ArbLeg[] = (raw.legs ?? []).slice(0, 3).map((leg) => ({
      bookmakerId: leg.sourceId ?? 'unknown',
      bookmakerName: formatBookmakerName(leg.sourceId),
      selection: leg.selection ?? 'Selection',
      rawOdds: Number(leg.odds ?? 0),
      effectiveOdds: Number(leg.odds ?? 0),
      marketKey: leg.marketKey ?? raw.marketKey ?? 'unknown',
      marketName: legLabel(leg, baseName, raw.line, true),
      deepLinkUrl: leg.eventUrl,
      stake: leg.stake,
      payout: leg.payout,
    }));
    const hold = raw.holdPercent != null
      ? Number(raw.holdPercent)
      : raw.marginPercent != null
        ? Math.abs(Number(raw.marginPercent))
        : 0;
    return {
      id: raw.eventKey ? `lowhold:${raw.eventKey}:${raw.marketKey ?? 'na'}:${index}` : `lowhold:${index}`,
      sport: normalizeSport(sportInput),
      rawSport: raw.sport ?? identity.sportSlug,
      eventKey: raw.eventKey,
      marketKey: raw.marketKey,
      league: raw.league ?? '',
      homeTeam: raw.homeTeam ?? identity.homeTeam ?? 'Home',
      awayTeam: raw.awayTeam ?? identity.awayTeam ?? 'Away',
      startTime: raw.kickoff ?? identity.kickoff ?? new Date().toISOString(),
      isLive: Boolean(raw.live),
      marketName,
      holdPercent: hold,
      legs,
    };
  });
}

export interface BookActivity {
  bookmakerId: string;
  pricedLegs: number;
  opportunities: number;
}

export function bookActivity(opportunities: ArbitrageOpportunity[]): Map<string, BookActivity> {
  const activity = new Map<string, { legs: number; ids: Set<string> }>();
  for (const item of opportunities) {
    for (const leg of item.legs) {
      const entry = activity.get(leg.bookmakerId) ?? { legs: 0, ids: new Set<string>() };
      entry.legs += 1;
      entry.ids.add(item.id);
      activity.set(leg.bookmakerId, entry);
    }
  }
  const summary = new Map<string, BookActivity>();
  for (const [bookmakerId, entry] of activity) {
    summary.set(bookmakerId, { bookmakerId, pricedLegs: entry.legs, opportunities: entry.ids.size });
  }
  return summary;
}

// ---- Typed HTTP & SSE Client Gateway ---------------------------------------

let cachedCsrfToken: string | null = null;

async function ensureCsrfToken(forceRefresh = false): Promise<string> {
  if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;
  const csrfPath = ['/api', 'csrf'].join('/');
  const res = await fetch(csrfPath, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CSRF request failed (${res.status})`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('Missing CSRF token');
  cachedCsrfToken = data.token;
  return cachedCsrfToken;
}

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpointPath: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const needsCsrf = method !== 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (needsCsrf) headers['x-arbiter-token'] = await ensureCsrfToken(false);

  let response = await fetch(endpointPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (response.status === 403 && needsCsrf) {
    headers['x-arbiter-token'] = await ensureCsrfToken(true);
    response = await fetch(endpointPath, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      // ignore non-json error body
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function fetchScan(signal?: AbortSignal): Promise<{
  scan: ScanPayload;
  opportunities: ArbitrageOpportunity[];
  lowHold: LowHoldRow[];
  published: boolean;
}> {
  const response = await fetch('/api/scan', { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Scan request failed (${response.status})`);
  const scan = (await response.json()) as ScanPayload;
  return {
    scan,
    opportunities: normalizeScan(scan),
    lowHold: normalizeLowHold(scan),
    published: scan.published !== false,
  };
}

export async function runCustomScan(options: Record<string, unknown>): Promise<ScanPayload> {
  return apiRequest<ScanPayload>('POST', ['/api', 'scan'].join('/'), options);
}

const EXPORT_FAMILY_BY_TYPE: Record<string, string> = {
  surebet: 'opportunities',
  middle: 'middles',
  positive_ev: 'positiveEv',
  low_hold: 'lowHold',
};

export function buildScanExportUrl(params: {
  type?: string;
  sport?: string;
  q?: string;
  confirmedOnly?: boolean;
}): string {
  const search = new URLSearchParams();
  if (params.type && params.type !== 'all') {
    search.set('type', EXPORT_FAMILY_BY_TYPE[params.type] ?? params.type);
  }
  if (params.sport && params.sport !== 'all') search.set('sport', params.sport);
  if (params.q && params.q.trim()) search.set('q', params.q.trim());
  if (params.confirmedOnly) search.set('confirmed', '1');
  const qs = search.toString();
  const base = ['/api', 'scan', 'export.csv'].join('/');
  return qs ? `${base}?${qs}` : base;
}

export async function runVerification(targets?: unknown[]): Promise<{
  confirmed: number;
  rejected: number;
  expired: number;
  unconfirmed: number;
}> {
  return apiRequest('POST', ['/api', 'verify'].join('/'), targets ? { targets } : {});
}

export async function fetchScrapeState(): Promise<ScrapeState> {
  const data = await apiRequest<{ state: ScrapeState }>('GET', ['/api', 'scrape', 'state'].join('/'));
  return data.state;
}

export async function fetchLatestScrapeRun(): Promise<ScrapeRunReport> {
  return apiRequest<ScrapeRunReport>('GET', ['/api', 'scrape-run'].join('/'));
}

export async function startScrape(
  bookIds: string[],
  scanOptions: Record<string, unknown> = {},
): Promise<ScrapeState> {
  const data = await apiRequest<{ state: ScrapeState }>('POST', ['/api', 'scrape'].join('/'), {
    bookIds,
    scanOptions,
  });
  return data.state;
}

export async function cancelScrape(): Promise<{ cancelled: boolean }> {
  return apiRequest<{ cancelled: boolean }>('POST', ['/api', 'scrape', 'cancel'].join('/'), {});
}

export async function fetchScrapers(): Promise<{
  jobs: ScraperJob[];
  enabledJobs: ScraperJob[];
  validatedJobs: ScraperJob[];
  experimentalJobs: ScraperJob[];
}> {
  return apiRequest('GET', ['/api', 'scrapers'].join('/'));
}

export async function fetchSports(): Promise<SportOption[]> {
  const data = await apiRequest<{ sports: SportOption[] }>('GET', ['/api', 'sports'].join('/'));
  return data.sports ?? [];
}

export async function fetchProfiles(): Promise<ScanProfile[]> {
  const data = await apiRequest<{ profiles: ScanProfile[] }>('GET', ['/api', 'profiles'].join('/'));
  return data.profiles ?? [];
}

export async function fetchScheduler(): Promise<SchedulerStatus> {
  return apiRequest<SchedulerStatus>('GET', ['/api', 'scheduler'].join('/'));
}

export async function saveScheduler(payload: {
  enabled: boolean;
  intervalMinutes?: number;
  bookIds?: string[];
  scanOptions?: Record<string, unknown>;
}): Promise<SchedulerStatus> {
  return apiRequest<SchedulerStatus>('POST', ['/api', 'scheduler'].join('/'), payload);
}

export async function fetchLiveStatus(): Promise<LivePollStatus> {
  return apiRequest<LivePollStatus>('GET', ['/api', 'live'].join('/'));
}

export async function saveLiveStatus(payload: {
  enabled: boolean;
  intervalSeconds?: number;
  bookIds?: string[];
  scanOptions?: Record<string, unknown>;
}): Promise<LivePollStatus> {
  return apiRequest<LivePollStatus>('POST', ['/api', 'live'].join('/'), payload);
}

export async function fetchAlerts(): Promise<AlertPayload> {
  return apiRequest<AlertPayload>('GET', ['/api', 'alerts'].join('/'));
}

export async function saveAlerts(preferences: Partial<AlertPreferences>): Promise<AlertPayload> {
  return apiRequest<AlertPayload>('POST', ['/api', 'alerts'].join('/'), { preferences });
}

export async function fetchTracker(): Promise<TrackerPayload> {
  return apiRequest<TrackerPayload>('GET', ['/api', 'tracker'].join('/'));
}

export async function addTrackedBet(bet: {
  eventKey?: string;
  marketKey?: string;
  selection: string;
  sourceId: string;
  odds: number;
  stake: number;
  status?: 'pending' | 'won' | 'lost' | 'void';
  notes?: string;
  provenance?: 'scan' | 'import' | 'manual';
}): Promise<TrackedBet> {
  return apiRequest<TrackedBet>('POST', ['/api', 'tracker'].join('/'), bet);
}

export async function updateTrackedBet(
  id: string,
  patch: Partial<Pick<TrackedBet, 'status' | 'odds' | 'stake' | 'notes' | 'selection' | 'sourceId'>>,
): Promise<TrackedBet> {
  return apiRequest<TrackedBet>('PUT', `${['/api', 'tracker'].join('/')}/${encodeURIComponent(id)}`, patch);
}

export async function deleteTrackedBet(id: string): Promise<TrackerPayload> {
  return apiRequest<TrackerPayload>('DELETE', `${['/api', 'tracker'].join('/')}/${encodeURIComponent(id)}`);
}

export async function importTrackerCsv(csv: string): Promise<{ imported: number; skipped: number }> {
  return apiRequest<{ imported: number; skipped: number }>('POST', ['/api', 'tracker', 'import'].join('/'), { csv });
}

export function trackerExportUrl(): string {
  return ['/api', 'tracker', 'export.csv'].join('/');
}

export async function fetchCatalog(): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>('GET', ['/api', 'catalog'].join('/'));
}

export async function fetchEventDetail(params: {
  sport: string;
  home: string;
  away: string;
  kickoff?: string;
}): Promise<EventDetailBookEvent[]> {
  const search = new URLSearchParams();
  search.set('sport', params.sport);
  search.set('home', params.home);
  search.set('away', params.away);
  if (params.kickoff) search.set('kickoff', params.kickoff);
  const path = `${['/api', 'event-detail'].join('/')}?${search.toString()}`;
  const data = await apiRequest<{ events?: EventDetailBookEvent[] }>('GET', path);
  return data.events ?? [];
}

export function connectEvents(
  onEvent: (type: string, payload: unknown) => void,
  onState: (state: 'open' | 'reconnecting') => void,
): () => void {
  const source = new EventSource('/api/events');
  const types = [
    'scrape-update',
    'scan-update',
    'verify-start',
    'verify-batch-start',
    'verify-job-complete',
    'verify-batch-end',
    'verify-end',
  ];
  for (const type of types) {
    source.addEventListener(type, (event) => {
      try {
        onEvent(type, JSON.parse((event as MessageEvent).data));
      } catch {
        /* ignore malformed server frames */
      }
    });
  }
  source.onopen = () => onState('open');
  source.onerror = () => onState('reconnecting');
  return () => source.close();
}
