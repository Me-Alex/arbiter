# Why the scan finds no arbitrage

Status as of 2026-09-26, re-measured against eleven independent live captures
between 14:48 and 19:18. The previous version of this document described a
matching failure that no longer existed and would have sent the next reader
looking in the wrong place.

## Summary

**Conclusion: there is no arbitrage to find on these feeds, and that is a
property of the market rather than a defect in the scanner.**

Nine defects were found and fixed along the way. After fixing them, the best
achievable return on any cross-feed market was **−1.80%** — every possible
combination of prices across independent bookmakers still costs more than it
returns. A negative return is what a well-arbitraged market looks like; an
arbitrage would require a positive one.

| # | Defect | Effect |
|---|---|---|
| 1 | `eventIdentityKey` included the **league**, which books name differently | 0 → 54 cross-book pairings |
| 2 | Shared feeds were arbitraged against each other | 9 false opportunities → 0 |
| 3 | The whole Fortuna family was invisible to the contract guard | 0 → 845 eligible 1X2 markets |
| 4 | Scrapers wrote their own `eventKey`, unrelated to the matching key | 1000/1000 events now carry the canonical key |
| 5 | Dropping the league merged different competition groups | league-aware alias matching: 54 → 104 pairings, groups kept apart |
| 6 | `contibet` publishes 1X2 markets priced below break-even | 18–22% of its events excluded as untrustworthy |
| 7 | First-half and double-chance markets were stamped `fulltime` and bucketed as the result market | fabricated arbitrage removed; enforced once in `ScraperBase` and in `isMatchResultMarket` rather than per adapter |
| 8 | The CSV export misaligned every opportunity row by two columns | 23 cells against a 25-column header; verification status landed under `riskPercent` |
| 9 | `winner` read an epoch timestamp as an ISO string | every event dropped as malformed, run reported success with 0 events |

Defect 1 was the largest. `eventIdentityKey` built its key as
`sport|league|date|home|away`, but the same competition arrives as
"Nations League" from netbet and "UEFA Liga Natiunilor" from admiral, so
identical fixtures never matched.

Defect 5 is the correction to defect 1. Simply dropping the league fixed the
pairing but merged fixtures that differ only by competition group — England in
Nations League group A and group C are different matches, and pairing them can
report an arbitrage between two fixtures that were never played against each
other. League labels are now compared rather than ignored, with an alias table
built from observed label pairs (`src/scanner/league-aliases.mjs`) and the
group token checked first.

Defect 6 is a data-quality guard, not a matching issue: a book whose complete
1X2 sums to less than 1 would pay out more than it collects, which no real book
does. Measured across all 22 configured sources, only contibet does this
(~20% of its events, both on the saved capture and live).

## Measured outcome

Eleven independent live captures on 2026-09-26, between 14:48 and 19:18, on
four to ten books each. `scripts/sample.mjs` re-runs the measurement.

| Round | Time | Books | Events | Cross-feed buckets | Best ROI |
|---|---|---|---|---|---|
| 1 | 14:51 | 6 | 600 | 50 | −1.94% |
| 2 | 14:54 | 6 | 600 | 50 | −1.94% |
| 3 | 14:57 | 6 | 600 | 50 | −1.94% |
| 4 | 14:55 | 7 | 700 | 50 | −1.94% |
| 5 | 14:59 | 7 | 700 | 49 | −2.12% |
| 6 | 15:00 | 7 | 700 | 49 | −2.12% |
| 7 | 14:48 | 10 | 1000 | 203 | −1.80% |
| 8 | 18:57 | 3 | 300 | 31 | −3.64% |
| 9 | 19:00 | 3 | 300 | 31 | −3.64% |
| 10 | 19:17 | 4 | 300 | 12 | −3.64% |
| 11 | 19:18 | 4 | 400 | 33 | −3.26% |

The best combination is consistently the same fixture — Slovakia vs Moldova,
one leg from betano and one from netbet — landing between −1.8% and −2.1%. No
round produced a positive return.

