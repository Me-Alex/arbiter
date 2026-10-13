# Arbiter

Local-first sports arbitrage scanner with configuration and support for 28 Romanian bookmakers.
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
`scheduler-service.mjs`, `live-service.mjs`, `tracker-service.mjs`,
`state-broadcaster.mjs`) are
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

### Checking a change

The unit suite is offline and fast; it cannot tell you that a bookmaker still
answers. These can, and they are how the defects in this project were mostly
found:

| Command | Answers |
|---|---|
| `npm run ci:preflight` | Would the CI workflow work? Runs its commands, and checks what a developer machine never does: path casing, the browser install, a single `on:` block, the pinned Node version. Add `--clean` to rehearse a fresh install. |
| `npm run smoke:live` | Does every enabled book still return usable events? Fails on zero events or a non-`ok` status. Pass book names to check a subset. |
| `npm run smoke:trend` | Has a book been failing repeatedly? Reads the archived reports and fails on a pattern rather than a bad day. |
| `npm run measure` | Is there a cross-feed arbitrage right now? Records a round in `data/measurements.jsonl`, so the series grows instead of being re-derived by hand. |
| `npm run measure:sync` | Does the table in `docs/no-arbitrage-root-cause.md` still match the journal? Exits non-zero on drift. |
| `npm run live-check -- <book>...` | Per-adapter detail against the real feed: bytes, timings, which guard rejected a response. Reports; never fails. |

