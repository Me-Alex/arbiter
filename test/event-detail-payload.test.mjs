/**
 * event-detail-payload.test.mjs — is every field /api/event-detail publishes read by someone?
 *
 * api-surface.test.mjs already proves something calls this route, including
 * the awkward `pathname === '/api/event-detail'` equality branch that a
 * prefix-shaped regex cannot see. That is a claim about the route, not about
 * the payload: a published field with no reader is invisible at route level, and
 * on this route it had already happened. The payload published `arbs` as a
 * flat array on top of the same arbitrage map it had already attached per
 * market as `m.arb`. Nothing read `arbs`, and it could not have been used:
 * `findDetailArbitrages` keys by market key, so spreading the values throws
 * away the only link between a plan and the market it belongs to.
 *
 * So the payload is checked field by field against the code that renders it,
 * and every unread field has to be named with a reason. One such reason is
 * already real: `selection.handicap` is never read, because the modal derives
 * the same line from the market key via `thresholdFromKey` and shows it in the
 * market heading. That is a reason, not a coincidence — but it is a reason
 * about today's capture, which is why the field is excused here rather than
 * dropped from the projection, which passes selection objects by reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { codeOnly, fieldReads, fieldsOn } from './helpers/code-only.mjs';
import { findDetailArbitrages } from '../src/scanner/event-arbs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CONSUMERS = [
  ['event-detail-modal.js', read('public/js/pages/event-detail-modal.js')],
  ['event-detail.js', read('public/js/pages/event-detail.js')],
  ['dashboard.js', read('public/js/pages/dashboard.js')],
];

/**
 * Fields published with no reader, and why that is not a defect. Adding a key
 * here is a claim about the code and has to survive review like any other.
 *
 * Keyed `level.field`, and that is the fix of a hole this lot found rather than
 * style. It was keyed by field name alone, so an excuse written for one level
 * silently excused the same name on every other level: publish `family` on the
 * event object as well as inside the plan, and the census waved it through on
 * `family`'s plan excuse, because `family` was in the table. The excuse is a
 * claim about *where* nothing reads the field, and a name does not carry a level.
 */
const UNREAD_WITH_REASON = new Map([
  ['selection.handicap', 'the modal renders the line itself from the market key (thresholdFromKey) in the market heading, so the numeric copy on the selection says nothing the heading has not said. Kept on DETAIL_SELECTION_FIELDS, which now names every field this projection publishes: the reason is a decision with a reason attached, which is what it was not when the route forwarded selection objects by reference.'],
  ['selection.group', 'measured on data-market-run/workspace, 22 blobs / 24829 events / 93600 selections: every selection carries group, every one of them says "Main", and not one market in 31927 holds two selections that share a name in different groups, so the field separates nothing in any capture on disk. The modal keys its columns on name-or-id alone, so no screen is missing a distinction. Kept for the same reason as handicap — it is on the named list — because group is what a book would use to disambiguate same-named outcomes the day one emits them.'],

  // The four below live one level deeper, inside the arbitrage plan attached as
  // `m.arb`. They reached this table the same way the census found them: the
  // walk stopped at the market, where `arb` is one more key on the row, so the
  // interior of the plan was under the floor of the only census covering this
  // route. Two of the plan's keys were copies of a fact already on the wire and
  // are gone (see the DetailArb docstring); these four are not copies, they are
  // simply unread — and each is kept for a reason that can be checked, not for
  // the convenience of the publisher.
  ['plan.family', 'the canonical alias of the contract the market heading already names in the book\'s own words. The heading renders m.name on every market (event-detail-modal.js:217-219) and falls back to the canonical key when a book sends none (:192), so a section is never left unlabelled and the alias has nothing to add beside it. What this reason deliberately does NOT claim is that the captures cover no family the heading fails to name. It used to, on a walk over data-market-run/workspace that found three plans and called them all BTTS — but every BTTS leg came off favbet rows this tree no longer emits, so that coverage described a writer which is not the one in this tree. Measured in test/favbet.test.mjs (\'the stored capture keys BTTS to rows this adapter now withholds\') and in the walk at the end of this file.'],
  ['plan.period', 'the settlement window the legs agree on. No plan on disk settles outside full-time, so the field separates nothing there — recomputed by the walk at the end of this file rather than quoted from one run of it. The scope that does vary is live vs pre-match, and that is published as `live` and already rendered as the panel\'s live badge. Kept because the docstring claims the view must be able to say a plan expires in 90 seconds, and that claim is about this field — dropping it would quietly retire a promise the panel has not yet kept.'],
  ['plan.line', 'the canonical line. No plan on disk carries one — recomputed by the same walk, not transcribed. Where a line does exist the heading shows it, derived from the market key by thresholdFromKey — the same derivation the assertion below checks. The case this reason does NOT cover is an Asian-handicap plan: thresholdFromKey only matches /^OVER_UNDER_\\d+_\\d+$/, so an AH heading would show no line. That is a gap in the heading, and it is named here rather than used as a licence to publish the number twice.'],
  ['plan.inverseSum', 'the raw reconciliation before it is rescaled into the ROI the panel does render. No screen shows it, and that is the honest part: the reader is a backend contract assertion, test/event-detail-arb.test.mjs:86, which recomputes Σ(1/odds) from the legs and holds the published figure to it. That reader is what makes this a contract on the allocation rather than a leftover from it, and roiPercent cannot stand in for it — the two are one figure in two units, the ROI being the inverse sum rescaled and rounded to two decimals (src/scanner/market-contracts.mjs:203), and the walk at the end of this file checks that relation on every plan it finds. The text this replaced quoted both numbers from one capture; the relation outlives that capture.'],
]);

