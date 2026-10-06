import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';
import { teamsMatch, eventIdentityKey } from '../src/shared/text.mjs';

/**
 * The loose name rule, and the second grouping pass it drives.
 *
 * Some books publish an initial where the others publish the name — "Bayern M."
 * for "Bayern Munchen" — so the exact key never pairs the two, the fixture
 * exists on one book only, and no cross-book opportunity can be priced at all.
 *
 * Two things are tested here and they are not the same thing:
 *
 *  - the predicate, on names, where a single letter stands in for the first
 *    letter of the other side's word;
 *  - the pass, over data that is ALREADY grouped, where the danger is not a bad
 *    name but a bad merge — reuniting two competitions, or two fixtures.
 *
 * Every negative assertion sits next to a positive that differs from it in
 * exactly the condition being tested, so a zero here means the rule refused
 * something and not that the fixture was built wrong.
 */

const DAY = '2030-01-01T12:00:00Z';
const OTHER_DAY = '2030-01-02T12:00:00Z';

function book(sourceId, {
  home, away, league = 'Liga 1', sport = 'Football', kickoff = DAY, odds = [2.10, 3.40, 4.60],
} = {}) {
  return {
    id: `${sourceId}:${home}:${away}`,
    sourceId,
    // The scrapers write the canonical key, so a key produced by the scanner can
    // be looked up straight back in a snapshot.
    eventKey: eventIdentityKey({ sport, kickoff, homeTeam: home, awayTeam: away }),
    sport,
    league,
    kickoff,
    homeTeam: home,
    awayTeam: away,
    markets: [{
      key: 'MATCH_ODDS',
      name: 'MATCH_ODDS',
      selections: [
        { name: '1', odds: odds[0] },
        { name: 'X', odds: odds[1] },
        { name: '2', odds: odds[2] },
      ],
    }],
  };
}

const keyOf = (home, away, over = {}) => eventIdentityKey({ sport: 'Football', kickoff: DAY, homeTeam: home, awayTeam: away, ...over });

/**
 * An event that publishes no competition at all.
 *
 * Written as a mutation of the event rather than as `league: undefined` in the
 * options, because a destructuring default replaces an explicit `undefined` —
 * the fixture would have quietly been given "Liga 1" and the test would have
 * been measuring the wrong thing.
 */
const unlabelled = (sourceId, home) => {
  const event = book(sourceId, { home, away: 'Porto' });
  event.league = null;
  return event;
};

describe('teamsMatch', () => {
  test('a single letter stands in for the first letter of the other name', () => {
    assert.equal(teamsMatch('Bayern M', 'Bayern Munchen'), true);
    // Both orders, because the rule is symmetric and the implementation is not
    // obviously so: it picks which token is the short one.
    assert.equal(teamsMatch('Bayern Munchen', 'Bayern M'), true, 'the abbreviated name may be on either side');

    // CONTROL: the same pair, one letter that begins no word in the other name.
    assert.equal(teamsMatch('Bayern Z', 'Bayern Munchen'), false);
    assert.equal(teamsMatch('Bayern Munchen', 'Bayern Z'), false);
  });

  test('an initial never buys a missing word', () => {
    assert.equal(teamsMatch('Augsburg', 'A. Augsburg'), false, 'one word against two');
    assert.equal(teamsMatch('A. Augsburg', 'Augsburg'), false);

    // CONTROL: the token lists line up, and the same rule accepts them.
    assert.equal(teamsMatch('Bayern M', 'Bayern Munchen'), true,
      'so the refusal above is the count, not the spelling');
  });

  test('a shared prefix is not an initial unless it is one letter', () => {
    assert.equal(teamsMatch('Munich', 'Munchen'), false, 'a spelling difference, not an initial');
    // The asymmetric one is the interesting one: "munich".startsWith("muni") is
    // true, so without a length guard only ONE direction would be refused.
    assert.equal(teamsMatch('Munich', 'Muni'), false);
    assert.equal(teamsMatch('Muni', 'Munich'), false);

    // CONTROL: the same pair with the second word actually abbreviated.
    assert.equal(teamsMatch('Munich', 'M'), true);
  });

  test('tokens are compared by position, not as a set', () => {
    assert.equal(teamsMatch('Auger Felix', 'F. Auger'), false, 'the same two words, the other way round');

    // CONTROL: initials in the same positions do match.
    assert.equal(teamsMatch('Felix A', 'F. Auger'), true);
  });

  test('a name that is not there matches nothing, including itself', () => {
    assert.equal(teamsMatch('', ''), false, 'two absences are not an agreement');
    assert.equal(teamsMatch('', 'Bayern M'), false);
    assert.equal(teamsMatch('Bayern M', ''), false);

    // CONTROL: the predicate answers about names, so it does say yes to one.
    assert.equal(teamsMatch('Bayern M', 'Bayern M'), true);
  });

  test('punctuation and diacritics are normalized before the comparison', () => {
    assert.equal(teamsMatch('Hapoel Tel Aviv', 'Hapoel Tel-Aviv'), true);
    assert.equal(teamsMatch('Nămeşteanul', 'Namesteanul'), true);

    // CONTROL: normalization is not a licence to ignore the words themselves.
    assert.equal(teamsMatch('Hapoel Tel Aviv', 'Hapoel Petah Tikva'), false);
  });
});

