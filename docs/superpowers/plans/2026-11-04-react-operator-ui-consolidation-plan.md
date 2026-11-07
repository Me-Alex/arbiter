# React Operator UI Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/app/` the sole Arbiter operator UI by completing React parity for legacy admin capabilities and turning protected legacy routes into tested compatibility redirects.

**Architecture:** Keep the Node backend and its API/SSE contracts unchanged. Add the remaining React workspaces and use `frontend/src/api.ts` as the exclusive browser boundary; expand Scanner into the operational control centre; then map legacy URLs in `src/router.mjs` to React hash routes only after React parity tests are in place.

**Tech Stack:** Node 20 ESM, native `node:test`, React 19, TypeScript, Vite, Zustand, TanStack Virtual, Playwright, existing Node HTTP router.

---

## Preconditions and completion criteria

Run implementation in an isolated worktree. Do not discard the substantial pre-existing working-tree changes in the source checkout.

The work is complete only when all of the following are evidenced:

1. React has Dashboard, Opportunities, Scanner, Live, Bookmakers, Analytics, Insights, Settings, and a non-navigation Local Access route.
2. Scanner contains the supported controls from legacy `scrape.html` and `scanner.html`, including full scan options, progress/history, automation, and a per-book odds board.
3. Live, Insights, Settings, Bookmakers, and Analytics cover the retained behavior from their legacy counterparts.
4. No React component bypasses `frontend/src/api.ts` for `fetch` or `EventSource`.
5. Every active legacy `/admin/*.html` path remains loopback-protected and redirects to its approved React route; `/` and `/index.html` redirect to Dashboard.
6. React and the public root do not link back to `/admin/*`.
7. `npm run typecheck`, `npm run build:frontend`, migration-focused tests, and the full `npm test` suite pass.

## File ownership map

| File | Responsibility |
|---|---|
| `frontend/src/workspace.ts` | Hash routes, view metadata, legacy-compatible route-query parsing, terminal classification |
| `frontend/src/App.tsx` | Shell navigation and workspace composition; no feature-specific API calls |
| `frontend/src/api.ts` | The only React HTTP/SSE boundary; typed odds, snapshot, and existing API access |
| `frontend/src/domain.ts` | Browser-facing contracts for scan, odds, alerts, and live state |
| `frontend/src/stores.ts` | Shared scan/SSE state and bounded operation activity timeline |
| `frontend/src/scanner-options.ts` | Pure scan-form defaults, profile application, validation, and request construction |
| `frontend/src/OddsBoard.tsx` | Bounded, cancellation-safe per-book odds browser used by Scanner and Live |
| `frontend/src/ScannerWorkspace.tsx` | Top-level composition of scrape control, run status, automation, and odds board |
| `frontend/src/LiveWorkspace.tsx` | Dedicated live engine state, current live signals, and live price board |
| `frontend/src/InsightsWorkspace.tsx` | Deterministic scan-derived health and verified-signal summaries |
| `frontend/src/LocalAccessWorkspace.tsx` | Local-only access/security explanation and Scanner entry point |
| `frontend/src/BookmakersWorkspace.tsx` | Source matrix and safe snapshot downloads/single-book scrape actions |
| `frontend/src/SettingsWorkspace.tsx` | Local preferences and server-backed alert preferences only |
| `frontend/src/styles.css` | Shared React styles for new workspaces; no legacy stylesheet imports |
| `src/router.mjs` | Compatibility redirect map and existing loopback enforcement |
| `test/frontend-operator-ui.test.mjs` | Pure route, gateway, scan-option, and deterministic insight behavior |
| `test/legacy-ui-retirement.test.mjs` | Compatibility-route map and no-reverse-navigation evidence |
| `test/router.test.mjs` | Real router behavior for loopback redirects and non-loopback concealment |
| `test/app-shell.browser.test.mjs` | Browser rendering and interaction coverage across every React workspace |

---

### Task 1: Restore a green baseline before changing UI behavior

**Files:**
- Modify: `src/scrapers/betfair.mjs:110`
- Modify: `test/frontend-stakes.test.mjs:47`
- Test: `test/engine-flawless.test.mjs`
- Test: `test/frontend-stakes.test.mjs`
- Test: `test/export-readers.test.mjs`
- Test: `test/reachability.test.mjs`

- [ ] **Step 1: Run each currently failing focused test and record its baseline failure**

Run:

```bash
cd /e/AI\ Folder\ Projects/arbiter
node --test test/engine-flawless.test.mjs
node --test test/frontend-stakes.test.mjs test/export-readers.test.mjs test/reachability.test.mjs
```

Expected before the fix:

```text
SyntaxError: The requested module '../src/scrapers/betfair.mjs' does not provide an export named 'BetfairScraper'
SyntaxError: Unexpected identifier 'as'
Error: could not tokenize import { test } from 'node:test'; import assert from 'node:a
```

- [ ] **Step 2: Add the named Betfair export without removing the default integration export**

Change the class declaration in `src/scrapers/betfair.mjs` from:

```js
export default class BetfairScraper extends ScraperBase {
```

to:

```js
export class BetfairScraper extends ScraperBase {
```

Append this exact compatibility export after the closing class brace:

```js
export default BetfairScraper;
```

This preserves callers that use the default scraper registry while satisfying the named import used by the engine regression suite.

- [ ] **Step 3: Remove TypeScript-only syntax from the JavaScript test file**

In `test/frontend-stakes.test.mjs`, replace:

```js
const opts = { distribution: 'target' as const, targetLegIndex: 0, legTaxPercents: [0, 12] };
```

with:

```js
const opts = { distribution: 'target', targetLegIndex: 0, legTaxPercents: [0, 12] };
```

The runtime function accepts the literal string; `as const` is a TypeScript assertion and cannot occur in a `.mjs` file parsed by Espree-based audit helpers.

- [ ] **Step 4: Re-run the focused baseline tests**

Run:

```bash
node --test test/engine-flawless.test.mjs test/frontend-stakes.test.mjs test/export-readers.test.mjs test/reachability.test.mjs
```

Expected:

```text
pass > 0
fail 0
```

- [ ] **Step 5: Commit the independent baseline repair**

```bash
git add src/scrapers/betfair.mjs test/frontend-stakes.test.mjs
git commit -m "test: restore baseline module and parser compatibility"
```

---

### Task 2: Add route primitives for the React-only shell

**Files:**
- Modify: `frontend/src/workspace.ts:9-66`
- Modify: `test/frontend-shell.test.mjs:22-115`
- Create: `test/frontend-operator-ui.test.mjs`

- [ ] **Step 1: Write the failing route contract tests**

Create `test/frontend-operator-ui.test.mjs` with the following testable contract:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW,
  NAV_VIEWS,
  hashForView,
  parseWorkspaceHash,
  viewFromHash,
} from '../frontend/src/workspace.ts';

test('the React shell owns the eight operator workspaces and a non-navigation local-access route', () => {
  assert.equal(DEFAULT_VIEW, 'Dashboard');
  assert.deepEqual([...NAV_VIEWS], [
    'Dashboard', 'Opportunities', 'Scanner', 'Live', 'Bookmakers', 'Analytics', 'Insights', 'Settings',
  ]);
  assert.deepEqual(parseWorkspaceHash('#/scanner?sport=football&includeLive=1'), {
    view: 'Scanner',
    params: new URLSearchParams('sport=football&includeLive=1'),
  });
  assert.equal(viewFromHash('#/local-access'), 'LocalAccess');
  assert.equal(hashForView('Insights'), '#/insights');
});

