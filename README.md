# Arbiter

Local-first sports arbitrage scanner with configuration and support for 24 Romanian bookmakers.
Binds to `127.0.0.1` and stores all application state locally. Bookmaker discovery uses Playwright and native public HTTP feeds.

## Stack

- Node.js ≥ 20, pure ESM, no TypeScript, no bundler, no transpilation.
- Electron desktop shell (`electron/main.mjs`).
- Vanilla HTML / CSS / JS in `public/` (no framework).
- Playwright for rendered public-page discovery and endpoint observation.
- Public read-only bookmaker feeds

## Architecture

**One server entrypoint** -- `src/server.mjs` (`npm start`) constructs the
services and hands every request to `router.mjs`, which owns the route table.
The services it wires (`scrape-orchestrator.mjs`, `scan-service.mjs`,
`scheduler-service.mjs`, `tracker-service.mjs`, `state-broadcaster.mjs`) are
each independently testable. There used to be a second entrypoint,
`server-modular.mjs`, carrying a duplicate route table that drifted from the
router's; it was removed so a fix cannot land in one copy and miss the other.

**Frontend design tokens** -- all visual values (colors, spacing, radii, motion,
shadows) are CSS custom properties in `public/css/design-tokens.css`, imported
by `public/css/theme.css`. Light mode is opt-in via `data-theme="light"` on
`<html>`. Page-specific CSS files (`dashboard.css`, `scanner.css`, etc.) extend
the shared theme. Scripts load in order via `<script>` tags (no bundler):
`api.js` -> `i18n.js` -> `sse.js` -> `app.js` -> `common.js` ->
`connection-status.js` -> page script. Every module exposes a `window.*` global.

**Connection status** -- `connection-status.js` auto-wires into the SSE client
and updates a consistent status chip on every page. Error toasts are surfaced
via wrapped `arbiterApi` methods.

See `DESIGN.md` for the full design-system documentation.

## Quick start

```bash
npm install
npm start                # node src/server.mjs  →  http://127.0.0.1:3022
npm run desktop          # Electron shell (production-like)
npm run desktop:dev      # Electron with DevTools open
npm test                 # node --test test/*.test.mjs
npm run lint
```

## Environment variables

| Var                                  | Default        | Notes                                                 |
| ------------------------------------ | -------------- | ----------------------------------------------------- |
| `PORT`                               | `3022`         | HTTP port the dashboard binds to.                     |
| `HOST`                               | `127.0.0.1`    | Bind host. Keep loopback.                             |
| `PUBLIC_HOSTS`                       | _unset_        | Comma-separated extra hosts allowed to hit `/api/*`.  |
| `ARBITER_DATA_DIR`                   | `./data`       | Runtime workspace and discovery data directory.       |
| `ARBITER_SCHEDULER_INTERVAL_MINUTES` | `15`           | How often the scheduler triggers a full cycle.        |
| `ARBITER_SCRAPE_PARALLEL`            | `4`            | Max parallel scrapers per cycle.                      |
| `ARBITER_TIMEOUT_<SCRAPER>`          | _(inherited)_  | Per-bookmaker timeout override in ms.                 |
| `ARBITER_MAX_ATTEMPTS_<SCRAPER>`     | _(inherited)_  | Per-bookmaker retry-count override.                   |
| `ARBITER_NO_LISTEN`                  | _unset_        | Set to `1` to start then immediately close (tests).   |
| `ARBITER_DEV`                        | _unset_        | Set to `1` for desktop dev mode (DevTools + verbose). |

## Layout

