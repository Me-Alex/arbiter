import test from 'node:test';
import assert from 'node:assert/strict';
import EveryMatrixWampScraper, {
  EVERYMATRIX_SPORT_ID_MAP,
  EVERYMATRIX_SPORT_NAME_TO_ID,
} from '../src/scrapers/everymatrix-wamp.mjs';
import GetsBetScraper from '../src/scrapers/getsbet.mjs';
import ContibetScraper from '../src/scrapers/contibet.mjs';
import { isFullTimeMarket, resolveContract, canonicalOutcomeFor, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

/**
 * EveryMatrix WAMP is the most complex transport in src/scrapers/ — a reverse
 * engineered WAMP v2 session over a WebSocket — and it had no coverage at all.
 * These exercise the pure parts: topic construction, the 1X2 extractor, and the
 * guards that keep a malformed dealer payload from becoming a published event.
 * Nothing here opens a socket.
 *
 * Record shapes follow the dealer's tournament-aggregator and match-odds dumps:
 * a MARKET carries `bettingTypeId`, its BETTING_OFFERs reference an OUTCOME by
 * `outcomeId`, and the home/away/draw mapping comes from the outcome's
 * participant name rather than its id — which is why a wrong team name
 * silently drops the market.
 */

const FUTURE = Date.parse('2030-01-01T12:00:00Z');

function makeScraper(Cls = GetsBetScraper) {
  const s = new Cls({ dataDir: 'data' });
  s._lastObservedAt = '2026-09-26T00:00:00.000Z';
  s._lastSourceUrl = 'wss://api-online.getsbet.ro/v2';
  return s;
}

function makeMatch(overrides = {}) {
  return {
    id: 900001,
    startTime: FUTURE,
    homeParticipantName: 'FCSB',
    awayParticipantName: 'Dinamo',
    parentName: 'Liga 1',
    ...overrides,
  };
}

/** A complete regulation-time 1X2 dump for the given match. */
function oneXTwoRecords(s, { homeOdds = 2.10, drawOdds = 3.40, awayOdds = 3.50 } = {}) {
  const type = s.oneXTwoTypeId;
  return [
    { _type: 'MARKET', id: 500, bettingTypeId: type, displayName: 'Final - Timp regulamentar.' },
    { _type: 'OUTCOME', id: 11, typeName: 'Home', paramParticipantName1: 'FCSB' },
    { _type: 'OUTCOME', id: 12, typeName: 'Draw' },
    { _type: 'OUTCOME', id: 13, typeName: 'Away', paramParticipantName1: 'Dinamo' },
    { _type: 'BETTING_OFFER', id: 21, bettingTypeId: type, outcomeId: 11, odds: homeOdds, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 22, bettingTypeId: type, outcomeId: 12, odds: drawOdds, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 23, bettingTypeId: type, outcomeId: 13, odds: awayOdds, isAvailable: true },
  ];
}

test('topic URLs carry the dealer identity, so WAMP routing can match', () => {
  const s = makeScraper();
  assert.match(s.tournamentListTopic(), new RegExp(`/${s.operatorId}/`));
  assert.match(s.tournamentListTopic(), new RegExp(`/${s.sportId}/`));
  // A wrong realm or operator receives no records rather than an error, so the
  // topic has to be built from the subclass identity.
  assert.match(s.aggregatorTopic(1234), /tournament-aggregator-groups-overview\/1234/);
  assert.match(s.matchOddsTopic(900001), /900001/);
  assert.notEqual(s.tournamentListTopic(), s.aggregatorTopic(1234));
});

test('getsbet and contibet address different dealers', () => {
  const gets = makeScraper(GetsBetScraper);
  const conti = makeScraper(ContibetScraper);
  assert.notEqual(gets.wsUrl, conti.wsUrl);
  assert.notEqual(gets.realm, conti.realm);
  assert.notEqual(gets.operatorId, conti.operatorId);
});

test('the base class pins the sport and its catalogue', () => {
  const s = makeScraper();
  assert.equal(s.sport, 'Football');
  assert.equal(s.sportSlug, 'football');
  assert.equal(s.sportId, '1');
});

test('extractEvents emits a full-time 1X2 with three distinct outcomes', () => {
  const s = makeScraper();
  const [ev] = s.extractEvents([{ match: makeMatch(), records: oneXTwoRecords(s) }]);
  assert.ok(ev, 'a complete regulation-time market yields an event');
  assert.equal(ev.sourceId, 'getsbet');
  assert.equal(ev.sport, 'Football');
  assert.equal(ev.league, 'Liga 1');
  assert.equal(ev.homeTeam, 'FCSB');
  assert.equal(ev.awayTeam, 'Dinamo');
  assert.equal(ev.kickoff, new Date(FUTURE).toISOString());
  assert.equal(ev.markets[0].key, 'MATCH_ODDS');
  // The WAMP adapter does not emit `period`; the contract guard reads an
  // absent period as full-time, which is the documented default. This asserts
  // the adapter's actual contract rather than an aspiration.
  assert.equal(ev.markets[0].period, undefined);
  assert.equal(isFullTimeMarket(ev.markets[0]), true, 'an absent period is treated as full-time');
  const names = ev.markets[0].selections.map((x) => x.name).sort();
  assert.deepEqual(names, ['1', '2', 'X']);
  for (const sel of ev.markets[0].selections) {
    assert.ok(sel.odds > 1, `odds must be usable, got ${sel.odds}`);
    assert.ok(sel.id, 'each selection keeps its provider id');
  }
});

test('extractEvents drops a match that has already kicked off', () => {
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  assert.equal(s.extractEvents([{ match: makeMatch({ startTime: Date.parse('2020-01-01T00:00:00Z') }), records }]).length, 0);
  assert.equal(s.extractEvents([{ match: makeMatch({ startTime: 'not-a-timestamp' }), records }]).length, 0);
  assert.equal(s.extractEvents([{ match: makeMatch({ startTime: 0 }), records }]).length, 0);
});

test('extractEvents drops a match with no participants', () => {
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  assert.equal(s.extractEvents([{ match: makeMatch({ homeParticipantName: '' }), records }]).length, 0);
  assert.equal(s.extractEvents([{ match: makeMatch({ awayParticipantName: null }), records }]).length, 0);
});

test('extractEvents dedupes the same fixture arriving from two dumps', () => {
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  const out = s.extractEvents([
    { match: makeMatch(), records },
    { match: makeMatch({ id: 900002 }), records },
  ]);
  assert.equal(out.length, 1, 'same home/away/kickoff is one event');
});

test('extractEvents refuses an incomplete or malformed market', () => {
  const s = makeScraper();
  // No market at all.
  assert.equal(s.extractEvents([{ match: makeMatch(), records: [] }]).length, 0);
  // A market with fewer than three offers cannot settle a 1X2.
  const twoOffers = oneXTwoRecords(s).filter((r) => r._type !== 'BETTING_OFFER' || r.id !== 23);
  assert.equal(s.extractEvents([{ match: makeMatch(), records: twoOffers }]).length, 0);
  // An unusable price on one outcome leaves the 1X2 incomplete.
  assert.equal(s.extractEvents([{ match: makeMatch(), records: oneXTwoRecords(s, { drawOdds: 0 }) }]).length, 0);
  // An explicitly unavailable offer is not a price.
  const unavailable = oneXTwoRecords(s).map((r) => (r._type === 'BETTING_OFFER' && r.id === 22 ? { ...r, isAvailable: false } : r));
  assert.equal(s.extractEvents([{ match: makeMatch(), records: unavailable }]).length, 0);
  // A home/away outcome whose participant name does not match the match cannot
  // be assigned a side.
  const mismatched = oneXTwoRecords(s).map((r) => (r._type === 'OUTCOME' && r.id === 13 ? { ...r, paramParticipantName1: 'Alta Echipa' } : r));
  assert.equal(s.extractEvents([{ match: makeMatch(), records: mismatched }]).length, 0);
});

test('eventUrl points at the dealer front end and carries the match id', () => {
  const s = makeScraper();
  const url = s.eventUrl(900001);
  assert.match(url, /^https:\/\//);
  assert.ok(url.includes('900001'), `expected the match id in ${url}`);
});

test('normalize rejects a payload that is not the expected envelope', () => {
  const s = makeScraper();
  assert.throws(() => s.normalize(null), /missing events/);
  assert.throws(() => s.normalize({}), /missing events/);
  assert.throws(() => s.normalize({ events: 'nope' }), /missing events/);
});

test('the snapshot records provenance, so loadWorkspace keeps the events', () => {
  // Without sourceUrl and transport the snapshot is classified PARTIAL and
  // every event is discarded, so both EveryMatrix books were scraped, reported
  // valid, and then silently dropped by the scan.
  const s = makeScraper();
  const records = oneXTwoRecords(s);
  const events = s.extractEvents([{ match: makeMatch(), records }]);
  const snapshot = s._serializable(events, {
    sourceUrl: s.wsUrl,
    transport: s.transport,
    observedAt: '2026-09-26T00:00:00.000Z',
  });
  assert.equal(snapshot.sourceId, 'getsbet');
  assert.ok(snapshot.sourceUrl, 'a missing sourceUrl makes the whole snapshot unusable');
  assert.equal(snapshot.transport, 'everymatrix-odds-wamp');
  assert.equal(snapshot.runId, null, 'runId is set by the orchestrator, not the adapter');
  // And the envelope falls back to the socket when the payload omits it.
  const fallback = s._serializable(events, {});
  assert.ok(fallback.sourceUrl, 'provenance survives a payload without it');
  assert.ok(fallback.transport);
});

/**
 * A match dump is flat, and several markets in it can share a bettingTypeId —
 * a regulation-time result and a first-half result both present as "match
 * result" to that field. Matching offers on the type alone let the last market
 * parsed win, so the published price depended on the order the dealer happened
 * to serialise them.
 */

/** The same dump, with every record tagged to a market id. */
function scopedRecords(s, marketId, odds, displayName) {
  const type = s.oneXTwoTypeId;
  return [
    { _type: 'MARKET', id: marketId, bettingTypeId: type, displayName },
    { _type: 'OUTCOME', id: `${marketId}h`, typeName: 'Home', paramParticipantName1: 'FCSB', marketId },
    { _type: 'OUTCOME', id: `${marketId}d`, typeName: 'Draw', marketId },
    { _type: 'OUTCOME', id: `${marketId}a`, typeName: 'Away', paramParticipantName1: 'Dinamo', marketId },
    { _type: 'BETTING_OFFER', id: `${marketId}1`, bettingTypeId: type, outcomeId: `${marketId}h`, odds: odds[0], isAvailable: true },
    { _type: 'BETTING_OFFER', id: `${marketId}2`, bettingTypeId: type, outcomeId: `${marketId}d`, odds: odds[1], isAvailable: true },
    { _type: 'BETTING_OFFER', id: `${marketId}3`, bettingTypeId: type, outcomeId: `${marketId}a`, odds: odds[2], isAvailable: true },
  ];
}

test('the result market is chosen by name, not by position in the dump', () => {
  const s = makeScraper();
  const match = { id: 900001, startTime: FUTURE, homeParticipantName: 'FCSB', awayParticipantName: 'Dinamo', parentName: 'Liga 1' };
  const fullTime = scopedRecords(s, 500, [2.10, 3.40, 3.50], 'Final - Timp regulamentar');
  const firstHalf = scopedRecords(s, 900, [9.90, 9.90, 9.90], 'Repriza 1');

  for (const [label, records] of [
    ['full-time listed first', [...fullTime, ...firstHalf]],
    ['first-half listed first', [...firstHalf, ...fullTime]],
  ]) {
    const got = s.extractOneXTwo(match, records);
    assert.ok(got, `a result market is available when ${label}`);
    assert.deepEqual(
      got.offers,
      { 1: 2.10, X: 3.40, 2: 3.50 },
      `the full-time price is published when ${label}`,
    );
  }
});

test('a dump that names no market anywhere is still usable', () => {
  // The scoping cannot exclude offers it cannot attribute; a dump with no
  // market ids has nothing to confuse them with, so it must not be emptied.
  const s = makeScraper();
  const match = { id: 900001, startTime: FUTURE, homeParticipantName: 'FCSB', awayParticipantName: 'Dinamo', parentName: 'Liga 1' };
  const got = s.extractOneXTwo(match, oneXTwoRecords(s));
  assert.ok(got, 'an unattributable offer set is not thrown away');
  assert.equal(got.offers['1'], 2.10);
});

test('a second offer for the same side does not overwrite the first', () => {
  const s = makeScraper();
  const match = { id: 900001, startTime: FUTURE, homeParticipantName: 'FCSB', awayParticipantName: 'Dinamo', parentName: 'Liga 1' };
  const duplicate = {
    _type: 'BETTING_OFFER', id: 'dup', bettingTypeId: s.oneXTwoTypeId, outcomeId: 11, odds: 99, isAvailable: true,
  };
  const got = s.extractOneXTwo(match, [...oneXTwoRecords(s), duplicate]);
  assert.equal(got.offers['1'], 2.10, 'a contradictory duplicate is ignored, not taken');
});

test('cancelling a dump tears the socket down instead of waiting out the deadline', async () => {
  const s = makeScraper();
  const controller = new AbortController();
  let onclose = null;
  s._openSocket = async () => ({
    send() {},
    close() { if (onclose) setTimeout(onclose, 0); },
    set onclose(fn) { onclose = fn; },
    onmessage: null,
    onerror: null,
  });

  const started = Date.now();
  const dump = s.dumpTopic('/sports/x', { waitMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(dump, (err) => {
    assert.equal(err.code, 'EABORTED', 'a cancelled dump is reported as an abort, not a dealer fault');
    return true;
  });
  // The 30s deadline would have taken 30000ms; aborting must land far sooner.
  assert.ok(Date.now() - started < 5_000, `aborted promptly, took ${Date.now() - started}ms`);
});

test('a dump aborted before it starts never opens a socket', async () => {
  const s = makeScraper();
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  s._openSocket = async () => { opened = true; throw new Error('should not be reached'); };
  await assert.rejects(
    s.dumpTopic('/sports/x', { waitMs: 1000, signal: controller.signal }),
    (err) => err.code === 'EABORTED',
  );
  assert.equal(opened, false, 'no socket is opened for an already-cancelled run');
});

/**
 * The family extractors (everything except 1X2).
 *
 * A live getsbet capture on 2026-09-29 showed the feed publishing 77 markets
 * per match across 19 betting type ids, of which this adapter published 21 —
 * the 1X2 and nothing else. Two separate faults caused that, and both were
 * silent, so both are pinned here:
 *
 *   1. OUTCOME records carry NO `marketId`. The only outcome→market link is a
 *      MARKET_OUTCOME_RELATION row, so every extractor that compared
 *      `outcome.marketId` to a market id discarded every leg.
 *   2. `typeName` is the English CATEGORY and is identical for both legs of a
 *      market ("Total Score Over"/"Total Score Under", "Both Teams To Score"),
 *      while `shortTranslatedName` is the per-leg LABEL ("Peste 2.5", "Da").
 *      Reading the category gave both legs the same string, so no side regex
 *      could split them even once the join worked.
 *
 * `familyDump` builds records in the real shape: a relation row per leg, no
 * `marketId` on any outcome, and a `typeName` that is deliberately useless as
 * a side label.
 */
function leg(marketId, id, typeName, side, odds) {
  return [
    { _type: 'OUTCOME', id, typeName, shortTranslatedName: side },
    { _type: 'MARKET_OUTCOME_RELATION', id: `r${id}`, marketId, outcomeId: id },
    ...(odds === null ? [] : [{ _type: 'BETTING_OFFER', id: `o${id}`, outcomeId: id, odds, isAvailable: true }]),
  ];
}

function familyDump(extraMarkets) {
  return [...oneXTwoRecords(makeScraper()), ...extraMarkets];
}

function marketsOf(s, records) {
  const [ev] = s.extractEvents([{ match: makeMatch(), records }]);
  assert.ok(ev, 'a complete 1X2 keeps the event, so the extras are reachable');
  return ev.markets;
}

function byKey(markets, key) {
  return markets.filter((m) => m.key === key);
}

test('legs are attributed through MARKET_OUTCOME_RELATION, not outcome.marketId', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 700, bettingTypeId: '76', name: 'Ambele echipe marchează - Timp regulamentar.' },
    // Both legs share one category, exactly as the dealer sends them.
    ...leg(700, 710, 'Both Teams To Score', 'Da', 1.83),
    ...leg(700, 711, 'Both Teams To Score', 'Nu', 1.98),
  ]);
  for (const r of records) {
    // The relation row is the one place marketId belongs; the OUTCOME must not
    // carry it, or the join would never be exercised.
    if (r._type === 'OUTCOME') assert.equal(r.marketId, undefined, 'the fixture must not hand the join a shortcut');
  }
  const btts = byKey(marketsOf(s, records), 'BOTH_TEAMS_SCORE');
  assert.equal(btts.length, 1, 'the relation table is enough to attribute both legs');
  assert.deepEqual(btts[0].selections.map((x) => x.name), ['Yes', 'No']);
  assert.deepEqual(btts[0].selections.map((x) => x.odds), [1.83, 1.98]);
});