test('unknown hashes fail closed while a query does not stop a known view from resolving', () => {
  assert.equal(parseWorkspaceHash('#/unknown?x=1'), null);
  assert.equal(viewFromHash('#/opportunities?type=surebet'), 'Opportunities');
});
```

Update `test/frontend-shell.test.mjs` to expect `Dashboard` as the default, the eight navigated workspaces, and `LocalAccess` as a recognized non-navigation view. Keep `TERMINAL_VIEWS` equal to `['Opportunities']`.

- [ ] **Step 2: Run the route tests to verify failure**

Run:

```bash
node --test test/frontend-shell.test.mjs test/frontend-operator-ui.test.mjs
```

Expected: failure because `parseWorkspaceHash`, `Live`, `Insights`, `LocalAccess`, and the Dashboard default do not exist yet.

- [ ] **Step 3: Implement typed hash-route parsing in `workspace.ts`**

Replace the workspace declaration and parsing portion with the following shapes:

```ts
export const WORKSPACES = {
  Dashboard: 'dashboard',
  Opportunities: 'opportunities',
  Scanner: 'scanner',
  Live: 'live',
  Bookmakers: 'bookmakers',
  Analytics: 'analytics',
  Insights: 'insights',
  Settings: 'settings',
  LocalAccess: 'local-access',
} as const;

export type WorkspaceView = keyof typeof WORKSPACES;
export type WorkspaceRoute = { view: WorkspaceView; params: URLSearchParams };

export const DEFAULT_VIEW: WorkspaceView = 'Dashboard';

