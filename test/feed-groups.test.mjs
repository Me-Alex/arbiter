import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_GROUPS, feedGroupOf, isSharedFeed, sharedFeedPeers } from '../src/scanner/feed-groups.mjs';
import { groupByEvent, findArbitrage, findPositiveEV } from '../src/scanner/engine.mjs';

function makeEvent(sourceId, eventKey, marketKey, selections) {
  return {
    id: `${sourceId}-${eventKey}`,
    sourceId,
    eventKey,
    sport: 'Football',
    league: 'Liga 1',
    kickoff: new Date('2030-01-01').toISOString(),
    homeTeam: 'Home',
    awayTeam: 'Away',
    markets: [{ key: marketKey, name: marketKey, period: 'fulltime', selections }],
  };
}

test('feed groups declare each brand in at most one group', () => {
  const seen = new Map();
  for (const group of FEED_GROUPS) {
    for (const member of group.members) {
      assert.equal(seen.has(member), false, `${member} appears in both ${seen.get(member)} and ${group.id}`);
      seen.set(member, group.id);
    }
  }
  assert.ok(seen.size > 0, 'there are groups to check');
});

test('isSharedFeed is true only within a declared group', () => {
  assert.equal(isSharedFeed('fortuna', 'casa-pariurilor'), true);
  assert.equal(isSharedFeed('admiral', 'stanleybet'), true);
  assert.equal(isSharedFeed('excelbet', 'magnumbet'), true);
  assert.equal(isSharedFeed('don', 'winbet'), true);
  // Different providers.
  assert.equal(isSharedFeed('superbet', 'fortuna'), false);
  assert.equal(isSharedFeed('betano', 'netbet'), false);
  // Same platform, different NSoft tenant. Measured live on 2026-09-26 over
  // the 36 fixtures the two tenants share: 8 byte-identical, 28 differing. The
  // two genuinely price independently, so a pairing between them can be a
  // real arbitrage and must stay allowed. The reason is the measurement, not
  // the differing companyUuid — a different tenant id does not by itself make
  // two brands one feed.
  assert.equal(isSharedFeed('admiral', 'maxbet'), false);
  // Degenerate inputs.
  assert.equal(isSharedFeed('fortuna', 'fortuna'), false);
  assert.equal(isSharedFeed('', 'fortuna'), false);
  assert.equal(isSharedFeed(null, undefined), false);
  assert.equal(isSharedFeed('unknown-book', 'fortuna'), false);
});

test('sharedFeedPeers lists the group minus the source itself', () => {
  assert.deepEqual(sharedFeedPeers('fortuna'), ['casa-pariurilor']);
  assert.deepEqual(sharedFeedPeers('casa-pariurilor'), ['fortuna']);
  assert.deepEqual(sharedFeedPeers('superbet'), []);
  assert.equal(feedGroupOf('fortuna'), 'fortuna-bff');
  assert.equal(feedGroupOf('superbet'), null);
});

test('findArbitrage does not report two brands of one feed as an arbitrage', () => {
  // fortuna and casa-pariurilor resell the same provider feed. A price gap
  // between two captured responses of that feed is a timing artifact, not an
  // edge, so it must not be published as arbitrage.
  const grouped = groupByEvent([
    makeEvent('fortuna', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.10 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.60 },
    ]),
    makeEvent('casa-pariurilor', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.05 }, { name: 'Draw', odds: 3.45 }, { name: 'Away', odds: 3.55 },
    ]),
  ]);
  assert.equal(findArbitrage(grouped).length, 0);
});

test('findArbitrage still reports a cross-feed arbitrage', () => {
  // superbet and fortuna are separate providers, so the same kind of price gap
  // is a real opportunity and must survive the feed-group filter.
  // 1/2.10 + 1/3.40 + 1/3.60 = 0.9803 < 1 → +2.0% ROI.
  const grouped = groupByEvent([
    makeEvent('superbet', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.10 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.60 },
    ]),
    makeEvent('fortuna', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.60 }, { name: 'Draw', odds: 3.50 }, { name: 'Away', odds: 3.50 },
    ]),
  ]);
  const out = findArbitrage(grouped);
  assert.equal(out.length, 1);
  const ids = out[0].legs.map((l) => l.sourceId);
  assert.ok(ids.includes('superbet') && ids.includes('fortuna'), `expected both feeds, got ${ids.join('+')}`);
  assert.ok(out[0].marginPercent > 0);
});

test('findArbitrage still allows a three-leg arb with one shared-feed pair dropped', () => {
  // If the only cheap legs come from one feed, there is no arb; the engine
  // must not substitute a second brand from that feed to manufacture one.
  const grouped = groupByEvent([
    makeEvent('fortuna', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.10 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.60 },
    ]),
    makeEvent('casa-pariurilor', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.11 }, { name: 'Draw', odds: 3.41 }, { name: 'Away', odds: 3.59 },
    ]),
    makeEvent('superbet', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.30 }, { name: 'Draw', odds: 3.60 }, { name: 'Away', odds: 4.00 },
    ]),
  ]);
  const out = findArbitrage(grouped);
  for (const arb of out) {
    const ids = arb.legs.map((l) => l.sourceId);
    assert.ok(!(ids.includes('fortuna') && ids.includes('casa-pariurilor')),
      `an arb was built from one feed: ${ids.join('+')}`);
  }
});

test('findPositiveEV draws its consensus only from independent feeds', () => {
  // A leg priced above its own feed-mates is not a +EV signal: the comparison
  // is against one provider's resold copies, not the market.
  const grouped = groupByEvent([
    makeEvent('fortuna', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 3.00 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.50 },
    ]),
    makeEvent('casa-pariurilor', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.00 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.50 },
    ]),
  ]);
  const evs = findPositiveEV(grouped, { minEvPercent: 2 });
  // fortuna's 3.00 looks +50% against casa-pariurilor's 2.00, but both are the
  // same feed, so the consensus is empty and nothing is reported.
  assert.equal(evs.length, 0);
});

test('findPositiveEV still works when an independent feed sets the consensus', () => {
  const grouped = groupByEvent([
    makeEvent('fortuna', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 3.00 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.50 },
    ]),
    makeEvent('superbet', 'k1', 'MATCH_ODDS', [
      { name: 'Home', odds: 2.00 }, { name: 'Draw', odds: 3.40 }, { name: 'Away', odds: 3.50 },
    ]),
  ]);
  const evs = findPositiveEV(grouped, { minEvPercent: 2 });
  assert.ok(evs.length >= 1, 'a genuinely mispriced leg against an independent feed is still found');
  assert.ok(evs.every((e) => e.sourceId === 'fortuna'));
});