describe('the second grouping pass', () => {
  test('an abbreviated name is reunited with the full one', () => {
    const grouped = groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto' }),
      book('b', { home: 'Bayern M', away: 'Porto' }),
    ]);
    assert.equal(grouped.size, 1, 'the two books describe one fixture');
    assert.deepEqual([...grouped.values()][0].map((e) => e.sourceId), ['a', 'b']);

    // CONTROL: two different fixtures on the same day stay apart.
    const apart = groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto' }),
      book('b', { home: 'Bayern M', away: 'Benfica' }),
    ]);
    assert.equal(apart.size, 2, 'the initial is on the home side only, so the away side decides');
  });

  test('a shared first letter is where to look, not a conclusion', () => {
    // Both of these pairs hash to the same coarse bucket — "sporting" + a second
    // word starting with "l", twice — so one of them merging and the other not
    // is what proves the exact rule runs INSIDE the bucket rather than the
    // bucket deciding on its own.
    const bridged = groupByEvent([
      book('a', { home: 'Sporting L', away: 'Porto' }),
      book('b', { home: 'Sporting Lisboa', away: 'Porto' }),
    ]);
    assert.equal(bridged.size, 1, 'a one-letter token is an initial');

    const refused = groupByEvent([
      book('a', { home: 'Sporting Lis', away: 'Porto' }),
      book('b', { home: 'Sporting Lus', away: 'Porto' }),
    ]);
    assert.equal(refused.size, 2, 'same first letters, different words');
  });

  test('the pass stays inside one sport and one day', () => {
    assert.equal(groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto' }),
      book('b', { home: 'Bayern M', away: 'Porto', sport: 'Basketball' }),
    ]).size, 2, 'a basketball fixture is not this football fixture');

    assert.equal(groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto' }),
      book('b', { home: 'Bayern M', away: 'Porto', kickoff: OTHER_DAY }),
    ]).size, 2, 'nor is tomorrow\'s');

    // CONTROL: nothing else differs between these and the pair that does merge.
    assert.equal(groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto' }),
      book('b', { home: 'Bayern M', away: 'Porto' }),
    ]).size, 1);
  });

  test('a loose name never reunites two competitions', () => {
    // The strict pass splits these two on competition alone, putting them in two
    // groups that share a base. The loose pass must leave that decision alone:
    // it is the one guard that keeps a fictional arbitrage between two fixtures
    // that are never played against each other from being invented.
    const grouped = groupByEvent([
      book('a', { home: 'Bayern M', away: 'Porto', league: 'Liga Natiunilor A' }),
      book('b', { home: 'Bayern Munchen', away: 'Porto', league: 'Liga Natiunilor C' }),
    ]);
    assert.equal(grouped.size, 2, 'group A and group C stay separate');

    // CONTROL: the same two names under one competition do merge.
    assert.equal(groupByEvent([
      book('a', { home: 'Bayern M', away: 'Porto', league: 'Liga Natiunilor A' }),
      book('b', { home: 'Bayern Munchen', away: 'Porto', league: 'Nations League A' }),
    ]).size, 1, 'two names for the same competition are still one competition');
  });

  test('a generic label cannot smuggle a second competition in', () => {
    // "Final" carries no identity, so it is compatible with everything — which
    // is correct on its own and is exactly what makes it useless as a bridge.
    // Merging is transitive, so checking the pair being joined is not enough:
    // this component would end up naming two competitions the strict pass keeps
    // apart. The check has to run on the whole component, which is why the
    // generic label is FIRST here — a component that has already collected a
    // specific label is the one that must refuse the next one.
    const grouped = groupByEvent([
      book('a', { home: 'Faversham Town', away: 'Welling United', league: 'Final' }),
      book('b', { home: 'Faversham T', away: 'Welling U', league: 'Liga Natiunilor A' }),
      book('c', { home: 'Faversham Tow', away: 'Welling Uni', league: 'Liga Natiunilor C' }),
    ]);
    assert.equal(grouped.size, 2, 'the first two merge, the third is refused');
    const merged = [...grouped.values()].find((events) => events.length > 1);
    assert.deepEqual([...new Set(merged.map((e) => e.sourceId))].sort(), ['a', 'b']);
    for (const events of grouped.values()) {
      const labels = new Set(events.map((e) => e.league));
      assert.ok(labels.size === 1 || labels.has('Final'),
        `a merged group names one competition, got ${[...labels].join(' + ')}`);
    }

    // CONTROL: the same three names with a competition all three agree on.
    assert.equal(groupByEvent([
      book('a', { home: 'Faversham Town', away: 'Welling United', league: 'Liga Natiunilor A' }),
      book('b', { home: 'Faversham T', away: 'Welling U', league: 'Liga Natiunilor A' }),
      book('c', { home: 'Faversham Tow', away: 'Welling Uni', league: 'Liga Natiunilor A' }),
    ]).size, 1, 'nothing to disagree about, so all three join');
  });

  test('the surviving key is the one that was seen first', () => {
    const full = book('a', { home: 'Bayern Munchen', away: 'Porto' });
    const short = book('b', { home: 'Bayern M', away: 'Porto' });

    const seenFirst = [...groupByEvent([full, short]).keys()];
    assert.deepEqual(seenFirst, [keyOf('Bayern Munchen', 'Porto')],
      'the bare key belongs to the group that was seen first');

    const reversed = [...groupByEvent([short, full]).keys()];
    assert.deepEqual(reversed, [keyOf('Bayern M', 'Porto')],
      'and to whichever book happened to be read first, not to the longer name');
  });

  test('a merged group keeps the bare key and the split below it is renumbered', () => {
    // Three strict groups: two competition splits of one base, plus a base that
    // differs only by an initial. The split that does not merge must end up
    // numbered against the group that did, not against the one it lost.
    const grouped = groupByEvent([
      book('a', { home: 'Bayern M', away: 'Porto', league: 'Liga Natiunilor A' }),
      book('b', { home: 'Bayern M', away: 'Porto', league: 'Liga Natiunilor C' }),
      book('c', { home: 'Bayern Munchen', away: 'Porto', league: 'Liga Natiunilor A' }),
    ]);
    assert.equal(grouped.size, 2);
    assert.deepEqual([...grouped.keys()], [keyOf('Bayern M', 'Porto'), `${keyOf('Bayern M', 'Porto')}#1`]);
    assert.deepEqual(grouped.get(keyOf('Bayern M', 'Porto')).map((e) => e.sourceId), ['a', 'c'],
      'the bare key holds the merged group');
    assert.deepEqual(grouped.get(`${keyOf('Bayern M', 'Porto')}#1`).map((e) => e.sourceId), ['b']);
  });

  test('two events that name no competition at all still pair', () => {
    // The label comparison is shared with the strict pass, where two absent
    // labels have always counted as the same one. A loose pass that disagreed
    // here would quietly change the first pass's behaviour.
    //
    // These two have the SAME name, so the strict pass is what has to pair them:
    // with the name abbreviated instead they would never meet in the strict pass
    // at all, and the test would pass whatever the label comparison said.
    const sameName = groupByEvent([
      unlabelled('a', 'Bayern Munchen'),
      unlabelled('b', 'Bayern Munchen'),
    ]);
    assert.equal(sameName.size, 1, 'two books that publish no competition are not two fixtures');

    // A label that is present but carries no identity — punctuation only — is
    // the same case, and the strict pass has to treat it the same way.
    const junk = groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto', league: '---' }),
      book('b', { home: 'Bayern Munchen', away: 'Porto', league: '---' }),
    ]);
    assert.equal(junk.size, 1, 'and neither is a label that cleans to nothing');

    // CONTROL: an absent label is not the same as any real competition.
    assert.equal(groupByEvent([
      unlabelled('a', 'Bayern Munchen'),
      book('b', { home: 'Bayern Munchen', away: 'Porto', league: 'Liga 1' }),
    ]).size, 2);
  });

  test('the reunited fixture becomes priceable', () => {
    const grouped = groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto', odds: [2.60, 3.40, 3.20] }),
      book('b', { home: 'Bayern M', away: 'Porto', odds: [2.70, 3.40, 3.10] }),
    ]);
    assert.equal(findArbitrage(grouped, { minMarginPercent: 0 }).length, 1,
      'the reason the rule exists: this price was not reachable before');

    // CONTROL: the same two prices on two different fixtures are not an arb.
    const apart = groupByEvent([
      book('a', { home: 'Bayern Munchen', away: 'Porto', odds: [2.60, 3.40, 3.20] }),
      book('b', { home: 'Bayern M', away: 'Benfica', odds: [2.70, 3.40, 3.10] }),
    ]);
    assert.equal(findArbitrage(apart, { minMarginPercent: 0 }).length, 0);
  });
});