export function parseWorkspaceHash(hash: string): WorkspaceRoute | null {
  const raw = hash.replace(/^#\/?/, '').trim();
  if (!raw) return null;
  const [slug, query = ''] = raw.split('?', 2);
  const match = (Object.entries(WORKSPACES) as [WorkspaceView, string][])
    .find(([, value]) => value === slug.toLowerCase());
  return match ? { view: match[0], params: new URLSearchParams(query) } : null;
}

export function viewFromHash(hash: string): WorkspaceView | null {
  return parseWorkspaceHash(hash)?.view ?? null;
}

export function hashForView(view: WorkspaceView): string {
  return `#/${WORKSPACES[view]}`;
}
```

Set navigation explicitly, rather than deriving it from all routes:

```ts
export const NAV_VIEWS: readonly WorkspaceView[] = [
  'Dashboard', 'Opportunities', 'Scanner', 'Live', 'Bookmakers', 'Analytics', 'Insights', 'Settings',
];
```

Keep `LocalAccess` out of `NAV_VIEWS` and leave `TERMINAL_VIEWS` as `['Opportunities']`.

- [ ] **Step 4: Re-run route tests**

Run:

```bash
node --test test/frontend-shell.test.mjs test/frontend-operator-ui.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the route primitive**

```bash
git add frontend/src/workspace.ts test/frontend-shell.test.mjs test/frontend-operator-ui.test.mjs
git commit -m "feat: add React operator workspace routes"
```

---

### Task 3: Centralize remaining React API contracts and pure scan projections

**Files:**
- Modify: `frontend/src/domain.ts:141-289`
- Modify: `frontend/src/api.ts:616-887`
- Create: `frontend/src/insights.ts`
- Modify: `test/frontend-normalize.test.mjs`
- Modify: `test/frontend-operator-ui.test.mjs`

- [ ] **Step 1: Add failing gateway and insight tests**

Append these tests to `test/frontend-operator-ui.test.mjs`:

```js
import {
  buildBookOddsUrl,
  deriveScanInsights,
  normalizeBookOdds,
} from '../frontend/src/api.ts';

test('book odds URL encodes only meaningful supported filters', () => {
  assert.equal(
    buildBookOddsUrl('betano', { marketKey: 'over_under_2_5', eventKey: 'football|x', limit: 500 }),
    '/api/odds/betano?marketKey=OVER_UNDER_2_5&eventKey=football%7Cx&limit=100',
  );
  assert.equal(buildBookOddsUrl('betano', {}), '/api/odds/betano?limit=50');
  assert.throws(() => buildBookOddsUrl('../escape', {}), /source id/i);
});

test('odds normalization preserves source timestamp, market selections, and live scope', () => {
  const result = normalizeBookOdds({
    sourceId: 'betano',
    capturedAt: '2026-11-04T10:00:00.000Z',
    results: [{
      eventKey: 'football|x', homeTeam: 'Home', awayTeam: 'Away', live: false,
      market: { key: 'MATCH_ODDS', name: 'Match odds', live: true, selections: [{ name: '1', odds: 2.1 }] },
    }],
  });
  assert.equal(result.sourceId, 'betano');
  assert.equal(result.results[0].market.live, true);
  assert.equal(result.results[0].market.selections[0].odds, 2.1);
});

test('insights are deterministic and do not call unverified rows confirmed', () => {
  const summary = deriveScanInsights({
    published: true,
    health: { status: 'fresh', actionableSourceCount: 2, sources: { fresh: 2 } },
    opportunities: [
      { id: 'safe', type: 'surebet', profitPercent: 2, isLive: false, ruleSafety: { severity: 'safe', isCompatible: true }, legs: [] },
      { id: 'unverified', type: 'surebet', profitPercent: 9, isLive: false, ruleSafety: { severity: 'unverified', isCompatible: false }, legs: [] },
    ],
  });
  assert.equal(summary.confirmedCount, 1);
  assert.deepEqual(summary.topConfirmedIds, ['safe']);
  assert.equal(summary.published, true);
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
node --test test/frontend-normalize.test.mjs test/frontend-operator-ui.test.mjs
```

Expected: failure because the gateway helpers and deterministic insights projection do not exist.

- [ ] **Step 3: Define the browser contracts in `domain.ts`**

Add these interfaces after `LivePollStatus`:

```ts
export interface BookOddsFilters {
  marketKey?: string;
  eventKey?: string;
  limit?: number;
}

export interface BookOddsSelection {
  id?: string;
  name: string;
  odds: number;
  handicap?: number | string | null;
}

export interface BookOddsMarket {
  key: string;
  name: string;
  live: boolean;
  selections: BookOddsSelection[];
}

export interface BookOddsRow {
  eventKey: string;
  id?: string;
  sport?: string;
  league?: string;
  kickoff?: string;
  homeTeam?: string;
  awayTeam?: string;
  live: boolean;
  market: BookOddsMarket;
}

export interface BookOddsPayload {
  sourceId: string;
  capturedAt: string | null;
  results: BookOddsRow[];
}
```

Correct `AlertPreferences` to match the server contract instead of keeping a parallel client-only shape:

```ts
export interface AlertPreferences {
  minMarginPercent: number;
  minMiddleRoiPercent: number;
  includeLive: boolean;
  cooldownSeconds: number;
  channels: { desktop: boolean; sound: boolean; telegram?: boolean; webhook?: boolean };
  quietHours: { from: string; to: string; enabled: boolean };
}
```

- [ ] **Step 4: Implement the odds gateway in `api.ts`**

Import `BookOddsFilters`, `BookOddsPayload`, `BookOddsRow`, and `BookOddsSelection` from `./domain` and add these functions below `fetchLiveStatus`:

```ts
function assertSourceId(sourceId: string): string {
  const value = sourceId.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error('Invalid bookmaker source id');
  return value;
}

export function buildBookOddsUrl(sourceId: string, filters: BookOddsFilters = {}): string {
  const id = assertSourceId(sourceId);
  const params = new URLSearchParams();
  const marketKey = filters.marketKey?.trim().toUpperCase();
  const eventKey = filters.eventKey?.trim();
  const requestedLimit = Number(filters.limit);
  if (marketKey) params.set('marketKey', marketKey);
  if (eventKey) params.set('eventKey', eventKey);
  params.set('limit', String(Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 50));
  return `/api/odds/${encodeURIComponent(id)}?${params.toString()}`;
}

export function normalizeBookOdds(raw: unknown): BookOddsPayload {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rows = Array.isArray(input.results) ? input.results : [];
  return {
    sourceId: typeof input.sourceId === 'string' ? input.sourceId : '',
    capturedAt: typeof input.capturedAt === 'string' ? input.capturedAt : null,
    results: rows.flatMap((row): BookOddsRow[] => {
      if (!row || typeof row !== 'object') return [];
      const value = row as Record<string, unknown>;
      const rawMarket = value.market && typeof value.market === 'object' ? value.market as Record<string, unknown> : null;
      if (!rawMarket || typeof rawMarket.key !== 'string') return [];
      return [{
        eventKey: typeof value.eventKey === 'string' ? value.eventKey : '',
        id: typeof value.id === 'string' ? value.id : undefined,
        sport: typeof value.sport === 'string' ? value.sport : undefined,
        league: typeof value.league === 'string' ? value.league : undefined,
        kickoff: typeof value.kickoff === 'string' ? value.kickoff : undefined,
        homeTeam: typeof value.homeTeam === 'string' ? value.homeTeam : undefined,
        awayTeam: typeof value.awayTeam === 'string' ? value.awayTeam : undefined,
        live: value.live === true,
        market: {
          key: rawMarket.key,
          name: typeof rawMarket.name === 'string' ? rawMarket.name : rawMarket.key,
          live: rawMarket.live === true,
          selections: (Array.isArray(rawMarket.selections) ? rawMarket.selections : []).flatMap((selection): BookOddsSelection[] => {
            if (!selection || typeof selection !== 'object') return [];
            const item = selection as Record<string, unknown>;
            const odds = Number(item.odds);
            if (typeof item.name !== 'string' || !Number.isFinite(odds)) return [];
            return [{ id: typeof item.id === 'string' ? item.id : undefined, name: item.name, odds, handicap: item.handicap as number | string | null | undefined }];
          }),
        },
      }];
    }),
  };
}

export async function fetchBookOdds(sourceId: string, filters: BookOddsFilters = {}, signal?: AbortSignal): Promise<BookOddsPayload> {
  const response = await apiRequest<unknown>('GET', buildBookOddsUrl(sourceId, filters), undefined, signal);
  return normalizeBookOdds(response);
}

export function snapshotUrl(sourceId: string): string {
  return `/api/snapshot/${encodeURIComponent(assertSourceId(sourceId))}`;
}
```

- [ ] **Step 5: Add a pure deterministic insight projection**

Create `frontend/src/insights.ts`:

```ts
import type { ArbitrageOpportunity } from './domain';

export interface ScanInsightInput {
  published: boolean;
  health: { status?: string; actionableSourceCount?: number; sources?: Record<string, number> } | null;
  opportunities: readonly ArbitrageOpportunity[];
}

export interface ScanInsights {
  published: boolean;
  healthStatus: string;
  actionableSourceCount: number;
  sourceStates: Array<{ status: string; count: number }>;
  confirmedCount: number;
  topConfirmedIds: string[];
}

export function deriveScanInsights(input: ScanInsightInput): ScanInsights {
  const confirmed = input.opportunities
    .filter((item) => item.type === 'surebet' && item.ruleSafety.severity === 'safe')
    .sort((a, b) => b.profitPercent - a.profitPercent || a.id.localeCompare(b.id));
  return {
    published: input.published,
    healthStatus: input.health?.status ?? 'unknown',
    actionableSourceCount: input.health?.actionableSourceCount ?? 0,
    sourceStates: Object.entries(input.health?.sources ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([status, count]) => ({ status, count: Number(count) }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    confirmedCount: confirmed.length,
    topConfirmedIds: confirmed.slice(0, 5).map((item) => item.id),
  };
}
```

Re-export `deriveScanInsights` from `api.ts` so tests and workspaces use one import boundary:

```ts
export { deriveScanInsights } from './insights';
```

- [ ] **Step 6: Verify the focused gateway tests**

Run:

```bash
node --test test/frontend-normalize.test.mjs test/frontend-operator-ui.test.mjs
npm run typecheck
```

Expected: both test files pass and TypeScript reports no error.

- [ ] **Step 7: Commit the API boundary**

```bash
git add frontend/src/domain.ts frontend/src/api.ts frontend/src/insights.ts test/frontend-normalize.test.mjs test/frontend-operator-ui.test.mjs
git commit -m "feat: centralize React odds and insight contracts"
```

---

### Task 4: Give Scanner full scrape-control parity and a bounded odds board

**Files:**
- Create: `frontend/src/scanner-options.ts`
- Create: `frontend/src/OddsBoard.tsx`
- Modify: `frontend/src/ScannerWorkspace.tsx`
- Modify: `frontend/src/stores.ts:51-163`
- Modify: `frontend/src/styles.css`
- Modify: `test/frontend-operator-ui.test.mjs`
- Modify: `test/app-shell.browser.test.mjs`

- [ ] **Step 1: Write failing scan-option tests**

Append to `test/frontend-operator-ui.test.mjs`:

```js
import { applyScanProfile, buildScanOptions } from '../frontend/src/scanner-options.ts';

test('profile defaults and scan options preserve all supported scrape controls', () => {
  const form = applyScanProfile({
    bankroll: 1000, minMarginPercent: 0, minEvPercent: 2,
    maxMiddleRiskPercent: 15, minMiddleRoiPercent: 20,
    includeLive: false, includePast: false, maxEvents: 'all', sport: '',
  }, {
    defaults: { bankroll: 500, minMarginPercent: 1, minEvPercent: 3, maxMiddleRiskPercent: 10, minMiddleRoiPercent: 30, includeLive: true, includePast: true },
  });
  assert.deepEqual(form, {
    bankroll: 500, minMarginPercent: 1, minEvPercent: 3,
    maxMiddleRiskPercent: 10, minMiddleRoiPercent: 30,
    includeLive: true, includePast: true, maxEvents: 'all', sport: '',
  });
  assert.deepEqual(buildScanOptions({ ...form, maxEvents: '100', sport: 'football' }), {
    bankroll: 500, minMarginPercent: 1, minEvPercent: 3,
    maxMiddleRiskPercent: 10, minMiddleRoiPercent: 30,
    includeLive: true, includePast: true, maxEvents: 100, sport: 'football',
  });
});
```

Extend the existing Playwright route fixture with `/api/odds/betano`, `/api/scrape-run`, and `/api/live`. Add UI assertions that Scanner exposes bankroll, min EV, middle risk, middle ROI, include past, a run-history row, and the odds board before interactions are attempted.

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs
```

Expected: failure because the pure scan-option module and complete UI controls do not exist.

- [ ] **Step 3: Implement pure scan form handling**

Create `frontend/src/scanner-options.ts`:

```ts
import type { ScanProfile } from './domain';

export interface ScanFormValues {
  bankroll: number;
  minMarginPercent: number;
  minEvPercent: number;
  maxMiddleRiskPercent: number;
  minMiddleRoiPercent: number;
  includeLive: boolean;
  includePast: boolean;
  maxEvents: string;
  sport: string;
}

export const DEFAULT_SCAN_FORM: ScanFormValues = {
  bankroll: 1000,
  minMarginPercent: 0,
  minEvPercent: 2,
  maxMiddleRiskPercent: 15,
  minMiddleRoiPercent: 20,
  includeLive: false,
  includePast: false,
  maxEvents: 'all',
  sport: '',
};

const numberOr = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function applyScanProfile(current: ScanFormValues, profile: Pick<ScanProfile, 'defaults'>): ScanFormValues {
  const defaults = profile.defaults ?? {};
  return {
    ...current,
    bankroll: numberOr(defaults.bankroll, current.bankroll),
    minMarginPercent: numberOr(defaults.minMarginPercent, current.minMarginPercent),
    minEvPercent: numberOr(defaults.minEvPercent, current.minEvPercent),
    maxMiddleRiskPercent: numberOr(defaults.maxMiddleRiskPercent, current.maxMiddleRiskPercent),
    minMiddleRoiPercent: numberOr(defaults.minMiddleRoiPercent, current.minMiddleRoiPercent),
    includeLive: defaults.includeLive ?? current.includeLive,
    includePast: defaults.includePast ?? current.includePast,
  };
}

export function buildScanOptions(values: ScanFormValues): Record<string, string | number | boolean> {
  const maxEvents = values.maxEvents === 'all' ? 'all' : Math.max(1, Math.trunc(Number(values.maxEvents) || 1));
  return {
    bankroll: Math.max(10, numberOr(values.bankroll, DEFAULT_SCAN_FORM.bankroll)),
    minMarginPercent: Math.max(0, numberOr(values.minMarginPercent, DEFAULT_SCAN_FORM.minMarginPercent)),
    minEvPercent: Math.max(0, numberOr(values.minEvPercent, DEFAULT_SCAN_FORM.minEvPercent)),
    maxMiddleRiskPercent: Math.max(0, numberOr(values.maxMiddleRiskPercent, DEFAULT_SCAN_FORM.maxMiddleRiskPercent)),
    minMiddleRoiPercent: Math.max(0, numberOr(values.minMiddleRoiPercent, DEFAULT_SCAN_FORM.minMiddleRoiPercent)),
    includeLive: values.includeLive === true,
    includePast: values.includePast === true,
    maxEvents,
    ...(values.sport.trim() ? { sport: values.sport.trim() } : {}),
  };
}
```

- [ ] **Step 4: Implement a cancellation-safe reusable odds board**

Create `frontend/src/OddsBoard.tsx` using the API gateway only:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { BookOddsPayload, ScraperJob } from './domain';
import { fetchBookOdds, formatBookmakerName } from './api';
import { t, tf } from './i18n';

export function OddsBoard({ books, liveOnly = false }: { books: ScraperJob[]; liveOnly?: boolean }) {
  const eligibleBooks = books.filter((book) => !liveOnly || book.liveCapability?.inPlay === 'supported' || (book.liveCapability as { live?: boolean } | null)?.live === true);
  const [sourceId, setSourceId] = useState('');
  const [marketKey, setMarketKey] = useState('');
  const [eventKey, setEventKey] = useState('');
  const [limit, setLimit] = useState(50);
  const [payload, setPayload] = useState<BookOddsPayload | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sourceId) { setPayload(null); setStatus('idle'); return; }
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    void fetchBookOdds(sourceId, { marketKey, eventKey, limit }, controller.signal)
      .then((next) => { if (!controller.signal.aborted) { setPayload(next); setStatus('ready'); } })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setStatus('error');
          setError(cause instanceof Error ? cause.message : t('appOddsLoadFailed'));
        }
      });
    return () => controller.abort();
  }, [sourceId, marketKey, eventKey, limit]);

  const rows = useMemo(() => (payload?.results ?? []).filter((row) => !liveOnly || row.live || row.market.live), [payload, liveOnly]);

  return <section className="panel workspace-table odds-board">
    <div className="section-head"><div><div className="eyebrow">{t('bookPrices')}</div><h3>{t('appOddsBoardTitle')}</h3></div></div>
    <div className="scanner-controls-grid">
      <label className="control-field"><span>{t('bookmaker')}</span><select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">{t('pricesPickBook')}</option>{eligibleBooks.map((book) => <option key={book.id} value={book.id}>{formatBookmakerName(book.id)}</option>)}</select></label>
      <label className="control-field"><span>{t('market')}</span><input className="select" value={marketKey} onChange={(e) => setMarketKey(e.target.value)} placeholder={t('marketFilterHint')} /></label>
      <label className="control-field"><span>{t('event')}</span><input className="select" value={eventKey} onChange={(e) => setEventKey(e.target.value)} placeholder={t('eventFilterHint')} /></label>
      <label className="control-field"><span>{t('limit')}</span><select className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
    </div>
    {status === 'loading' && <p className="subtle">{t('pricesLoading')}</p>}
    {status === 'error' && <p className="risk-tag blocked">{error}</p>}
    {status === 'ready' && rows.length === 0 && <p className="subtle">{t('pricesNoneForFilter')}</p>}
    {rows.length > 0 && <div className="odds-board-list">{rows.map((row, index) => <article className="odds-board-row" key={`${row.eventKey}-${row.market.key}-${index}`}><div><strong>{row.homeTeam} {t('vs')} {row.awayTeam}</strong><span className="subtle">{[row.sport, row.league, row.kickoff].filter(Boolean).join(' · ')}</span></div><span className="market-badge">{row.market.name}</span><div className="inline-actions">{row.market.selections.map((selection) => <span className="odds-pill" key={`${selection.id ?? selection.name}-${selection.odds}`}>{selection.name} <strong className="num">@{selection.odds.toFixed(2)}</strong></span>)}</div></article>)}</div>}
    {payload?.capturedAt && <p className="subtle">{tf('appOddsCapturedAt', { time: new Date(payload.capturedAt).toLocaleString() })}</p>}
  </section>;
}
```

- [ ] **Step 5: Refactor `ScannerWorkspace` to own complete scan configuration**

Replace separate `minMargin`, `includeLive`, `maxEvents`, and `selectedSport` state with one `ScanFormValues` state initialized from `DEFAULT_SCAN_FORM`.

Use the pure functions in all writes:

```ts
const scanOptions = buildScanOptions(form);
const bookIds = bookScope === 'custom' ? [...selectedBooks] : [];
const state = await startScrape(bookIds, scanOptions);
```

When a profile is selected:

```ts
const applyProfile = (profile: ScanProfile) => {
  setActiveProfileId(profile.id);
  setForm((current) => applyScanProfile(current, profile));
};
```

Render fields with these stable IDs so browser coverage can assert them:

```tsx
<input id="scanner-bankroll" type="number" value={form.bankroll} />
<input id="scanner-min-margin" type="number" value={form.minMarginPercent} />
<input id="scanner-min-ev" type="number" value={form.minEvPercent} />
<input id="scanner-middle-risk" type="number" value={form.maxMiddleRiskPercent} />
<input id="scanner-middle-roi" type="number" value={form.minMiddleRoiPercent} />
<input id="scanner-include-live" type="checkbox" checked={form.includeLive} />
<input id="scanner-include-past" type="checkbox" checked={form.includePast} />
```

Pass the full options and current scope when saving automation:

```ts
await saveScheduler({
  enabled,
  intervalMinutes: Math.max(1, schedMinutes),
  bookIds: bookScope === 'custom' ? [...selectedBooks] : [],
  scanOptions: buildScanOptions(form),
});

await saveLiveStatus({
  enabled,
  intervalSeconds: Math.max(5, liveSeconds),
  bookIds: [],
  scanOptions: { ...buildScanOptions(form), includeLive: true },
});
```

Render `<OddsBoard books={scrapers} />` below automation. Retain `fetchLatestScrapeRun()` data and show `runId`, start/end time, terminal status, event count, duration, and job error details instead of only compact job pills.

- [ ] **Step 6: Add a bounded operation timeline to the feed store**

Add to `FeedState`:

```ts
activity: Array<{ id: number; at: number; type: string; message: string; tone: 'info' | 'success' | 'error' }>;
appendActivity: (entry: Omit<FeedState['activity'][number], 'id' | 'at'>) => void;
```

Implement a maximum of 100 entries and record only state transitions, not every duplicate SSE frame:

```ts
let activitySeq = 0;
appendActivity(entry) {
  activitySeq += 1;
  set((state) => ({ activity: [...state.activity, { id: activitySeq, at: Date.now(), ...entry }].slice(-100) }));
},
```

In `start()`, call `appendActivity` on `scrape-update`, `verify-start`, and `verify-end`; compare the previous scrape status/current activity before adding a scrape entry. Render the latest 50 entries in Scanner under a native `<details>` element. This preserves legacy operational visibility without inventing server-side log persistence.

- [ ] **Step 7: Add styles and browser assertions**

Add CSS for `.odds-board`, `.odds-board-list`, `.odds-board-row`, and a responsive one-column layout below 760px. Do not import any stylesheet from `public/css`.

In `test/app-shell.browser.test.mjs`, route `/api/odds/betano` with a response matching `BookOddsPayload`, route `/api/scrape-run` with a run object, then assert:

```js
await navButtons.nth(2).click();
await page.locator('#scanner-bankroll').waitFor();
assert.equal(await page.locator('#scanner-min-ev').count(), 1);
assert.equal(await page.locator('#scanner-middle-risk').count(), 1);
assert.equal(await page.locator('#scanner-middle-roi').count(), 1);
assert.equal(await page.locator('#scanner-include-past').count(), 1);
await page.locator('.odds-board select').first().selectOption('betano');
await page.locator('.odds-board-row').first().waitFor();
```

- [ ] **Step 8: Verify Scanner parity**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs test/frontend-shell.test.mjs
node --test test/app-shell.browser.test.mjs
npm run typecheck
npm run build:frontend
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit Scanner parity**

```bash
git add frontend/src/scanner-options.ts frontend/src/OddsBoard.tsx frontend/src/ScannerWorkspace.tsx frontend/src/stores.ts frontend/src/styles.css test/frontend-operator-ui.test.mjs test/app-shell.browser.test.mjs
git commit -m "feat: consolidate scrape controls into React scanner"
```

---

### Task 5: Add dedicated Live, Insights, and Local Access React workspaces

**Files:**
- Create: `frontend/src/LiveWorkspace.tsx`
- Create: `frontend/src/InsightsWorkspace.tsx`
- Create: `frontend/src/LocalAccessWorkspace.tsx`
- Modify: `frontend/src/App.tsx:1-90, 586-848`
- Modify: `frontend/src/styles.css`
- Modify: `public/js/i18n.js`
- Modify: `test/frontend-shell.test.mjs`
- Modify: `test/app-shell.browser.test.mjs`

- [ ] **Step 1: Add failing shell coverage for the new workspaces**

In `test/frontend-shell.test.mjs`, assert the exact navigation labels and verify `LocalAccess` is not navigated:

```js
assert.deepEqual([...NAV_VIEWS], [
  'Dashboard', 'Opportunities', 'Scanner', 'Live', 'Bookmakers', 'Analytics', 'Insights', 'Settings',
]);
assert.ok(Object.keys(WORKSPACES).includes('LocalAccess'));
assert.ok(!NAV_VIEWS.includes('LocalAccess'));
```

In `test/app-shell.browser.test.mjs`, update the expected sidebar count from `7` to `8`, navigate to Live and Insights by visible nav button, and open `#/local-access` directly. Assert that each view includes its unique heading.

- [ ] **Step 2: Run shell tests to verify failure**

Run:

```bash
node --test test/frontend-shell.test.mjs test/app-shell.browser.test.mjs
```

Expected: failure because the workspace components, navigation labels, and render branches do not yet exist.

- [ ] **Step 3: Implement `LiveWorkspace.tsx` without unsupported poll mutations**

Create `frontend/src/LiveWorkspace.tsx` with this component contract:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import type { ArbitrageOpportunity, LivePollStatus, ScraperJob } from './domain';
import { fetchLiveStatus, fetchScrapers } from './api';
import { OddsBoard } from './OddsBoard';
import { t } from './i18n';

export function LiveWorkspace({ opportunities }: { opportunities: ArbitrageOpportunity[] }) {
  const [status, setStatus] = useState<LivePollStatus | null>(null);
  const [books, setBooks] = useState<ScraperJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const liveSignals = useMemo(() => opportunities.filter((item) => item.isLive), [opportunities]);

  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const [nextStatus, scrapers] = await Promise.all([fetchLiveStatus(), fetchScrapers()]);
      setStatus(nextStatus);
      setBooks(scrapers.jobs.filter((job) => job.liveCapability?.inPlay === 'supported' || job.liveCapability?.live === true));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('appLiveLoadFailed'));
    } finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  return <div className="workspace-stack">
    <section className="kpis">
      <div className="kpi"><div className="kpi-label">{t('engine')}</div><div className="kpi-value">{status?.enabled ? t('enabled') : t('disabled')}</div></div>
      <div className="kpi"><div className="kpi-label">{t('liveSignals')}</div><div className="kpi-value green num">{liveSignals.length}</div></div>
      <div className="kpi"><div className="kpi-label">{t('pollInterval')}</div><div className="kpi-value num">{status?.intervalSeconds ?? '—'}s</div></div>
      <div className="kpi"><div className="kpi-label">{t('lastPoll')}</div><div className="kpi-value">{status?.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : '—'}</div></div>
    </section>
    <section className="panel workspace-table">
      <div className="section-head"><div><div className="eyebrow">{t('live')}</div><h3>{t('liveArbitrage')}</h3><span className="subtle">{t('liveEngineNote')}</span></div><button className="chip" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''} /> {t('appRefreshLive')}</button></div>
      {error && <p className="risk-tag blocked">{error}</p>}
      {!status?.enabled && !loading && <p className="subtle">{t('appLiveDisabledNote')}</p>}
      {status?.enabled && <p className="subtle">{t('appLiveNextPollNote')}</p>}
    </section>
    <section className="panel workspace-table"><div className="section-head"><div><div className="eyebrow">{t('liveSignals')}</div><h3>{t('appLiveSignalsTitle')}</h3></div></div>{liveSignals.length ? <div className="preview-list">{liveSignals.map((item) => <article className="preview-row" key={item.id}><div><strong>{item.homeTeam} {t('vs')} {item.awayTeam}</strong><span className="subtle">{item.marketName}</span></div><strong className="profit num">+{item.profitPercent.toFixed(2)}%</strong></article>)}</div> : <p className="subtle">{t('noOpportunities')}</p>}</section>
    <OddsBoard books={books} liveOnly />
  </div>;
}
```

Do not add a "Poll now" mutation: the current backend has no single-shot live polling endpoint. The refresh button re-reads status and bounded odds data only.

- [ ] **Step 4: Implement deterministic Insights and Local Access**

Create `frontend/src/InsightsWorkspace.tsx`:

```tsx
import type { ArbitrageOpportunity } from './domain';
import type { FeedHealth } from './stores';
import { deriveScanInsights } from './insights';
import { t, tf } from './i18n';