test('a goals total resolves as a canonical OVER_UNDER with the line in the name', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 720, bettingTypeId: '47', name: 'Total Peste/Sub 2.5 Timp regulamentar.', paramFloat1: 2.5 },
    ...leg(720, 721, 'Total Score Over', 'Peste 2.5', 1.80),
    ...leg(720, 722, 'Total Score Under', 'Sub 2.5', 1.88),
  ]);
  const [total] = byKey(marketsOf(s, records), 'TOTAL_GOALS');
  assert.ok(total, 'a half-line total is published');
  assert.deepEqual(total.selections.map((x) => x.name), ['Peste 2.5', 'Sub 2.5']);

  // Resolving is not enough: the leg has to route to over/under as well, or
  // the contract prices nothing. Capitalised "Peste" used to fail this.
  const contract = resolveContract({ ...total, sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Dinamo' });
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '2.5');
  assert.notEqual(contract.arbEligible, false, 'a two-way goals total is arbitrable');
  assert.deepEqual(
    total.selections.map((x) => canonicalOutcomeFor(x.name, contract, {})),
    ['over', 'under'],
  );
});

test('a first-half total is separated by period, not by a key suffix', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 730, bettingTypeId: '47', name: 'Total Peste/Sub 0.5 Repriza 1', paramFloat1: 0.5 },
    ...leg(730, 731, 'Total Score Over', 'Peste 0.5', 1.36),
    ...leg(730, 732, 'Total Score Under', 'Sub 0.5', 2.80),
  ]);
  const markets = marketsOf(s, records);
  const [firstHalf] = byKey(markets, 'TOTAL_GOALS');
  assert.ok(firstHalf, 'the first-half total is published, not dropped');
  assert.equal(firstHalf.key, 'TOTAL_GOALS', 'no _1H suffix, which resolves to nothing');
  assert.equal(firstHalf.period, 'half1', 'the window travels in period');
  const contract = resolveContract({ ...firstHalf, sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Dinamo' });
  assert.equal(contract.period, 'half1', 'and the resolver buckets on it');
});

