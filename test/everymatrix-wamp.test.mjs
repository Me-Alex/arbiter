import test from 'node:test';
import assert from 'node:assert/strict';
import EveryMatrixWampScraper from '../src/scrapers/everymatrix-wamp.mjs';
import GetsBetScraper from '../src/scrapers/getsbet.mjs';
import ContibetScraper from '../src/scrapers/contibet.mjs';
import { isFullTimeMarket } from '../src/scanner/market-contracts.mjs';

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