export function InsightsWorkspace({ opportunities, health, published, onOpenScanner }: { opportunities: ArbitrageOpportunity[]; health: FeedHealth | null; published: boolean; onOpenScanner: () => void }) {
  const insights = deriveScanInsights({ published, health, opportunities });
  return <div className="workspace-stack">
    <section className="panel workspace-table"><div className="eyebrow">{t('scanDerived')}</div><h3>{t('dataHealth')}</h3>{!insights.published ? <><p className="subtle">{t('noPublishedScan')}</p><button className="chip active" onClick={onOpenScanner}>{t('runScrape')}</button></> : <><span className="safe-tag">{insights.healthStatus}</span><p className="subtle">{tf('appActionableCount', { n: insights.actionableSourceCount })}</p><div className="inline-actions">{insights.sourceStates.map((entry) => <span className="market-badge" key={entry.status}>{entry.status}: {entry.count}</span>)}</div></>}</section>
    <section className="panel workspace-table"><div className="eyebrow">{t('insights')}</div><h3>{t('appConfirmedInsights')}</h3>{insights.confirmedCount === 0 ? <p className="subtle">{t('noVerifiedOpps')}</p> : <p className="subtle">{tf('appConfirmedInsightsCount', { n: insights.confirmedCount })}</p>}</section>
  </div>;
}
```

Create `frontend/src/LocalAccessWorkspace.tsx`:

```tsx
import { ShieldCheck } from 'lucide-react';
import { t } from './i18n';