That stability is the finding. A single scrape would have been an anecdote;
eleven captures across five hours all land inside a 0.3-point band, and
always negative. The market is arbitraged and there is no edge left to take.

Rounds 8–11 are worse (−3.3% to −3.6%) than the earlier ones because they ran
on a narrower book set: the four books they cover are dominated by a single
league window, so the best pairing available sits further from the mid. The
sign does not change.

### What rounds 8–11 additionally found

Re-measuring after the settlement-period and provenance fixes turned up two
defects that had been hiding behind a clean-looking result:

- **winner collected nothing.** `matchDateTime` is an epoch in milliseconds,
  not an ISO string, and `currentStatus` is a score object rather than a status
  label. Reading the timestamp with `Date.parse` yields `NaN`, so every event
  was skipped as malformed and the run reported success with zero events. The
  unit fixtures used ISO strings, so the mismatch was invisible. Fixed, and
  `test/winner.test.mjs` now uses the real payload shape.
- **maxbet fails outright** — `/api/sports` returns 404. This is not a
  regression: the endpoint has been gone since before this measurement, and
  the adapter is the legacy `ProviderContract` class, not one of the public
  feeds. It is left as-is pending a replacement endpoint, and it is excluded
  from the captures above.

Both show the same lesson as the earlier defects: a scraper that collects
nothing and a scraper that collects everything look the same in a report that
only counts rows.

### How much independent coverage actually exists

Counted on a full 22-book capture, grouping brands by the feed they resell
(`src/scanner/feed-groups.mjs`):

| Distinct price source | Usable 1X2 markets |
|---|---|
| exalogic-xsport (excelbet, winboss, las-vegas, magnumbet) | 4122 |
| nsoft-company (admiral, stanleybet) | 2908 |
| fortuna-bff (fortuna, casa-pariurilor) | 2431 |
| maxbet | 1343 |
| altenar-tenancy (six tenants) | 496 |
| winner | 76 |
| superbet | 70 |
| netbet | 67 |
| betano | 25 |
| everymatrix-wamp (getsbet, contibet) | 22 |

**11 distinct price sources from 22 brands.** That is the ceiling this approach
can reach: the other 11 brands cannot disagree with each other, so pairing
them is not arbitrage.

Of the 80 cross-feed fixtures in that capture, only 17 are covered by three or
more independent feeds. On the largest of them — England vs Spain, five
independent feeds with a complete 1X2 each — the prices are 3.78–3.85 on the
home side, 3.50–3.65 on the draw, 1.97–1.99 away, giving a best case of
**−3.50%**. The widest dispersion on any single outcome is about 4%, which is
smaller than the ~5% margin the books charge. No combination of those prices
is profitable, and that is arithmetic rather than a coverage gap.

### Goals and handicap markets were measured too

The hypothesis was that totals and handicaps carry thinner margins than 1X2.
They do not:

| Market | Median margin |
|---|---|
| Full-time 1X2 | ~5% |
| Full-time goals, 2.5 | 8.2% |
| Full-time goals, 3.5 | 9.2% |
| Full-time goals, 1.5 | 9.3% |

Goals markets are *wider* than 1X2, not tighter. On top of that only 6 of 250
fixture-and-line buckets are covered by two or more independent feeds, so there
is almost nothing to compare even in principle. Two candidate arbitrages
(+6.98% on Scunthorpe, +4.85% on San Marino) turned out to be artifacts of
comparing an in-play capture against a pre-match one: the fixture had already
kicked off, and `isActionableKickoff` correctly drops it in the real scan. The
`OVER_UNDER_*` contract is reachable — `favbet.mjs` and `everymatrix-wamp.mjs`
both emit those keys — but favbet was behind a Cloudflare challenge at the time
of measurement and returned 403, leaving the market with a single feed. The
figures above are therefore a lower bound, though the goals margin is wide
enough that closing that gap is unlikely to change the conclusion.

### Why the league is compared rather than ignored

Ignoring the league entirely would collapse England in Nations League group A
and group C into one group — two different fixtures, same teams, same kickoff.
If their prices happened to line up, the scanner would report an arbitrage
between two matches that were never played against each other. That is a
fictional opportunity, and it is the worst failure mode this pipeline has,
because it looks exactly like a real find.