```
arbiter/
├── src/
│   ├── server.mjs                # entrypoint: builds services, delegates to the router
│   ├── router.mjs                # HTTP routing + body parsing
│   ├── scrape-orchestrator.mjs   # scrape + verify lifecycle
│   ├── scan-service.mjs          # workspace scan persistence
│   ├── scheduler-service.mjs     # recurring cycles
│   ├── tracker-service.mjs       # bet tracker, CSV import/export, alerts
│   ├── state-broadcaster.mjs     # SSE clients + heartbeat
│   ├── scraper-service.mjs       # runs ScraperBase child processes
│   ├── verification.mjs          # re-scrape only involved books
│   ├── scrapers/                 # one file per bookmaker
│   │   ├── base.mjs              # ScraperBase contract
│   │   ├── provider-contract.mjs # swappable parser
│   │   ├── altenar-provider.mjs  # shared Altenar parser
│   │   ├── altenar-sites.mjs     # Don/TopBet/Million/Baumbet/Winbet
│   │   ├── superbet.mjs
│   │   ├── betano.mjs
│   │   ├── ...                   # one file per remaining bookmaker
│   └── scanner/
│       ├── scanner.mjs           # scanWorkspace() entry point
│       ├── engine.mjs            # matching + arb/middle/EV/low-hold math
│       ├── market-contracts.mjs  # canonical market contracts + stake allocation
│       └── market-catalog.mjs
├── public/
│   ├── index.html                # visitor dashboard
│   ├── admin/                    # admin pages
│   └── css/theme.css             # dark theme tokens
├── electron/
│   ├── main.mjs                  # Electron entry
│   └── preload.mjs               # contextBridge IPC
├── config/
│   ├── scrapers.json             # the scraper registry (source of truth)
│   └── scan-profiles.json        # trusted + review scan profiles
├── data/                         # runtime state (gitignored)
│   ├── workspace/<book>_events.json   # one per bookmaker (atomic-promoted)
│   ├── staging/<book>_<ts>.json       # write-then-promote buffer
│   ├── discovery/<book>_links.json     # rendered routes, tournaments, event URLs
│   ├── latest-*.json                  # canonical pointers
│   └── bet-tracker.json
└── test/
```

## Public endpoint pipeline

A source can use either a bookmaker's validated public read-only offer feed or the public endpoint adapters:

1. The validated Superbet source reads its current public offer v3 feed directly, records the exact feed URL and capture metadata, and keeps only standard complete 1X2 markets.
2. The Unibet candidate observes the bookmaker-owned public sports API response loaded by its football page; the Betano candidate reads only publicly rendered prematch rows. Other experimental sources remain API-pending until a native adapter is verified. Every candidate remains disabled until a current bounded smoke validates its route, parser, provenance, and freshness.

`maxDiscoveredMatches`, `maxLiveMatches`, `maxTournaments`, and `maxMatches` in `config/scrapers.json` are safety limits; `maxMatches` controls how many discovered links are extracted in one cycle.

Set `ARBITER_MAX_EVENTS_PER_BOOK` to a positive integer for a bounded per-book result count, or to `all` to retain every qualifying event available from each provider's bounded public feed/window. `all` does not fabricate events or bypass upstream pagination, browser gating, lookahead windows, rate limits, or abort/timeouts; provider availability determines the actual count.

As of 2026-09-01, **Superbet is the only enabled validated source**. Unibet's dedicated public sports API v2 adapter completed one bounded smoke with fresh provenance, but three immediate repeat validations timed out, so it remains experimental and disabled until it is reliably repeatable. Betano also remains experimental and disabled because its bounded local smoke received upstream HTTP 403. Arbiter neither bypasses these protections nor reports the unavailable sources as empty.

## Adding a new bookmaker

1. Add the browser routes and link patterns to `config/scrapers.json`:

   ```js
   newbook: {
     id: 'newbook',
     name: 'Newbook',
     baseUrl: 'https://newbook.example/sport/football',
     liveUrl: 'https://newbook.example/live/football',
     discoveryStrategy: 'browser-only',
     eventUrlPattern: '[/]event[/]',
     tournamentUrlPattern: '[/]league[/]',
     maxMatches: 20,
   }
   ```