/**
 * Blank out the byte ranges the tokenizer calls comments, then search what is
 * left. A hand-written stripper was tried first and got a backtick wrong: it
 * swallowed the rest of dashboard.js from line 742 on, so the comment at 560
 * survived the "stripping" and `selection.group` was credited with a reader it
 * does not have. espree is what ESLint already runs over these files, so it is
 * asked the only question it cannot get wrong — which ranges are comments.
 *
 * That masker now lives in helpers/code-only.mjs. It was never this file's:
 * four censuses in the tree decided readership from raw source text, each
 * carrying its own version of the idea, and this was the fifth copy. One
 * implementation means the next census starts from the honest one.
 */

/** Does any consumer read `name` off an object, or name it in an object literal? */
function readersOf(name) {
  const re = new RegExp(`\\.${name}\\b|(?<!\\.)\\b${name}\\s*:|\\['${name}'\\]`, 'g');
  const sites = [];
  for (const [file, src] of CONSUMERS) {
    const n = (codeOnly(src).match(re) || []).length;
    if (n) sites.push(`${file}×${n}`);
  }
  return sites;
}

/**
 * The key the plan hangs from, and therefore the receiver a plan field is read
 * off. The level below reaches the plan through `m.arb`, so a plan reader is a
 * read spelled `arb.<field>` or `m.arb.<field>` — the same trailing segment in
 * both spellings, so one receiver-anchored search covers the panel's own
 * parameter and every access through the market row.
 */
const PLAN_KEY = 'arb';

/**
 * Readers of a plan field, per file, in the same shape `readersOf` returns.
 *
 * This exists because the name-only search above over-covers, and the mutation
 * run is what made that visible rather than argued: putting `marketKey` back
 * into the plan literal left the census green, because dashboard.js reads
 * `marketKey` — on an *opportunity*, from a different payload entirely, five
 * times over. A same-named field on another route's object is not a reader of
 * this route's object, and a name is the one thing this route cannot assume is
 * unique. So at this level the reader has to be a read of that plan.
 *
 * The consequence is that this level is strict while the three above it are
 * still name-only. That asymmetry is deliberate and worth stating plainly: the
 * level opened by this lot is the one where a duplicate is most likely to carry
 * a name the frontend already uses elsewhere, which is exactly the case the
 * loose form waves through.
 */
const PLAN_READERS = (() => {
  const byField = new Map();
  for (const [file, src] of CONSUMERS) {
    for (const f of fieldReads(src, PLAN_KEY, true)) {
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(file);
    }
  }
  return byField;
})();

/**
 * Readers of an event field, per file, in the same shape `readersOf` returns.
 *
 * The event level needed this for the same reason the plan level did, and the
 * measurement is what says so rather than a hunch. The route publishes ten
 * fields per event; over data-market-run/workspace, through the real route, its
 * three consumers read three of them — `markets`, `sourceId`, `sourceUrl`. The
 * other seven were credited a reader because dashboard.js reads identically-named
 * fields on *opportunities*: `o.sport`, `o.homeTeam`, `o.league`, `o.kickoff`,
 * `o.live`, all on a payload this route never serves. Five of them have been
 * connected to the bookmarkable event page since, and one was deleted as an
 * alias, so today all seven are read — but the census could not have told that
 * from the collision, which is the point.
 */
const EVENT_READERS = (() => {
  const byField = new Map();
  for (const [file, src] of CONSUMERS) {
    for (const f of fieldReads(src, 'ev', true)) {
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(file);
    }
  }
  return byField;
})();

/**
 * The bindings that hold selections, found by proof rather than by name.
 *
 * This level was written as name-only, on the recorded claim that `s` is
 * ambiguous and cannot be anchored: in dashboard.js `s` is a source, in
 * event-detail-modal.js `s` is a selection. The claim about the name is true and
 * it does not survive contact with a measurement — the ambiguity is between
 * files, and a binding can be proven to be a selection without being told so.
 *
 * The proof: the panel computes each book's overround from a selection's odds and
 * renders the column (event-detail-modal.js:242, `match.odds > 1`), so a binding
 * that reads `odds` holds something the panel prices. Requiring one of `name` or
 * `id` beside it keeps the arbitrage legs out — measured over the three consumers
 * (scratch/probe-selection-receivers.mjs), six bindings read `.odds`:
 *
 *   event-detail-modal.js:match  id, name, odds            — a selection
 *   dashboard.js:e               altKey, ctrlKey, legs...  — an arb leg
 *   dashboard.js:l               eventUrl, payout, stake... — a leg
 *
 * and exactly one survives both conditions. `s` in dashboard.js never appears:
 * it reads `dataStatus` and `ageMs`, never `odds`, which is the whole reason the
 * name search could have credited it a selection field.
 *
 * So the level is anchored after all, and the hole that made it name-only —
 * a selection field called `dataStatus` would have been waved through on
 * dashboard.js's *source* read — is closed. The assertion pairing below keeps
 * both sides visible: `readersOf('dataStatus')` is non-empty and
 * `SELECTION_READERS` has no `dataStatus`, which is that hole, measured.
 */