So league labels are compared, not discarded (`src/scanner/league-aliases.mjs`):

1. identical labels match;
2. a group token is extracted and must agree — `Liga Natiunilor A` and
   `Liga Natiunilor C` do not match, whatever else they share;
3. otherwise one label containing the other matches — `Premier League` inside
   `Anglia - Premier League`;
4. otherwise a small alias table applies, built from label pairs observed on
   the same fixture in the capture rather than from guesswork. One confirmed
   entry: psim yogyakarta vs persita tangerang is "Liga 1" to the six Altenar
   tenants (all sharing provider id 17473188) and "Super League" to favbet.

Measured effect: cross-book pairings rise from 54 to 104 while the two-group
case stays split, and the best available return is still negative.

### Coverage of the label comparison

Measured on the saved capture, over 7,628 label pairs observed on the same
fixture across two books:

| | Pairs matched |
|---|---|
| Before any normalisation | 59.6% |
| After diacritics, seasons, group suffixes, word order | 72.5% |
| After the generated translation table | **80.5%** |

Getting there required fixing several things the first version of `clean()`
got wrong, each of which silently lost pairings:

- diacritics were never stripped, so `Amicale-internaționale` could not meet
  `Amicale Internationale`, even though `normalizeTeamName` already existed for
  exactly that;
- the season regex consumed only the first two digits of `2026/2027`, leaving
  `2027` behind as a stray token;
- a group written as a slug suffix (`liga-natiunilor-1`) or as a trailing
  digit (`Liga Natiunilor 1`) was not recognised as a group, so it could not be
  compared against the other form;
- word order and Roman numerals (`III Liga` / `Liga III`) were not equivalent.

The comparison also had a correctness bug, not just a coverage gap: a bare
substring test matched `Premier League` to `Premier League 2` — the top flight
against its reserve league, which settle differently. Containment is now
anchored on word boundaries, and a trailing division number is treated as a
different competition.

### The generated translation table

Normalisation rules cannot bridge `Nations League` to `UEFA Liga Natiunilor` —
no shared prefix, no shared token, no rule that generalises. Those pairings are
translations, and they belong in a table.

`src/scanner/league-translations.mjs` holds 169 of them, built by
`scripts/gen-league-translations.mjs` from the capture rather than written by
hand. An entry is kept only when the two labels were seen on the same fixture
**and** the two books shared a provider event id for it, which proves they
price the same match rather than two matches that share a name and a kickoff.
3,277 candidate pairs were rejected for failing that test.

The index is deliberately multi-valued. `liga 1` is confirmed against
`league one`, `ligue 1`, `1 lyga` and `primera division` — different countries,
different competitions, one spelling. Collapsing it to a single canonical
partner would drop three of those, and taking whichever appeared first would be
arbitrary. Storing the full set keeps every proven pairing: `liga 1` matches
`ligue 1` while `liga 1` still does not match `liga 2`.

Each entry records how many fixtures confirmed it, which is the maintenance
signal — a competition that changes naming shows up as a pair that stops
matching rather than as a silent no-op.

The remaining 19.5% are label pairs that failed the shared-id test. Most are
genuinely ambiguous: `italia-serie-a-1` against `italia-serie-a`, where
`Serie A` is both the Italian top flight and a tier code, so the two cannot be
told apart without the context the label itself discards. Pairing them on the
name alone risks comparing different competitions.

The remaining exposure is coverage, not correctness: a competition published
under a name absent from the alias table simply will not pair. That loses an
opportunity rather than inventing one, which is the right way to fail.

## The defects that were found and fixed

### 1. Shared feeds were arbitraged against each other

`casa-pariurilor` and `fortuna` both read the Fortuna BFF feed. `admiral` and
`stanleybet` share one NSoft company UUID. Six Altenar tenants, four Exalogic
brands and two EveryMatrix brands are the same story.

Measured on the 22-snapshot capture, comparing markets shared by two or more
brands and splitting by whether the prices were byte-identical:

| Group | Members | Identical prices | Differing prices |
|---|---|---|---|
| Exalogic | excelbet, winboss, las-vegas, magnumbet | 1638 | 0 |
| Altenar | don, topbet, million, baumbet, powerbet, winbet | 1960 | 0 |
| NSoft | admiral, stanleybet | 314 | 0 |
| Fortuna | fortuna, casa-pariurilor | 1958 | 0 |
| EveryMatrix | getsbet, contibet | 0 | 188 |

`loadWorkspace` already suppressed *byte-identical* Altenar payloads. It
cannot see a pair whose prices drifted apart between two captures — which is
precisely the case that looks like arbitrage. The groups are therefore
declared in `src/scanner/feed-groups.mjs` and enforced in `findArbitrage` and
`findPositiveEV`.

`maxbet` is deliberately not in the NSoft group: same platform, different
company UUID, and a different catalogue. Historical captures show a different
football sportId and marketId, so a real price difference is possible there.

Effect: 9 → 0 opportunities; positive-EV signals 16,213 → 8,530.

### 2. The whole Fortuna family was invisible to the contract guard

Two independent bugs, both in `src/scanner/market-contracts.mjs`.

**Period.** The FEG scrapers publish `period: 'unknown'` on every market.
`isFullTimeMarket` treated any non-empty string as a real settlement period and
accepted only `fulltime` / `full time` / empty, so `'unknown'` was rejected.
Every FEG market was dropped before contract resolution — the literal case
the function's own comment describes as "absent" was not handled.

**Key shape.** FEG keys are `ufo:mtyp:<sport>-<marketType>`, verified against
live output:

| Key | Market name | Selections | Full-time 1X2? |
|---|---|---|---|
| `ufo:mtyp:00-00` | Meci | 1 / 2 / X | yes |
| `ufo:mtyp:00-01` | Meci - sansa dubla | 12 / 1X / X2 | no |
| `ufo:mtyp:00-03` | Victorie fara egal | 1 / 2 | no |
| `ufo:mtyp:00-04` | Pauza sau Final | X / 2 / 1 | no |
| `ufo:mtyp:00-0u` | Total goluri 2.5 | sub / peste 2.5 | no |
| `ufo:mtyp:00-1c` | Ambele marcheaza | Da / Nu | no |

`isOpaqueMatchResultKey` read the **first** field as the period, so it accepted
the goals-total and BTTS keys and rejected the real match-result key — exactly
backwards. The second field is the market type; only `00` is "Meci".

Effect, measured on a live 10-book capture: eligible full-time 1X2 markets
went from 0 to 845.

| Source | Eligible 1X2 markets |
|---|---|
| admiral / stanleybet / maxbet / excelbet | 100 each |
| fortuna | 99 |
| casa-pariurilor | 98 |
| winner | 79 |
| netbet | 74 |
| superbet | 70 |
| betano | 25 |

### 3. Scrapers wrote an identity key unrelated to the matching key

Nine adapters each built their own `eventKey` string, and all of them included
the league. The scanner meanwhile grouped by `eventIdentityKey`, so a key
produced by the scanner could not be looked up in a snapshot: `market-catalog`
and `/api/odds` filtered on the written form, which no longer matched anything
the scanner emitted.

`ScraperBase.validate` now normalises the key once, for every adapter, keeping
the adapter's own string as `providerEventKey` for provenance. Verified on a
ten-book live capture: 1000/1000 events carry the canonical key, and
`/api/odds?eventKey=…` resolves it.

### 4. One source prices markets below break-even

A complete three-way result market whose inverse-odds sum is below 1 pays out
more than it collects. No real book does that. Measured across all 22
configured sources, only contibet does, on roughly a fifth of its events — on
the saved capture (5 of 23) and live (2 of 11). The parsed selections are
correct, so it is the feed, not the parser: it publishes 1.99 / 3.80 / 5.50 for
a match another book prices 1.51 / 4.20 / 6.00.