test('totals at a whole or quarter line are withheld, because they are not exhaustive', () => {
  const s = makeScraper();
  // "Total Peste/Sub 2" pushes at exactly 2; "2.25" half-pushes one leg.
  // classifyAndExtractLine does NOT test this on the O/U path — it only
  // requires equal magnitudes — so TOTAL_GOALS at these lines would otherwise
  // resolve and price as arbitrable.
  for (const line of [2, 2.25, 3, 1.75]) {
    const records = familyDump([
      { _type: 'MARKET', id: 740, bettingTypeId: '47', name: `Total Peste/Sub ${line} Timp regulamentar.`, paramFloat1: line },
      ...leg(740, 741, 'Total Score Over', `Peste ${line}`, 1.40),
      ...leg(740, 742, 'Total Score Under', `Sub ${line}`, 2.60),
    ]);
    assert.equal(
      byKey(marketsOf(s, records), 'TOTAL_GOALS').length, 0,
      `a total at ${line} must not be published as an arbitrable two-way`,
    );
  }
});

test('a team total is not a match total', () => {
  const s = makeScraper();
  // Type 77 carries the identical "Total Peste/Sub" wording for ONE team's
  // goals. Publishing it would let another book's match total stand in for it.
  const records = familyDump([
    { _type: 'MARKET', id: 750, bettingTypeId: '77', name: 'Poli Timisoara Total Peste/Sub 2.5 - Timp regulamentar.', paramFloat1: 2.5 },
    ...leg(750, 751, 'Team Score Over/Under', 'Gazde Peste 2.5', 3.10),
    ...leg(750, 752, 'Team Score Over/Under', 'Gazde Sub 2.5', 1.30),
  ]);
  assert.equal(byKey(marketsOf(s, records), 'TOTAL_GOALS').length, 0);
});

