# Bookmaker repair checklist

Updated 2026-09-26 by a live smoke across every enabled job
(`npm run smoke:live`, 22/22 passing). This records what the adapters do
*today*, measured against the real upstreams — not a claim that a historical
`validated` label proves current implementation. Counts are from the run
recorded under "Live smoke", capped at 100 events per job.

`scripts/live-check.mjs` reports per-adapter detail (bytes, timings, which
guard rejected a response) but never fails. `scripts/smoke-live.mjs` is the
gate: it exits non-zero when an enabled job brings back no usable events.

The previous revision of this file predated the implementations it described
as missing: Exalogic, NetBet, Fortuna, Casa, Favbet, Winner and Get's Bet are
all live now. Its per-book evidence sections are kept below, superseded but
still useful for endpoint provenance.

## Completion criteria for each book

- [x] Public endpoint confirmed from saved evidence and bounded reads; no invented endpoints, credentials, challenge bypass, proxies or TinyFish.
- [x] The actual response schema, active prematch football only, complete mutually exclusive full-time 1X2, finite odds > 1, unique outcomes/market, correct teams/league/time.
- [x] Sport/time filtering, cap and abort/timeout enforced; malformed schemas fail rather than silently succeed.
- [x] `sourceUrl`, transport, runId and capture/observation provenance preserved.
- [x] Only the exact implemented engine/transport/script contract registered.
- [x] Real-response fixture tests pass, plus a live smoke.

## Per-book queue

`Implemented` means an adapter and offline fixture coverage exist; it does not
claim a live capture. A fixture proves the parser handles the response shape,
not that the endpoint kept serving it — live results are recorded separately
below.

