# React Operator UI Consolidation Design

**Status:** Approved design

**Date:** 2026-11-04

## Objective

Make the React/Vite application served from `/app/` the sole Arbiter operator interface. Migrate the remaining useful functionality from the legacy static pages under `public/admin/*` into React, use one typed React API gateway, and retain old `/admin/*.html` URLs only as loopback-protected compatibility redirects after the corresponding React feature has verified parity.

This eliminates duplicated presentation, translation, client-side API assumptions, tests, and navigation while preserving the existing Node backend, local-first deployment model, API contracts, CSRF protection, SSE updates, and loopback-only operator security.

## Current State

The React shell already provides:

- Dashboard
- Opportunities/workstation
- Scanner with scrape launch, cancellation, progress, profiles, source selection, re-scan, verification, scheduler controls, and live-poll controls
- Bookmakers source matrix
- Analytics tracker, market catalog, and coverage
- Settings for local preferences and alert thresholds

The legacy pages still expose or duplicate capabilities through separate HTML, CSS, i18n, and page-script stacks:

- `public/admin/scrape.html`: detailed scrape operations, pipeline/log/history, scheduler/live configuration, and per-book odds board
- `public/admin/live.html`: live engine monitoring and price events
- `public/admin/arbitrage.html`, `public/index.html`, `public/admin/workstation.html`: legacy opportunity presentation and old entry points
- `public/admin/bookies.html`: bookmaker presentation and configuration affordances
- `public/admin/analytics.html`: tracker, catalog, and event coverage
- `public/admin/scanner.html`: manual scan, verification, and alert controls
- `public/admin/settings.html`: scanner/scheduler/source preferences and presentation preferences
- `public/admin/ai.html`: deterministic scan-derived insights
- `public/admin/login.html`: local-only access explanation

## Product Decision

React is the only rendered operator UI. The legacy static pages are not a fallback interface and will not remain user-navigable after their features reach React parity.

The server retains legacy paths for existing bookmarks and Electron/deep-link compatibility. Each is protected by the current `/admin` loopback guard and redirects only after all feature-parity acceptance criteria for its destination are satisfied.

## Information Architecture

The React shell navigation becomes:

1. Dashboard
2. Opportunities
3. Scanner
4. Live
5. Bookmakers
6. Analytics
7. Insights
8. Settings

### Dashboard and Opportunities

Dashboard remains the operational summary. Opportunities remains the actionable scanner result terminal, including execution slip, market comparison, filtering, CSV export, safety state, and freshness state.

These workspaces replace the old dashboard, arbitrage terminal, and workstation presentations.

### Scanner

Scanner is the authoritative control center for batch collection and scan operations. It owns:

- scan profile selection
- sport, event limit, bankroll, minimum margin, minimum EV, middle-risk, middle-ROI, include-live, and include-past scan options
- validated or custom bookmaker selection
- scrape launch and cancellation
- active job progress, error information, stage progress, and latest run summary
- latest run history and operational log
- re-scan and re-verification actions
- scheduler configuration
- live-poll configuration
- per-book odds explorer, including bookmaker, event, market, and limit filters

The existing monolithic `ScannerWorkspace` is split into focused React components so controls, run telemetry, automation controls, and price browsing can be tested independently.

### Live

Live is the dedicated in-play monitoring workspace. It reads and writes the same live configuration managed in Scanner; it must not create a second live-preference model.

It owns:

- live-engine status and last poll time
- poll interval and configured bookmaker scope
- current in-play signals from the published scan
- bounded, refreshable per-book price-event display

The UI exposes only backend-supported actions. If the backend has no explicit one-shot live-poll endpoint, the page must state that the next configured poll performs collection rather than presenting a misleading “Poll now” action.

### Bookmakers

Bookmakers remains the source matrix for coverage, freshness, live capability, rule metadata, shared-feed/clone status, source health, opportunities, and single-book scraping.

It gains only safe detail actions available through supported routes, such as raw capture download. A legacy UI control that writes scraper configuration is not replicated until the backend has an explicit validated mutation contract. Configuration editing otherwise remains a documented development workflow, not an unsafe browser file editor.

### Analytics

Analytics retains:

- local bet tracker and settlement controls
- CSV import/export
- position grouping
- opportunity breakdowns
- market catalog
- event coverage

### Insights

Insights replaces the legacy `ai.html` page. It is explicitly deterministic and scan-derived, never presented as a separate generative-AI system. It displays scan data health and derived findings from the normalized published scan.

### Settings

Settings owns operator-local and alert preferences only:

- bankroll and rounding defaults
- theme and language
- audio/notification preferences
- alert thresholds and quiet hours
- guide visibility

Scanner engine, scheduler, live-poll, and source-operation controls belong in Scanner, so operational configuration is not split between two pages.

### Local Access

A minimal React local-access view replaces the informational legacy login page. It explains the loopback-only security boundary, does not claim remote authentication, and links to the Scanner control center.

## Canonical Client Boundary

`frontend/src/api.ts` is the sole browser API gateway for React. React components and stores must not make direct `fetch` or `EventSource` calls outside the gateway.

The gateway retains its existing responsibilities:

- typed response normalization
- CSRF token retrieval and retry for mutations
- scan, scrape, scheduler, live, tracker, alerts, catalog, scrapers, sports, profiles, and SSE access

It adds typed interfaces for remaining legacy-only reads:

- `fetchBookOdds(bookId, filters)` for `/api/odds/:book`
- bounded price-event data derived from the same odds read
- normalized deterministic scan-insight selectors

No backend route changes are required for this consolidation. API behavior, CSRF headers, SSE event types, local-only request checks, and admin loopback protection remain authoritative backend contracts.

## Legacy Compatibility Routes

After the destination workspace satisfies its parity gate, the old path redirects to its React hash route:

| Legacy path | React destination |
|---|---|
| `/` and `/index.html` | `/app/#dashboard` |
| `/admin/workstation.html` and `/admin/arbitrage.html` | `/app/#opportunities` |
| `/admin/scanner.html` and `/admin/scrape.html` | `/app/#scanner` |
| `/admin/live.html` | `/app/#live` |
| `/admin/bookies.html` | `/app/#bookmakers` |
| `/admin/analytics.html` | `/app/#analytics` |
| `/admin/ai.html` | `/app/#insights` |
| `/admin/settings.html` | `/app/#settings` |
| `/admin/login.html` | `/app/#local-access` |

Requirements:

- `/admin/*` guards stay in `router.mjs`; non-loopback callers continue to receive the existing concealment 404 rather than a redirect.
- Redirects use `302` plus `Cache-Control: no-store`.
- Meaningful legacy query parameters are translated to React route/filter state; unsupported parameters are ignored safely.
- React UI and public root content must not link to a legacy `/admin/*` page.
- Static legacy files can remain on disk temporarily, but they must no longer be served as active application pages after their redirect is enabled.

## Feature-Parity Gates

A legacy page may redirect only when each condition below is demonstrated for its React destination:

1. **Capability parity:** every user-visible data view and supported operation exists in React, or has a documented intentional retirement reason.
2. **Canonical client:** all React network access for the capability passes through `frontend/src/api.ts`.
3. **State coverage:** loading, empty, disconnected/stale, permission/security, mutation-in-progress, and mutation-failure states are implemented where applicable.
4. **Test coverage:** focused component or integration tests cover successful read/mutation flows and relevant error/empty paths.
5. **Compatibility coverage:** router tests prove that loopback legacy requests redirect to the intended React route and off-loopback requests remain concealed with 404.
6. **No reverse navigation:** no remaining React or public page link targets that legacy route.

## Feature Mapping and Acceptance Criteria

### `scrape.html` to Scanner

React Scanner must provide the legacy page’s operational capabilities: full scan option set, source selection and filtering, start/cancel, progress, stage/activity status, current and last-run job details, log/history, scheduler, live-poll configuration, verification totals, and per-book odds board.

The Scanner can present the same information in a different layout. Its contract is operational completeness, not pixel equivalence.

### `live.html` to Live

React Live must show engine state, poll interval, last poll/run state, live-signal count and cards, configured books, and bounded source price events. It must clearly represent unavailable or stale live state.

### `arbitrage.html`, `workstation.html`, and root dashboard to Dashboard/Opportunities