`smoke:live` is the one that matters most, because a scraper which collects
nothing reports success and looks like a quiet market day.

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
│   ├── live-service.mjs          # in-play poll on the live clock
│   ├── tracker-service.mjs       # bet tracker, CSV import/export, alerts
│   ├── state-broadcaster.mjs     # SSE clients + heartbeat
│   ├── scraper-service.mjs       # runs ScraperBase child processes
│   ├── verification.mjs          # re-scrape only involved books
│   ├── scrapers/                 # one file per bookmaker
│   │   ├── index.mjs             # registry: exact (engine, transport, script) contract
│   │   ├── base.mjs              # ScraperBase contract
│   │   ├── provider-contract.mjs # swappable parser
│   │   ├── nsoft.mjs             # one adapter, several tenants (admiral/stanleybet/maxbet)
│   │   ├── altenar-public.mjs    # one adapter, six Altenar tenants
│   │   ├── excelbet.mjs          # base for winboss/las-vegas/magnumbet
│   │   ├── superbet.mjs
│   │   ├── betano.mjs
│   │   └── ...                   # one file per remaining bookmaker
│   └── scanner/
│       ├── scanner.mjs           # scanWorkspace() entry point
│       ├── engine.mjs            # matching + arb/middle/EV/low-hold math
│       ├── market-contracts.mjs  # canonical market contracts + stake allocation
│       ├── feed-groups.mjs       # which brands resell one upstream feed
│       ├── league-aliases.mjs    # whether two competition labels name one competition
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
├── data/                         # two different kinds of thing, see below
│   ├── workspace/<book>_events.json   # one per bookmaker (atomic-promoted)
│   ├── staging/<book>_<ts>.json       # write-then-promote buffer
│   ├── discovery/<book>_links.json     # rendered routes, tournaments, event URLs
│   ├── latest-*.json                  # canonical pointers
│   ├── bet-tracker.json               # the user's own bets
│   ├── scrape-state.json              # scrape orchestrator: last run, per book
│   ├── scheduler-state.json           # scheduler: interval, last cycle
│   ├── live-state.json                # live poll: interval, last duration, skips
│   └── endpoints/                     # provider evidence: endpoints.json + 108 captures
├── data-market-run/              # one frozen 24-book capture, versioned on purpose
│   ├── workspace/<book>_events.json
│   └── all-market-report.json
├── scripts/                      # maintenance and measurement commands
└── test/
```

`data-market-run/` is a top-level directory that looks like leftover output and
is not. It is versioned, and it is load-bearing in two places:
`scripts/gen-league-translations.mjs` reads its `workspace/` to regenerate
`src/scanner/league-translations.mjs`, and `src/scanner/feed-groups.mjs` plus
`src/scanner/league-aliases.mjs` both name it as the capture their hardcoded
tables were derived from. It is the only complete multi-book capture kept, so
the derived tables can be rebuilt from a known input rather than from whatever
the books happen to be quoting today.

### What `data/` actually holds

`data/` is not one thing, and the split is deliberate. Getting it backwards is
how a capture gets deleted or an evidence file gets ignored.

| | Contents | In git? |
| --- | --- | --- |
| **Runtime** | `workspace/`, `staging/`, `discovery/`, `backups/`, `latest-*.json`, `bet-tracker.json`, `measurements.jsonl` | No — written by the app, rebuilt by the next cycle |
| **Service state** | `scrape-state.json`, `scheduler-state.json`, `live-state.json` | Yes — each is a service's own last-known state and its settings |
| **Provider evidence** | `endpoints/` (109 files, ~11 MB) | Yes — the recorded basis for every claim about a bookmaker's feed |

`endpoints/` is the exception that gives `data/` its bad name: it is reference
material, not runtime output. It is the only versioned directory under `data/`,
`src/shared/endpoints.mjs` reads `endpoints.json` from it at runtime, and the
per-book captures under it are cited by name in the adapter comments and in the
"Public endpoint pipeline" section below. It is deliberately not ignored — a
provider's response shape is the thing most likely to change without notice, so
it is the thing most worth being able to diff.

The service-state files are versioned because they carry the settings the admin
pages set (intervals, and whether a cycle is running), and a settings change
should show up in a diff rather than only on the machine that made it. They also
change on their own, which is the one cost of this arrangement.

### Scripts you have to run by path

Most of `scripts/` is reachable through `npm run`, and the verification commands
are tabulated under [Checking a change](#checking-a-change). The eight below
have **no `npm run` entry at all**, because each is either one-off, needs a
browser attached over CDP, or regenerates a source file rather than reporting on
the running app:

| Script | What it is for |
| --- | --- |
| `gen-league-translations.mjs` | **Regenerates a source file.** Rewrites `src/scanner/league-translations.mjs` from the captures in `data/workspace` and `data-market-run/workspace`. The competition-alias table is derived, not hand-written; if you change how aliases are matched, this is how the table is rebuilt. |
| `sample.mjs` | Repeated live capture over hours, reporting the distribution of the best cross-feed return. Answers whether a near-zero result in one capture is stable or an accident. |
| `smoke.mjs` | Quick hit test against an already-running server on `127.0.0.1:3022`. Note the port is hardcoded, so it ignores `PORT`. |
| `discover-unibet.mjs` | Loads Unibet's sportsbook in a real browser and records the requests it makes, to find a replacement for the retired Kambi path. Observes only. |
| `probe-unibet-feed.mjs` | Captures the full URL of those sports calls, then replays one without a browser to test whether the feed is genuinely public. |
| `inspect-event-element.mjs` | Playwright element inspector over CDP. Needs `CDP_URL`; `MATCH_TEXT` selects the element. |
| `inspect-tinyfish-browser.mjs` | Playwright browser/context inspector over CDP. Needs `CDP_URL`. |
| `test-cli.bat` | Windows-only Tinyfish CLI smoke test, hardcoded to one machine's absolute path. Local scratch, kept out of `npm run` on purpose. |

## Public endpoint pipeline

A source uses a bookmaker's own public, unauthenticated, read-only offer feed, reached either by a plain HTTP client or — where the host gates a bare request — from a real browser navigation context, exactly as a visitor's browser would load it. No credentials are used, and no challenge or access control is bypassed.

28 jobs are enabled across twelve platform families, and those 28 brands resolve to **12 independent price sources**. The platform, not the brand, is what decides whether a source is worth adding: `src/scanner/feed-groups.mjs` refuses to pair two brands that resell one upstream feed, because a price gap between them is a capture artifact rather than an edge.

| Platform | Enabled brands | Independent? |
|---|---|---|
| NSoft | admiral, stanleybet, maxbet, betmen | admiral/stanleybet are one company feed; maxbet and betmen are independent tenants, each with its own football sport id and result-market ids |
| Exalogic XSport | excelbet, winboss, las-vegas, magnumbet | one feed |
| Altenar | don, topbet, million, baumbet, powerbet, winbet | one feed |
| Fortuna BFF | fortuna, casa-pariurilor | one feed |
| EveryMatrix WAMP | getsbet, contibet | one feed |
| Digitain | winner, bet7, mrplay, 888sport | one feed |
| Superbet, Betano, NetBet, Favbet, EGT Digital (vipbet), Unibet | one each | independent |

Evidence for each platform, including the negative results and the measurements behind each grouping, is recorded in `data/endpoints/` and `docs/platform-findings.json`.

`maxDiscoveredMatches`, `maxLiveMatches`, `maxTournaments`, and `maxMatches` in `config/scrapers.json` are safety limits; `maxMatches` controls how many discovered links are extracted in one cycle.

Set `ARBITER_MAX_EVENTS_PER_BOOK` to a positive integer for a bounded per-book result count, or to `all` to retain every qualifying event available from each provider's bounded public feed/window. `all` does not fabricate events or bypass upstream pagination, browser gating, lookahead windows, rate limits, or abort/timeouts; provider availability determines the actual count.

As of 2026-10-08, **28 of the 30 configured jobs are enabled**; `SCRAPER-TASKS.md`
carries the per-book status and what each one rests on. Unibet was re-enabled on
2026-09-28 after recovering a pollable REST offer surface (az-menu → lobby →
lobby, with the site's own tenant headers); its `fullMarkets` detail pass is
what lets it compare totals, BTTS and handicaps rather than the result market.

Arbiter neither bypasses a provider's protections nor reports an unavailable
source as an empty one. `npm run smoke:live` exists precisely because the two
are easy to confuse: a run that collects nothing and reports success looks
exactly like a quiet market day, and four separate defects survived a green
test suite that way.

## Adding a new bookmaker

1. Find the feed and confirm it is a public, read-only endpoint. The browser's
   own network view is the tool for this: open the sport page, look at the
   same-origin JSON requests it makes, and write down the full URL, the content
   type, and whether the response carries a complete three-way result market
   with both teams.

   There is no collector script for this. The earlier
   `scripts/endpoint-collector.mjs` is gone, and a one-off probe is usually
   enough — `scratch/` is the right place for it, and it is gitignored on
   purpose.

2. Add the job to `config/scrapers.json`, disabled, with the contract you
   actually observed rather than a placeholder:

   ```json
   {
     "id": "newbook",
     "name": "Newbook (public endpoint pending)",
     "enabled": false,
     "supportedSports": ["football"],
     "engine": "public-feed",
     "transport": "bookmaker-public-json",
     "script": "newbook.mjs",
     "sourceIds": ["newbook"],
     "validationStatus": "experimental",
     "validationReason": "Why this is still experimental, in one sentence."
   }
   ```

   `engine`, `transport` and `script` are a contract, not labels. The registry
   dispatches a job only when all three match what the adapter was written
   against (`src/scrapers/index.mjs`), and rejects anything else with
   `ESCRAPERCONFIG` — a typo must fail loudly rather than instantiate a
   scraper against a feed it does not implement.

3. Write the adapter under `src/scrapers/`, extending `ScraperBase`:
   `fetchRaw` for the request, `normalize` for the provider shape,
   `extractEvents` for the engine's event shape. Bounds are not optional: a
   body cap, a deadline, and the caller's `signal` propagated through.

4. Register it — the class in `src/scrapers/index.mjs`, with an exact
   `(engine, transport, script)` entry, so a configuration typo cannot route
   the wrong scraper to the wrong feed.

5. Validate against real responses, in this order:

   - `npm run smoke:live -- newbook` — the gate. It fails on zero events or a
     non-`ok` status, which is the check that catches the failure mode where an
     adapter collects nothing and still reports success.
   - Save a real payload under `test/fixtures/` and write a fixture test
     against it, as `test/winner.test.mjs` does. Use the shape the feed really
     sends: an adapter tested only on hand-written fixtures can be broken in
     ways a live capture alone shows.
   - Add the book to `src/scanner/feed-groups.mjs` if it resells another
     book's feed, and justify that with a measurement rather than an
     assumption about who owns it.

6. Only then set `"enabled": true` and `"validationStatus": "validated"`,
   and record the outcome in `SCRAPER-TASKS.md`.

The registry is the source of truth, but validation is a required promotion
gate rather than a configuration shortcut. A job runs only when **both**
`enabled` is not `false` **and** `validationStatus` is `"validated"`;
`src/scrape-orchestrator.mjs` enforces that, and the scrape UI selects on the
same predicate so a gated job is never ticked and then silently dropped. A
registry that declares an enabled-but-unvalidated job fails
`test/scraper-routing.test.mjs` on the commit that promotes it, and a run that
names only a non-runnable job fails with the specific reason rather than a
generic "nothing selected".

## Multi-sport architecture

Arbiter has a central **sport registry** (`src/sports/registry.mjs`) that the
router and the scrape orchestrator both read, so the UI never offers a filter
that cannot be served.

### Supported sports

| Sport | Draw outcome | Scraper status | Key markets |
|---|---|---|---|
| Football | draw | Active (bookmaker-specific scrapers) | MATCH_ODDS, OVER_UNDER, DOUBLE_CHANCE, BTTS, HANDICAP |
| 42 further sports (tennis, basketball, ice-hockey, volleyball, handball, American football, table-tennis, esports, darts, rugby, futsal, …) | per registry | Active (multi-sport adapters) | MATCH_ODDS, OVER_UNDER, HANDICAP |

The registry carries 43 sports, and every one of them is declared by at least one
enabled, validated job in `config/scrapers.json` — that array is what the
orchestrator's sport filter matches on, and
`test/sport-registry-consistency.test.mjs` checks the two files against each
other in both directions, because a registry id no job declares is a dropdown
option that always fails and a declaration outside the registry makes every
scan naming it fail before a job runs.

That is the state after 2026-10-08, and it is worth being precise about what
changed and what did not: the adapters were already ahead of the registry.
superbet's offer-v3 fetches a multi-sport feed, betano crawls 36 Betano sport
ids, Altenar walks a per-tenant `GetSportMenu` (id map in
`src/scrapers/altenar-public.mjs`), Unibet crawls its az-menu, Winner reads a
sport filter over a 30-sport payload, and the FEG feed publishes a per-sport
market namespace (`ufo:mtyp:02-*` basketball, `01-*` and `14-*` tennis, …).
Measured over the saved `data/workspace` capture, the books had already
collected 146,393 football markets alongside 4,558 markets across the other
sports before any of them could be selected.

Multi-sport scans are measured rather than assumed: `node
scripts/market-coverage.mjs --workspace data/workspace <sport>` reports 25
arbitrable contract lines for tennis, 77 for basketball and 13 for ice-hockey,
with MATCH_ODDS pair-able across five independent books in tennis — so a
non-football scan has something to find, not just something to try. Because the
books map sport ids themselves, the datetime filter stays tenant-local and a
scan still escapes an odd UTC minute.

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

### What a line counts: `subject` and `team`

A contract is `(family, period, lineKey, subject, team)`. The last two answer
questions the first three could not: **what** the line counts and **whose**.

| Dimension | Values |
|---|---|
| `subject` | `goals`, `corners`, `cards`, `points`, `games`, `rounds`, `legs`, `shots_on_target` |
| `team` | `match`, `home`, `away` |

`subject` and `team` are appended to the bucket key, so `OVER 8.5 corners` and
`OVER 8.5 goals` are different buckets, and one team's goals total never meets
the match's goals total of the same line.

Every market type is built from the provider's own market name, read out of the
captures rather than assumed. Two of those readings are not obvious and are the
reason the table looks the way it does:

- **`Total hărți` is CARDS; `Harta 1.` is a SET.** "harta" is the Romanian for a
  *map*, and a set is a map of a match. Both appear on the same FEG feed with
  numeric legs — `ufo:mtyp:02-02` "Total harti 2.5" and `ufo:mtyp:02-04` "Harta 1.
  castigator" — so a bare `hărți` pattern would file a tennis set winner under
  cards. The cards class requires `total` in front of it.
- **`ufo:mtyp:03-03` is a cards TOTAL, not a handicap**, even though that slot
  defaults to `ASIAN_HANDICAP` and its legs (`- 4.5` / `+ 4.5`) are the shape a
  spread looks like. A name that says "total" overrides the key's family, which
  is the same precedence this file gives a name over a declared period
  everywhere else. Without it a push-capable contract was priced as an
  exhaustive one.

This exists because those two dimensions were the reason a large class of
market was **refused outright**. Corners, cards, points and games totals used
to `return null` in `market-contracts.mjs`: the contract could not say what the
line counted, and a corners 8.5 landing in the same bucket as a goals 8.5 is an
arithmetic result on one contract priced from another. Now that the answer has
somewhere to live, the collision is closed **at the key** instead, and the
markets became tradable. Measured on `data/workspace`, 131 markets that
previously resolved to nothing now resolve: 35 games, 34 corners, 33 points, 29
cards.

**Every total must leave `resolveContract` with a subject, and this has to be
checked rather than assumed.** `superbetDetailRoute` builds its contract
directly and never had a subject to give, so superbet's goals totals bucketed as
`_::_` while the same line from the other fifteen books bucketed as
`goals::match` — and a bucket key is equality, so superbet could not pair its
own goals 2.5 with anyone. 562 markets, and nothing raised: a lost opportunity
and a quiet market look identical in a scan that reports rows. It surfaced as
`superbet — single book` in `scripts/market-coverage.mjs`. Routing that branch
through `ouContract` took goals 2.5 from 10 books / 43 pairs / 25 shared events
to **11 / 53 / 29**, and improved every other goals line with it.
`scratch/find-missing-subject.mjs` is the check that would have caught it.

Two things are still refused, both because guessing is worse than declining:

- **Keys with no measured subject.** `TOTP`, `TSCR` and `TCOR` sit beside the
  measured keys in the old refusal list but no capture attributes a subject to
  them, so they stay withheld. So does the Romanian spelling of *shots on
  target* — the English is matched, but no capture contains the local form, and
  inventing it is exactly the failure mode this table exists to prevent.
- **A per-team total that does not name its side.** EveryMatrix publishes
  `Total Goluri Echipă Peste/Sub` — one team's goals, with no indication of
  which. Filed under `match` it would meet a real match total, so it is refused.
  Costing 62 markets on getsbet and contibet, which is a real coverage loss and
  the correct trade.

A total whose subject nothing proves still defaults to `goals`, which is exactly
the pre-change behaviour: every total the engine could reach before was a goals
total, and that is *why* the others were refused. After the `rounds`, `cards`
and `legs` readings were added, that fallback carries 3,199 markets and every
one of them is a real goals total — favbet's `TOTAL_GOALS` titled only
`"Peste / Sub"`, and getsbet — so the default is now narrow rather than a
cloak.

## Why a scan can still legitimately find nothing

Coverage is not the binding constraint on football 1X2 — the market is. Every
alt market above is published by **exactly one** of the 24 books
(`scripts/market-coverage.mjs` reports them as `single book`), and an arbitrage
needs one contract from two *independent* feeds. So the reachable edge is a
book-coverage problem, not a maths problem: the alt markets are collected but
have no counterparty, and football 1X2 has many counterparties and no edge. See
`docs/no-arbitrage-root-cause.md` for the measured 1X2 series.

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

## The live poll

`includeLive` has been plumbed end to end for a while: the per-feed predicates in
`src/scrapers/live-status.mjs`, the flag from the router through the orchestrator
into every adapter, the 90-second freshness window in
`src/shared/data-quality.mjs`, the pairing scope in `src/scanner/engine.mjs`, and
the in-play badge and counter in the UI. What was missing was anything that
*collected* on a live cadence, so `src/live-service.mjs` drives it. Off by
default; enable it from the scrape page or `POST /api/live`.

**It polls every runnable book, not a live-capable subset.** Two reasons agree.
A partial poll would leave the untouched books on the previous run's `runId`,
and `loadWorkspace` forces STALE on any snapshot whose `runId` is not the scan's
own (`scanner.mjs:51,61,74-80`) — measured, a poll covering 3 of 8 books dropped
the other 5. And 19 of the 24 books have `scope: null` in `LIVE_EVIDENCE`, which
is a measurement rather than a verdict, so polling all of them is what lets a
book that starts publishing in-play be picked up without a code change. The cost
is real: while enabled, the whole bookmaker set is scraped continuously.

**It skips the verification pass and the market catalog per tick.** The
verification pass re-quotes every leg by re-scraping the books those legs came
from — measured medians: unibet 53.9s, getsbet 34.4s, contibet 31.3s — which
roughly doubles the work and pushes the pipeline past the 90s window the poll
exists to serve. The scrape that just ran is the freshest statement of the
price. An ordinary scrape still does both; `pipeline.verify` / `pipeline.catalog`
default to `true`.

**Read `lastRun.durationMs`, not the configured interval.** A full 24-book batch
was measured at 55.1s min / 63.9s median / 117.9s max wall clock over nine real
runs, so at a 60s interval roughly half of all ticks find the previous poll still
running. Those ticks are counted in `skippedTicks` and timestamped in
`lastSkippedAt`; they deliberately do *not* overwrite `lastRun`, because a skip
lands precisely when the poll is overrunning and that is when its duration is
worth reading. `lastRun.keepingUp` is computed from the measurement.

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
- `GET /api/live` · `POST /api/live` — in-play poll config and measured status. See below.
- `GET /api/tracker` · `POST /api/tracker` · `PUT/DELETE /api/tracker/:id` — bet tracker; `GET /api/tracker/export.csv` and `POST /api/tracker/import` for CSV round-trips.
- `GET /api/alerts` · `POST /api/alerts` — alert preferences.
- `GET /api/events` — SSE stream of pipeline + scan updates.

### Diagnostic routes

Two routes have no consumer in the dashboard and never did. They are not
vestigial, and this paragraph is the reason that is written down:

- `GET /api/snapshot/:sourceId` — one book's workspace snapshot verbatim, every
  key included. This is the ground truth of what an adapter wrote.
- `GET /api/odds/:sourceId` — the same file projected to
  `{ eventKey, id, sport, league, kickoff, homeTeam, awayTeam, live, market }`,
  with optional `?eventKey=`, `?marketKey=` (case-insensitive) and `?limit=`
  (1–100, default 50). `market` carries `{ key, name, live, selections }`.

`/api/event-detail` already shows the same selections to the dashboard, but it
finds an event through a heuristic matcher — normalized club identity, an
`eventKey`-token fallback, a ±5 minute kickoff window. When the matcher itself
is what is under suspicion, a view built on the matcher cannot be the evidence;
these two routes read one book with no matching at all. That is the job
`docs/no-arbitrage-root-cause.md` used them for, and it is the reason they
cannot be deleted as "redundant with the event page".

`live` is projected per market, not per event, on both: the adapters mark each
market from the provider's own field and two books of one event can disagree.
A price list that arrives without it reads as a pre-match one.

Both are loopback-only, accept a bare `[a-z0-9][a-z0-9-]*` source id (400
`EBADID` otherwise), answer 404 `ENOTFOUND` for a book that has never run and
500 `EINVALID` for a truncated file — never a bare empty list, which is
indistinguishable from a book that had nothing to offer.

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

Status as of 2026-10-08: 28 of the 30 configured jobs are enabled and
implemented against verified public endpoints. Only `prowin` and `ultrabet`
stay disabled — the two EGT resellers, disabled because all three EGT brands
are one upstream feed, so enabling them would add coverage without adding an
independent price source; `vipbet`, the EGT brand that was kept, is measured
daily (0.5–4.2s) and now supplies fresh football prices everything else on that
platform lacks. Unibet, which was disabled pending a repeatability check of its
crawl, re-ran green on 2026-10-08 and is enabled, taking the independent-source
count to 12. `SCRAPER-TASKS.md` tracks per-book status and
`docs/platform-findings.json` holds the evidence.

