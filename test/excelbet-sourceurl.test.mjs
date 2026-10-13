import test from 'node:test';
import assert from 'node:assert/strict';

import ExcelBet from '../src/scrapers/excelbet.mjs';
import WinBoss from '../src/scrapers/winboss.mjs';
import LasVegas from '../src/scrapers/las-vegas.mjs';
import MagnumBet from '../src/scrapers/magnumbet.mjs';

/**
 * The provenance regression.
 *
 * `this.sourceUrl` is a pattern with a literal `YYYYMMDD` in it, because the
 * palinsesto endpoint is per day. Publishing it verbatim put a dead link on
 * every event of excelbet and its three subclasses -- 190 published legs whose
 * "where did this price come from" answer a user could not follow. The prices
 * themselves were always fetched correctly, because `fetchBoard` substitutes a
 * real date per day; only the link that claims to point at the source was
 * broken, which is the worst kind of defect to leave in a provenance field.
 *
 * The date substituted must be the EVENT's own kickoff date, not the crawl's
 * date: the link has to identify the day whose response carried the event.
 */
const EVENT_KICKOFF = '2026-10-13T19:00:00.000Z';

const RAW = {
  avs: {
    avs: [{
      lv: 0, bid: 9001, ts: '20261013 19:00:00',
      dsl: { RO: 'Viking - Bayern Munchen' }, p: 'UEFA Liga Campionilor',
      scs: [{ cs: 3, d: 'FINAL', eqs: [{ ce: 1, q: '315' }, { ce: 2, q: '457' }, { ce: 3, q: '149' }] }],
    }],
  },
};

function configured(Cls) {
  const s = new Cls({ maxEvents: 10 });
  // Exactly what fetchRaw assigns, without touching the network.
  s.sourceUrl = `${s.apiBase}/getPalinsestoDelGiorno?systemCode=${s.systemCode}&lingua=RO&data=YYYYMMDD&idSport=1&idAggregata=1`;
  s.observedAt = new Date().toISOString();
  return s;
}

const TENANTS = [
  { name: 'excelbet', Cls: ExcelBet },
  { name: 'winboss', Cls: WinBoss },
  { name: 'las-vegas', Cls: LasVegas },
  { name: 'magnumbet', Cls: MagnumBet },
];

for (const { name, Cls } of TENANTS) {
  test(`${name} never publishes the unresolved YYYYMMDD pattern on an event`, () => {
    const s = configured(Cls);
    const [event] = s.extractEvents(s.normalize(RAW));
    assert.ok(event, `${name}: fixture event must be extracted`);
    assert.ok(event.sourceUrl, `${name}: event must carry a source url`);
    assert.ok(
      !event.sourceUrl.includes('YYYYMMDD'),
      `${name}: source url still carries the placeholder -> ${event.sourceUrl}`,
    );
    assert.match(event.sourceUrl, /[?&]data=20261013(&|$)/, `${name}: wrong date in ${event.sourceUrl}`);
  });
}

test('the substituted date is the event day, not the day the crawl ran', () => {
  const s = configured(ExcelBet);
  s.observedAt = '2026-11-30T08:00:00.000Z';
  // The fixture is a fortnight before the crawl, so "today" would be wrong.
  assert.match(s.sourceUrlForDate(EVENT_KICKOFF), /[?&]data=20261013(&|$)/);
  // The run record describes only this run, so it points at the day it ran.
  assert.match(s.sourceUrlForDate(s.observedAt), /[?&]data=20261130(&|$)/);
});

test('the run record publishes an openable link, not the pattern', () => {
  const s = configured(ExcelBet);
  s.observedAt = '2026-11-30T08:00:00.000Z';
  const record = s._serializable(s.extractEvents(s.normalize(RAW)), RAW);
  assert.ok(!String(record.sourceUrl).includes('YYYYMMDD'), 'run record still carries the placeholder');
});

