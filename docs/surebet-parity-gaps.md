# What's missing to deliver surebet.com-style surebets

## Where the project is today

- **28 of 30 bookmaker jobs enabled**, but still only **12 independent price sources** once shared feeds are collapsed (`docs/no-arbitrage-root-cause.md`, `src/scanner/feed-groups.mjs`). Brands like 888sport (≡ `winner`, Digitain), Don/WinBet/TopBet (both Altenar), admiral/stanleybet (one NSoft company feed), and the disabled EGT duo (prowin/ultrabet) add no independent pricing. The 2026-10-08 additions (bet7, mrplay, 888sport — all Digitain; vipbet — EGT) followed exactly this rule: they changed coverage, not independence, so only `vipbet` moved the source count, from 11 to 12.
- **43 sports are registered** in `src/sports/registry.mjs` and served, each declared by at least one enabled job (`test/sport-registry-consistency.test.mjs` pins the two files together). The adapters the paragraph above worried about are now wired to the registry: measured on `data/workspace`, football holds 146,393 markets and the other sports 4,558, with 25 arbitrable contract lines in tennis, 77 in basketball and 13 in ice-hockey.
- **Arbitrable market contracts** are effectively `MATCH_ODDS`, `OVER_UNDER`, `ASIAN_HANDICAP`, `BTTS`. `DOUBLE_CHANCE` and `DRAW_NO_BET` are recognized but `arbEligible: false`.
- The engine pairs 2-way or 3-way inverse-sum **and** name-based totals for middles; `period: 'unknown'` contracts are admitted since 2026-10-08 (`src/scanner/engine.mjs`), which stopped dropping Unibet's per-team totals — though `bucketKeyForContract` keeps them in their own bucket, and `Total Goluri Echipă` stays refused on naming, not period.
- Measured reality: football 1X2 cross-feed return is −1.8% to −4.5% (arbitraged away), and only 6 of 250 fixture-line buckets are covered by ≥2 independent feeds (`docs/no-arbitrage-root-cause.md`). On the current capture that is 44 arbitrable contract lines with 2,145 independent pairs, of which 1,804 quote the same fixture — the pair count is not the constraint; the independent cross-feed pair is.

## The gaps, in priority order

### 1. Missing independent books (the binding constraint)
- **Mozzart** is the one genuinely missing independent book identified from the surebet.com sample page — `mozzartbet.ro` endpoint evidence is already captured (`data/endpoints/captures/mozzartbet_api.json`), it's `mozzart-native`, not Altenar/Digitain, but it was removed from config after HTTP 521. Reviving or re-probing it is the single highest-value addition.
- Adding more Altenar/EGT/NSoft-company tenants is explicitly **not** useful — `feed-groups.mjs` already refuses to pair them, correctly.
- The surebet.com sample page's other books (Fortuna, StanleyBet, Don, WinBet, SuperBet, 888sport) are already covered or byte-identical to something we have.

### 2. Missing sports

surebet.com's results span basketball, American football, tennis, ice hockey, etc. For a while the project had **zero** non-football *served* coverage: the adapters collected those sports (`altenar-public.mjs` walks a multi-sport catalogue, `unibet.mjs` crawls 13) but nothing was registered. That closed on 2026-10-08 — 42 further sports are registered and each is declared by an enabled job, measured at 25/77/13 arbitrable contract lines for tennis/basketball/ice-hockey. The remaining gap is counterparty, not collection: MATCH_ODDS pairs across 5 books in tennis, but most non-football alt lines still sit single-book.

### 3. Missing market families
- **Per-team goal totals**: `Total Goluri Echipă` (62 markets on getsbet/contibet) is refused because it doesn't name its side; Unibet's per-team totals land in `period: 'unknown'` and are dropped by the engine. Together that's a large, surebet.com-typical market we refuse.
- **Shots on target**: the Romanian spelling (`Șuturi pe poartă`-style) is absent from every capture, so it stays withheld; English SOT is matched but only on feeds that publish it.
- **Corners / cards / clean sheet / per-team**: corners and cards totals resolve now, but each is published by exactly one book (betano for corners/cards), so no pairing is possible. Clean-sheet isn't in the contract table at all.
- `TOTP`/`TSCR`/`TCOR` (total points) keys are withheld because no capture attributes a subject to them.

### 4. Counterparty problem on alt markets
Even after `subject`/`team` landed, 131 newly-resolvable markets (games/corners/points/cards) are still single-book per line. An arbitrage needs the **same contract priced by two independent feeds**. Right now alt markets are tradable in name but cannot produce a surebet without a second feed quoting them.

### 5. Engine limitations that close rows

- Only inverse-sum 2/3-way pairing **plus** name-based totals for middles (landed 2026-10-08, pinned by `test/market-settlement-contract.test.mjs` and `test/market-coverage-captures.test.mjs`). No `DOUBLE_CHANCE`/`DRAW_NO_BET` arb (correctly — overlapping outcomes); no cross-event or live-vs-prematch pairing.
- `period: 'unknown'` is admitted as its own bucket since 2026-10-08, so real per-team totals no longer evaporate. What still refuses them is naming: `Total Goluri Echipă` does not name its side.

## What "done" would look like
To actually emit surebet.com-style rows we need, roughly in order:
1. **Add Mozzart** (one new independent feed) and re-validate it — breaks the single-feed ceiling.
2. **Restore a second multi-tenant alt-market counterparty** so corners/cards/SOT get a pair. Unibet has already recovered (2026-09-28, Kindred XNS REST — the MQTT conclusion was wrong), so the remaining move is to make sure the scanner actually *pairs* Unibet's alt markets: it crawls 13 sports and ~36-150 propositions per contest, but only `football` is registered and its per-team/`period:'unknown'` totals are currently refused. Pairing Unibet's totals with betano's is the cheapest counterparty win available.
3. **Add one non-football sport** end-to-end — the adapter side largely exists (Unibet crawls 30 sports; `altenar-public.mjs` walks a multi-sport catalogue), the blocker is the sport registry (`src/sports/registry.mjs` registers only `football`) and per-sport contract keys. Basketball is the best candidate: it's on the surebet.com sample page (margin, overtime) and both Altenar and Unibet publish it.
4. **Unblock per-team totals** by either reading the side from the market name/URL where present or pairing them only when both feeds name the same side — currently a hard refusal that costs 62+ markets.
5. **Extend the engine** to pair `DOUBLE_CHANCE`/`DRAW_NO_BET` and to admit `period: 'unknown'` contracts when the subject+team+line match exactly.

Until at least #1 and #2 land, the scanner's correct output remains "no arbitrage" — the architecture is ready, the market just has no counterparty on the edges we surface.
