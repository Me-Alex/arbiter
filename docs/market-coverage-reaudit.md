# Captured market coverage re-audit — 2026-10-08

No initially unsupported market produced a new complete, independent-feed, same-fixture contract. Recovery came from club-name identity: **14 additional 1X2 bookmaker pairs in the older workspace and 90 additional bookmaker/contract pairs in the current workspace**. One previously reported BTTS pair was invalid and was removed. Net gain: **103**.

Counts below follow scripts/market-coverage.mjs: each unordered independent bookmaker pair is counted once per contract line when it shares at least one fixture. They are historical coverage counts, not profitable or currently executable surebets; multiple fixtures for the same bookmaker/contract pair do not increase this metric. Shared-feed brands remain excluded.

| Workspace | Books | Resolved lines before → after | Lines with same-fixture independent pairs | Same-fixture bookmaker/contract pairs |
|---|---:|---:|---:|---:|
| data-market-run/workspace | 22 | 14 → 14 | 4 → 3 | 138 → 151 |
| data/workspace | 24 | 39 → 39 | 23 → 23 | 1449 → 1539 |

## Every recovered market

These are additional pairings on existing contract lines, not new market families. Handicap lines below are in home/away order. All totals are match goals totals with explicit subject, team and period.

| Workspace | Contract | Before | After | Change |
|---|---|---:|---:|---:|
| data-market-run/workspace | MATCH_ODDS::fulltime::_::home+draw+away::_::_ | 133 | 147 | +14 |
| data-market-run/workspace | BTTS::fulltime::_::yes+no::_::_ | 1 | 0 | -1 |
| data/workspace | OVER_UNDER::fulltime::3.5::over+under::goals::match | 131 | 142 | +11 |
| data/workspace | OVER_UNDER::fulltime::1.5::over+under::goals::match | 111 | 112 | +1 |
| data/workspace | OVER_UNDER::fulltime::4.5::over+under::goals::match | 85 | 105 | +20 |
| data/workspace | BTTS::fulltime::_::yes+no::_::_ | 95 | 100 | +5 |
| data/workspace | ASIAN_HANDICAP::fulltime::-1.5/1.5::home+away::_::_ | 76 | 78 | +2 |
| data/workspace | ASIAN_HANDICAP::fulltime::1.5/-1.5::home+away::_::_ | 66 | 70 | +4 |
| data/workspace | OVER_UNDER::fulltime::0.5::over+under::goals::match | 67 | 69 | +2 |
| data/workspace | ASIAN_HANDICAP::fulltime::2.5/-2.5::home+away::_::_ | 57 | 67 | +10 |
| data/workspace | ASIAN_HANDICAP::fulltime::-3.5/3.5::home+away::_::_ | 33 | 40 | +7 |
| data/workspace | ASIAN_HANDICAP::fulltime::3.5/-3.5::home+away::_::_ | 21 | 37 | +16 |
| data/workspace | ASIAN_HANDICAP::fulltime::-4.5/4.5::home+away::_::_ | 22 | 28 | +6 |
| data/workspace | ASIAN_HANDICAP::fulltime::4.5/-4.5::home+away::_::_ | 7 | 12 | +5 |
| data/workspace | OVER_UNDER::half1::1.5::over+under::goals::match | 9 | 10 | +1 |

## Candidate ledger

The capture test and both football coverage commands were run after each candidate group, including the final refusal pass.

| Candidate | Older workspace pairs | Current workspace pairs |
|---|---:|---:|
| Baseline | 138 | 1,449 |
| Exclude mislabelled BTTS variants | 137 | 1,449 |
| Kabuscorp SCP / Kabuscorp | 147 | 1,449 |
| Captured club spellings, Norwegian ø, and league translations | 147 | 1,534 |
| Romanian club aliases; preserve CS Dinamo as a distinct club | 147 | 1,538 |
| UNAM FC / UNAM Windhoek and Inter / Inter Milano | 151 | 1,539 |
| Re-audit remaining unsupported markets and identity candidates | 151 | 1,539 |

## Unsupported-market census and stop decision

The older workspace contains 31,927 markets, all football. Initially zero resolved to null. The current workspace contains 112,622 markets across sports (108,086 football); initially 48 resolved to null, of which 45 were football. Every initially-null shape was inspected.