export function LocalAccessWorkspace({ onOpenScanner }: { onOpenScanner: () => void }) {
  return <section className="panel local-access-card">
    <ShieldCheck size={28} color="#10b981" />
    <div><div className="eyebrow">{t('localOnly')}</div><h2>{t('appLocalAccessTitle')}</h2><p className="subtle">{t('appLocalAccessBody')}</p><button className="chip active" onClick={onOpenScanner}>{t('appOpenLocalControl')}</button></div>
  </section>;
}
```

- [ ] **Step 5: Wire the views in `App.tsx` and remove the unrelated Plans presentation**

Import `Radio`, `Sparkles`, and `ShieldCheck` icons as needed, plus all three new workspace components.

Replace the `icons`, `WORKSPACE_LABEL_KEYS`, and `WORKSPACE_SUBTITLE_KEYS` records so every `WorkspaceView` is classified. Add `Live` and `Insights` labels/subtitles. Give `LocalAccess` an internal title/subtitle but do not put it in navigation.

Change `useWorkspaceView()` to retain parsed query state:

```ts
function useWorkspaceView() {
  const [route, setRoute] = useState(() => parseWorkspaceHash(window.location.hash) ?? { view: DEFAULT_VIEW, params: new URLSearchParams() });
  useEffect(() => {
    const onHashChange = () => setRoute(parseWorkspaceHash(window.location.hash) ?? { view: DEFAULT_VIEW, params: new URLSearchParams() });
    window.addEventListener('hashchange', onHashChange);
    if (!parseWorkspaceHash(window.location.hash)) window.location.replace(`${window.location.pathname}${window.location.search}${hashForView(DEFAULT_VIEW)}`);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = useCallback((view: WorkspaceView) => { window.location.hash = hashForView(view); window.scrollTo(0, 0); }, []);
  return [route, navigate] as const;
}
```

Render `Live`, `Insights`, and `LocalAccess` branches and remove the `Plans` branch entirely. Remove the Plans quick-jump UI as it has no legacy parity purpose and is outside the approved navigation model.

- [ ] **Step 6: Add required shared dictionary keys in both language blocks**

Add the following keys to both `ro` and `en` dictionaries in `public/js/i18n.js`; use the English values below and Romanian translations of the same meaning:

```js
appSubtitleLive: 'Monitor in-play polling, current live signals, and bounded bookmaker price snapshots.',
appSubtitleInsights: 'Deterministic summaries of the published scan, data health, and confirmed signals.',
appSubtitleLocalAccess: 'This local workstation is protected by the loopback-only server boundary.',
appOddsBoardTitle: 'Per-book captured prices',
appOddsCapturedAt: 'Capture: {time}',
appLiveLoadFailed: 'Could not load live engine state.',
appRefreshLive: 'Refresh live state',
appLiveDisabledNote: 'Live polling is disabled. Enable it from Scanner automation controls.',
appLiveNextPollNote: 'The backend runs the next configured poll; refreshing this view does not start a new scrape.',
appLiveSignalsTitle: 'Current in-play signals',
appConfirmedInsights: 'Confirmed scan findings',
appConfirmedInsightsCount: '{n} confirmed surebets in the current published scan.',
appLocalAccessTitle: 'Local operator access',
appLocalAccessBody: 'This build does not provide remote authentication. Administrative controls are available only through the loopback-bound local server.',
appOpenLocalControl: 'Open scrape control',
```

- [ ] **Step 7: Add styles and verify the new navigation**

Add `.local-access-card` and `.odds-board-row` responsive styles. Confirm that the app shell has no third execution-slip column for Live, Insights, or Local Access because only `Opportunities` is terminal.

Run:

```bash
node --test test/frontend-shell.test.mjs test/frontend-operator-ui.test.mjs
node --test test/app-shell.browser.test.mjs
npm run typecheck
npm run build:frontend
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit new workspaces**

```bash
git add frontend/src/LiveWorkspace.tsx frontend/src/InsightsWorkspace.tsx frontend/src/LocalAccessWorkspace.tsx frontend/src/App.tsx frontend/src/styles.css public/js/i18n.js test/frontend-shell.test.mjs test/app-shell.browser.test.mjs
git commit -m "feat: add React live insights and local access workspaces"
```

---

### Task 6: Finish retained Bookmakers, Analytics, and Settings parity

**Files:**
- Modify: `frontend/src/BookmakersWorkspace.tsx`
- Modify: `frontend/src/AnalyticsWorkspace.tsx`
- Modify: `frontend/src/SettingsWorkspace.tsx`
- Modify: `frontend/src/domain.ts`
- Modify: `test/app-shell.browser.test.mjs`
- Modify: `test/frontend-operator-ui.test.mjs`

- [ ] **Step 1: Write failing parity assertions**

Add static and browser assertions:

```js
import { readFileSync } from 'node:fs';

test('React settings contains no link back to a legacy operator page', () => {
  const settings = readFileSync(new URL('../frontend/src/SettingsWorkspace.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /\/admin\//);
});
```

In the browser test, navigate to Bookmakers, assert a source row exposes a snapshot download anchor, navigate to Analytics and verify tracker/catalog controls, then navigate to Settings and verify alert quiet hours, cooldown, live inclusion, and channel controls.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs test/app-shell.browser.test.mjs
```

Expected: failure because Settings still links to legacy pages and uses the old alert-preference shape.

- [ ] **Step 3: Add safe source capture downloads to Bookmakers**

Import `snapshotUrl` from `api.ts` in `BookmakersWorkspace.tsx`. For every row with `row.source?.count > 0`, render:

```tsx
<a
  className="chip sm"
  href={snapshotUrl(row.id)}
  download={`${row.id}-events.json`}
  title={t('captureSourceLink')}
>
  {t('captureSourceLink')}
</a>
```

Do not recreate the legacy "add bookmaker" form. The backend has no validated mutation endpoint for `config/scrapers.json`; preserve the safe single-book scrape action and state in the UI that scraper registration is a development workflow.

- [ ] **Step 4: Keep Analytics feature-complete without duplicating a second tracker client**

Keep existing tracker CRUD, CSV import/export, positions, catalog, and event coverage. Add a compact deterministic scan-summary panel at the top from the already normalized `opportunities` prop, rather than fetching `/api/scan` a second time. The panel must link internally through `onJumpToOpportunities`, not to `/admin/scanner.html`.

Use this interaction for every catalog event jump:

```tsx
onClick={() => {
  resetFilters();
  setCriteria({ query: ev.homeTeam ?? matchQuery });
  onJumpToOpportunities();
}}
```

- [ ] **Step 5: Correct Settings to the server-backed alert schema and remove legacy links**

Replace all references to `minEvPercent`, `quietHoursStart`, and `quietHoursEnd` with the normalized backend fields:

```tsx
<input
  id="alert-include-live"
  type="checkbox"
  checked={alertPrefs.includeLive}
  onChange={(e) => setAlertPrefs({ ...alertPrefs, includeLive: e.target.checked })}
/>
<input
  id="alert-cooldown"
  type="number"
  min={0}
  value={alertPrefs.cooldownSeconds}
  onChange={(e) => setAlertPrefs({ ...alertPrefs, cooldownSeconds: Math.max(0, Number(e.target.value) || 0) })}
/>
<input
  id="alert-quiet-enabled"
  type="checkbox"
  checked={alertPrefs.quietHours.enabled}
  onChange={(e) => setAlertPrefs({ ...alertPrefs, quietHours: { ...alertPrefs.quietHours, enabled: e.target.checked } })}
/>
<input
  id="alert-quiet-from"
  type="time"
  value={alertPrefs.quietHours.from}
  onChange={(e) => setAlertPrefs({ ...alertPrefs, quietHours: { ...alertPrefs.quietHours, from: e.target.value } })}
/>
<input
  id="alert-quiet-to"
  type="time"
  value={alertPrefs.quietHours.to}
  onChange={(e) => setAlertPrefs({ ...alertPrefs, quietHours: { ...alertPrefs.quietHours, to: e.target.value } })}
/>
```

Render desktop and sound channel switches from `alertPrefs.channels`. Remove the entire `appClassicConsole*` section and remove the `ExternalLink` import.

- [ ] **Step 6: Verify supporting workspace parity**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs
node --test test/app-shell.browser.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit supporting surfaces**

```bash
git add frontend/src/BookmakersWorkspace.tsx frontend/src/AnalyticsWorkspace.tsx frontend/src/SettingsWorkspace.tsx frontend/src/domain.ts test/frontend-operator-ui.test.mjs test/app-shell.browser.test.mjs
git commit -m "feat: complete React operator supporting workspaces"
```

---

### Task 7: Apply legacy hash query state in the React shell

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/ScannerWorkspace.tsx`
- Modify: `frontend/src/workspace.ts`
- Modify: `test/frontend-operator-ui.test.mjs`

- [ ] **Step 1: Write failing query-translation tests**

Add these pure functions and expectations to `test/frontend-operator-ui.test.mjs`:

```js
import { opportunityCriteriaFromRoute, scannerFormFromRoute } from '../frontend/src/workspace.ts';

test('legacy-compatible query state is whitelisted before it changes React filters', () => {
  assert.deepEqual(
    opportunityCriteriaFromRoute(new URLSearchParams('type=surebet&sport=football&q=FCSB&confirmed=1&unknown=x')),
    { type: 'surebet', sport: 'football', query: 'FCSB', safety: 'safe_only' },
  );
  assert.deepEqual(
    scannerFormFromRoute(new URLSearchParams('sport=tennis&includeLive=1&maxEvents=100&bad=9')),
    { sport: 'tennis', includeLive: true, maxEvents: '100' },
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs
```

Expected: failure because the route-to-state helpers do not exist.

- [ ] **Step 3: Implement whitelisted route state in `workspace.ts`**

Add these functions:

```ts
export function opportunityCriteriaFromRoute(params: URLSearchParams): Partial<OpportunityFilterCriteria> {
  const type = params.get('type');
  const sport = params.get('sport');
  const q = params.get('q');
  return {
    ...(type === 'surebet' || type === 'middle' || type === 'positive_ev' ? { type } : {}),
    ...(sport ? { sport: sport as Sport } : {}),
    ...(q ? { query: q.slice(0, 120) } : {}),
    ...(params.get('confirmed') === '1' ? { safety: 'safe_only' } : {}),
  };
}

export function scannerFormFromRoute(params: URLSearchParams): Partial<Pick<ScanFormValues, 'sport' | 'includeLive' | 'maxEvents'>> {
  const maxEvents = params.get('maxEvents');
  const sport = params.get('sport')?.trim();
  return {
    ...(sport && /^[a-z0-9-]{1,64}$/i.test(sport) ? { sport } : {}),
    ...(params.get('includeLive') === '1' ? { includeLive: true } : {}),
    ...(maxEvents === 'all' || ['40', '100', '200', '500', '1000'].includes(maxEvents ?? '') ? { maxEvents: maxEvents! } : {}),
  };
}
```

Import `ScanFormValues` as a type from `scanner-options.ts`.

- [ ] **Step 4: Apply route state once per route change**

In `App.tsx`, receive `{ view, params }` from `useWorkspaceView`. Add an effect that applies `opportunityCriteriaFromRoute(params)` when `view === 'Opportunities'` and calls `setCriteria` only if the patch has keys.

Pass `routeParams={params}` into Scanner. In `ScannerWorkspace`, add:

```ts
useEffect(() => {
  const patch = scannerFormFromRoute(routeParams);
  if (Object.keys(patch).length) setForm((current) => ({ ...current, ...patch }));
}, [routeParams]);
```

Do not apply arbitrary parameter names, HTML, or unbounded input into UI state.

- [ ] **Step 5: Verify the route query behavior**

Run:

```bash
node --test test/frontend-operator-ui.test.mjs test/frontend-shell.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit route state**

```bash
git add frontend/src/workspace.ts frontend/src/App.tsx frontend/src/ScannerWorkspace.tsx test/frontend-operator-ui.test.mjs
git commit -m "feat: translate compatibility route queries into React state"
```

---

### Task 8: Add protected legacy compatibility redirects in the server router

**Files:**
- Modify: `src/router.mjs:1-10,332-400,826-864`
- Modify: `test/router.test.mjs:401-470`
- Create: `test/legacy-ui-retirement.test.mjs`

- [ ] **Step 1: Write redirect tests before changing the router**

Add this table-driven test to `test/router.test.mjs`:

```js
test('loopback legacy operator URLs redirect to their React compatibility routes', async () => {
  const { route } = makeServer({ publicDir: PUBLIC_DIR });
  const server = await startServer(route);
  try {
    const cases = [
      ['/admin/workstation.html', '/app/#/opportunities'],
      ['/admin/arbitrage.html?type=surebet&sport=football&confirmed=1', '/app/#/opportunities?type=surebet&sport=football&confirmed=1'],
      ['/admin/scanner.html?sport=tennis', '/app/#/scanner?sport=tennis'],
      ['/admin/scrape.html', '/app/#/scanner'],
      ['/admin/live.html', '/app/#/live'],
      ['/admin/bookies.html', '/app/#/bookmakers'],
      ['/admin/analytics.html', '/app/#/analytics'],
      ['/admin/ai.html', '/app/#/insights'],
      ['/admin/settings.html', '/app/#/settings'],
      ['/admin/login.html', '/app/#/local-access'],
      ['/', '/app/#/dashboard'],
      ['/index.html', '/app/#/dashboard'],
    ];
    for (const [path, location] of cases) {
      const response = await fetchOnce(server, path, { headers: { Host: '127.0.0.1' } });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.location, location, path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
    }
  } finally { await closeServer(server); }
});
```

Update the existing root static test to expect `/app/#/dashboard`.

Add a second assertion in the existing foreign-admin test that every mapped admin path returns the existing 404 payload when `Host` is non-loopback.

- [ ] **Step 2: Run router tests to verify failure**

Run:

```bash
node --test test/router.test.mjs
```

Expected: failures because old admin pages still return `200` and root redirects to `/app/`.

- [ ] **Step 3: Add a single explicit redirect map to `router.mjs`**

Near the route constants, add:

```js
export const LEGACY_APP_REDIRECTS = Object.freeze({
  '/admin/workstation.html': { view: 'opportunities', keys: [] },
  '/admin/arbitrage.html': { view: 'opportunities', keys: ['type', 'sport', 'q', 'confirmed'] },
  '/admin/scanner.html': { view: 'scanner', keys: ['sport', 'includeLive', 'maxEvents'] },
  '/admin/scrape.html': { view: 'scanner', keys: ['sport', 'includeLive', 'maxEvents', 'book', 'marketKey', 'eventKey', 'limit'] },
  '/admin/live.html': { view: 'live', keys: ['book', 'marketKey', 'eventKey', 'limit'] },
  '/admin/bookies.html': { view: 'bookmakers', keys: [] },
  '/admin/analytics.html': { view: 'analytics', keys: [] },
  '/admin/ai.html': { view: 'insights', keys: [] },
  '/admin/settings.html': { view: 'settings', keys: [] },
  '/admin/login.html': { view: 'local-access', keys: [] },
});

export function legacyRedirectLocation(pathname, searchParams = new URLSearchParams()) {
  if (pathname === '/' || pathname === '' || pathname === '/index.html') return '/app/#/dashboard';
  const target = LEGACY_APP_REDIRECTS[pathname];
  if (!target) return null;
  const params = new URLSearchParams();
  for (const key of target.keys) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return `/app/#/${target.view}${query ? `?${query}` : ''}`;
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
  return null;
}
```

In the router dispatch, retain the existing `/admin` loopback check first. Immediately after it, redirect only allowed requests:

```js
const compatibilityLocation = legacyRedirectLocation(parsedUrl.pathname, parsedUrl.searchParams);
if (compatibilityLocation) return sendRedirect(res, compatibilityLocation);
```

Delete the root-specific redirect branch from `serveStatic`; compatibility routing now owns root and legacy routing in one place.

- [ ] **Step 4: Add a no-reverse-navigation regression test**

Create `test/legacy-ui-retirement.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_APP_REDIRECTS } from '../src/router.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every legacy operator document has an explicit React redirect destination', () => {
  assert.deepEqual(Object.keys(LEGACY_APP_REDIRECTS).sort(), [
    '/admin/ai.html', '/admin/analytics.html', '/admin/arbitrage.html', '/admin/bookies.html',
    '/admin/live.html', '/admin/login.html', '/admin/scanner.html', '/admin/scrape.html',
    '/admin/settings.html', '/admin/workstation.html',
  ]);
});