2. Add an entry to `config/scrapers.json` as experimental and disabled:

   ```json
   {
     "id": "newbook",
     "name": "Newbook (public endpoint pending)",
     "enabled": true,
     "validationStatus": "experimental",
     "engine": "api-pending",
     "transport": "api-pending",
     "script": "pending.mjs",
     "sourceIds": ["newbook"]
   }
   ```

3. Run `node scripts/endpoint-collector.mjs https://newbook.example/sport/football newbook`. Inspect `data/endpoints/newbook_api.json`; the collector records request method, full URL, status, content type, source page, and capture time for each same-origin JSON endpoint.
4. Set `enabled: true` and `validationStatus: "validated"` only after the bounded smoke proves fresh kickoff, complete 1X2, source URL, transport, and run provenance. The orchestrator and scheduler reject every other status.

The registry is the source of truth, but validation is a required promotion gate rather than a configuration shortcut.

## Multi-sport architecture

Arbiter has a central **sport registry** (`src/sports/registry.mjs`) that the
router and the scrape orchestrator both read, so the UI never offers a filter
that cannot be served.

### Supported sports

| Sport | Draw outcome | Scraper status | Key markets |
|---|---|---|---|
| Football | draw | Active (bookmaker-specific scrapers) | MATCH_ODDS, OVER_UNDER, DOUBLE_CHANCE, BTTS, HANDICAP |

Football is the only registered sport. Every feed in `config/scrapers.json`
currently returns prematch football, and each active job declares
`"supportedSports": ["football"]` — that array is what the orchestrator's sport
filter matches on.

Tennis, basketball, ice hockey, volleyball and handball are deliberately not
served. Registering them made the dropdown offer options that always failed:
those jobs are `sport-generic` stubs with no adapter file, so selecting one
returned `no enabled bookmaker jobs selected` (HTTP 400). They remain in the
config, disabled, as the placeholders for when real adapters land.

### How it works

1. **Sport registry** (`src/sports/registry.mjs`) — a plain table of
   `{ id, name, hasDraw, markets }`. `getSport(id)` validates a filter and
   `sportOptions()` feeds the dropdown; the same table therefore drives both
   validation and what the UI shows.

2. **Job capability** (`config/scrapers.json`) — a job opts into a sport with
   `supportedSports`. A job with no such array cannot vouch for any sport and
   is excluded whenever a filter is active.

3. **Sport filter** (`src/scrape-orchestrator.mjs`) — one predicate
   (`jobMatchesSport`) decides which jobs are runnable. The id set and the
   default selection both use it, so they cannot disagree and leave the
   selection empty.

4. **Market contracts** (`src/scanner/market-contracts.mjs`) — market keys are
   canonicalised to a contract (`MATCH_ODDS`, `OVER_UNDER_*`, …) before the
   engine pairs legs, which is what stops a 2-way market being arbitraged
   against a 3-way one.

### Adding a new sport

1. Write the per-sport adapter under `src/scrapers/`.
2. Add a job in `config/scrapers.json` with `"supportedSports": ["your-sport"]`,
   pointing `script` at that adapter, and set `enabled: true`.
3. Register the sport in `src/sports/registry.mjs` — only once step 2 works,
   so the dropdown and the orchestrator stay in agreement.
4. If the sport's result market settles without a draw (tennis, volleyball),
   its market keys need their own contract; `hasDraw` in the registry records
   the intent but the contract table is what the engine actually consults.

## Two scan profiles

- **Trusted · Prematch** (`trusted-prematch`) — independent feeds with plausibility
  checks. Default bankroll 1000 RON, ROI ≥ 0%, middle risk ≤ 15%, middle ROI ≥ 20%.
- **Review · Live + Past** (`review-live`) — lower-confidence feeds that include
  live + past markets. Bankroll 500 RON, ROI ≥ 1%, middle risk ≤ 10%, middle ROI ≥ 30%.
  Always verify prices before staking.

## HTTP API

All routes are loopback-only; mutations require the `x-arbiter-token` CSRF header (fetch `GET /api/csrf` first).