React must remain the source for opportunity summaries, surebets, middles, positive EV, low hold, CSV export, bankroll-aware calculations, confirmation/safety display, event detail, comparison, and execution preparation.

### `bookies.html` to Bookmakers

React must preserve bookmaker/source status, event and opportunity context, validation/live capability, shared feed indicators, details, and safe single-source collection. Unsupported legacy configuration writes are intentionally retired until a safe server mutation exists.

### `analytics.html` to Analytics

React must preserve tracker CRUD, settlement, import/export, catalog filtering, event-coverage filtering, and navigation to relevant opportunities.

### `scanner.html` to Scanner and Settings

React must preserve manual re-scan, verification, alert preference configuration, scan-health/verification visibility, data exports, and signal navigation. Alert policy belongs in Settings; operational scan controls belong in Scanner.

### `settings.html` to Scanner and Settings

React must preserve supported scheduler/source/scan settings and user-display settings. Any destructive operation without a dedicated backend mutation remains an explanatory command/help state rather than a fake browser action.

### `ai.html` to Insights

React must preserve deterministic scan health and findings, visibly labelled as scan-derived.

### `login.html` to Local Access

React must preserve the local-only access explanation and safe entry point. It does not implement an authentication flow that the backend does not provide.

## Failure Handling

- API errors are rendered through the React notification system with an actionable explanation.
- Mutations disable their initiating control while in flight and restore it on completion or failure.
- A stale or disconnected SSE state remains visibly distinct from healthy live data.
- Live and odds tables are bounded to avoid unbounded rendering or network load.
- The React UI never implies a scan, poll, scrape, or configuration write succeeded unless the corresponding API mutation returns successfully.
- Unsupported legacy behavior is explicitly documented rather than imitated by inert controls.

## Testing Strategy

### Client and domain tests

- CSRF acquisition and retry behavior
- scan/scrape option serialization
- bookmaker odds query construction and normalization
- normalized insights derivation
- legacy query-to-React-state translation

### Component and integration tests

- Scanner launch, cancellation, full option selection, progress, job failures, run history, schedule/live saves, and odds board
- Live healthy/stale/disabled/error states and bounded price-event display
- Bookmakers source actions and safe detail/download behavior
- Analytics tracker/catalog/coverage workflows
- Insights deterministic data-health and empty state
- Settings alert preference save/failure and local-access messaging

### Router tests

- root redirects to the React dashboard
- each loopback `/admin/*.html` compatibility URL redirects to the declared React route after its parity gate is enabled
- all `/admin/*` requests from non-loopback callers remain 404
- redirects have `Cache-Control: no-store`

### Architecture and regression tests

- a consumer census asserts React features use the API gateway rather than direct browser network calls
- no React/public navigation links point at active legacy pages
- legacy page scripts do not receive new features
- `npm run typecheck`
- `npm run build:frontend`
- focused migration tests, then `npm test`

The current full-suite baseline is not green and must be repaired separately as part of hardening: the observed failures include a missing `BetfairScraper` export, TypeScript syntax parsed as plain JavaScript in a frontend-stakes test, and code-only tokenizer failures affecting export-reader/reachability checks. A redirect or migration test is not sufficient evidence until these baseline failures are resolved and the full suite passes.

## Delivery Order

1. Stabilize React shell routing and add the Live, Insights, and Local Access views.
2. Extract remaining typed API gateway functionality and add client tests.
3. Expand Scanner into the complete scrape-control workspace, including odds board and run history/log.
4. Complete Live, Bookmakers, Analytics, and Settings parity gaps.
5. Add route compatibility mapping only for completed workspace groups.
6. Remove React/public links to legacy pages and freeze legacy scripts.
7. Repair current baseline test failures, run full verification, and then remove obsolete legacy assets in a separately reviewed cleanup change.

## Non-Goals

- Changing backend scan, scraper, verification, scheduler, tracker, or alert business logic
- Adding remote authentication or exposing operator controls beyond loopback
- Automatic wager placement, credential storage, or bookmaker-control bypass
- Replicating unsafe legacy configuration editing without a validated server-side mutation contract
- Deleting every legacy asset in the same change as feature migration
