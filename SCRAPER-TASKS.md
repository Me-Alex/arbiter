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
| [ ] | unibet | public-sports-api-v2 | disabled | no repeatable live validation |

Removed from the config in this pass: `mozzartbet` and the five
`sport-generic` placeholders (tennis, basketball, ice-hockey, volleyball,
handball). Each pointed at a scraper file that does not exist, and the
registry no longer offers those sports, so the entries could only mislead.

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
- Unibet stays disabled pending a repeatability check.

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

## Follow-up order

1. Re-evaluate disabled Unibet for repeatability, without bypassing access
   controls.
2. Widen EveryMatrix coverage if the dealer exposes more tournaments.
3. Full regression and operator review before any requested backend restart.
   TinyFish remains disabled throughout.