test('an Asian handicap routes home/away and is keyed on the line, not on leg order', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 760, bettingTypeId: '48', name: 'Handicap asiatic -1.5 - Timp regulamentar.', paramFloat1: 1.5 },
    // Listed away-first on purpose: the two legs must not decide the contract.
    ...leg(760, 761, 'Handicap Winner With Money Back On Draw', 'Oaspeţi (+1.5)', 1.40),
    ...leg(760, 762, 'Handicap Winner With Money Back On Draw', 'Gazde (-1.5)', 2.63),
  ]);
  const [hcap] = byKey(marketsOf(s, records), 'ASIAN_HANDICAP');
  assert.ok(hcap, 'a half-line handicap is published');
  assert.deepEqual(hcap.selections.map((x) => x.name), ['1 (-1.5)', '2 (1.5)']);

  const contract = resolveContract({ ...hcap, sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Dinamo' });
  assert.equal(contract.family, 'ASIAN_HANDICAP');
  assert.equal(contract.lineKey, '-1.5/1.5', 'the line key is home-first whatever the leg order');
  assert.deepEqual(
    hcap.selections.map((x) => canonicalOutcomeFor(x.name, contract, {})),
    ['home', 'away'],
    'the numbered shape routes; nsoft’s "H1 -1.5" resolves but prices nothing',
  );
});

test('a whole or quarter handicap is withheld', () => {
  const s = makeScraper();
  for (const line of [1, 1.25, 2.25]) {
    const records = familyDump([
      { _type: 'MARKET', id: 770, bettingTypeId: '48', name: `Handicap asiatic -${line} - Timp regulamentar.`, paramFloat1: line },
      ...leg(770, 771, 'Handicap Winner With Money Back On Draw', `Gazde (-${line})`, 2.10),
      ...leg(770, 772, 'Handicap Winner With Money Back On Draw', `Oaspeţi (+${line})`, 1.80),
    ]);
    assert.equal(
      byKey(marketsOf(s, records), 'ASIAN_HANDICAP').length, 0,
      `a handicap at ${line} pushes or half-settles, so it is not a surebet`,
    );
  }
});

test('a handicap whose legs are not negations is withheld', () => {
  const s = makeScraper();
  // Two same-signed legs do not cover the outcome space, whatever the name says.
  const records = familyDump([
    { _type: 'MARKET', id: 780, bettingTypeId: '48', name: 'Handicap asiatic -1.5 - Timp regulamentar.', paramFloat1: 1.5 },
    ...leg(780, 781, 'Handicap Winner With Money Back On Draw', 'Gazde (-1.5)', 2.10),
    ...leg(780, 782, 'Handicap Winner With Money Back On Draw', 'Oaspeţi (-1.5)', 1.80),
  ]);
  assert.equal(byKey(marketsOf(s, records), 'ASIAN_HANDICAP').length, 0);
});

test('a leg with no price is not a market', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 790, bettingTypeId: '47', name: 'Total Peste/Sub 2.5 Timp regulamentar.', paramFloat1: 2.5 },
    ...leg(790, 791, 'Total Score Over', 'Peste 2.5', 1.80),
    ...leg(790, 792, 'Total Score Under', 'Sub 2.5', null),
  ]);
  assert.equal(byKey(marketsOf(s, records), 'TOTAL_GOALS').length, 0);
});

test('draw no bet is catalogued under a bare key, and stays non-arbitrable', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 800, bettingTypeId: '112', name: 'Egal - Pariul se rambursează - Timp regulamentar.' },
    ...leg(800, 801, 'Winner with money back on draw', 'Gazde', 1.72),
    ...leg(800, 802, 'Winner with money back on draw', 'Oaspeţi', 2.05),
  ]);
  const markets = marketsOf(s, records);
  const [dnb] = byKey(markets, 'DRAW_NO_BET');
  assert.ok(dnb, 'a draw-refunded product is still catalogued');

  // DNB_1H / DRAW_NO_BET_1H match no whitelist and fall through to the generic
  // 2-way resolver, which returns an ARBITRABLE MATCH_ODDS for "1"/"2" — a
  // fake surebet for a product that cannot arbitrage. The key must stay bare.
  const contract = resolveContract({ ...dnb, sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Dinamo' });
  assert.equal(contract.family, 'DRAW_NO_BET');
  assert.equal(contract.arbEligible, false, 'the draw is refunded, so this is not a surebet');
  assert.notEqual(
    resolveContract({ key: 'DNB_1H', selections: dnb.selections, period: 'half1' })?.arbEligible,
    false,
    'documents the landmine the bare key avoids: a _1H suffix resolves ARBITRABLE',
  );
});

test('double chance is catalogued with its three legs and is not arbitrable', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 810, bettingTypeId: '9', name: 'Șansă Dublă - Timp regulamentar.' },
    ...leg(810, 811, 'Double Chance', 'Gazde sau Egal', 1.10),
    ...leg(810, 812, 'Double Chance', 'Oaspeţi sau Egal', 2.05),
    ...leg(810, 813, 'Double Chance', 'Gazde sau Oaspeţi', 1.22),
  ]);
  const [dc] = byKey(marketsOf(s, records), 'DOUBLE_CHANCE');
  assert.ok(dc, 'double chance is published for coverage');
  assert.deepEqual(dc.selections.map((x) => x.name), ['1X', 'X2', '12']);
  const contract = resolveContract({ ...dc, sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Dinamo' });
  assert.equal(contract.family, 'DOUBLE_CHANCE');
  assert.equal(contract.arbEligible, false, '1X and X2 both settle on a draw, so they overlap');
});

test('a BTTS COMBINATION is not published as plain BTTS', () => {
  const s = makeScraper();
  // Type 419 and 743 label their legs "Da și Sub 2.5" / "… : Nu" — the words
  // are there, the contract is not. Only type 76 is plain both-teams-to-score.
  for (const id of ['419', '743']) {
    const records = familyDump([
      { _type: 'MARKET', id: 820, bettingTypeId: id, name: 'Ambele echipe marchează și Total goluri - Timp regulamentar.' },
      ...leg(820, 821, 'Both Teams To Score And Totals', 'Da și Sub 2.5', 1.50),
      ...leg(820, 822, 'Both Teams To Score And Totals', 'Nu și Peste 2.5', 2.35),
    ]);
    assert.equal(byKey(marketsOf(s, records), 'BOTH_TEAMS_SCORE').length, 0, `type ${id} is a combination`);
  }
});

