# Arbiter Frontend Shell Implementation Plan

## Goal

Deliver a Vite + React 19 + strict TypeScript frontend shell served by the existing Node server, with trustworthy surebet, middle, and positive-EV workflows and no billing mutations.

## Phase 1: Foundation

1. Add frontend toolchain and scripts:
   - Vite
   - React 19
   - TypeScript
   - Zustand
   - TanStack Virtual
   - Lucide React
   - Tailwind v4 or token-compatible CSS pipeline
2. Add `frontend/` source tree and `vite.config.ts`.
3. Add strict `tsconfig.json` scoped to frontend sources.
4. Add `frontend/index.html` and a compatibility build output path.
5. Add typed route/app shell entry point.
6. Preserve current public pages while the new shell is developed.

Acceptance:

- `npm run build:frontend` emits static assets.
- Existing `npm test` and `npm run lint` remain clean.
- Existing Node server continues serving legacy pages.

## Phase 2: Contracts and Gateway

1. Add frontend domain contracts from the approved spec.
2. Add typed API gateway for current backend routes.
3. Add SSE connection adapter with exponential backoff and stale-state classification.
4. Add fixture payloads derived from existing scan and scrape test data.
5. Add gateway validation tests.

Acceptance:

- Existing scan payloads normalize without data loss.
- Disconnected and stale states are explicit.
- No frontend component imports raw `fetch` or SSE parsing directly.

## Phase 3: State and Worker Data Plane

1. Add Zustand slices:
   - `oddsStreamStore`
   - `calculatorStore`
   - `filterStore`
   - `userPreferencesStore`
2. Add worker protocol and worker entry point.
3. Move delta application, TTL classification, surebet repricing, middle scenarios, positive-EV calculations, and rounding scenarios into the worker.
4. Add unit tests for every math family and worker message.

Acceptance:

- Worker output is deterministic for fixed fixtures.
- Main thread does not parse or recalculate large snapshots.
- Math distinguishes guaranteed profit from conditional middle and positive EV.

## Phase 4: Shell and Navigation

1. Build responsive `AppShell`.
2. Add route model for dashboard, arbitrage, scanner, live, bookmakers, analytics, settings, and account.
3. Add connection indicator, command palette, keyboard help, theme tokens, and responsive navigation.
4. Add capability-state primitives for future plans without billing writes.

Acceptance:

- All intended routes render in the new shell.
- Keyboard navigation and mobile layout are usable.
- Account/plan surfaces are read-only.

## Phase 5: Workstation

1. Build virtualized stream.
2. Build compact row and expanded card renderers.
3. Add filters and scan profiles.
4. Add freshness TTL and expiry dissolve states.
5. Add odds diff flashes with reduced-motion support.
6. Add safety shields and blocked opportunities.
7. Add surebet, middle, and positive-EV tabs.

Acceptance:

- 500+ fixture opportunities render with bounded DOM size.
- Filter changes do not re-render unrelated rows.
- Expired opportunities remain visible briefly and cannot be actioned.
- Blocked rule mismatches never appear executable.

## Phase 6: Execution Slip

1. Add selected-opportunity dock/sheet.
2. Add total stake and currency controls.
3. Add exact, round-to-5, round-to-10, and smart-integer rounding.
4. Add worst-case/best-case return display.
5. Add exchange commission, liability, and liquidity warnings.
6. Add deep-link and copy actions.
7. Add reprice-before-launch warning when the selected snapshot is stale.

Acceptance:

- Every displayed stake sums correctly after rounding.
- Worst-case and best-case values are mathematically reproducible.
- External links are opened only by explicit user action.

## Phase 7: Supporting Surfaces

1. Dashboard health and opportunity summary.
2. Scanner and live monitoring.
3. Bookmaker matrix and settlement metadata.
4. Analytics and opportunity history.
5. Settings and notification preferences.
6. Read-only account/capability surface.

Acceptance:

- Supporting pages use the same gateway and state model.
- Feed health and stale data are visible consistently.
- No page relies on legacy global DOM helpers.

## Phase 8: Hardening

1. Add accessibility coverage.
2. Add responsive browser tests.
3. Add performance profiling for worker and virtual list.
4. Add production build smoke test.
5. Add compatibility route tests.
6. Update deployment/start documentation.
7. Remove legacy pages only after route parity is proven.

Acceptance:

- Full unit/integration/browser suite passes.
- `npm run build:frontend` succeeds.
- `npm test` and `npm run lint` pass.
- Existing backend route behavior is unchanged.
- Production static assets are served by the current Node server.

## File Ownership Boundaries

- `frontend/`: new React application only.
- `src/`: backend changes only when required for typed gateway compatibility.
- `public/`: legacy compatibility assets until migration completion.
- `test/frontend/`: frontend unit and integration tests.
- `docs/superpowers/specs/`: approved architecture.
- `docs/superpowers/plans/`: implementation plan and progress notes.

## Risk Controls

- No destructive replacement of the current frontend before parity.
- No billing provider or subscription mutations.
- No client-side override of backend safety decisions.
- No credentials or bookmaker secrets in frontend code.
- Keep frontend fixtures synthetic or derived from existing non-secret captures.
