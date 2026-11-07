# Arbiter Frontend Shell Design

## Status

Approved architectural direction. This document defines the frontend phase before billing and subscription mutations.

## Objective

Rebuild the Arbiter frontend as a production-oriented Vite + React 19 application while preserving the existing Node server, backend routes, authentication behavior, scraper orchestration, SSE state updates, and local-first deployment shape.

The first release prioritizes trustworthy, actionable presentation of:

- Real surebets
- Real middles
- Positive-EV opportunities
- Correct stake, return, and rounding mathematics
- Settlement-rule safety
- Freshness and expiry handling
- A coherent product shell ready to add plans and entitlements later

No payment provider, checkout mutation, subscription mutation, or billing webhook is included in this phase.

## Product Principles

1. **Trust before excitement**: every opportunity shows freshness, source state, market contract, and safety status before profit emphasis.
2. **Execution over inspection**: selecting an opportunity immediately opens a calculator with leg-level stakes, returns, deep links, and copy actions.
3. **Guaranteed profit is not expected value**: surebets, middles, and positive-EV opportunities are separate product classes with distinct math and risk language.
4. **Stale data is visible**: expired opportunities dissolve instead of disappearing silently; disconnected feeds cannot look healthy.
5. **Backend truth is authoritative**: client workers may reprice, filter, and model scenarios, but cannot invent or override server contract decisions.
6. **Subscription-ready, not subscription-active**: capabilities and plan surfaces are modeled as UI state, without billing side effects.

## Runtime and Migration

### Runtime

- Vite
- React 19
- Strict TypeScript
- Static production build served by the existing Node server
- Existing backend URLs and API/SSE contracts preserved behind a typed client gateway

### Migration

The current vanilla pages remain the compatibility reference during migration. The new shell is introduced behind the existing authenticated application entry points, with route-level replacement in this order:

1. Shared app shell and authentication boundary
2. Dashboard and connection state
3. Arbitrage workstation
4. Scanner and live monitoring
5. Bookmakers and feed health
6. Analytics and settings
7. Account and future plan surfaces

The migration must not remove a legacy route until its React replacement has equivalent backend behavior and test coverage.

## Information Architecture

### Shared Shell

- Responsive sidebar navigation
- Active scan and connection indicators
- Command palette
- Keyboard shortcut help
- User/account context
- Theme and density preferences
- Global notification mute state

### Dashboard

- Scan health and freshness summary
- Opportunity counts by class: surebet, middle, positive EV
- Highest-quality current opportunities
- Feed health and stale-source warnings
- Recent activity and expired opportunity rate

### Arbitrage Workstation

Primary real-time surface with:

- Dense stream view
- Expanded card view
- Virtualized opportunity list
- Sport, league, market, bookmaker, profit, freshness, and safety filters
- Selected-opportunity execution slip
- Surebet, middle, and positive-EV tabs

### Scanner and Live

- Scan profile controls
- Current scrape progress
- Live feed health
- In-play opportunity stream
- Source-level latency and error state

### Bookmakers

- Enabled bookmaker matrix
- Commission settings
- Settlement-rule metadata
- Feed status and last-seen time
- Grouped/shared-feed indicators

### Analytics

- Opportunity history
- Stale/broken rate
- Profit distribution
- Feed reliability
- Exposure and rounding outcomes

### Settings and Account

- Currency and stake defaults
- Smart rounding preferences
- Rule-safety preferences
- Notification and sound controls
- Future plan/capability display with locked-feature states

## Visual System

The UI uses a high-contrast trading-terminal language without copying Bloomberg literally:

- Background: `#0B0E14`
- Elevated surfaces: `#121824`, `#1A2234`
- Primary text: cool white and slate hierarchy
- Profit emerald: `#10B981`
- Hazard amber: `#F59E0B`
- Error/expired rose: `#F43F5E`
- Exchange accent: `#8B5CF6`
- Monospace numerals for odds, prices, timestamps, and stake values
- Expressive display type for section headings, restrained utility type for dense data
- Layered surfaces, grid lines, subtle gradients, and short state transitions

Responsive behavior:

- Desktop: three-zone shell with navigation, stream, and execution slip
- Tablet: collapsible navigation and docked execution slip
- Mobile: bottom navigation, stacked cards, execution slip as a full-height sheet

## Frontend Contracts

```ts
export type Sport = 'football' | 'tennis' | 'basketball' | 'hockey';

export type TennisRule = 'one_ball' | 'one_set' | 'match_completion';
export type OvertimeRule = 'includes_ot' | 'regulation_only' | 'includes_ot_so';

export interface BookmakerMetadata {
  id: string;
  name: string;
  commission: number;
  rules: {
    tennis_retirement: TennisRule;
    basketball_2way: OvertimeRule;
    hockey_2way: OvertimeRule;
  };
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
}

export interface RuleSafetyResult {
  isCompatible: boolean;
  severity: 'safe' | 'warning' | 'blocked';
  ruleMismatchReason?: string;
}

export interface ArbitrageOpportunity {
  id: string;
  sport: Sport;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  isLive: boolean;
  profitPercent: number;
  palpableErrorRisk: boolean;
  createdAt: number;
  lastUpdatedAt: number;
  legs: [ArbLeg, ArbLeg] | [ArbLeg, ArbLeg, ArbLeg];
  ruleSafety: RuleSafetyResult;
}

export interface StakeCalculation {
  legStakes: number[];
  roundedStakes: number[];
  individualReturns: number[];
  worstCaseProfit: number;
  worstCaseRoi: number;
  isRounded: boolean;
}
```

The gateway also defines discriminated opportunity classes:

- `surebet`: inverse-odds sum below one, complete compatible settlement space
- `middle`: compatible line overlap with explicit outcome scenarios
- `positive_ev`: probability/price edge, never labeled guaranteed profit

## Data Flow

1. Existing backend publishes scan and odds state through its current API/SSE surface.
2. `clientGateway` validates and normalizes payloads into typed frontend contracts.
3. `oddsStreamStore` receives immutable snapshots and deltas.
4. A dedicated Web Worker applies deltas, computes freshness, recalculates visible opportunities, and emits compact view models.
5. `filterStore` applies user filters before React rendering.
6. TanStack Virtual renders only the visible stream window.
7. `calculatorStore` receives the selected opportunity and calculates exact and rounded scenarios.
8. UI displays server safety decisions and worker-derived freshness/calculation state separately.

Connection behavior:

- SSE/WebSocket reconnect with exponential backoff and jitter
- Visible `connected`, `reconnecting`, `stale`, and `failed` states
- Last-good snapshot remains visible but is explicitly marked stale
- No stale opportunity can show as executable without a freshness warning

## Worker Responsibilities

The worker owns CPU-heavy, deterministic calculations:

- Odds delta application
- Opportunity indexing by event and market
- Surebet inverse-sum calculations
- Middle scenario calculations
- Positive-EV calculations from supplied probabilities
- Commission-adjusted exchange odds
- TTL classification
- Filter precomputation
- Stake rounding scenario generation

The worker never performs network requests, launches bookmaker links, or mutates account state.

## Workstation Modules

### Opportunity Stream

Each row/card includes:

- Sport and league
- Live or pre-match kickoff state
- TTL decay bar
- Canonical match title and optional raw-name disclosure
- Market contract badge
- Opportunity-class badge
- Profit/edge pill
- Palpable-error hazard when profit exceeds configured threshold
- Leg cards with bookmaker, selection, raw odds, effective odds, commission, and liquidity
- Rule-safety shield

State transitions:

- Improved odds: green cell flash
- Worsened odds: amber/red flash
- Broken opportunity: 1.5-second faded, struck-through tombstone before removal
- Disconnected source: muted source badge and stale timestamp

### Execution Slip

- Selected opportunity summary
- Total stake and currency
- Quick increments
- Exact, round-to-5, round-to-10, and smart-integer modes
- Per-leg stake and return
- Worst-case and best-case result after rounding
- Exchange commission and liability fields
- Available-liquidity warning
- Deep-link and copy actions
- Explicit stale/reprice state before launch

The slip never claims a successful wager. It only prepares calculations and opens user-selected external links.

### Safety Matrix

Rules are evaluated before an opportunity becomes actionable.

- Tennis retirement mismatch: warning or blocked based on backend severity
- Basketball/hockey overtime/regulation mismatch: blocked
- Unknown settlement rule: warning or blocked, never silently safe
- Exchange liquidity below required stake: warning
- Missing leg, invalid odds, or unsupported market contract: blocked

### Filters and Profiles

Initial profiles:

- Strict Safe
- Romanian Softs Only
- Exchange Hedges
- Live Sniping

Filter state is persisted locally and includes bookmaker matrix, sports, market families, profit bounds, class selection, and rule-safety preference.

### Notifications

- Web Audio API synthesized tones only
- Standard new opportunity click
- Higher-priority ping above configurable profit threshold
- Global mute and `M` shortcut
- Title ticker with opportunity count and maximum current value

## Error and Empty States

Every module must define:

- Initial loading
- No data yet
- No matching filters
- Stale data
- Reconnecting
- Failed source
- Invalid opportunity
- Unsupported market
- Mobile overflow behavior

Errors should explain the operator action, not only expose an exception string.

## Accessibility and Performance

- Keyboard navigable stream, filters, slip, and dialogs
- Visible focus states
- Reduced-motion mode disables flashes and dissolve animations
- ARIA labels for odds cells, hazard shields, and TTL bars
- Virtualized rendering for 500+ opportunities
- No per-update full-list React render
- Worker messages use compact typed payloads
- Performance targets: 60 FPS interaction, bounded DOM node count, no synchronous parsing of large snapshots on the main thread

## Testing Strategy

### Unit

- Contract validation and normalization
- Surebet/middle/positive-EV math
- Commission calculations
- Smart rounding and worst-case return calculations
- Tennis and overtime rule matrix
- TTL and expiry transitions

### Component

- Opportunity row/card state transitions
- Filter profiles
- Execution slip calculations
- Warning and blocked states
- Responsive navigation and mobile slip

### Integration

- Existing API/SSE payloads through the typed gateway
- Worker message protocol
- Selected opportunity flow from stream to slip
- Reconnect and stale-state handling

### Browser

- Full navigation shell
- Keyboard workflows
- Virtualized stream scrolling
- Mobile viewport layouts
- Screenshot checks for dense and expanded workstation views

## Non-Goals

- Payment provider integration
- Checkout or subscription mutation
- Automated bookmaker bet placement
- Credential storage
- Bypassing bookmaker controls
- Replacing backend market-contract validation with client-only logic
- Claiming that an external bookmaker link was successfully placed

## Delivery Phases

1. Foundation: Vite, React, TypeScript, design tokens, routing, app shell, gateway types
2. Data plane: stores, SSE adapter, worker protocol, normalized fixtures
3. Workstation: stream, virtualization, filters, opportunity cards, freshness states
4. Execution: calculator, rounding, exchange fields, deep links, copy actions
5. Safety: settlement matrix, warnings, blocked states, positive-EV/middle views
6. Product surfaces: dashboard, bookmakers, live, analytics, settings, account/capability states
7. Hardening: accessibility, responsive QA, performance profiling, regression coverage, production build