test('a contradictory duplicate offer does not overwrite the first price', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 830, bettingTypeId: '47', name: 'Total Peste/Sub 2.5 Timp regulamentar.', paramFloat1: 2.5 },
    ...leg(830, 831, 'Total Score Over', 'Peste 2.5', 1.80),
    ...leg(830, 832, 'Total Score Under', 'Sub 2.5', 1.88),
    { _type: 'BETTING_OFFER', id: 'dup', outcomeId: 831, odds: 99, isAvailable: true },
  ]);
  const [total] = byKey(marketsOf(s, records), 'TOTAL_GOALS');
  assert.equal(total.selections[0].odds, 1.80, 'the first price stands');
});

test('an unavailable offer is not a price', () => {
  const s = makeScraper();
  const records = familyDump([
    { _type: 'MARKET', id: 840, bettingTypeId: '76', name: 'Ambele echipe marchează - Timp regulamentar.' },
    ...leg(840, 841, 'Both Teams To Score', 'Da', 1.83),
    { _type: 'OUTCOME', id: 842, typeName: 'Both Teams To Score', shortTranslatedName: 'Nu' },
    { _type: 'MARKET_OUTCOME_RELATION', id: 'r842', marketId: 840, outcomeId: 842 },
    { _type: 'BETTING_OFFER', id: 'o842', outcomeId: 842, odds: 1.98, isAvailable: false },
  ]);
  assert.equal(byKey(marketsOf(s, records), 'BOTH_TEAMS_SCORE').length, 0);
});

test('EveryMatrix sport maps export sports taxonomy and resolve IDs', () => {
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['1'], 'Football');
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['2'], 'Basketball');
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['3'], 'Tennis');
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['4'], 'Ice Hockey');
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['5'], 'Handball');
  assert.equal(EVERYMATRIX_SPORT_ID_MAP['6'], 'Volleyball');

  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID.football, '1');
  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID.basketball, '2');
  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID.tennis, '3');
  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID['ice hockey'], '4');
  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID.handball, '5');
  assert.equal(EVERYMATRIX_SPORT_NAME_TO_ID.volleyball, '6');
});

test('EveryMatrix constructor sets sport, sportSlug, and sportId correctly', () => {
  const bball = new GetsBetScraper({ sport: 'Basketball' });
  assert.equal(bball.sport, 'Basketball');
  assert.equal(bball.sportSlug, 'basketball');
  assert.equal(bball.sportId, '2');

  const tennis = new GetsBetScraper({ sport: 'Tennis' });
  assert.equal(tennis.sport, 'Tennis');
  assert.equal(tennis.sportSlug, 'tennis');
  assert.equal(tennis.sportId, '3');

  const byId = new GetsBetScraper({ sportId: '2' });
  assert.equal(byId.sport, 'Basketball');
  assert.equal(byId.sportSlug, 'basketball');
  assert.equal(byId.sportId, '2');
});

function twoWayWinnerRecords(s, {
  home = 'Jannik Sinner',
  away = 'Carlos Alcaraz',
  homeOdds = 1.75,
  awayOdds = 2.10,
  bettingTypeId = s.twoWayMatchWinnerTypeId,
} = {}) {
  return [
    { _type: 'MARKET', id: 600, bettingTypeId, displayName: 'Câștigător meci' },
    { _type: 'OUTCOME', id: 31, typeName: 'Home', paramParticipantName1: home },
    { _type: 'OUTCOME', id: 32, typeName: 'Away', paramParticipantName1: away },
    { _type: 'BETTING_OFFER', id: 41, bettingTypeId, outcomeId: 31, odds: homeOdds, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 42, bettingTypeId, outcomeId: 32, odds: awayOdds, isAvailable: true },
  ];
}

test('extractTwoWayMatchWinner extracts 2-way moneyline for Tennis', () => {
  const s = new GetsBetScraper({ sport: 'Tennis' });
  const match = makeMatch({
    id: 900002,
    homeParticipantName: 'Jannik Sinner',
    awayParticipantName: 'Carlos Alcaraz',
    parentName: 'Wimbledon',
  });
  const records = twoWayWinnerRecords(s);
  const result = s.extractTwoWayMatchWinner(match, records);

  assert.ok(result, '2-way match winner extracted');
  assert.deepEqual(result.selections, ['1', '2']);
  assert.equal(result.offers['1'], 1.75);
  assert.equal(result.offers['2'], 2.10);

  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev, 'event emitted for tennis 2-way winner');
  assert.equal(ev.sport, 'Tennis');
  assert.equal(ev.markets[0].key, 'MATCH_ODDS');
  assert.equal(ev.markets[0].selections.length, 2);
  assert.deepEqual(ev.markets[0].selections.map((x) => x.name), ['1', '2']);

  const contract = resolveContract(ev.markets[0], { sport: 'Tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz' });
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.deepEqual(contract.outcomes, ['home', 'away']);
  assert.notEqual(contract.arbEligible, false);
});

test('extractTwoWayMatchWinner rejects markets with a draw outcome', () => {
  const s = new GetsBetScraper({ sport: 'Tennis' });
  const match = makeMatch({
    id: 900002,
    homeParticipantName: 'Jannik Sinner',
    awayParticipantName: 'Carlos Alcaraz',
  });
  const records = [
    { _type: 'MARKET', id: 600, bettingTypeId: '249', displayName: 'Winner' },
    { _type: 'OUTCOME', id: 31, typeName: 'Home', paramParticipantName1: 'Jannik Sinner' },
    { _type: 'OUTCOME', id: 32, typeName: 'Away', paramParticipantName1: 'Carlos Alcaraz' },
    { _type: 'OUTCOME', id: 33, typeName: 'Draw' },
    { _type: 'BETTING_OFFER', id: 41, bettingTypeId: '249', outcomeId: 31, odds: 1.80, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 42, bettingTypeId: '249', outcomeId: 32, odds: 2.10, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 43, bettingTypeId: '249', outcomeId: 33, odds: 3.50, isAvailable: true },
  ];
  assert.equal(s.extractTwoWayMatchWinner(match, records), null);
});

test('extractTotals emits POINTS_OVER_UNDER with points subject for Basketball', () => {
  const s = new GetsBetScraper({ sport: 'Basketball' });
  const match = makeMatch({
    id: 900003,
    homeParticipantName: 'Los Angeles Lakers',
    awayParticipantName: 'Boston Celtics',
    parentName: 'NBA',
  });
  const records = [
    ...twoWayWinnerRecords(s, { home: 'Los Angeles Lakers', away: 'Boston Celtics' }),
    { _type: 'MARKET', id: 700, bettingTypeId: '47', name: 'Total puncte 215.5', paramFloat1: 215.5 },
    ...leg(700, 701, 'Total Score Over', 'Peste 215.5', 1.85),
    ...leg(700, 702, 'Total Score Under', 'Sub 215.5', 1.95),
  ];
  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);
  const totals = byKey(ev.markets, 'POINTS_OVER_UNDER');
  assert.equal(totals.length, 1);
  assert.equal(totals[0].subject, 'points');
  assert.equal(totals[0].selections[0].handicap, 215.5);

  const contract = resolveContract(totals[0], { sport: 'Basketball' });
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'points');
  assert.equal(contract.lineKey, '215.5');
  assert.notEqual(contract.arbEligible, false);
});

