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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRouter } from '../src/router.mjs';
import * as scanService from '../src/scan-service.mjs';
import { RateLimiter } from '../src/shared/rate-limit.mjs';
import { codeOnly, fieldReads } from './helpers/code-only.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CONSUMERS = [
  ['event-detail-modal.js', read('public/js/pages/event-detail-modal.js')],
  ['event-detail.js', read('public/js/pages/event-detail.js')],
  ['dashboard.js', read('public/js/pages/dashboard.js')],
];

/**
 * Fields published with no reader, and why that is not a defect. Adding a key
 * here is a claim about the code and has to survive review like any other.
 */
const UNREAD_WITH_REASON = new Map([
  ['handicap', 'the modal renders the line itself from the market key (thresholdFromKey) in the market heading, so the numeric copy on the selection says nothing the heading has not said. Kept on DETAIL_SELECTION_FIELDS, which now names every field this projection publishes: the reason is a decision with a reason attached, which is what it was not when the route forwarded selection objects by reference.'],
  ['group', 'measured on data-market-run/workspace, 22 blobs / 24829 events / 93600 selections: every selection carries group, every one of them says "Main", and not one market in 31927 holds two selections that share a name in different groups, so the field separates nothing in any capture on disk. The modal keys its columns on name-or-id alone, so no screen is missing a distinction. Kept for the same reason as handicap — it is on the named list — because group is what a book would use to disambiguate same-named outcomes the day one emits them.'],

  // The four below live one level deeper, inside the arbitrage plan attached as
  // `m.arb`. They reached this table the same way the census found them: the
  // walk stopped at the market, where `arb` is one more key on the row, so the
  // interior of the plan was under the floor of the only census covering this
  // route. Two of the plan's keys were copies of a fact already on the wire and
  // are gone (see the DetailArb docstring); these four are not copies, they are
  // simply unread — and each is kept for a reason that can be checked, not for
  // the convenience of the publisher.
  ['family', 'the canonical alias of the contract the market heading already names in the book\'s own words. The heading renders m.name on every market (event-detail-modal.js:217-219) and the plan only ever attaches to such a market, so the panel has nothing to add by showing the alias. Measured on data-market-run/workspace: 5166 fixtures carry two or more books, 3 of them produce a plan, and all 3 are family=BTTS — the capture contains no family the heading fails to name.'],
  ['period', 'the settlement window the legs agree on. Measured on the same capture: all 3 plans are period=fulltime, so the field separates nothing on disk. The scope that does vary is live vs pre-match, and that is published as `live` and already rendered as the panel\'s live badge. Kept because the docstring claims the view must be able to say a plan expires in 90 seconds, and that claim is about this field — dropping it would quietly retire a promise the panel has not yet kept.'],
  ['line', 'the canonical line. Measured on the same capture: null in all 3 plans, because all 3 are BTTS, a contract with no line. Where a line does exist the heading shows it, derived from the market key by thresholdFromKey — the same derivation the assertion below checks. The case this reason does NOT cover is an Asian-handicap plan: thresholdFromKey only matches /^OVER_UNDER_\\d+_\\d+$/, so an AH heading would show no line. That is a gap in the heading, and it is named here rather than used as a licence to publish the number twice.'],
  ['inverseSum', 'the raw reconciliation before it is rescaled into the ROI the panel does render. No screen shows it, and that is the honest part: the reader is a backend contract assertion, test/event-detail-arb.test.mjs:86, which recomputes Σ(1/odds) from the legs and holds the published figure to it. That reader is what makes this a contract on the allocation rather than a leftover from it, and roiPercent cannot stand in for it — on the real capture the pair is 0.5042016806722689 against 98.33, the same number in two units, only one of which is on screen.'],
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

/** The reader set for one level. The other levels use the name search. */
const readersForLevel = (level, key) => {
  const anchored = level === 'plan' ? PLAN_READERS : level === 'event' ? EVENT_READERS : null;
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
  assert.ok(levels.plan.has('roiPercent'), 'the plan the census walked is the reconciled one the panel renders');

  const unread = [];
  for (const [level, keys] of Object.entries(levels)) {
    for (const key of keys) {
      if (readersForLevel(level, key).length === 0 && !UNREAD_WITH_REASON.has(key)) unread.push(`${level}.${key}`);
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

test('the payload does not republish the arbitrage map it already attaches per market', async () => {
  const payload = await fetchPayload();
  assert.equal('arbs' in payload, false,
    'payload.arbs is a second copy of the per-market arb, and a lossy one: spreading the map values drops the market key that links a plan to its market');
  // And the channel that does work is still there. A test that only checked the
  // field is gone would pass on a route that had stopped finding arbitrages.
  const withArb = (payload.events || []).flatMap((e) => e.markets || []).filter((m) => m.arb);
  assert.ok(withArb.length >= 1, 'the priced fixture produces a real cross-book arbitrage, and m.arb carries it');
  assert.equal(typeof withArb[0].arb.roiPercent, 'number', 'and it carries the reconciled ROI the panel renders');
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
  assert.ok(PLAN_READERS.has('roiPercent'), 'the plan reader set lost roiPercent, which renderArbPanel renders — the receiver is wrong or renamed');
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
  assert.ok(EVENT_READERS.has('sourceId'), 'the event reader set lost sourceId, which the modal keys its books on');
});