Such a source is recorded with an `implausibleMarginRate` and, above 10%, its
events are dropped before any signal is derived. A stray bad market should not
disqualify a book; a fifth of them means the prices cannot be trusted.

## Current state

- Live smoke across all 22 enabled jobs: every one succeeds. No redirect
  (the adapters now use `redirect: 'error'`), no body over the 16 MB cap.
- Response sizes: superbet ~7.4 MB, NSoft ~6.5 MB, maxbet ~4.8 MB, Altenar
  ~210–280 KB, favbet ~14.4 MB. The 4 MB cap first tried on
  `provider-contract.fetchJson` would have rejected favbet outright, so the
  limit is now 16 MB to match `nsoft.mjs`.
- EveryMatrix (getsbet, contibet) completes in ~34 s against a 3-minute
  per-attempt deadline.
- End-to-end through the server: four independent books scraped, 399 events
  accepted, 19 SSE events delivered (15 `scrape-update`, 1 `scan-update`, 3
  `heartbeat`), catalog with 3607 cross-book events, CSV export 200.

### Unibet is not a missing feed, it is a different transport

The adapter targets `/api/kambi/offer/v1/betoffer/list.json`. That path returns
404 while the site itself returns 200, so the job was failing for a different
reason than the timeouts recorded when it was disabled — four consecutive runs
fail in 70–244 ms, not by timing out.

`scripts/discover-unibet.mjs` loads the sportsbook in Chromium and records what
it actually calls. The odds now live behind
`wss://sportsbff-ams.kindredext.net/betting-mqtt-sports/` — an MQTT-over-
WebSocket feed, not a pollable REST endpoint. The REST siblings that remain
(`odds-ladder`, `az-menu`, `configured-landing-page`) answer to a plain fetch
with no cookies, and `scripts/probe-unibet-feed.mjs` confirms 200 with 640 KB
of odds-ladder data — but that payload is a display-format scale
(`1.001 → 1/1000`), and the landing view contains no events at all. Scrolling
the odds list produced no further data calls.

So re-enabling this book is not a URL fix. It needs an MQTT client, a
subscription, and a reconnect test against a live feed — a different piece of
work from anything else here, and one that would add a persistent connection to
a scraper set that is otherwise stateless polling.

## What is still open

- Whether an arbitrage ever surfaces. Repeated captures put the best case
  between −1.8% and −2.27%, always negative, and the widest price dispersion
  between independent feeds is smaller than the margin. That points to the
  market rather than the tooling, but it is a statement about the moments
  sampled, not a proof.
- **favbet was briefly gated by a Cloudflare challenge** partway through
  2026-09-26 — HTTP 403 with a "Just a moment..." page on the API endpoint and
  on the site's own pages, whatever headers were sent, while every other book
  kept working. It recovered on its own within the hour, so the adapter was
  never at fault. Policy is no challenge bypass, so the scraper fails closed
  and the run is reported as `rejected` during such a window rather than
  silently returning zero events. The goals-market coverage above was measured
  while it was blocked and is therefore a lower bound.
- The league alias table is built from one capture. A competition published
  under a name not in the table will not pair, which loses an opportunity
  rather than inventing one. `node scripts/gen-league-translations.mjs`
  rebuilds it from the capture on disk.
- `getsbet` and `contibet` return 11 events each. Their dealer publishes only
  three Romanian football divisions, which is a coverage limit upstream, not in
  the adapter.
- Unibet stays disabled, so the independent-source count is 11 rather than 12.
  The reason is a transport change rather than an unimplemented adapter — see
  above — so re-enabling it is a build, not a configuration flip.

## Reproduce

```bash
# live adapters, with size and timing
node scripts/live-check.mjs

# repeated captures, tracking how close the market gets
node scripts/sample.mjs superbet,netbet,betano,winner,fortuna,admiral 5 120000

# rebuild the league translation table from the capture
node scripts/gen-league-translations.mjs

# contract, feed-group and league-alias unit tests
node --test test/engine.test.mjs test/feed-groups.test.mjs \
  test/league-aliases.test.mjs test/event-grouping-risk.test.mjs \
  test/verification-regression.test.mjs
```
