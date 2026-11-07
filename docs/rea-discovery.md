# REA MCP Sportsbook Odds Discovery & Verification

This document describes how Arbiter integrates the local [`morluto/rea`](https://github.com/morluto/rea) Model Context Protocol (MCP) server (`rea-agents@6.8.0`) on this workstation to inspect, reverse-engineer, and verify live sportsbook public odds feeds without web scraping workarounds or authentication bypasses.

---

## 1. Workstation MCP Setup

Arbiter connects to the globally installed `rea-agents` package via a Node.js stdio JSON-RPC client:

- **Global Package Location**: `C:\Users\flore\AppData\Roaming\npm\node_modules\rea-agents\scripts\rea.mjs`
- **Node Runtime**: Node.js `v24.22.1`
- **Browser Automation Runtime**: Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`)
- **Protocol**: MCP stdio JSON-RPC over stdin/stdout with 128 MiB bounded buffering (`REA_MCP_MAX_RESPONSE_BYTES = 134217728`).

### Available NPM Commands

| Script | Purpose |
|---|---|
| `npm run rea:doctor` | Verifies local Node, Chrome, and REA MCP tools availability. |
| `npm run rea:discover -- --url <URL> --book <BOOK>` | Runs headless browser scenario, parses REA Evidence, fingerprints platform, and extracts public odds endpoints. |
| `npm run rea:har -- --file <PATH>` | Reassembles and scores HTTP/WebSocket transactions from an existing HAR file. |
| `npm run rea:bundle -- --dir <PATH>` | Scans static JS build bundles for embedded API keys, tenant hashes, and WebSocket endpoints. |

---

## 2. Zero-Bypass Compliance & Anti-Bot Rule

Arbiter strictly follows public unauthenticated access policies:
1. **No Bot-Bypass Hacks**: When REA detects Cloudflare Turnstile, Cloudflare 403, Datadome, or ONJN sinkhole redirects, Arbiter records the candidate as blocked and never attempts evasion.
2. **No Credential / Session Sniffing**: Endpoints requiring private authentication tokens (`authorization`, `x-auth-token`, `x-session-token`) are rejected from automated public scanning.
3. **Exact SHA-256 Provenance**: Every discovered candidate endpoint is captured into `data/endpoints/captures/<book>-odds-<date>.json` with complete SHA-256 integrity metadata before any adapter promotion.

---

## 3. Discovered & Onboarded Sportsbooks

### 1. `victorybet` (VictoryBet — `victorybet.ro`)
- **Platform**: `betconstruct-swarm` (BetConstruct Swarm WebSocket reverse proxy).
- **Endpoint**: `wss://eu-swarm-reverse.victorybet.ro/` (`site_id: 18754351`, `source: 42`).
- **Currency**: RON.
- **Coverage**: Prematch + live odds across 7 sports (Football, Basketball, Tennis, Ice Hockey, Handball, Volleyball, Table Tennis).
- **Markets Unlocked**: 1X2 / 3-way regulation result (`P1XP2`), 2-way match winner (`P1P2`), Double Chance (`1X12X2`), Both Teams to Score (`BothTeamsToScore`), Draw No Bet (`DrawNoBet`), Over/Under Totals (`OverUnder`, `MatchTotal`, `TotalGamesOver/Under`, `CornersOverUnder`), and Asian Handicap (`AsianHandicap`, `MatchHandicap`).
- **Feed Grouping**: Independent feed (no shared reseller clones).

### 2. `luck` (Luck — `luck.com/sport`)
- **Platform**: `exalogic-xsport` (Exalogic XSport REST API).
- **Endpoint**: `https://sport.luck.com/XSportDatastore` (`systemCode: 'LUCKY'`).
- **Currency**: RON.
- **Coverage**: Multi-sport prematch offer feeds (1,288+ fixtures).
- **Feed Grouping**: Measured 100/100 byte-identical 1X2 vectors against `excelbet` -> grouped under `exalogic-xsport` in `src/scanner/feed-groups.mjs` to prevent clone-feed false arbitrages.

---

## 4. Market Settlement & Depth Enhancements

Using REA browser network analysis, Arbiter reverse-engineered the exact market and specifier representations across disparate providers:

1. **Exhaustive Totals Rule**: Totals lines (`OVER_UNDER`, `TOTAL_POINTS`, `TOTAL_GAMES`, `CNOU`) only admit half-lines ($N.5$) where `Math.abs(line % 1) === 0.5`. Whole lines ($2.0$) and quarter lines ($2.25$) are push/split lines and are refused to prevent unhedged false arbitrages.
2. **Asian Handicap Sign Normalization**: Signed bases are anchored strictly by competitor identity (Home base vs Away base), correctly handling provider conventions where Away lines are published with Home-perspective specifiers.
3. **Overtime Settlement Isolation**: 2-way match winners on Basketball and Ice Hockey that include overtime are tagged with `period: 'fulltime_ot'` so they never bucket against 60-minute regulation 1X2 markets.
4. **Altenar SB2 Synthetic DC/DNB**: Activated `DOUBLE_CHANCE` and `DRAW_NO_BET` across all 65+ Altenar sportsbooks, unlocking synthetic equivalence surebets (`1X_VS_AWAY`, `X2_VS_HOME`, `12_VS_DRAW`, `DNB_AH0`).
5. **Oddin Platform (`totalbet.ro`)**: Multi-sport pagination across sports 1, 2, 4, 5, 6, 20, 23, merging split BTTS entries (`GG` and `NG`), and enriching top fixtures via `getFixturev2`.
6. **AdmiralBet Poland (`admiralbet.pl`)**: WebSocket hierarchy discovery + `q-events` multi-sport extraction with Over/Under half-line goals, points, games, and Double Chance.