const SELECTION_BINDINGS = (() => {
  const found = [];
  for (const [file, src] of CONSUMERS) {
    const text = codeOnly(src);
    for (const [, receiver] of text.matchAll(/\b([A-Za-z_$][\w$]*)\.odds\b/g)) {
      const fields = fieldsOn(text, receiver);
      if (!fields.includes('name') && !fields.includes('id')) continue;
      if (found.some((b) => b.file === file && b.receiver === receiver)) continue;
      found.push({ file, receiver, fields });
    }
  }
  return found;
})();

const SELECTION_READERS = (() => {
  const byField = new Map();
  for (const b of SELECTION_BINDINGS) {
    for (const f of b.fields) {
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(`${b.file}:${b.receiver}`);
    }
  }
  return byField;
})();

/** The reader set for one level. The payload and market levels use the name search. */
const readersForLevel = (level, key) => {
  const anchored = level === 'plan' ? PLAN_READERS
    : level === 'event' ? EVENT_READERS
      : level === 'selection' ? SELECTION_READERS : null;
  return anchored ? (anchored.get(key) || []) : readersOf(key);
};

/**
 * A workspace with two books quoting one event, priced so a cross-book
 * arbitrage really exists. The arb has to be present, or the test would pass
 * without ever proving the per-market channel works.
 */
function seedWorkspace(dir) {
  // loadEventDetailSnapshots reads `join(dataDir, 'workspace')`, not dataDir
  // itself. The first version of this fixture wrote the blobs one level too
  // high, so the route answered 200 with zero events and the failure read as
  // "the projection publishes nothing" rather than as a fixture that was in
  // the wrong place.
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const now = new Date().toISOString();
  // Every selection carries the provider bookkeeping that nsoft.mjs:497 and
  // altenar-public.mjs leave on their own — deliberately, so the payload has
  // something it must NOT publish. A fixture that only carried the five fields
  // the route publishes would pass against a projection that forwards
  // selections by reference, which is exactly the leak this closes.
  const bookmaker = (id, name, odds, extra = {}) => ({
    id: `${id}-${name}`, name, odds, group: 'Main', providerOutcomeId: `${id}-out-${name}`, providerName: id, ...extra,
  });
  const event = (sourceId) => ({
    id: `${sourceId}-1`,
    sourceId,
    sourceUrl: `https://example.invalid/${sourceId}`,
    observedAt: now,
    sport: 'Football',
    league: 'Liga',
    kickoff: '2026-10-01T18:00:00.000Z',
    homeTeam: 'Athletic Bilbao',
    awayTeam: 'Atletico Madrid',
    eventKey: 'football|2026-10-01|athletic-bilbao|atletico-madrid',
    markets: [
      {
        key: 'BOTH_TEAMS_SCORE',
        name: 'Both teams to score',
        selections: [
          // A market with no line, which is the majority case in the capture and
          // the one a truthiness test would lose: 29286 selections carry a line
          // there, 28278 carry `handicap: null`. BTTS is quoted without a line, so
          // these two arrive with the key present and empty.
          bookmaker(sourceId, 'Yes', sourceId === 'alpha' ? 2.84 : 1.9, { handicap: null }),
          bookmaker(sourceId, 'No', sourceId === 'alpha' ? 1.55 : 2.55, { handicap: null }),
        ],
      },
      {
        // A second market with no cross-book arbitrage, quoted by both books at
        // the same price. Without it the fixture had a single market, which is
        // the one market the route attaches an arb to — so "attaches the plan to
        // every market" and "attaches it where it found one" were the same
        // observation, and a mutation that fabricated plans for markets without
        // one could not be told apart from correct behaviour.
        key: 'OVER_UNDER_2_5',
        name: 'Total goluri Peste/Sub',
        selections: [
          bookmaker(sourceId, 'Peste 2.5', 1.9, { handicap: '2.5' }),
          bookmaker(sourceId, 'Sub 2.5', 2.05, { handicap: '2.5' }),
        ],
      },
    ],
  });
  for (const sourceId of ['alpha', 'beta']) {
    writeFileSync(join(workspace, `${sourceId}_events.json`), JSON.stringify({
      schemaVersion: 2, runId: `markets-1-${sourceId}`, sourceId, sourceUrl: `https://example.invalid/${sourceId}`,
      capturedAt: now, observedAt: now, dataStatus: 'ok', events: [event(sourceId)],
    }), 'utf8');
  }
}