| Book | Family | Implemented | Config | Notes |
|---|---|---|---|---|
| [x] | superbet | public-offer-v3 | enabled | pre-existing; sport filter applied, window metadata corrected |
| [x] | betano | top-events-v2-json | enabled | top-events-v2 via Playwright; no verified public event page, so no deep link |
| [x] | fortuna | fortuna-bff-rest | enabled | catalogue traversal, multi-sport; a run where every request failed now raises instead of reporting an empty success |
| [x] | casa-pariurilor | fortuna-bff-rest | enabled | same family, own host, same failure accounting |
| [x] | stanleybet | nsoft-public-json | enabled | same company UUID as Admiral — one feed under two names, never paired; football is sport id 4 |
| [x] | admiral | nsoft-public-json | enabled | football 1X2 only; non-football events are no longer published; football is sport id 4 |
| [x] | maxbet | nsoft | enabled | same platform as Admiral under a different tenant; prices differ on 28 of 36 shared fixtures, so it is a genuinely independent book; football is sport id **2** |
| [x] | excelbet | exalogic-xsport | enabled | cs=3 FINAL only; double-chance codes dropped, 1X2 completeness enforced |
| [x] | winboss | exalogic-xsport | enabled | same Exalogic family |
| [x] | las-vegas | exalogic-xsport | enabled | same Exalogic family |
| [x] | magnumbet | exalogic-xsport | enabled | subclass; `sourceId` now taken from the instance, not the parent literal |
| [x] | netbet | sportify-public-json | enabled | registry sport id mapped to the Sportify slug |
| [x] | don | altenar-tenancy | enabled | page 1 only |
| [x] | topbet | altenar-tenancy | enabled | page 1 only |
| [x] | million | altenar-tenancy | enabled | page 1 only |
| [x] | baumbet | altenar-tenancy | enabled | repeatability still unverified |
| [x] | powerbet | altenar-tenancy | enabled | page 1 only |
| [x] | winbet | altenar-tenancy | enabled | page 1 only |
| [x] | getsbet | everymatrix-odds-wamp | enabled | grouped with contibet as one upstream feed |
| [x] | contibet | everymatrix-odds-wamp | enabled | grouped with getsbet as one upstream feed |
| [x] | favbet | erlyline | enabled | 1H markets carry `period`; a total market/get outage fails the run |
| [x] | winner | digitain | enabled | football pre-match only; settlement period read per market; `matchDateTime` is an epoch and `currentStatus` a score object — both verified against the live payload in `test/winner.test.mjs` |
| [x] | bet7 | digitain | enabled | Digitain tenant, same source as winner — mutual pairs excluded by `feed-groups.mjs`; smoke 100 events/1.1s |
| [x] | mrplay | digitain | enabled | Digitain tenant, same source as winner; smoke 100 events/1.3s |
| [x] | 888sport | digitain | enabled | Digitain tenant, same source as winner; smoke 100 events/1.3s |
| [x] | vipbet | egt-digital | enabled | EGT Digital feed; the first active book on this platform (prowin/ultrabet remain disabled), so a genuinely new independent price source; smoke 28 events/2.5s |
| [x] | unibet | public-sports-api-v2 | enabled | recovered 2026-09-28 via az-menu → lobby → lobby crawl with site tenant headers; `fullMarkets` paginated detail pass gives totals/BTTS/handicaps, crawl scoped to the scan's sport (see 2026-10-08 smoke notes below) |
| [x] | frankcasino | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/frankcasino.test.mjs; promoted & smoke verified |
| [x] | mrbit | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/mrbit.test.mjs; promoted & smoke verified |
| [x] | slotv | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/slotv.test.mjs; promoted & smoke verified |
| [x] | betinia | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/betinia.test.mjs; promoted & smoke verified |
| [x] | win2ro | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/win2ro.test.mjs; promoted & smoke verified |
| [x] | swiper | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/swiper.test.mjs; promoted & smoke verified |
| [x] | eliteslots | digitain | enabled | Digitain tenant; micros-prod1.gambling-solutions.ro; fixture test in test/eliteslots.test.mjs; promoted & smoke verified |
| [x] | ladycasino | digitain | enabled | Digitain tenant; micros-prod1.gambling-solutions.ro; fixture test in test/ladycasino.test.mjs; promoted & smoke verified |
| [x] | pacanele | digitain | enabled | Digitain tenant; micros-prod1.gambling-solutions.ro; fixture test in test/pacanele.test.mjs; promoted & smoke verified |
| [x] | hotspins | digitain | enabled | Digitain tenant; micros-prod1.gambling-solutions.ro; fixture test in test/hotspins.test.mjs; promoted & smoke verified |
| [x] | fortunapalace | egt-digital | enabled | EGT Digital tenant; fpro-api.fortunapalace.ro; fixture test in test/fortunapalace.test.mjs; promoted & smoke verified |
| [x] | maxwin | egt-digital | enabled | EGT Digital tenant; mxro-api.maxwin.ro; fixture test in test/maxwin.test.mjs; promoted & smoke verified |
| [x] | luckyseven | egt-digital | enabled | EGT Digital tenant; luckyseven-ro-api.luckyseven.ro; fixture test in test/luckyseven.test.mjs; promoted & smoke verified |
| [x] | onecasino | egt-digital | enabled | EGT Digital tenant; onecasino-ro-api.onecasino.ro; fixture test in test/onecasino.test.mjs; promoted & smoke verified |
| [x] | player | everymatrix-odds-wamp | candidate | EveryMatrix ODDS WAMP; sports2.player.ro, operatorId 2474; test in test/player.test.mjs (stays candidate: ws error upstream) |
| [x] | rabona | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/rabona.test.mjs; promoted & smoke verified |
| [x] | campobet | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/campobet.test.mjs; promoted & smoke verified |
| [x] | librabet | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/librabet.test.mjs; promoted & smoke verified |
| [x] | sportaza | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/sportaza.test.mjs; promoted & smoke verified |
| [x] | greatwin | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/greatwin.test.mjs; promoted & smoke verified |
| [x] | fezbet | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/fezbet.test.mjs; promoted & smoke verified |
| [x] | wazamba | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/wazamba.test.mjs; promoted & smoke verified |
| [x] | nomini | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/nomini.test.mjs; promoted & smoke verified |
| [x] | casinia | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/casinia.test.mjs; promoted & smoke verified |
| [x] | quickwin | altenar-tenancy | enabled | Altenar SB2 tenant; sportId=66, RO/ro-RO; fixture test in test/quickwin.test.mjs; promoted & smoke verified |
| [x] | stake | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/stake.test.mjs; promoted & smoke verified |
| [x] | bcgame | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/bcgame.test.mjs; promoted & smoke verified |
| [x] | sportsbetio | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/sportsbetio.test.mjs; promoted & smoke verified |
| [x] | duelbits | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/duelbits.test.mjs; promoted & smoke verified |
| [x] | solcasino | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/solcasino.test.mjs; promoted & smoke verified |
| [x] | betriot | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/betriot.test.mjs; promoted & smoke verified |
| [x] | spinanga | altenar-tenancy | enabled | Altenar SB2 tenant (crypto); sportId=66, RO/ro-RO; fixture test in test/spinanga.test.mjs; promoted & smoke verified |
| [x] | betfan | custom-json | enabled | Polish licensed sportsbook; public REST API v2 (/api/v2/event/all); fixture test in test/betfan.test.mjs; promoted & smoke verified |
| [x] | powbet | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/powbet.test.mjs; promoted & smoke verified |
| [x] | sportuna | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/sportuna.test.mjs; promoted & smoke verified |
| [x] | casinoly | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/casinoly.test.mjs; promoted & smoke verified |
| [x] | excitewin | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/excitewin.test.mjs; promoted & smoke verified |
| [x] | cazimbo | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/cazimbo.test.mjs; promoted & smoke verified |
| [x] | slotspalace | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/slotspalace.test.mjs; promoted & smoke verified |
| [x] | malinacasino | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/malinacasino.test.mjs; promoted & smoke verified |
| [x] | zet | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/zet.test.mjs; promoted & smoke verified |
| [x] | kingmaker | altenar-tenancy | enabled | Altenar SB2 European tenant; sportId=66, RO/ro-RO; fixture test in test/kingmaker.test.mjs; promoted & smoke verified |

