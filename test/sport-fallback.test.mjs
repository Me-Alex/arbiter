/**
 * sport-fallback.test.mjs — the label a producer publishes when its feed did
 * not say which sport an event is.
 *
 * MEASURED, before any of this was written: fifteen sites across the adapter
 * tree answered a missing sport with the literal 'Football'. Reachability of
 * each one, by running the code rather than reading it:
 *
 *   - Production paths do not fire them. `altenar-public` and `egt` gate on
 *     FOOTBALL_SPORT_ID before the default; `favbet` requests only
 *     `sport_id: 1`; `everymatrix-wamp` drops every row whose sportId is not
 *     the configured '1' (and both enabled jobs declare
 *     `supportedSports: ["football"]`); `netbet.normalize` always stamps
 *     `_sportName` (unknown slugs pass through as their own name), and
 *     `feg-common.fetchRaw` stamps `_sportName = fegSportName(sportId)`
 *     before any fixture exists — `fegSportName` is total (it renders an
 *     unmapped id as `Unknown (<id>)`), so the fetchRaw default was dead
 *     code and is now removed rather than left to lie.
 *   - The remaining sites fire only on direct calls: the legacy
 *     Admiral/Stanleybet/MaxBet classes (no enabled job routes to them —
 *     provider-contract.test.mjs pins that), the TinyFish cluster (the
 *     server refuses TinyFish configuration — reachability.test.mjs pins
 *     that), and `extractEvents`/`parse` called with hand-built rows in
 *     tests and smoke scripts.
 *
 * WHY 'Unknown' AND NOT '' — a label that says nothing still pairs, because
 * `eventIdentityKey` takes `canonicalSport(sport || '')` and both books
 * contribute '' the same way. 'Unknown' canonicalises to 'unknown', which
 * cannot collide with a feed that did report 'football', while staying in
 * the convention netbet's own normalize(), winner, betano and superbet
 * already use for an unnamed sport. Measured: identity keys are
 * `football|<kickoff>|<home>|<away>` for a reported football event and
 * `unknown|<kickoff>|<home>|<away>` for an unreported one — no cross-book
 * pairing between the two.
 *
 * The construction-gated literals are deliberately NOT retested here: each
 * already has its gate or its output pinned where it lives (altenar
 * otherSport/tennis cases, egt-digital, favbet, everymatrix-wamp,
 * provider-contract). Two controlări pe aceeași proprietate = una.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import AdmiralScraper from '../src/scrapers/admiral.mjs';
import StanleybetScraper from '../src/scrapers/stanleybet.mjs';
import MaxBetScraper from '../src/scrapers/maxbet.mjs';
import NetBetScraper from '../src/scrapers/netbet.mjs';
import Fortuna from '../src/scrapers/fortuna.mjs';
import ExcelBet from '../src/scrapers/excelbet.mjs';
import TinyfishScraper from '../src/scrapers/tinyfish-scraper.mjs';
import { TINYFISH_BOOKS } from '../src/tinyfish/books.mjs';
import { normalizeExtraction } from '../src/tinyfish/extract.mjs';
import { classifyLinks, readEventElements } from '../src/tinyfish/browser-discovery.mjs';
import { agentMatchFrom } from '../src/tinyfish/discovery.mjs';

const MSG = {
  admiral: 'admiral parse labels a sportless row Unknown, not Football',
  stanleybet: 'stanleybet parse labels a sportless row Unknown, not Football',
  maxbet: 'maxbet parse labels a sportless row Unknown, not Football',
  netbet: 'netbet extractEvents labels a row without _sportName Unknown, not Football',
  feg: 'feg normalize labels a fixture with no tree label Unknown, not Football',
  tinyfishNormalize: 'tinyfish normalize labels a sportless discovery event Unknown, not Football',
  tinyfishSport: 'tinyfish extractEvents labels a sportless raw event Unknown, not Football',
  tinyfishKey: 'tinyfish extractEvents keys a sportless raw event under unknown, not football',
  extraction: 'normalizeExtraction labels a sportless extraction Unknown, not Football',
  classify: 'classifyLinks labels a discovered match Unknown, not Football',
  elements: 'readEventElements labels discovered elements Unknown, not Football',
  agentMissing: 'agentMatchFrom labels a row without sport Unknown, not Football',
  agentNamed: 'agentMatchFrom keeps a sport the agent did report',
  agentNoUrl: 'agentMatchFrom refuses a row with no url',
  excelbetEmit: 'excelbet emits exactly the sport its feed and coverage declare',
  excelbetCoverage: 'excelbet emitted sport agrees with the coverage record',
};

test(MSG.admiral, () => {
  const s = new AdmiralScraper({});
  const out = s.extractEvents(s.parse([{
    home: 'FCSB', away: 'Dinamo', kickoff: '2030-01-01T12:00:00Z',
    odd_1: 2.1, odd_x: 3.4, odd_2: 3.2,
  }]));
  assert.equal(out.length, 1, 'the priced fixture survives the adapter');
  assert.equal(out[0].sport, 'Unknown', MSG.admiral);
});

test(MSG.stanleybet, () => {
  const s = new StanleybetScraper({});
  const out = s.extractEvents(s.parse([{
    home: 'FCSB', away: 'Dinamo', date: '2030-01-01T12:00:00Z',
    homeOdds: 2.1, drawOdds: 3.4, awayOdds: 3.2,
  }]));
  assert.equal(out.length, 1, 'the priced fixture survives the adapter');
  assert.equal(out[0].sport, 'Unknown', MSG.stanleybet);
});

test(MSG.maxbet, () => {
  const s = new MaxBetScraper({});
  const out = s.extractEvents(s.parse({
    events: [{
      EventId: 1, HomeName: 'FCSB', AwayName: 'Dinamo',
      MatchTime: '2030-01-01T12:00:00Z', LeagueName: 'Liga 1',
      HomeOdds: 2.1, DrawOdds: 3.4, AwayOdds: 3.2,
      // no SportName — the field the feed would carry
    }],
  }));
  assert.equal(out.length, 1, 'the priced fixture survives the adapter');
  assert.equal(out[0].sport, 'Unknown', MSG.maxbet);
});

test(MSG.netbet, () => {
  const s = new NetBetScraper({ maxEvents: 10 });
  s.observedAt = '2026-09-29T12:33:00.000Z';
  // The shape netbet.test.mjs builds from the live capture, minus
  // `_sportName`: only normalize() stamps that, so a row reaching
  // extractEvents without it is exactly the case the default answers.
  const bare = {
    id: 900002,
    is_live: false,
    is_suspended: false,
    starts_at: '2030-01-01T12:00:00Z',
    competition_name: 'Liga 1',
    competitors: [
      { name: 'Atletico Tucuman', is_home: true },
      { name: 'Barracas Central', is_home: false },
    ],
    markets: [{
      id: 'm-default',
      market_code: 'default',
      market_type: 5498,
      name: 'Rezultat Final',
      outcomes: [
        { id: 'o1', odds: 1.91, kind: 'W1', name: '1', fullname: 'Atletico Tucuman', order: 0, suspended: false, visible: true, status: 'active', market_type: 5498, handicap: null, handicap_abs: null },
        { id: 'o2', odds: 2.97, kind: 'X', name: 'X', fullname: 'X', order: 1, suspended: false, visible: true, status: 'active', market_type: 5498, handicap: null, handicap_abs: null },
        { id: 'o3', odds: 4.5, kind: 'W2', name: '2', fullname: 'Barracas Central', order: 2, suspended: false, visible: true, status: 'active', market_type: 5498, handicap: null, handicap_abs: null },
      ],
    }],
  };
  const [ev] = s.extractEvents([bare]);
  assert.ok(ev, 'the priced fixture survives the adapter');
  assert.equal(ev.sport, 'Unknown', MSG.netbet);
});

test(MSG.feg, () => {
  const s = new Fortuna({});
  // No `_sportName` (only fetchRaw's catalogue traversal stamps it) and no
  // `sportId` of its own: normalize() must not pick the tree's sport from
  // thin air.
  const fx = {
    id: 'fx-bare',
    sportSeoName: 'efotbal',
    _tournamentName: 'Liga 1',
    _tournamentSeoName: 'liga-1',
    startDatetime: Date.parse('2030-01-01T12:00:00.000Z'),
    participants: [
      { type: 'HOME', name: 'Dinamo' },
      { type: 'AWAY', name: 'Rapid' },
    ],
  };
  const market = [{
    id: 'm1', marketTypeId: 'ufo:mtyp:03-0c', name: 'Total goluri', period: 'FT',
    outcomes: [
      { id: 'm1-o', name: 'Over', odds: 1.91 },
      { id: 'm1-u', name: 'Under', odds: 1.91 },
    ],
  }];
  const events = s.extractEvents(s.normalize({
    fixtures: [fx],
    marketsByFixture: new Map([['fx-bare', market]]),
  }));
  assert.equal(events.length, 1, 'the priced fixture survives the adapter');
  assert.equal(events[0].sport, 'Unknown', MSG.feg);
});

test(MSG.tinyfishNormalize, () => {
  const s = new TinyfishScraper({ bookConfig: TINYFISH_BOOKS.superbet });
  const [raw] = s.normalize({
    events: [{
      sourceUrl: 'https://superbet.ro/cote/fotbal/a-vs-b-1',
      homeTeam: 'A', awayTeam: 'B', league: 'Liga 1',
      kickoff: '2030-01-01T00:00:00.000Z',
      // no sport — discovery found the match, not its sport
      markets: [{
        key: 'MATCH_ODDS', name: 'Final',
        selections: [{ name: 'A', odds: 2 }, { name: 'B', odds: 3.5 }],
      }],
    }],
    discovery: { count: 1, runId: 'r1' },
    extraction: { ok: 1, failed: 0, runs: [] },
  });
  assert.equal(raw.sport, 'Unknown', MSG.tinyfishNormalize);
});

const tinyfishBareRaw = () => [{
  id: 'u',
  homeTeam: 'A', awayTeam: 'B', league: 'Liga 1',
  kickoff: '2030-01-01T00:00:00.000Z',
  marketGroups: [{
    key: 'MATCH_ODDS', name: 'Final',
    selections: [{ name: 'A', odds: 2 }, { name: 'B', odds: 3 }],
  }],
}];

test(MSG.tinyfishSport, () => {
  const s = new TinyfishScraper({ bookConfig: TINYFISH_BOOKS.superbet });
  const [ev] = s.extractEvents(tinyfishBareRaw());
  assert.ok(ev, 'the priced fixture survives the adapter');
  assert.equal(ev.sport, 'Unknown', MSG.tinyfishSport);
});

test(MSG.tinyfishKey, () => {
  const s = new TinyfishScraper({ bookConfig: TINYFISH_BOOKS.superbet });
  const [ev] = s.extractEvents(tinyfishBareRaw());
  assert.ok(ev, 'the priced fixture survives the adapter');
  assert.ok(ev.eventKey.startsWith('unknown|'),
    `${MSG.tinyfishKey} (got ${ev.eventKey})`);
});

test(MSG.extraction, () => {
  const ev = normalizeExtraction({
    homeTeam: 'A', awayTeam: 'B',
    markets: [{
      key: 'MATCH_ODDS', name: 'Final',
      selections: [{ name: 'A', odds: 2 }, { name: 'B', odds: 3 }],
    }],
  }, 'https://x.test/a-vs-b', {});
  assert.ok(ev, 'a complete extraction survives normalization');
  assert.equal(ev.sport, 'Unknown', MSG.extraction);
});

test(MSG.classify, () => {
  const result = classifyLinks([
    { href: 'https://superbet.ro/cote/fotbal/a-vs-b-1', text: 'A B' },
  ], {
    baseUrl: 'https://superbet.ro',
    eventUrlPattern: '\\/cote\\/fotbal\\/',
  });
  assert.equal(result.matches.length, 1, 'the event link is classified as a match');
  assert.equal(result.matches[0].sport, 'Unknown', MSG.classify);
});

test(MSG.elements, async () => {
  // A frame stand-in that answers the in-page query with one event element:
  // the element-scoped path (not link classification) is what fires here.
  const page = {
    frames: () => [{
      evaluate: async () => [{
        id: 'event-42', text: 'A v B', homeTeam: 'A', awayTeam: 'B', league: null,
      }],
    }],
  };
  const matches = await readEventElements(page, {
    baseUrl: 'https://x.test',
    eventElementSelector: '.event',
    eventUrlTemplate: 'https://x.test/event/{id}',
  });
  assert.equal(matches.length, 1, 'the element becomes a match');
  assert.equal(matches[0].sport, 'Unknown', MSG.elements);
});

test(MSG.agentMissing, () => {
  const row = agentMatchFrom(
    { url: 'https://x.test/a-vs-b', homeTeam: 'A', awayTeam: 'B' },
    { currency: 'RON', locale: 'ro-RO' },
  );
  assert.ok(row, 'a complete agent row survives coercion');
  assert.equal(row.sport, 'Unknown', MSG.agentMissing);
});

test(MSG.agentNamed, () => {
  const row = agentMatchFrom(
    { url: 'https://x.test/a-vs-b', homeTeam: 'A', awayTeam: 'B', sport: 'Tennis' },
    { currency: 'RON', locale: 'ro-RO' },
  );
  assert.ok(row, 'a complete agent row survives coercion');
  assert.equal(row.sport, 'Tennis', MSG.agentNamed);
});

test(MSG.agentNoUrl, () => {
  assert.equal(
    agentMatchFrom({ homeTeam: 'A', awayTeam: 'B' }, { currency: 'RON', locale: 'ro-RO' }),
    null,
    MSG.agentNoUrl,
  );
});

const MARKETS_FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/excelbet-markets.json', import.meta.url), 'utf8'),
);

test(MSG.excelbetEmit, () => {
  // The feed carries no sport field at all: 'football' here is the adapter's
  // assertion about the whole feed, measured over five days on four tenants
  // (see the AGGREGATE_IDS census in excelbet.mjs). Pin it, because nothing
  // else can — and the coverage record must not drift from what events say.
  const s = new ExcelBet({ maxEvents: 100 });
  const events = s.extractEvents(s.normalize(MARKETS_FIXTURE));
  assert.ok(events.length > 0, 'the fixture yields events');
  assert.ok(events.every((e) => e.sport === 'football'),
    `${MSG.excelbetEmit} (got ${[...new Set(events.map((e) => e.sport))].join(', ')})`);
});

test(MSG.excelbetCoverage, () => {
  const s = new ExcelBet({ maxEvents: 100 });
  const [event] = s.extractEvents(s.normalize(MARKETS_FIXTURE));
  assert.ok(event, 'the fixture yields events');
  const coverage = s._serializable([], { avs: { avs: [] } }).coverage;
  assert.equal(event.sport, coverage.sport, MSG.excelbetCoverage);
});
