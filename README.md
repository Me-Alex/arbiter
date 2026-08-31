# Arbiter

Local-first sports arbitrage scanner for 18 Romanian bookmakers.
Binds to `127.0.0.1` and stores all application state locally. Bookmaker browser automation and odds extraction use TinyFish.

## Stack

- Node.js ≥ 20, pure ESM, no TypeScript, no bundler, no transpilation.
- Electron desktop shell (`electron/main.mjs`).
- Vanilla HTML / CSS / JS in `public/` (no framework).
- TinyFish remote browsers plus Playwright for rendered link discovery.
- TinyFish automation agents for structured extraction from individual event pages.

## Quick start

```bash
npm install
npm install -g @tiny-fish/cli
tinyfish auth login
tinyfish auth status
npm start                # node src/server.mjs  →  http://127.0.0.1:3022
npm run desktop          # Electron shell (production-like)
npm run desktop:dev      # Electron with DevTools open
npm test                 # node --test test/*.test.mjs
npm run lint
npm run tinyfish:diagnose -- betano fortuna
npm run tinyfish:discover -- superbet 10
npm run tinyfish:smoke -- superbet 2
```

## Environment variables

| Var                                  | Default        | Notes                                                 |
| ------------------------------------ | -------------- | ----------------------------------------------------- |
| `PORT`                               | `3022`         | HTTP port the dashboard binds to.                     |
| `HOST`                               | `127.0.0.1`    | Bind host. Keep loopback.                             |
| `PUBLIC_HOSTS`                       | _unset_        | Comma-separated extra hosts allowed to hit `/api/*`.  |
| `ARBITER_DATA_DIR`                   | `./data`       | Runtime workspace and discovery data directory.       |
| `ARBITER_SCHEDULER_INTERVAL_MINUTES` | `15`           | How often the scheduler triggers a full cycle.        |
| `ARBITER_DEV`                        | _unset_        | Set to `1` for desktop dev mode (DevTools + verbose). |
| `TINYFISH_API_KEY`                   | saved CLI key  | Optional alternative to `tinyfish auth login`.        |
| `TINYFISH_BIN`                       | auto-detected  | Override the TinyFish executable or JS entrypoint.    |
| `TINYFISH_CONCURRENCY`               | `2`            | Global cap across browser and agent operations.       |

## Layout

```
arbiter/
├── src/
│   ├── server.mjs                # legacy monolith (also the standalone entrypoint)
│   ├── server-modular.mjs        # new modular entrypoint
│   ├── router.mjs                # HTTP routing + body parsing
│   ├── scrape-orchestrator.mjs   # scrape + verify lifecycle
│   ├── scan-service.mjs          # workspace scan persistence
│   ├── scheduler-service.mjs     # recurring cycles
│   ├── tracker-service.mjs       # bet tracker, CSV import/export, alerts
│   ├── state-broadcaster.mjs     # SSE clients + heartbeat
│   ├── scraper-service.mjs       # runs ScraperBase child processes
│   ├── verification.mjs          # re-scrape only involved books
│   ├── tinyfish/                  # browser discovery, agent client, extraction
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
│       ├── engine.mjs            # matching + arb/middle math
│       ├── bookmaker-signals.mjs # positive EV + low hold
│       ├── bankroll-allocation.mjs
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

## TinyFish pipeline

Each configured bookmaker runs in two phases:

1. A TinyFish remote browser renders the prematch route and, when configured, the live route. Playwright reads real anchor URLs, follows discovered tournament pages, removes duplicate market-tab links, and records whether each event is live.
2. Arbiter persists the complete bounded discovery set to `data/discovery/<book>_links.json`. It then sends a cost-capped mix of prematch and live event URLs to TinyFish agents for structured odds extraction.

The global queue allows two TinyFish operations at once. Agent runs are cancelled on timeout. `maxDiscoveredMatches`, `maxLiveMatches`, `maxTournaments`, and `maxMatches` in `src/tinyfish/books.mjs` are safety limits; `maxMatches` controls how many discovered links are extracted in one cycle.

Superbet and Powerbet currently have live-validated browser routes and event URL patterns. Other entries are configured browser-first but still require route and pattern validation against their current rendered sites. Browser discovery is `browser-only` by default so an unvalidated landing page does not silently spend agent runs trying to invent links.

## Adding a new bookmaker

1. Add the browser routes and link patterns to `src/tinyfish/books.mjs`:

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

2. Add an entry to `config/scrapers.json`:

   ```json
   {
     "id": "newbook",
     "name": "Newbook (TinyFish)",
     "enabled": true,
     "engine": "tinyfish",
     "script": "tinyfish-scraper.mjs",
     "sourceIds": ["newbook"]
   }
   ```

3. Run `npm run tinyfish:discover -- newbook 10`. Inspect the discovered URLs before running `npm run tinyfish:smoke -- newbook 2` and confirming `data-smoke/workspace/newbook_events.json`.

That's the entire wiring — the registry is the source of truth.

## Two scan profiles

- **Trusted · Prematch** (`trusted-prematch`) — independent feeds with plausibility
  checks. Default bankroll 1000 RON, ROI ≥ 0%, middle risk ≤ 15%, middle ROI ≥ 20%.
- **Review · Live + Past** (`review-live`) — lower-confidence feeds that include
  live + past markets. Bankroll 500 RON, ROI ≥ 1%, middle risk ≤ 10%, middle ROI ≥ 30%.
  Always verify prices before staking.

## Security model

- `/api/*` accepts loopback only unless `PUBLIC_HOSTS` is set.
- Mutations require `x-arbiter-token: <csrf>` and a loopback `Origin`.
- Static files served only from `public/`, no path traversal.
- CSP locked to `default-src 'self'`; interactive pages load only same-origin scripts and styles, with no remote font or script dependency.
- Actionable opportunities require a fresh snapshot, a complete supported market contract, and legs from at least two bookmaker sources; unverified, stale, partial, and unsupported data stays informational.
- Each workspace snapshot records its run ID, capture time, and data-health status so the dashboard can show whether data is fresh, empty, partial, stale, or failed.
- Atomic writes use unique temp files plus rename — concurrent writers never share a temporary path.

## Caveats

The scrape layer is **configuration**, not magic. Romanian bookmakers change routes, consent screens, anti-bot layers, and link formats regularly. Validate every bookmaker with the discovery smoke test before enabling large extraction batches. TinyFish usage is metered, and live prices can move before verification completes.

The served dashboard intentionally contains no demo odds or synthetic opportunity data. The static design reference lives in `design-preview/`, outside the server's public web root, and must never be used for decisions.