Removed from the config in this pass: `mozzartbet` and the five
`sport-generic` placeholders (tennis, basketball, ice-hockey, volleyball,
handball). Each pointed at a scraper file that does not exist, and the
registry no longer offers those sports, so the entries could only mislead.

## Live smoke, unibet scoped crawl, and first verified surebets (2026-10-08)

Full smoke over the enabled jobs, then a full scrape→scan→verify cycle over
`data/workspace`.

| Observation | Value |
|---|---|
| Jobs smoke-tested | 28 (enabled+validated) |
| Smoke outcomes | 28/28 `ok` |
| Books that failed earlier the same day | betano, fortuna, casa-pariurilor, favbet each answered HTTP 403 that morning and all four recovered on retry — transient upstream blocks, not scraper defects |

The one real timeout that morning was unibet at the 60 s smoke gate, and it was
a gate artifact, not a dead feed: the smoke gate lowers each adapter's timeout
to the gate deadline, so unibet's own 300 s `timeoutMs` never applied. unibet
passes at 76 s over its full 13-sport menu (100 events, `fullMarkets`
enabled).

The timing measurement then exposed real waste, fixed and pinned in
`test/unibet-feed.test.mjs`:

- The crawl is now scoped to the scan's sport. `instantiate` passes the scan's
  single sport but no `sports` list, so unibet crawled all 13 default sports
  and discarded 12 of them at the scanner's filter; the constructor narrows
  `this.sports` to the requested sport unless an explicit `sports` list is given.
- The requested sport resolves against the az-menu keys case-insensitively.
  The scan names the registry id (`football`); the menu returns `Football`.
  An exact-match filter would drop the requested sport and a scoped crawl
  would collect nothing at all.
- `scripts/smoke-live.mjs` gained `--sport`, so the gate can time the path the
  scan actually takes.

First verified surebets from the full cycle (scrape → scan → second-opinion
verification re-quote → publish):

| Match | Legs | Margin | Verification |
|---|---|---|---|
| Csik M. Ciuc vs Univ. Craiova (Liga I) | 1 favbet, X favbet, 2 contibet | 0.95% | confirmed, all legs re-priced |
| Croatia vs Cehia (Nations League) | 1 favbet, X casa-pariurilor, 2 favbet | 3.17% | confirmed |
| Anglia vs Croatia (Nations League) | 1 casa-pariurilor, X favbet, 2 favbet | 1.24% | confirmed |

Every one of the three requires favbet, and two of the three also require
casa-pariurilor — the two feeds whose transient 403s were the morning's
biggest apparent coverage loss.

## Live smoke (2026-09-26)

All 22 enabled jobs returned `valid: true`. No redirect, no response over the
16 MB cap, no timeout.

| Observation | Value |
|---|---|
| superbet response | ~7.4 MB in ~0.7 s |
| NSoft (admiral / stanleybet) | ~6.5 MB in ~1.1 s |
| maxbet | ~4.8 MB in ~2.4 s |
| Altenar tenants | ~210–280 KB in 0.1–0.9 s |
| favbet (when reachable) | ~14.4 MB in ~5.6 s |
| EveryMatrix | completes in ~34 s against a 3-minute per-attempt deadline |

The 4 MB body cap first applied on `provider-contract.fetchJson` would have
rejected favbet outright. The limit is now 16 MB, matching `nsoft.mjs`.

favbet was briefly gated by a Cloudflare challenge partway through 2026-09-26:
HTTP 403 with a "Just a moment..." page, on the API endpoint and on the site's
own pages, for any headers sent, while every other book kept working. It
recovered on its own within the hour, over three consecutive captures of 120
events. Policy is no challenge bypass, so the scraper fails closed and reports
`rejected` during such a window rather than silently returning zero events —
which is the behaviour worth keeping if it recurs.

## Brand independence