test('extractTotals emits TOTAL_GAMES with games subject for Tennis', () => {
  const s = new GetsBetScraper({ sport: 'Tennis' });
  const match = makeMatch({
    id: 900004,
    homeParticipantName: 'Jannik Sinner',
    awayParticipantName: 'Carlos Alcaraz',
    parentName: 'Wimbledon',
  });
  const records = [
    ...twoWayWinnerRecords(s),
    { _type: 'MARKET', id: 710, bettingTypeId: '47', name: 'Total game-uri 22.5', paramFloat1: 22.5 },
    ...leg(710, 711, 'Total Score Over', 'Peste 22.5', 1.80),
    ...leg(710, 712, 'Total Score Under', 'Sub 22.5', 2.00),
  ];
  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);
  const totals = byKey(ev.markets, 'TOTAL_GAMES');
  assert.equal(totals.length, 1);
  assert.equal(totals[0].subject, 'games');
  assert.equal(totals[0].selections[0].handicap, 22.5);

  const contract = resolveContract(totals[0], { sport: 'Tennis' });
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'games');
  assert.equal(contract.lineKey, '22.5');
  assert.notEqual(contract.arbEligible, false);
});

test('extractEvents admits in-play matches and marks markets live when includeLive is true', () => {
  const s = new GetsBetScraper();
  s.includeLive = true;
  const match = makeMatch({
    id: 900005,
    startTime: Date.now() - 30 * 60 * 1000,
    isLive: true,
  });
  const records = oneXTwoRecords(s);
  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev, 'live event admitted when includeLive is true');
  assert.equal(ev.live, true);
  assert.equal(ev.markets[0].live, true, 'market must be marked live');
});

test('EveryMatrixWampScraper.periodFor recognizes sets and quarters', () => {
  assert.equal(EveryMatrixWampScraper.periodFor('Câștigător Set 1'), 'set1');
  assert.equal(EveryMatrixWampScraper.periodFor('Setul 2 Câștigător'), 'set2');
  assert.equal(EveryMatrixWampScraper.periodFor('Primul set Câștigător'), 'set1');
  assert.equal(EveryMatrixWampScraper.periodFor('Al doilea set'), 'set2');
  assert.equal(EveryMatrixWampScraper.periodFor('Sfertul 1 Câștigător'), 'q1');
  assert.equal(EveryMatrixWampScraper.periodFor('1st Quarter Winner'), 'q1');
  assert.equal(EveryMatrixWampScraper.periodFor('Al doilea sfert'), 'q2');
  assert.equal(EveryMatrixWampScraper.periodFor('Hartă 1 Câștigător'), 'set1');
  assert.equal(EveryMatrixWampScraper.periodFor('Harta 2 Total Runde'), 'set2');
  assert.equal(EveryMatrixWampScraper.periodFor('Total Goluri 1h'), 'half1');
  assert.equal(EveryMatrixWampScraper.periodFor('Rezultat 2h'), 'half2');
  assert.equal(EveryMatrixWampScraper.periodFor('Match Winner'), 'fulltime');
});

test('extractPeriodWinners extracts Set 1 Winner for Tennis and isolates in bucketKey', () => {
  const s = new GetsBetScraper({ sport: 'Tennis' });
  const match = makeMatch({
    id: 900006,
    homeParticipantName: 'Jannik Sinner',
    awayParticipantName: 'Carlos Alcaraz',
    parentName: 'Roland Garros',
  });
  const records = [
    ...twoWayWinnerRecords(s),
    { _type: 'MARKET', id: 800, bettingTypeId: '300', displayName: 'Câștigător Set 1' },
    { _type: 'OUTCOME', id: 81, typeName: 'Home', paramParticipantName1: 'Jannik Sinner' },
    { _type: 'OUTCOME', id: 82, typeName: 'Away', paramParticipantName1: 'Carlos Alcaraz' },
    { _type: 'BETTING_OFFER', id: 801, bettingTypeId: '300', outcomeId: 81, odds: 1.65, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 802, bettingTypeId: '300', outcomeId: 82, odds: 2.25, isAvailable: true },
  ];
  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);
  const set1Market = ev.markets.find((m) => m.period === 'set1');
  assert.ok(set1Market, 'Set 1 market extracted');
  assert.equal(set1Market.key, 'MATCH_ODDS');
  assert.deepEqual(set1Market.selections.map((x) => x.name), ['1', '2']);

  const contract = resolveContract(set1Market, { sport: 'Tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz' });
  assert.ok(contract);
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.equal(contract.period, 'set1');
  assert.deepEqual(contract.outcomes, ['home', 'away']);

  const ftMarket = ev.markets[0];
  const ftContract = resolveContract(ftMarket, { sport: 'Tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz' });
  assert.equal(ftContract.period, 'fulltime');
});