test('the active React shell and public root contain no legacy admin navigation', () => {
  for (const path of ['frontend/src/App.tsx', 'frontend/src/SettingsWorkspace.tsx', 'public/index.html']) {
    assert.doesNotMatch(read(path), /href=["']\/admin\//, path);
  }
});
```

- [ ] **Step 5: Replace `public/index.html` with a non-UI compatibility fallback**

Replace the legacy markup with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=/app/#/dashboard" />
    <title>Arbiter</title>
  </head>
  <body>
    <p><a href="/app/#/dashboard">Open Arbiter</a></p>
  </body>
</html>
```

The router still controls normal requests; this document is only a safe fallback if it is served by a static host without `router.mjs`.

- [ ] **Step 6: Verify redirect security and retirement tests**

Run:

```bash
node --test test/router.test.mjs test/legacy-ui-retirement.test.mjs
```

Expected: all paths redirect on loopback; all `/admin/*` paths stay concealed for non-loopback requests; no active page points back at a legacy admin URL.

- [ ] **Step 7: Commit compatibility redirects**

```bash
git add src/router.mjs public/index.html test/router.test.mjs test/legacy-ui-retirement.test.mjs
git commit -m "feat: redirect legacy operator pages to React workspaces"
```

---

### Task 9: Enforce React gateway ownership and legacy parity coverage

**Files:**
- Create: `test/react-api-boundary.test.mjs`
- Modify: `test/api-surface.test.mjs:324-390`
- Modify: `test/legacy-ui-retirement.test.mjs`

- [ ] **Step 1: Write failing source-boundary tests**

Create `test/react-api-boundary.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FRONTEND = join(ROOT, 'frontend', 'src');

function files(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test('api.ts is the only React source allowed to own browser network primitives', () => {
  const offenders = files(FRONTEND)
    .filter((file) => !file.endsWith(join('frontend', 'src', 'api.ts')))
    .filter((file) => /\bfetch\s*\(|\bnew\s+EventSource\s*\(/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

test('the typed gateway exposes every legacy operational route family', () => {
  const api = readFileSync(join(FRONTEND, 'api.ts'), 'utf8');
  for (const name of [
    'fetchScan', 'runCustomScan', 'runVerification', 'fetchScrapeState', 'fetchLatestScrapeRun',
    'startScrape', 'cancelScrape', 'fetchScrapers', 'fetchProfiles', 'fetchSports',
    'fetchScheduler', 'saveScheduler', 'fetchLiveStatus', 'saveLiveStatus', 'fetchBookOdds',
    'fetchAlerts', 'saveAlerts', 'fetchTracker', 'fetchCatalog', 'snapshotUrl',
  ]) assert.match(api, new RegExp(`export (?:async )?function ${name}\\b`), name);
});
```

- [ ] **Step 2: Run the new source-boundary tests to verify their current failures or gaps**

Run:

```bash
node --test test/react-api-boundary.test.mjs test/legacy-ui-retirement.test.mjs
```

Expected before final cleanup: `legacy-ui-retirement` fails if a React/public active file still contains an admin link; otherwise both pass after Tasks 3–8.

- [ ] **Step 3: Update the API surface audit to distinguish active React from retired legacy consumers**

In `test/api-surface.test.mjs`, leave the existing public/electron route census intact because legacy source remains on disk temporarily. Add a second assertion reading `test/react-api-boundary.test.mjs` is not sufficient: explicitly assert that all routes used by the retired pages have typed React gateway coverage through a named map.

Add after the existing route-closure test:

```js
test('every legacy operational route family has a named React gateway owner', () => {
  const api = read('frontend/src/api.ts');
  const owners = {
    '/api/scan': ['fetchScan', 'runCustomScan', 'buildScanExportUrl'],
    '/api/verify': ['runVerification'],
    '/api/scrape/state': ['fetchScrapeState'],
    '/api/scrape-run': ['fetchLatestScrapeRun'],
    '/api/scrape': ['startScrape', 'cancelScrape'],
    '/api/scrapers': ['fetchScrapers'],
    '/api/sports': ['fetchSports'],
    '/api/profiles': ['fetchProfiles'],
    '/api/scheduler': ['fetchScheduler', 'saveScheduler'],
    '/api/live': ['fetchLiveStatus', 'saveLiveStatus'],
    '/api/odds': ['buildBookOddsUrl', 'fetchBookOdds'],
    '/api/alerts': ['fetchAlerts', 'saveAlerts'],
    '/api/tracker': ['fetchTracker', 'addTrackedBet', 'updateTrackedBet', 'deleteTrackedBet'],
    '/api/catalog': ['fetchCatalog'],
  };
  for (const [route, names] of Object.entries(owners)) {
    for (const name of names) assert.match(api, new RegExp(`\\b${name}\\b`), `${route} lacks ${name}`);
  }
});
```

This test does not treat a comment as a consumer and does not require TypeScript to be parsed by the Espree helper.

- [ ] **Step 4: Run all migration regression tests**

Run:

```bash
node --test test/frontend-shell.test.mjs test/frontend-normalize.test.mjs test/frontend-filter-parity.test.mjs test/frontend-operator-ui.test.mjs test/react-api-boundary.test.mjs test/legacy-ui-retirement.test.mjs test/router.test.mjs test/app-shell.browser.test.mjs test/api-surface.test.mjs
```

Expected: `fail 0`.

- [ ] **Step 5: Commit architecture enforcement**

```bash
git add test/react-api-boundary.test.mjs test/api-surface.test.mjs test/legacy-ui-retirement.test.mjs
git commit -m "test: enforce React API ownership and legacy parity"
```

---

### Task 10: Complete audit, production build, and full suite verification

**Files:**
- Modify: `README.md` (only if it still calls `/admin/*.html` the primary UI)
- Modify: `docs/superpowers/specs/2026-11-04-react-operator-ui-consolidation-design.md` (mark implementation status only after all commands pass)
- Test: full repository suite

- [ ] **Step 1: Update user-facing entry documentation**

Search documentation and package scripts for active legacy UI instructions:

```bash
rg -n "admin/(arbitrage|scrape|scanner|live|bookies|analytics|ai|settings|login|workstation)\.html|Legacy workstation|classic operator" README.md docs package.json electron public/index.html
```

Replace active usage instructions with these concrete routes:

```md
- Operator application: `http://127.0.0.1:3022/app/#/dashboard`
- Opportunity terminal: `http://127.0.0.1:3022/app/#/opportunities`
- Scrape and automation controls: `http://127.0.0.1:3022/app/#/scanner`
- Legacy `/admin/*.html` bookmarks are local-only compatibility redirects.
```

Do not remove historical documentation that describes the migration; label it historical rather than active usage.

- [ ] **Step 2: Build and typecheck the production React application**

Run:

```bash
npm run typecheck
npm run build:frontend
```

Expected:

```text
exit code 0
public/app/index.html exists
```

- [ ] **Step 3: Execute focused browser and migration suites against the built app**

Run:

```bash
node --test test/app-shell.browser.test.mjs test/router.test.mjs test/legacy-ui-retirement.test.mjs test/react-api-boundary.test.mjs
```

Expected: `fail 0`.

- [ ] **Step 4: Execute the complete test suite**

Run:

```bash
npm test
```

Expected:

```text
fail 0
```

Do not claim completion if the suite reports a failure, cancellation, or parser error.

- [ ] **Step 5: Perform an objective completion audit**

Run:

```bash
rg -n "href=[\"']\/admin\/|location\.(assign|replace|href).*\/admin\/" frontend/src public/index.html
rg -n "\bfetch\s*\(|\bnew\s+EventSource\s*\(" frontend/src --glob '!api.ts'
node --test test/legacy-ui-retirement.test.mjs test/react-api-boundary.test.mjs
```

Expected:

```text
no matches from either rg command
fail 0
```

Then verify each approved route directly in router test output or with the table in `test/router.test.mjs`:

- `/` and `/index.html` → `/app/#/dashboard`
- workstation/arbitrage → `/app/#/opportunities`
- scanner/scrape → `/app/#/scanner`
- live → `/app/#/live`
- bookies → `/app/#/bookmakers`
- analytics → `/app/#/analytics`
- ai → `/app/#/insights`
- settings → `/app/#/settings`
- login → `/app/#/local-access`

- [ ] **Step 6: Update the approved design status and commit the verified release**

After every command above passes, change the first line under Status in `docs/superpowers/specs/2026-11-04-react-operator-ui-consolidation-design.md` to:

```md
**Status:** Implemented and verified
```

Commit only the documentation and any final user-facing route text:

```bash
git add README.md docs/superpowers/specs/2026-11-04-react-operator-ui-consolidation-design.md
git commit -m "docs: document React-only operator interface"
```

---

## Explicit non-goals for this implementation

- Do not alter scanning, scraper, verification, scheduler, tracker, alert-engine, or settlement business logic just to move UI ownership.
- Do not add remote authentication, credential storage, automatic bet placement, or bookmaker-control bypass.
- Do not reintroduce a browser editor for `config/scrapers.json` without a backend mutation contract, validation, and security review.
- Do not delete all legacy static assets in this plan. They are inactive after redirects; deleting them is a separately reviewable cleanup after the compatibility period.