async function fetchPayload() {
  const dir = mkdtempSync(join(tmpdir(), 'arb-detail-'));
  try {
    seedWorkspace(dir);
    const route = buildRouter({
      dataDir: dir,
      publicDir: dir,
      configPath: 'unused', profilesPath: 'unused',
      rateLimiter: new RateLimiter({ capacity: 500, refillPerSec: 500 }),
      logger: () => {},
      scanService,
      orchestrator: { scrapeState: { status: 'idle', jobs: [] }, async launch() { return {}; }, async cancel() { return {}; } },
      scheduler: { async status() { return {}; }, async enable() {}, async disable() {} },
      tracker: { async loadAlerts() { return { preferences: {} }; }, async saveAlerts(p) { return p; } },
      broadcaster: { add() {}, stop() {} },
    });
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => route(req, res, new URL(req.url, 'http://127.0.0.1')).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address();
      const q = new URLSearchParams({ sport: 'Football', home: 'Athletic Bilbao', away: 'Atletico Madrid' });
      const res = await fetch(`http://127.0.0.1:${port}/api/event-detail?${q}`, { headers: { Host: '127.0.0.1' } });
      const body = await res.text();
      assert.equal(res.status, 200, `route answered ${res.status}: ${body.slice(0, 300)}`);
      return JSON.parse(body);
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the payload publishes no field without a reader, and every excuse is named', async () => {
  const payload = await fetchPayload();
  const events = payload.events || [];
  assert.ok(events.length >= 2, `the fixture must reach two books, got ${events.length}`);

  const levels = { payload: new Set(Object.keys(payload)) };
  for (const [level, of] of [
    ['event', (e) => e],
    ['market', (e) => e.markets?.[0]],
    ['selection', (e) => e.markets?.[0]?.selections?.[0]],
    ['plan', (e) => e.markets?.[0]?.arb],
  ]) {
    levels[level] = new Set();
    for (const e of events) for (const o of [of(e)].filter(Boolean)) Object.keys(o).forEach((k) => levels[level].add(k));
  }

  // The plan level is the one that can pass vacuously. `arb` hangs off the first
  // market of each event, and a fixture that stopped producing arbitrages would
  // leave this level empty — a census over an empty object finds no orphans and
  // reports nothing wrong. So the level has to be proven populated before it is
  // allowed to pass as clean, which is what the arb's own reconciled ROI is for:
  // it is a field the panel renders, so its presence is the control.
  assert.ok(levels.plan.size >= 7, `the plan level has to be walked, got ${levels.plan.size} keys — if arbitrages stopped being produced the census below is vacuous`);
  assert.ok(levels.plan.has('marginPercent'), 'the plan the census walked is the reconciled one the panel renders');

  const unread = [];
  for (const [level, keys] of Object.entries(levels)) {
    for (const key of keys) {
      if (readersForLevel(level, key).length === 0 && !UNREAD_WITH_REASON.has(`${level}.${key}`)) unread.push(`${level}.${key}`);
    }
  }
  assert.deepEqual(unread, [], `published with no reader and no recorded reason: ${unread.join(', ')}`);

  // The excuse is a claim about what the modal *renders*, so it has to be
  // checked there. Checking only that `thresholdFromKey` still exists was the
  // weaker version and it was wrong: a mutation that dropped the whole line
  // from the heading while leaving the function defined sails straight past
  // it. What matters is the line reaching the page, so that is what is
  // asserted — the derivation AND the span that shows it.
  const [modalName, modal] = CONSUMERS[0];
  const modalCode = codeOnly(modal);
  assert.match(modalCode, /thresholdFromKey\(\s*m\.key\s*\)/,
    `${modalName} no longer derives the market threshold from the market key; re-examine the handicap entry`);
  assert.match(modalCode, /market-threshold/,
    `${modalName} no longer renders the threshold in the market heading, so the handicap field is no longer a duplicate of anything on screen`);

  // The same rule for the two plan excuses that are also claims about what the
  // modal renders. `family` is excused because the heading names the contract
  // in the book's own words, and `line` because the heading derives it from the
  // key. An excuse whose subject could be deleted and leave the test green is
  // not a reason, it is a rumour — so both subjects are asserted here, in the
  // consumer, not in the publisher.
  assert.match(modalCode, /escapeHtml\(\s*m\.name\s*\)/,
    `${modalName} no longer names the market in its heading, so plan.family is no longer an alias of something already on screen`);
  assert.match(modalCode, /market-threshold/,
    `${modalName} no longer shows the line in the heading, so plan.line has no on-screen equivalent`);
});

/**
 * The captures, grouped the way the route groups them, and the plans that fall
 * out — shared by the two tests below so neither re-derives it.
 *
 * The grouping is the route's: one entry per (eventKey, sourceId), spread with
 * `sourceId` attached and handed to `findDetailArbitrages` (src/router.mjs:610
 * and 655). `namesByMarketKey` is what the panel's heading reads, so a claim
 * about a heading is checked against the names the captures actually carry.
 */