- `GET /api/health` — liveness + uptime.
- `GET /api/scan` — latest published scan (opportunities, middles, positiveEv, lowHold, sources, dataHealth). `dataHealth.status` is worst-per-source: `fresh` if any source is fresh, else `stale` > `partial` > `failed` > `empty`; `dataHealth.actionableSourceCount` is the number of fresh sources.
- `POST /api/scan` — run a scan now with `{ bankroll, minRoiPercent, minEvPercent, maxMiddleRiskPercent, minMiddleRoiPercent, includeLive, includePast, sport }` (not published). `minRoiPercent` (default 0) gates arbitrage; `minEvPercent` (default 2) gates positive-EV signals and is separate, because a leg priced exactly at the consensus is not an edge. Optional `sport` (currently only `"football"`) filters events and scrapers.
- `GET /api/sports` — list registered sports with id and display name.
- `GET /api/scan/export.csv` — download scan findings as CSV; optional `?type=opportunities,middles,positiveEv,lowHold` filter.
- `GET /api/scrape/state` · `POST /api/scrape` · `POST /api/scrape/cancel` — scrape pipeline control.
- `GET /api/scrapers` — bookmaker registry (jobs, enabled, validated).
- `GET /api/scheduler` · `POST /api/scheduler` — recurring cycle config.
- `GET /api/tracker` · `POST /api/tracker` · `PUT/DELETE /api/tracker/:id` — bet tracker; `GET /api/tracker/export.csv` and `POST /api/tracker/import` for CSV round-trips.
- `GET /api/alerts` · `POST /api/alerts` — alert preferences.
- `GET /api/events` — SSE stream of pipeline + scan updates.

## Security model

- `/api/*` accepts loopback only unless `PUBLIC_HOSTS` is set.
- Mutations require `x-arbiter-token: <csrf>` and a loopback `Origin`.
- Static files served only from `public/`, no path traversal.
- CSP locked to `default-src 'self'`; interactive pages load only same-origin scripts and styles, with no remote font or script dependency.
- Actionable opportunities require a fresh snapshot, a complete supported market contract, and legs from at least two bookmaker sources; unverified, stale, partial, and unsupported data stays informational.
- Each workspace snapshot records its run ID, capture time, and data-health status so the dashboard can show whether data is fresh, empty, partial, stale, or failed.
- Atomic writes use unique temp files plus rename — concurrent writers never share a temporary path.

## Caveats

The scrape layer is **configuration**, not magic. Romanian bookmakers change routes, consent screens, anti-bot layers, and link formats regularly. Validate every bookmaker with the discovery smoke test before enabling large extraction batches.

### Live-data readiness

The served dashboard intentionally contains no demo odds or synthetic opportunity data. The static design reference lives in `design-preview/`, outside the server's public web root, and must never be used for decisions.

A source is **actionable** only when all of these hold for its most recent snapshot:

- `dataStatus` is `fresh` (captured within the staleness window, see `src/shared/data-quality.mjs`).
- The snapshot records a `runId`, `sourceUrl`, and `transport` (provenance).
- The market is a complete, supported contract (see `src/scanner/market-contracts.mjs`) with a full 1X2 or equivalent selection set.
- Legs come from at least **two different bookmakers** — a single-book "arb" is always rejected.
- Legs also come from **two different upstream feeds**: brands resold from one provider are listed in `src/scanner/feed-groups.mjs` and are never paired, because their prices are one feed counted twice.

Why a scan may legitimately come back empty is measured, not assumed: see
`docs/no-arbitrage-root-cause.md`, which re-measures seven live captures and
finds the best available cross-feed return to be negative — the market is
arbitraged, not mis-scanned.

Status as of this writing: 22 of the 29 configured jobs are enabled and
implemented against verified public endpoints; `unibet`, `mozzartbet` and the
five `sport-generic` stubs stay disabled because repeatable real-source
validation did not pass for them. `SCRAPER-TASKS.md` tracks per-book status.