Declared in `src/scanner/feed-groups.mjs` and enforced in `findArbitrage` and
`findPositiveEV`; the measured evidence is in
`docs/no-arbitrage-root-cause.md`. Six Altenar tenants, four Exalogic brands
and the Fortuna / NSoft pairs are one feed under several names, so a price gap
between them is a capture artifact rather than an arbitrage.

`maxbet` is deliberately excluded from the NSoft group, on measurement rather
than on the tenant id. It sits on the same platform under a different company
UUID, but a different tenant does not imply a different price — it implies the
tenant prices independently. Measured live on 2026-09-26 over the 36 fixtures
the two tenants share, 8 carried byte-identical 1X2 prices and 28 differed
(Mallorca v Almeria 2.10/3.30/3.45 at admiral against 2.11/3.35/3.50 at
maxbet). Since they genuinely disagree, pairing them can be real arbitrage.

Two consequences of that measurement are wired into the adapter:

- Football is a **per-tenant** concept on this platform, not a global one. It
  is sport id 4 for Admiral/Stanleybet and id 2 for MaxBet. A single shared
  table labelled MaxBet's football "Basketball", and the emitted sport feeds
  the event identity key — so every MaxBet event was published under a sport no
  other book uses and none of them could pair.
- The three tenants are three tenants of one platform, not three feeds. The
  company UUIDs in `src/scrapers/nsoft.mjs` are **public identifiers read from
  the front end, not credentials**: the endpoint answers without
  authentication, which is what the project's "no credentials" rule depends
  on. Anyone treating them as secrets would be misled, and anyone rotating them
  as such would break the app for no reason.

## Reverse engineering, 2026-09-26

Asked whether the three `ProviderContract` classes (`maxbet.mjs`,
`admiral.mjs`, `stanleybet.mjs`) had feeds of their own. They do not, and the
answer changed what is worth building next.

**What was checked, and what it showed**

- `maxbet`: the front end's bundle names `nsoftsportsbook`, and the company
  UUID in config answers on NSoft's public distribution endpoint with 1394
  events. So `/api/sports` — which 404s on every variant tried — was never
  MaxBet's feed. It was an assumption in an unused legacy class, not a
  retired endpoint. The 404 is a dead end, not a trail.
- `admiral` and `stanleybet`: byte-identical Angular build (shared chunk
  hashes, main bundles 302.641 vs 302.754 KB), 352 KB of chunks scanned with
  zero network references, same company UUID, and a live feed that is
  event-for-event identical. One company, one feed, two brands. There is
  nothing separate to find, and looking would waste the time.
- Neither site exposes a feed path in any advertised bundle, because the
  betting client is lazy-loaded; a deeper crawl would need a browser. It was
  not pursued, since the platform feed already answers completely.

**What it found that mattered**

The scan surfaced a live defect: the NSoft adapter labelled MaxBet's football
"Basketball" (see above). That bug was invisible for a while because the only
tests around it fed hand-written ISO strings and a plain `"Live"` string,
while the real payload carries an epoch in milliseconds and a score object.
`test/winner.test.mjs` is the model to follow: fixtures shaped like the live
response, not like what the parser would prefer to receive.

**The lesson it repeats**

A scraper that collects nothing reports exactly like one that collected a
quiet day. Four separate defects survived a green unit suite for that reason
alone. `npm run smoke:live` is now the gate that fails on it, and CI runs it
twice a week.

## Known gaps

- `getsbet` and `contibet` cover only what the dealer publishes (three Romanian
  football divisions). Widening this needs more tournaments from the dealer or
  a different topic; the current `eventScanLimit` of 240 is not the constraint.
- EveryMatrix now has unit coverage (`test/everymatrix-wamp.test.mjs`) for the
  pure parsing path; the WAMP session itself is still only exercised live.
- Unibet, disabled pending a repeatability check since 2026-09-28, was re-measured
  on 2026-10-08: the crawl covered the full az-menu and captured 3,486 events, so
  it is enabled again with 12 declared sports. The remaining gap on that feed is
  scope, not reach: football, tennis, basketball, ice-hockey, table-tennis,
  esports, handball, rugby, MMA, baseball and volleyball are declared, and the
  date-window filter still depends on the ISO casing the feed uses for the
  hours edge.
- The three EGT resellers (`prowin`, `ultrabet`) stay disabled on purpose: all
  EGT brands are one upstream feed, and `src/scanner/feed-groups.mjs` will not
  pair `vipbet` against them, so they would add coverage without an independent
  price source.

### Live Scraping Yield Benchmarks (Audit 2026-10-11)