test('extractPeriodWinners extracts 3-way sub-window markets (Football 1st/2nd Half 1X2) with bucket key isolation', () => {
  const s = new GetsBetScraper({ sport: 'Football' });
  const match = makeMatch({
    id: 900007,
    homeParticipantName: 'Real Madrid',
    awayParticipantName: 'Barcelona',
    parentName: 'La Liga',
  });
  const records = [
    ...oneXTwoRecords(s, { homeOdds: 2.15, drawOdds: 3.50, awayOdds: 3.20 }),
    // Repriza 1 - 1X2 (3-way)
    { _type: 'MARKET', id: 810, bettingTypeId: '69', displayName: 'Repriza 1 - 1X2' },
    { _type: 'OUTCOME', id: 91, typeName: 'Home', paramParticipantName1: 'Real Madrid' },
    { _type: 'OUTCOME', id: 92, typeName: 'Draw' },
    { _type: 'OUTCOME', id: 93, typeName: 'Away', paramParticipantName1: 'Barcelona' },
    { _type: 'BETTING_OFFER', id: 901, bettingTypeId: '69', outcomeId: 91, odds: 2.70, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 902, bettingTypeId: '69', outcomeId: 92, odds: 2.20, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 903, bettingTypeId: '69', outcomeId: 93, odds: 3.60, isAvailable: true },
    // Repriza 2 - 1X2 (3-way)
    { _type: 'MARKET', id: 820, bettingTypeId: '69', displayName: 'Repriza 2 - 1X2' },
    { _type: 'OUTCOME', id: 94, typeName: 'Home', paramParticipantName1: 'Real Madrid' },
    { _type: 'OUTCOME', id: 95, typeName: 'Draw' },
    { _type: 'OUTCOME', id: 96, typeName: 'Away', paramParticipantName1: 'Barcelona' },
    { _type: 'BETTING_OFFER', id: 904, bettingTypeId: '69', outcomeId: 94, odds: 2.50, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 905, bettingTypeId: '69', outcomeId: 95, odds: 2.40, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 906, bettingTypeId: '69', outcomeId: 96, odds: 3.40, isAvailable: true },
  ];

  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);

  const ftMarket = ev.markets[0];
  const half1Market = ev.markets.find((m) => m.period === 'half1');
  const half2Market = ev.markets.find((m) => m.period === 'half2');

  assert.ok(half1Market, 'First half 3-way market extracted');
  assert.ok(half2Market, 'Second half 3-way market extracted');

  assert.deepEqual(half1Market.selections.map((x) => x.name), ['1', 'X', '2']);
  assert.deepEqual(half2Market.selections.map((x) => x.name), ['1', 'X', '2']);

  const ftContract = resolveContract(ftMarket, { sport: 'Football', homeTeam: 'Real Madrid', awayTeam: 'Barcelona' });
  const half1Contract = resolveContract(half1Market, { sport: 'Football', homeTeam: 'Real Madrid', awayTeam: 'Barcelona' });
  const half2Contract = resolveContract(half2Market, { sport: 'Football', homeTeam: 'Real Madrid', awayTeam: 'Barcelona' });

  assert.equal(ftContract.period, 'fulltime');
  assert.equal(half1Contract.period, 'half1');
  assert.equal(half2Contract.period, 'half2');

  assert.deepEqual(ftContract.outcomes, ['home', 'draw', 'away']);
  assert.deepEqual(half1Contract.outcomes, ['home', 'draw', 'away']);
  assert.deepEqual(half2Contract.outcomes, ['home', 'draw', 'away']);

  const ftBucket = bucketKeyForContract('evClasico', ftContract);
  const half1Bucket = bucketKeyForContract('evClasico', half1Contract);
  const half2Bucket = bucketKeyForContract('evClasico', half2Contract);

  assert.equal(ftBucket, 'evClasico::MATCH_ODDS::fulltime::_::home+draw+away::_::_');
  assert.equal(half1Bucket, 'evClasico::MATCH_ODDS::half1::_::home+draw+away::_::_');
  assert.equal(half2Bucket, 'evClasico::MATCH_ODDS::half2::_::home+draw+away::_::_');

  assert.notEqual(ftBucket, half1Bucket);
  assert.notEqual(ftBucket, half2Bucket);
  assert.notEqual(half1Bucket, half2Bucket);
});

test('extractPeriodWinners extracts multi-set tennis derivatives and basketball quarters with deduplication', () => {
  const s = new GetsBetScraper({ sport: 'Tennis' });
  const match = makeMatch({
    id: 900008,
    homeParticipantName: 'Novak Djokovic',
    awayParticipantName: 'Daniil Medvedev',
    parentName: 'US Open',
  });
  const records = [
    ...twoWayWinnerRecords(s, { home: 'Novak Djokovic', away: 'Daniil Medvedev' }),
    // Set 1
    { _type: 'MARKET', id: 830, bettingTypeId: '300', displayName: 'Setul 1 Câștigător' },
    { _type: 'OUTCOME', id: 101, typeName: 'Home', paramParticipantName1: 'Novak Djokovic' },
    { _type: 'OUTCOME', id: 102, typeName: 'Away', paramParticipantName1: 'Daniil Medvedev' },
    { _type: 'BETTING_OFFER', id: 1001, bettingTypeId: '300', outcomeId: 101, odds: 1.60, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1002, bettingTypeId: '300', outcomeId: 102, odds: 2.30, isAvailable: true },
    // Duplicate Set 1 market should be deduplicated
    { _type: 'MARKET', id: 831, bettingTypeId: '300', displayName: 'Primul set Câștigător' },
    { _type: 'OUTCOME', id: 103, typeName: 'Home', paramParticipantName1: 'Novak Djokovic' },
    { _type: 'OUTCOME', id: 104, typeName: 'Away', paramParticipantName1: 'Daniil Medvedev' },
    { _type: 'BETTING_OFFER', id: 1003, bettingTypeId: '300', outcomeId: 103, odds: 1.58, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1004, bettingTypeId: '300', outcomeId: 104, odds: 2.35, isAvailable: true },
    // Set 2
    { _type: 'MARKET', id: 840, bettingTypeId: '300', displayName: 'Setul 2 Câștigător' },
    { _type: 'OUTCOME', id: 105, typeName: 'Home', paramParticipantName1: 'Novak Djokovic' },
    { _type: 'OUTCOME', id: 106, typeName: 'Away', paramParticipantName1: 'Daniil Medvedev' },
    { _type: 'BETTING_OFFER', id: 1005, bettingTypeId: '300', outcomeId: 105, odds: 1.65, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1006, bettingTypeId: '300', outcomeId: 106, odds: 2.25, isAvailable: true },
  ];

  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);

  const set1Markets = ev.markets.filter((m) => m.period === 'set1');
  assert.equal(set1Markets.length, 1, 'Duplicate set1 market was deduplicated');

  const set2Markets = ev.markets.filter((m) => m.period === 'set2');
  assert.equal(set2Markets.length, 1, 'Set 2 market was extracted');

  const set1Contract = resolveContract(set1Markets[0], { sport: 'Tennis', homeTeam: 'Novak Djokovic', awayTeam: 'Daniil Medvedev' });
  const set2Contract = resolveContract(set2Markets[0], { sport: 'Tennis', homeTeam: 'Novak Djokovic', awayTeam: 'Daniil Medvedev' });

  assert.equal(set1Contract.period, 'set1');
  assert.equal(set2Contract.period, 'set2');

  const set1Bucket = bucketKeyForContract('evUSOpen', set1Contract);
  const set2Bucket = bucketKeyForContract('evUSOpen', set2Contract);

  assert.equal(set1Bucket, 'evUSOpen::MATCH_ODDS::set1::_::home+away::_::_');
  assert.equal(set2Bucket, 'evUSOpen::MATCH_ODDS::set2::_::home+away::_::_');
  assert.notEqual(set1Bucket, set2Bucket);
});

test('periodFor resolves period from eventPartName and shortEventPartName', () => {
  assert.equal(EveryMatrixWampScraper.periodFor({ eventPartName: 'Repriza 1' }), 'half1');
  assert.equal(EveryMatrixWampScraper.periodFor({ shortEventPartName: 'Repriza 2' }), 'half2');
  assert.equal(EveryMatrixWampScraper.periodFor({ eventPartName: 'Sfertul 1' }), 'q1');
  assert.equal(EveryMatrixWampScraper.periodFor({ shortEventPartName: 'Setul 1' }), 'set1');
  assert.equal(EveryMatrixWampScraper.periodFor({ name: 'Total Peste/Sub 2.5', eventPartName: 'Repriza 1' }), 'half1');
  assert.equal(EveryMatrixWampScraper.periodFor({ name: 'Total Peste/Sub 2.5' }), 'fulltime');
});