function plansOnDisk() {
  const dir = new URL('../data-market-run/workspace/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('_events.json'));
  const byKey = new Map();
  const namesByMarketKey = new Map();
  for (const f of files) {
    const doc = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    for (const ev of doc.events || []) {
      if (!Array.isArray(ev.markets) || !ev.markets.length) continue;
      for (const m of ev.markets) {
        if (!namesByMarketKey.has(m.key)) namesByMarketKey.set(m.key, new Set());
        if (m.name) namesByMarketKey.get(m.key).add(m.name);
      }
      if (!byKey.has(ev.eventKey)) byKey.set(ev.eventKey, new Map());
      const books = byKey.get(ev.eventKey);
      if (!books.has(ev.sourceId)) books.set(ev.sourceId, ev);
    }
  }
  const multi = [...byKey.entries()].filter(([, books]) => books.size >= 2);
  const plans = [];
  for (const [eventKey, books] of multi) {
    const instances = [...books.entries()].map(([sourceId, ev]) => ({ ...ev, sourceId }));
    for (const [marketKey, plan] of findDetailArbitrages(instances)) plans.push({ eventKey, marketKey, plan });
  }
  return { files, multi, plans, namesByMarketKey };
}

/** Read once. The captures are 31 MB and two tests above need the same walk. */
let diskCache = null;
const disk = () => (diskCache ||= plansOnDisk());

/**
 * The plan walk four excuses above lean on, recomputed instead of quoted.
 *
 * `plan.family`, `plan.period`, `plan.line` and `plan.inverseSum` each carried a
 * figure transcribed from a run over data-market-run/workspace — how many
 * fixtures two books quote, how many of those produce a plan, and what that
 * plan's family, window and line turned out to be. Nothing checked any of it, so
 * those numbers could only go stale in one direction: quietly, and while still
 * reading as current.
 *
 * It is worse than stale for `family`. The walk found three plans and all three
 * were BTTS, which is what the excuse leaned on — but the BTTS legs came off
 * favbet rows this tree no longer emits, so the coverage said nothing about what
 * a fresh capture would hold. That is measured in test/favbet.test.mjs, and the
 * excuse no longer claims the coverage.
 *
 * The walk below is rebuilt from the captures and the real engine, and each
 * excuse is held to a property that either holds or fails: no plan sits on a
 * market the heading leaves unlabelled, none settles outside full-time, none
 * carries a line, and the ROI is the inverse sum in another unit. None of those
 * four is a number that can rot unnoticed.
 */
test('the plan walk the excuses above quote is measured, not transcribed', () => {
  const { files, multi, plans, namesByMarketKey } = disk();
  assert.ok(files.length >= 20, `only ${files.length} captures in data-market-run/workspace — every measurement below would rest on a handful`);
  assert.ok(multi.length > 0, 'no fixture on disk is quoted by two books — the walk measures nothing');
  // The guard that makes the three assertions after it mean anything. A capture
  // set that had stopped producing arbitrages would leave every one of them
  // empty and all three would pass — the shape a census is weakest in.
  assert.ok(plans.length > 0, `${multi.length} two-book fixtures on disk and not one plan — every measurement below is vacuous`);

  // plan.family. The excuse is that the heading names the contract already, so
  // the canonical alias beside it adds nothing. That only holds while every
  // market a plan attaches to is one the panel actually labels — and the modal
  // falls back to the canonical key, so a market with no name of its own heads
  // the section, it does not leave it blank.
  const unlabelled = plans.filter(({ marketKey }) => !(namesByMarketKey.get(marketKey)?.size));
  assert.deepEqual(unlabelled.map((p) => p.marketKey), [],
    `a plan sits on a market the captures never name, so the heading has nothing for the alias to repeat: ${JSON.stringify(unlabelled.map((p) => p.marketKey))}`);

  // plan.period — nothing on disk settles outside the full-time window.
  const offWindow = plans.filter(({ plan }) => plan.period !== 'fulltime');
  assert.deepEqual(offWindow.map(({ marketKey, plan }) => `${marketKey} = ${plan.period}`), [],
    `a plan now settles in a window other than full-time, so plan.period does separate something on disk: ${JSON.stringify(offWindow.map(({ marketKey, plan }) => plan.period))}`);

  // plan.line — and nothing on disk carries a line.
  const onLine = plans.filter(({ plan }) => plan.line !== null && plan.line !== undefined);
  assert.deepEqual(onLine.map(({ marketKey, plan }) => `${marketKey} = ${plan.line}`), [],
    `a plan now carries a line, so plan.line has a figure no heading shows: ${JSON.stringify(onLine.map(({ plan }) => plan.line))}`);

  // plan.inverseSum — the reason the raw sum is kept beside the ROI at all. Not
  // two figures from one run but one figure in two units, so the excuse that
  // the ROI cannot stand in for it holds without quoting either number. The
  // tolerance is the rounding, not slop: `roundedArbitrageAllocation` returns
  // `round2((1 / inverseSum - 1) * 100)` (src/scanner/market-contracts.mjs:203),
  // so the rescale agrees to half a hundredth. The first version of this
  // assertion asked for exact equality and failed on 98.33 against 98.3358 —
  // the source was right and the test was not.
  for (const { marketKey, plan } of plans) {
    assert.ok(Math.abs(plan.marginPercent - (1 - plan.inverseSum) * 100) < 0.005,
      `${marketKey}: marginPercent ${plan.marginPercent} is not inverseSum ${plan.inverseSum} rescaled — the two published figures are the same number in two units, and the panel shows only one`);
  }
});

/**
 * One URL on the event, one on each leg — and they are not the same field.
 *
 * src/router.mjs explains the missing `eventUrl` on the event with a pair of
 * figures it measured over the real route. The figures have rotted the way
 * transcribed ones do: it says 12 two-book fixtures and 26 events served, and
 * the two-book fixtures in the captures on disk hold 16938 events. The argument
 * does not need them, which is why this test exists rather than a corrected
 * number — both keys were written as `ev.sourceUrl || null`, so the measurement
 * could never have come out any other way. A tautology dressed as a sample size.
 *
 * What the comment never says is why the deletion stops at the event, and the
 * answer is not symmetry. A plan is attached to every book's copy of a market
 * (src/router.mjs:661-666), while its legs point at their own book — so the
 * plan sitting on betano's row carries a favbet leg, and that leg's URL is a
 * different page from the event's. On every plan the captures hold, the legs
 * open two different books. Collapsing `eventUrl` up to the event would have
 * made every leg in a plan open the same page, which is the one thing a leg
 * link must not do.
 */
test('the event carries one URL and every leg carries its own', async () => {
  const payload = await fetchPayload();
  const events = payload.events || [];
  assert.ok(events.length >= 2, `the fixture must reach two books, got ${events.length}`);

  const eventKeys = new Set(events.flatMap((e) => Object.keys(e)));
  assert.equal(eventKeys.has('eventUrl'), false,
    'eventUrl is back on the event: it was the same expression as sourceUrl, so one of the two is a second name for a value the first already carries');
  assert.ok(eventKeys.has('sourceUrl'), 'and the field it duplicated is the one that is published');
  const urls = events.map((e) => e.sourceUrl);
  assert.ok(urls.every((u) => typeof u === 'string' && u.length > 0),
    `every served event publishes the book's own URL, got ${JSON.stringify(urls)}`);

  const plans = events.flatMap((e) => (e.markets || []).map((m) => m.arb).filter(Boolean));
  assert.ok(plans.length >= 1, 'the priced fixture produces a plan — nothing below is checked');
  const legs = plans.flatMap((p) => p.legs);
  assert.ok(legs.every((l) => 'eventUrl' in l),
    'a leg without its own eventUrl has no link to its book, which is the only way back from a stake');
  // The control, and it is the whole point: two legs from two books must not open
  // the same page. A projection that copied the event's sourceUrl onto every leg
  // would pass the check above and quietly break navigation.
  const multiBook = plans.filter((p) => new Set(p.legs.map((l) => l.sourceId)).size >= 2);
  assert.ok(multiBook.length >= 1, `the fixture must produce a plan with legs from two books, got ${plans.length} plans`);
  for (const p of multiBook) {
    assert.ok(new Set(p.legs.map((l) => l.eventUrl)).size >= 2,
      `every leg of this plan opened ${JSON.stringify(p.legs.map((l) => l.eventUrl))} — the per-leg URL was collapsed onto one book`);
  }

  // And it has to be read, or carrying it is the same waste the event-level field
  // was. The modal turns it into the link icon beside each leg's stake.
  //
  // The search is for the CONDITIONAL, not for the name. A bare /l\.eventUrl/
  // passes on a line that mentions the field and no longer lets it decide
  // anything — which is exactly the mutation that got past the first version of
  // this assertion: gating the link on `l.stake` instead, leaving the field read
  // into an escapeHtml call that never runs when the stake is set.
  //
  // It now asks for the gate itself, by call. The link did not grow an `?` when
  // the feed URLs were filtered out — it moved into isEventUrl(l.eventUrl), so
  // a test still looking for the bare ternary would have reported a regression
  // that did not happen, and the day the gate was dropped it would have gone on
  // reporting one anyway.
  const modalCode = codeOnly(CONSUMERS[0][1]);
  assert.match(modalCode, /isEventUrl\(\s*l\.eventUrl\s*\)/,
    'event-detail-modal.js no longer lets a leg eventUrl decide whether the link renders, so the field is published with no reader');

  // The same claim on the real captures rather than on the fixture: every plan
  // the engine finds there has legs opening more than one book.
  const { plans: onDisk } = disk();
  assert.ok(onDisk.length >= 1, 'no plan on disk — the claim above rests on the fixture alone');
  const flat = onDisk.filter(({ plan }) => new Set(plan.legs.map((l) => l.eventUrl)).size >= 2);
  assert.deepEqual(flat.length, onDisk.length,
    `a plan on disk has legs opening one page: ${JSON.stringify(onDisk.filter(({ plan }) => new Set(plan.legs.map((l) => l.eventUrl)).size < 2).map(({ marketKey, plan }) => plan.legs.map((l) => `${l.sourceId}->${l.eventUrl}`)))}`);
});

test('the payload does not republish the arbitrage map it already attaches per market', async () => {
  const payload = await fetchPayload();
  assert.equal('arbs' in payload, false,
    'payload.arbs is a second copy of the per-market arb, and a lossy one: spreading the map values drops the market key that links a plan to its market');
  // And the channel that does work is still there. A test that only checked the
  // field is gone would pass on a route that had stopped finding arbitrages.
  const withArb = (payload.events || []).flatMap((e) => e.markets || []).filter((m) => m.arb);
  assert.ok(withArb.length >= 1, 'the priced fixture produces a real cross-book arbitrage, and m.arb carries it');
  assert.equal(typeof withArb[0].arb.marginPercent, 'number', 'and it carries the reconciled margin the panel renders');
  // The plan is a claim about money, so it may only sit on a market that has
  // one. The modal renders `m.arb` as both a "live arbitrage" badge and a full
  // stake/payout panel, so a plan attached to a market with no arbitrage would
  // be a payout table for a bet that does not exist. The fixture's second
  // market is the control that makes this observable: it is quoted by both
  // books, so it reaches the payload, and it is priced with no arbitrage.
  const markets = (payload.events || []).flatMap((e) => e.markets || []);
  const byKey = new Map();
  for (const m of markets) {
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push(m);
  }
  const noArbKey = 'OVER_UNDER_2_5';
  assert.ok((byKey.get(noArbKey) || []).length >= 2, `the control market has to reach the payload from both books, got ${(byKey.get(noArbKey) || []).length}`);
  const claimed = (byKey.get(noArbKey) || []).filter((m) => m.arb);
  assert.deepEqual(claimed, [], `a market with no arbitrage was given a money plan: ${JSON.stringify(claimed[0]?.arb || null)}`);
});

test('the projection publishes the five named selection fields and nothing else', async () => {
  const payload = await fetchPayload();
  const selections = (payload.events || []).flatMap((e) => (e.markets || []).flatMap((m) => m.selections || []));
  assert.ok(selections.length >= 4, `the fixture has to reach selections, got ${selections.length}`);

  // What the fixture put on the wire, measured from the fixture rather than
  // asserted from memory: the capture objects carry the provider bookkeeping
  // nsoft.mjs and altenar-public.mjs leave behind.
  const onDisk = new Set();
  for (const entry of selections) for (const k of Object.keys(entry)) onDisk.add(k);
  assert.ok([...onDisk].includes('id') && [...onDisk].includes('name') && [...onDisk].includes('odds'),
    `the payload's own selections carry the three read fields, got ${[...onDisk].join(', ')}`);

  // The leak itself. `providerOutcomeId` and `providerName` are on the
  // selection objects three adapters write, nothing on this route reads either,
  // and the projection used to forward them by reference. A capture exists that
  // would have carried them: 22 of 30 adapters are represented in
  // data-market-run/workspace and neither nsoft nor altenar-public is among
  // them, so the day one of them scrapes, they would have gone out on the wire
  // for every selection of every market on the page.
  //
  // Checked before the controls below, so a projection that forwarded by
  // reference fails here and names the leak rather than tripping over whatever
  // else that same projection happens to lose on the way.
  const leaked = selections.filter((s) => 'providerOutcomeId' in s || 'providerName' in s);
  assert.deepEqual(leaked, [],
    `provider bookkeeping reached the payload: ${JSON.stringify(leaked[0] || null)} — the projection is forwarding selections by reference again`);

  // The controls: the two fields that are unread but kept on purpose really are
  // kept, and kept with their presence. A narrowing that quietly dropped them
  // would pass the leak assertion above while quietly losing the fields the
  // census excuses by name.
  const withLine = selections.filter((s) => s.handicap === '2.5');
  assert.ok(withLine.length >= 2, `handicap is on the published list, so the line has to survive: ${withLine.length} selections carry 2.5`);
  // Presence, not truthiness — the router's own claim, checked against the
  // majority case in the capture. A copy that kept a real line and dropped the
  // empty one would keep `odds`, keep `name`, leak nothing, and pass every
  // other assertion here while re-shaping a third of the wire: `handicap: null`
  // says the market has no line, and dropping the key says nothing about it.
  const noLine = selections.filter((s) => 'handicap' in s);
  assert.ok(noLine.length >= withLine.length + 2,
    `a null line is a present line and has to stay one: ${noLine.length} selections carry the key, ${withLine.length} carry a value`);
  assert.ok(noLine.some((s) => s.handicap === null),
    'the fixture has to reach the route with handicap: null, or this control tests nothing — check seedWorkspace');
  assert.ok(selections.every((s) => 'group' in s), 'group is on the published list too');

  // And the named list is a list, not a widening: every field on the wire is
  // one the route declares. A stray key would be a second copy of something,
  // which is the whole class this lot is about.
  const declared = ['id', 'name', 'odds', 'group', 'handicap'];
  const published = [...new Set(selections.flatMap((s) => Object.keys(s)))].sort();
  assert.deepEqual(published, ['group', 'handicap', 'id', 'name', 'odds'],
    `the published selection fields drifted from DETAIL_SELECTION_FIELDS: ${published.join(', ')}`);
  assert.deepEqual(declared.slice().sort(), published, 'and the list the route declares is the list the wire carries');
});

test('the reader search is sensitive, so an unread field is not a naming accident', () => {
  assert.deepEqual(readersOf('sourceId').length > 0 ? 'found' : 'missed', 'found', 'a field the modal does read was missed');
  assert.deepEqual(readersOf('aFieldNoConsumerEverReads').length, 0, 'a name nothing reads was reported as read');
  // The negative control that matters: `group` is the one field that is named
  // in a consumer file and read by nobody. dashboard.js:560 writes "the whole
  // group:" in a comment, and a search that counted comments credited that
  // comment with a reader — which is how the first version of this census
  // passed while the real orphan walked straight through it. A word in a
  // comment is not a read, and this assertion is what says so.
  assert.deepEqual(readersOf('group'), [], 'a name that appears only inside a comment was counted as a reader');

  // The plan level's reader set, held to the same standard. A strict search that
  // finds nothing is indistinguishable from a strict search pointed at the wrong
  // receiver, and it is the one that would wave every future plan field through
  // — so the set has to be shown to hold the fields the panel demonstrably
  // renders, and to hold nothing beyond them.
  assert.ok(PLAN_READERS.has('marginPercent'), 'the plan reader set lost marginPercent, which renderArbPanel renders — the receiver is wrong or renamed');
  assert.ok(PLAN_READERS.has('totalStake'), 'the plan reader set lost totalStake, which the panel equation is built from');
  assert.ok(PLAN_READERS.has('legs'), 'the plan reader set lost legs, the one field every other figure hangs off');
  // And the case that motivated receiver-anchoring at all. `marketKey` is read
  // five times in dashboard.js — on opportunities, a different payload — so the
  // name search credits it a reader and the census waves it through. Put back
  // into the plan, it is a second copy of the market's own key, and it has to
  // be reported.
  assert.ok(readersOf('marketKey').length > 0, 'the name search is supposed to over-cover marketKey — if it stops doing so, this control is measuring nothing');
  assert.deepEqual(PLAN_READERS.get('marketKey'), undefined, 'marketKey is read on other payloads, not off the plan, and was credited with a reader it does not have');

  // The same pair, one level up, on a field the name search credits to the
  // opportunity payload. `roiPercent` is read five times over in dashboard.js —
  // every opportunity's headline — and not once off an event. Publish it on an
  // event tomorrow and the name search waves it through; this is the assertion
  // that says the two searches are not the same search.
  assert.ok(readersOf('roiPercent').length > 0, 'the name search is supposed to over-cover roiPercent, an opportunity field');
  assert.deepEqual(EVENT_READERS.get('roiPercent'), undefined, 'roiPercent is read on opportunities, not off an event');
  // And the event reader set has to be the real one, or the strictness is a
  // search pointed at nothing. The page's own reads are the proof.
  assert.ok(EVENT_READERS.has('homeTeam'), 'the event reader set lost homeTeam, which the page names the event with');
  assert.ok(EVENT_READERS.has('league'), 'the event reader set lost league, which the page shows in its meta line');
  assert.ok(EVENT_READERS.has('live'), 'the event reader set lost live, which the page badges from');

  // And the same pair, one level down, on the case that made this level look
  // unanchorable. `dataStatus` is read twice in dashboard.js — on `s`, which there
  // is a SOURCE — so the name search credits it to a selection that has no
  // dataStatus and never will. A strict search that came back empty here would be
  // equally wrong: it would be a strict search pointed at nothing.
  assert.ok(readersOf('dataStatus').length > 0,
    'the name search is supposed to over-cover dataStatus, a source field — if it stops doing so, this control measures nothing');
  assert.deepEqual(SELECTION_READERS.get('dataStatus'), undefined,
    'dataStatus is read off a source in dashboard.js, not off a selection, and was credited with a reader it does not have');
  // The binding set is one entry today and it is checkable by eye. An empty one
  // would be indistinguishable from a set built by a search that matches nothing,
  // so it is held to the fields the panel demonstrably prices and renders.
  assert.ok(SELECTION_BINDINGS.length >= 1, 'no binding was proven to hold a selection — the level is vacuously clean');
  assert.ok(SELECTION_READERS.has('odds'), 'the selection reader set lost odds, which the overround column is computed from');
  assert.ok(SELECTION_READERS.has('name'), 'the selection reader set lost name, which keys the matrix columns');
  assert.ok(SELECTION_READERS.has('id'), 'the selection reader set lost id, the fallback keying name is absent');
  assert.deepEqual([...SELECTION_READERS.keys()].sort(), ['id', 'name', 'odds'],
    `the selection reader set is not the panel's own: ${[...SELECTION_READERS.keys()].sort().join(', ')}`);
  assert.ok(EVENT_READERS.has('sourceId'), 'the event reader set lost sourceId, which the modal keys its books on');
});