test('an unparsable date degrades to the pattern rather than a half-written query', () => {
  const s = configured(ExcelBet);
  // No substitution, no crash, and never a truncated `data=` value.
  assert.equal(s.sourceUrlForDate('not-a-date'), s.sourceUrl);
  assert.equal(s.sourceUrlForDate(''), s.sourceUrl);
  assert.equal(s.sourceUrlForDate(undefined), s.sourceUrl);
  assert.equal(s.sourceUrlForDate('2026-1-3'), s.sourceUrl);
});

test('extractEvents still works before fetchRaw assigned the pattern', () => {
  // `extractEvents` is called directly by the unit suite and by the
  // sport-fallback path. Publishing `undefined` there was survivable;
  // calling `.replace` on it was not, and the whole suite found it.
  const s = new ExcelBet({ maxEvents: 10 });
  assert.equal(s.sourceUrl, undefined, 'the pattern is assigned by fetchRaw');
  const [event] = s.extractEvents(s.normalize(RAW));
  assert.ok(event, 'the fixture event is still extracted');
  assert.equal(event.sourceUrl, undefined);
});

test('multi-sport points and games totals extraction with subject attribution', () => {
  const rawEvents = [
    {
      bid: 5001,
      sportName: 'basketball',
      league: 'NBA',
      p: 'NBA',
      d: '2026-10-15',
      ts: '20261015 19:00:00',
      dsl: { RO: 'Los Angeles Lakers - Boston Celtics' },
      lv: false,
      scs: [
        {
          cs: 110, // BASKETBALL_WINNER_MARKET
          d: 'Castigator Meci',
          eqs: [
            { ce: 1, q: 185 },
            { ce: 2, q: 195 },
          ],
        },
        {
          cs: 14863, // BASKETBALL_POINTS_TOTAL_MARKET
          d: 'Total Puncte',
          h: 22450, // 224.5 in cents
          eqs: [
            { ce: 1, q: 190 }, // Peste
            { ce: 2, q: 190 }, // Sub
          ],
        },
      ],
    },
    {
      bid: 5002,
      sportName: 'tennis',
      league: 'ATP',
      p: 'ATP',
      d: '2026-10-15',
      ts: '20261015 14:00:00',
      dsl: { RO: 'Carlos Alcaraz - Jannik Sinner' },
      lv: true,
      scr: { sc: '1-0', t: '45', st: 'Set 2' },
      scs: [
        {
          cs: 2, // TENNIS_WINNER_MARKET
          d: 'Castigator',
          eqs: [
            { ce: 1, q: 170 },
            { ce: 2, q: 215 },
          ],
        },
        {
          cs: 13464, // TENNIS_GAMES_TOTAL_MARKET
          d: 'Total game-uri',
          h: 2250, // 22.5 in cents
          eqs: [
            { ce: 1, q: 185 },
            { ce: 2, q: 195 },
          ],
        },
      ],
    },
  ];

  // Prematch only filters out lv: true
  const prematchEvents = new ExcelBet({ sport: 'all', includeLive: false }).extractEvents(rawEvents);
  assert.equal(prematchEvents.length, 1, 'live event excluded when includeLive is false');
  assert.equal(prematchEvents[0].sport, 'basketball');

  const bballMarket = prematchEvents[0].markets.find((m) => m.subject === 'points');
  assert.ok(bballMarket, 'points market extracted');
  assert.equal(bballMarket.line, 224.5);
  assert.equal(bballMarket.subject, 'points');
  assert.equal(bballMarket.live, false);

  // includeLive: true includes both
  const liveEvents = new ExcelBet({ sport: 'all', includeLive: true }).extractEvents(rawEvents);
  assert.equal(liveEvents.length, 2);
  const tennis = liveEvents.find((e) => e.sport === 'tennis');
  assert.ok(tennis);
  assert.equal(tennis.live, true);
  assert.equal(tennis.isLive, true);
  assert.equal(tennis.score, '1-0');
  assert.equal(tennis.periodName, 'Set 2');

  const gamesMarket = tennis.markets.find((m) => m.subject === 'games');
  assert.ok(gamesMarket, 'games market extracted');
  assert.equal(gamesMarket.line, 22.5);
  assert.equal(gamesMarket.subject, 'games');
  assert.equal(gamesMarket.live, true);
});