test('extractTotals deduplicates repeated period totals for the same line and isolates buckets', () => {
  const s = makeScraper();
  const match = makeMatch();
  const records = [
    ...oneXTwoRecords(s),
    // Full time total 2.5
    { _type: 'MARKET', id: 601, bettingTypeId: '47', paramFloat1: 2.5, name: 'Total goluri' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 601, outcomeId: 101 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 601, outcomeId: 102 },
    { _type: 'OUTCOME', id: 101, shortTranslatedName: 'Peste 2.5' },
    { _type: 'OUTCOME', id: 102, shortTranslatedName: 'Sub 2.5' },
    { _type: 'BETTING_OFFER', id: 1001, bettingTypeId: '47', outcomeId: 101, odds: 1.95, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1002, bettingTypeId: '47', outcomeId: 102, odds: 1.85, isAvailable: true },
    // First half total 1.5 via eventPartName
    { _type: 'MARKET', id: 602, bettingTypeId: '47', paramFloat1: 1.5, name: 'Total goluri', eventPartName: 'Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 602, outcomeId: 103 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 602, outcomeId: 104 },
    { _type: 'OUTCOME', id: 103, shortTranslatedName: 'Peste 1.5' },
    { _type: 'OUTCOME', id: 104, shortTranslatedName: 'Sub 1.5' },
    { _type: 'BETTING_OFFER', id: 1003, bettingTypeId: '47', outcomeId: 103, odds: 2.10, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1004, bettingTypeId: '47', outcomeId: 104, odds: 1.70, isAvailable: true },
    // Duplicate first half total 1.5 (e.g. from promo or secondary widget block)
    { _type: 'MARKET', id: 603, bettingTypeId: '47', paramFloat1: 1.5, name: 'Total Peste/Sub Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 603, outcomeId: 105 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 603, outcomeId: 106 },
    { _type: 'OUTCOME', id: 105, shortTranslatedName: 'Peste 1.5' },
    { _type: 'OUTCOME', id: 106, shortTranslatedName: 'Sub 1.5' },
    { _type: 'BETTING_OFFER', id: 1005, bettingTypeId: '47', outcomeId: 105, odds: 2.05, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 1006, bettingTypeId: '47', outcomeId: 106, odds: 1.75, isAvailable: true },
  ];

  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);

  const halfTotals = ev.markets.filter((m) => m.period === 'half1');
  assert.equal(halfTotals.length, 1, 'Duplicate half1 total was cleanly deduplicated');

  const ftTotals = ev.markets.filter((m) => m.period === 'fulltime');
  assert.equal(ftTotals.length, 1, 'Full-time total was extracted');

  const ftContract = resolveContract(ftTotals[0], { sport: 'Football' });
  const halfContract = resolveContract(halfTotals[0], { sport: 'Football' });

  assert.equal(ftContract.period, 'fulltime');
  assert.equal(halfContract.period, 'half1');

  const ftBucket = bucketKeyForContract('evMatch', ftContract);
  const halfBucket = bucketKeyForContract('evMatch', halfContract);

  assert.match(ftBucket, /::fulltime::2\.5::/);
  assert.match(halfBucket, /::half1::1\.5::/);
  assert.notEqual(ftBucket, halfBucket);
});

test('extractAsianHandicap and extractBothTeamsToScore deduplicate sub-window duplicates', () => {
  const s = makeScraper();
  const match = makeMatch();
  const records = [
    ...oneXTwoRecords(s),
    // First half Asian Handicap -0.5
    { _type: 'MARKET', id: 701, bettingTypeId: '48', name: 'Handicap Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 701, outcomeId: 201 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 701, outcomeId: 202 },
    { _type: 'OUTCOME', id: 201, shortTranslatedName: 'Gazde (-0.5)' },
    { _type: 'OUTCOME', id: 202, shortTranslatedName: 'Oaspeţi (+0.5)' },
    { _type: 'BETTING_OFFER', id: 2001, bettingTypeId: '48', outcomeId: 201, odds: 2.00, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 2002, bettingTypeId: '48', outcomeId: 202, odds: 1.80, isAvailable: true },
    // Duplicate First half Asian Handicap -0.5
    { _type: 'MARKET', id: 702, bettingTypeId: '48', name: 'Handicap Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 702, outcomeId: 203 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 702, outcomeId: 204 },
    { _type: 'OUTCOME', id: 203, shortTranslatedName: 'Gazde (-0.5)' },
    { _type: 'OUTCOME', id: 204, shortTranslatedName: 'Oaspeţi (+0.5)' },
    { _type: 'BETTING_OFFER', id: 2003, bettingTypeId: '48', outcomeId: 203, odds: 1.95, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 2004, bettingTypeId: '48', outcomeId: 204, odds: 1.85, isAvailable: true },
    // First half BTTS
    { _type: 'MARKET', id: 703, bettingTypeId: '76', name: 'Ambele marcheaza Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 703, outcomeId: 205 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 703, outcomeId: 206 },
    { _type: 'OUTCOME', id: 205, shortTranslatedName: 'Da' },
    { _type: 'OUTCOME', id: 206, shortTranslatedName: 'Nu' },
    { _type: 'BETTING_OFFER', id: 2005, bettingTypeId: '76', outcomeId: 205, odds: 4.50, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 2006, bettingTypeId: '76', outcomeId: 206, odds: 1.18, isAvailable: true },
    // Duplicate First half BTTS
    { _type: 'MARKET', id: 704, bettingTypeId: '76', name: 'Ambele marcheaza Repriza 1' },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 704, outcomeId: 207 },
    { _type: 'MARKET_OUTCOME_RELATION', marketId: 704, outcomeId: 208 },
    { _type: 'OUTCOME', id: 207, shortTranslatedName: 'Da' },
    { _type: 'OUTCOME', id: 208, shortTranslatedName: 'Nu' },
    { _type: 'BETTING_OFFER', id: 2007, bettingTypeId: '76', outcomeId: 207, odds: 4.40, isAvailable: true },
    { _type: 'BETTING_OFFER', id: 2008, bettingTypeId: '76', outcomeId: 208, odds: 1.20, isAvailable: true },
  ];

  const [ev] = s.extractEvents([{ match, records }]);
  assert.ok(ev);

  const ahMarkets = ev.markets.filter((m) => m.key === 'ASIAN_HANDICAP');
  assert.equal(ahMarkets.length, 1, 'Duplicate Asian Handicap was deduplicated');
  assert.equal(ahMarkets[0].period, 'half1');

  const bttsMarkets = ev.markets.filter((m) => m.key === 'BOTH_TEAMS_SCORE');
  assert.equal(bttsMarkets.length, 1, 'Duplicate BTTS was deduplicated');
  assert.equal(bttsMarkets[0].period, 'half1');
});