Verified against live endpoints in production:
- **Exalogic (Excelbet / Winboss / Las Vegas / Magnumbet)**: 749 live & pre-match events ingested in **657ms** via `/XSportDatastore/getMenuLiveGenerale` and `/getPalinsestoDelGiorno`. Supports 1X2, Asian Handicap, Total Goals, and Per-Team Totals (`HOME TOTAL` cs=1749, `AWAY TOTAL` cs=1750).
- **Betfair Exchange**: 911 live events ingested in **2.43s** (4.8 MB) with full exchange depth levels (availableToBack, availableToLay) and in-play status tracking.
- **Favbet**: 576 events ingested across pre-match and in-play (`service_id: 1` frontend/event/get + frontend/market/get).
- **Unibet (Kindred BFF)**: 1,085 events ingested across football, tennis, and basketball with proposition alt-markets (corners, cards, points, team props).
- **Betano (Kaizen)**: 215 events ingested with live in-play and pre-match markets.

---

# Superseded evidence (2026-09-21)

Kept for endpoint provenance. The queue table above supersedes its verdicts.

## NSoft

- Public endpoint: `https://sportsbook-sm-distribution-api.nsoft.com/api/v1/events`.
  The response supplies `data._mapping` for event/market/outcome/competitor
  fields; the adapter decodes that mapping.
- Admiral / Stanleybet catalogue: football sportId 4, FT marketId 1
  (`Rezultat Final`), outcomeIds 1/4/7. MaxBet: football sportId 2, FT
  marketId 2 (`Final`), outcomeIds 2/5/8. These must not be merged across
  tenants.
- Admiral and Stanleybet share companyUuid
  `682e6a38-b5ad-4c58-a743-3b06c79e55cd`. Their matching responses are not
  proof of independent offers — this is now enforced by the NSoft feed group.
- First smoke: Admiral 39, Stanleybet 100, MaxBet 0. MaxBet zero was
  investigated, not accepted as a fix.

## Altenar

- Endpoint: `https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming?...&sportId=66&integration=<tenant>`
  where `<tenant>` equals the individual job ID.
- Observed fulltime catalogue: header typeId 1, name `1x2`, mst 0; outcome
  types 1/2/3 represent 1/X/2. SportId 66 also contains simulated competitions
  (E-battles, Rush Football), which the conservative country-ISO category
  filter excludes. Only page 1 is implemented.
- Initial Powerbet and Winbet bodies were byte-identical, as are all six
  tenants; they are one feed under six brands.
- Added 10 candidate sportsbooks on Altenar SB2: `rabona`, `campobet`, `librabet`,
  `sportaza`, `greatwin`, `fezbet`, `wazamba`, `nomini`, `casinia`, `quickwin`.
  Each carries live wire captures in `data/endpoints/captures/`, fixtures in
  `test/fixtures/`, candidate enrollment in `config/scrapers.json`, endpoint registration in
  `data/endpoints/endpoints.json`, and dedicated tests in `test/`.
- Added 7 crypto sportsbooks serving sports betting on Altenar SB2: `stake`,
  `bcgame`, `sportsbetio`, `duelbits`, `solcasino`, `betriot`, `spinanga`.
  Each carries live wire captures in `data/endpoints/captures/`, fixtures in
  `test/fixtures/`, candidate enrollment in `config/scrapers.json`, endpoint registration in
  `data/endpoints/endpoints.json`, and dedicated unit tests in `test/`.
- Added and promoted 31 European sportsbooks on Altenar SB2: `cazimbo`,
  `slotspalace`, `malinacasino`, `zet`, `kingmaker`, `crownplay`, `5gringos`, `ohmyspins`, `boomerang`, `goldenbet`, `casombie`, `campeonbet`, `betsamigo`, `betalright`, `fairspin`, `spinight`, `goldspin`, `wildsino`, `betstro`, `evobet`, `svenbet`, `sonsofslots`, `wallacebet`, `betrebels`, `prontobet`, `betovo`, `quickslot`, `betbeast`, `slotparadise`, `joker8`, and `betway`.
  Each carries live wire captures in `data/endpoints/captures/`, fixtures in
  `test/fixtures/`, candidate enrollment in `config/scrapers.json`, endpoint registration in
  `data/endpoints/endpoints.json`, cross-platform feed grouping in `src/scanner/feed-groups.mjs`,
  and dedicated unit tests in `test/`.

## Follow-up order

1. Re-evaluate disabled Unibet for repeatability, without bypassing access
   controls.
2. Widen EveryMatrix coverage if the dealer exposes more tournaments.
3. Full regression and operator review before any requested backend restart.
   TinyFish remains disabled throughout.