| Candidate | Captured evidence | Decision |
|---|---|---|
| Qualification | 38 football markets, ufo:mtyp:00-12, “Se califica”, 1/2 selections, Fortuna/Casa Pariurilor | One shared feed; not full-time result settlement. No independent qualification counterparty. |
| Quarter-line goals totals | Seven Don TOTAL_GOALS markets, lines 1.25/2.25/3.25 | Push/partial-settlement lines do not fit the current exhaustive-outcome surebet calculation; no independent same-line publisher. |
| Handball handicap | Betano FAHC, BK-46–EIF, 2026-10-07 15:30Z; BK-46 -10.5 / EIF +10.5 with matching handicap fields | The name parser reads the club's -46 as a line. Potentially decodable, but no other captured feed quotes the fixture. No speculative route added. |
| Rugby result | Australia–Samoa, 2026-10-16 09:05Z; Fortuna/Casa Pariurilor ufo:mtyp:07-00 have only X/2 | Missing home outcome. Superbet also captures only X/2; no complete settlement partition to arbitrage. |
| Corners | CNOU already resolves with subject=corners; Betano has October 7 fixtures, Favbet October 9–11 fixtures | Three lines have independent publishers, but none share a fixture. |
| Cards | Betano TCOU, 3.5/4.5/5.5, already resolves with subject=cards | One publisher. |
| Asian handicap subtypes | Captured football half-lines already resolve; no additional initially-null football handicap subtype | Identity gains are listed above; no invented whole/quarter-line settlement. |
| First-half O/U | Existing encoded totals, OUH1, TOTAL/TOTAL_GOALS, Superbet detail markets already resolve separately from full-time | Identity recovers one additional first-half 1.5 pair. |
| First-half 1X2 / exact score | No captured football markets identify either contract | No invented keys, selections or score catch-all. |
| BTTS variants | Older Favbet BOTH_TEAMS_SCORE keys actually name more than 1.5 each (757), less than 1.5 each (768), or both teams scoring in both halves (143) | All 1,668 now refused. Their Yes/No selections are not plain BTTS. This removes one false older-workspace pair. |
| BTTS by half | Favbet half1/half2 already resolve in distinct periods | Single publisher; no independent pair. |

The final identity pass found no further supported spelling-only gain. The remaining current-workspace candidates omit women/youth identity (Sporting/Moravia and Rosenborg/Lillestrom), so they remain separate. The older workspace also contains reversed home/away records and missing squad qualifiers; these cannot be merged as spelling aliases without evidence and outcome remapping. No feed, selection, handicap or kickoff was manufactured or changed.

## Regression evidence

- test/fixtures/market-reaudit-captures.json contains 47 independent-feed fixture witnesses, three BTTS variant captures, all six initially-null selection shapes, and two ambiguous fixture pairs. Tests compare every saved event field and market/selection object against the source workspace verbatim.
- Every captured total was checked for subject, team and period; football totals additionally require fulltime/half1/half2 and half-point lines. Tests preserve shared-feed exclusion, stale-price behavior, youth distinctions and Liga I/Liga II separation.
- Requested command: node --test test/market-coverage-captures.test.mjs. The Windows sandbox rejects the test runner's subprocess with spawn EPERM. The same tests run successfully with --test-isolation=none.
- Both requested coverage commands complete successfully. Final no-change pass produces the same 151 / 1,539 pair counts.
- Final validation: 111 tests pass across capture coverage, contract families, full market coverage, league aliases, text normalization, coverage reporting and scanner engine; targeted ESLint passes.

Commands:

    node --test --test-isolation=none test/market-coverage-captures.test.mjs
    node scripts/market-coverage.mjs --workspace data-market-run/workspace football
    node scripts/market-coverage.mjs --workspace data/workspace football

## Postscript: post-promotion coverage and the first verified surebets (2026-10-08)

Coverage was re-measured after the four new books were promoted and unibet's
crawl scoped (this supersedes the pair counts in the sections above, which
predate both changes):

| Run | Books | Contract lines | Independent pairs | Same-fixture meetings |
|---|---|---|---|---|
| frozen (`data-market-run`) | 22 | 14 | 215 | 139 |
| live (`data/workspace`) | 28 | 46 | 2092 | 1524 |

The live run adds 4 books and 32 contract lines: vipbet publishes the EGT
source that previously had no active brand, and the three extra Digitain tenants
only widen coverage where winner already priced. Same-fixture meetings vary by
capture moment, so the live number moves with the workspace; the structural
result is that no line published by two independent books fails to meet any more
except the two measured as genuinely disjoint.

The full scrape → scan → second-opinion verification cycle then produced the
project's first confirmed surebets (matches, legs and margins in
`SCRAPER-TASKS.md`). Structural note worth keeping: all three require favbet,
two of three require casa-pariurilor, and none required the new books — the
recovery of two feeds that 403ed that morning is what produced them, and the
pair-count ceiling only converts to money when the right two feeds are up on
the right fixture.
