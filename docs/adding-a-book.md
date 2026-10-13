# Adding a bookmaker

Adding a book used to mean editing six files by hand — the adapter,
`config/scrapers.json`, the dispatcher's `DIRECT` and `DIRECT_CONTRACTS` maps,
the platform's brand table, and `data/endpoints/endpoints.json` — with no check
that the result was routable until a test failed somewhere else.
`scripts/add-book.mjs` performs those edits in one step, from one table of what
each platform actually needs, and then refuses to do more.

```
npm run new-book -- --id betex --platform digitain --endpoint https://… --host betex.ro
```

The scaffold creates a **candidate**, never a working book. Everything it writes
is `enabled: false` and `validationStatus: 'candidate'`, and it never sets
`feedStatus`. Promotion is a measured decision and stays one — see
[Promoting a book](#promoting-a-book).

Start with `--dry-run`. It prints every file it intends to touch and writes
nothing:

```
add-book: zz-guide on exalogic-xsport (dry run — nothing written)
  add   src\scrapers\zz-guide.mjs — the skeleton adapter for exalogic-xsport
  edit  config\scrapers.json — the disabled, unvalidated job entry
  edit  src\scrapers\index.mjs — the dispatcher entry (import + DIRECT + the exact contract)
  edit  data\endpoints\endpoints.json — the endpoint registry record (unverified until measured)
  add   test\zz-guide.test.mjs — the test entry point for this book
```

`npm run new-book -- -h` lists every flag and every platform.

## The five dispatch shapes

The platform decides what gets written. Getting this wrong is silent, so
`src/scrapers/platforms.mjs` holds one recipe per platform, each derived from
books that already ship, and each naming the ones it was read from.

| Platform | Adapter written | Also edited | Routed by |
|---|---|---|---|
| `digitain`, `egt-digital` | new subclass file | platform brand table, `DIRECT` + `DIRECT_CONTRACTS` | the dispatcher |
| `nsoft` | **none** | `TENANTS` tuple in `nsoft.mjs` | `matchesNSoftConfig` |
| `altenar-sb2` | **none** | `TENANTS` array in `altenar-sites.mjs` + `ALTENAR_IDS` | `matchesAltenarConfig` |
| everything else | new skeleton that throws | config, `DIRECT` + `DIRECT_CONTRACTS` | the dispatcher |

`nsoft` and `altenar-sb2` get no adapter file on purpose. Their matchers run
*before* `DIRECT_CONTRACTS` in `src/scrapers/index.mjs` and dispatch on the
config's own `engine`/`transport`/`script` triple, so a subclass written for
them would be a file nothing imports. For the same reason `script` is a locked
field on both: a tenant naming an adapter file no matcher accepts is a job
pointing at nothing. The existing `admiral`, `stanleybet` and `maxbet` entries in
`DIRECT` are legacy provider-contract classes that no configured job reaches
(`src/scrapers/index.mjs:47-53`) — they are reference, not a pattern to copy.

The shipped `admiral` config job is the clearest example of why the recipes
exist: it declares `script: "nsoft.mjs"` while `DIRECT_CONTRACTS.admiral` says
`admiral.mjs`, so the two disagree and the matcher wins. `test/provider-contract.test.mjs`
exists to keep that true.

A skeleton throws `ValidationError` from both `normalize()` and
`extractEvents()`. That is deliberate: a book that collects nothing must not look
like a quiet day.

## After the scaffold runs

1. **Implement the skeleton**, if you got one — `fetchRaw` → `normalize` →
   `extractEvents`, against a real capture rather than a guessed payload. The
   generated file names these three in its header.
2. **Capture a real response** into `data/endpoints/captures/` (112 files today)
   and set that record's `feedStatus` to what it answered. The scaffold omits
   the field entirely on purpose: `test/field-census.test.mjs` requires
   `feedStatus` to be exactly one value across all 110 records and to be backed
   by the registry, and an invented value would satisfy neither. The values in
   use are `verified`, `experimental`, `no-sports-feed`, `no-public-odds-feed`
   and `host-down`.
3. **Replace the checks the scaffold left for you.** `test/<id>.test.mjs` is
   generated with three or four real checks, and two of them describe the
   scaffold rather than the book: the candidate state, and (on a skeleton) the
   unimplemented adapter refusing to fetch. Each calls `t.skip()` once it no
   longer applies, so following the order above never turns the file red — but a
   skip is not coverage. When the fail-closed check steps aside, that is the
   signal to replace it with fixtures from the real capture;
   `test/winner.test.mjs` is the model.

   What stays and keeps firing: the contract triple, and the fact that the
   dispatcher resolves the job. On a brand or tenant platform that second check
   also proves the table row exists — the base constructor throws without it, so
   removing the row makes the routing check fail with `unknown brand <id>`.
4. **Run the gates.** `node --test test/scraper-routing.test.mjs` and friends.
   See below.

## Promoting a book

Only after the adapter works against a real capture:

```
enabled: true, validationStatus: 'validated'
```

`test/scraper-routing.test.mjs` enforces enabled ⇒ validated, so the two cannot
be flipped apart. A job that only ever collected nothing stays a candidate; that
is a legitimate state, and the dashboard shows candidates as such.

For live verification, `npm run smoke:live -- --books <id>` exercises the real
feed. It needs network access — a scaffolded tree cannot be verified that way
offline, and nothing in this repository pretends otherwise.

## What the scaffold refuses

It exits non-zero and writes **nothing** rather than leaving a half-book, when:

- the id already exists in `config/scrapers.json` or the registry;
- the platform is not in the catalogue;
- a sport is not registered in `src/sports/registry.mjs`;
- `--endpoint` is not an http(s) URL, or `--host` is not a hostname;
- a required `--host` / `--uuid` / `--unit` is missing for that platform;
- a locked field (`--script`, and for `altenar-sb2` also `--engine` and
  `--transport`) is overridden with a different value;
- a brand table, tenant table, or id array cannot be located in the tree.

## Adding a platform to the catalogue

For a platform no shipped book uses yet, add a `skeleton` recipe to
`RECIPES` in `src/scrapers/platforms.mjs`: engine, transport, a `url` note, and
`notes` explaining what the feed is and whether it adds an *independent* price.
Independent matters — `src/scanner/feed-groups.mjs` groups books that share one
upstream feed, and a book that is not an independent source cannot be counted
as arbitrage coverage. `custom` is the platform for a book not yet characterised;
it is deliberately unverified.

Once a real book of that platform works, promote the recipe to `brand` or
`tenant` and record in `derivedFrom` which books it was read from. The id must
be a string `config/scrapers.json` and `endpoints.json` already use — a scaffold
that wrote a new vocabulary would be the only book of its kind in the registry.

## Tests

`test/add-book-scaffold.test.mjs` copies the tree to `scratch/`, scaffolds a book
of each dispatch shape into the copy, and runs this repository's own gate tests
against it — `scraper-routing`, `provider-contract`, `endpoints-registry`,
`sport-registry-consistency`, `field-census`. It keeps no private copy of what
"a valid book" means, so it cannot drift into agreeing with a scaffold that
stopped producing one.

One trap worth knowing before you edit that file. A spawned `node --test` that
inherits `NODE_TEST_CONTEXT` from the outer runner prints *"run() is being called
recursively within a test file. skipping running files"*, runs nothing, and exits
**0**. Every assertion there compares status to 0, so an inherited context turns
all five gates into no-ops that pass — the proof of this whole system, verified
against gates that never executed. `runGate()` deletes the variable and returns a
`ran` flag derived from the child's tally, and every caller asserts `ran` before
asserting `status`. If you add a spawned test, do the same: a gate that did not
run is indistinguishable from a gate that passed.

The copy goes under `scratch/` rather than the OS temp directory, and that is
load-bearing: `src/scrapers/index.mjs` imports `betano.mjs`, which imports
`playwright-extra`, which Node resolves by walking up to `node_modules`. A copy
under `C:\Users\…\Temp` walks up into nothing.

Run tests per file. A combined run reports hundreds of cancellations from a
sandbox `EPERM` artifact on Windows, documented in
[market-coverage-reaudit.md](market-coverage-reaudit.md); those are not
regressions.