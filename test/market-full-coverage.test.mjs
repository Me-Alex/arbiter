// Tests for the full-surface market coverage (the second-pass extension).
// Each test maps a real book/publisher shape (taken from data/workspace) to a
// non-null contract. These are *regression* tests: if a future change breaks
// any, that book/publisher loses a slice of the reachable surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContract, classifyAndExtractLine, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

function ev(key, selections) {
  return { key, period: 'fulltime', name: '', selections };
}

test('netbet game_handicap with line in name → ASIAN_HANDICAP', () => {
  const c = resolveContract(ev('game_handicap', [
    { name: '1 (-7.5)' }, { name: '2 (7.5)' },
  ]));
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '-7.5/7.5');
});

test('netbet handicap with player prefix → ASIAN_HANDICAP', () => {
  const c = resolveContract(ev('handicap', [
    { name: 'Zsombor Piros -4.5' }, { name: 'Benjamin Hassan +4.5' },
  ]));
  assert.equal(c.family, 'ASIAN_HANDICAP');
  assert.equal(c.lineKey, '-4.5/4.5');
});

test('netbet total_games with line in name → OVER_UNDER', () => {
  const c = resolveContract(ev('total_games', [
    { name: 'Peste (17.5)' }, { name: 'Sub (17.5)' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '17.5');
});

test('netbet total_points with line in name → OVER_UNDER', () => {
  const c = resolveContract(ev('total_points', [
    { name: 'Peste (171.5)' }, { name: 'Sub (171.5)' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '171.5');
});

test('betano FHOT (signed +/- X.X) → ASIAN_HANDICAP, in either leg order', () => {
  // The leg order carries no meaning and betano does not keep it: measured on the
  // 2026-09-29 capture, FHOT listed the negative leg first on 29 markets and the
  // positive leg first on 15. A lineKey built from array position therefore gave
  // one handicap two buckets, and a second book quoting the same spread could
  // pair with one of them and never the other. Ordering by sign — the negative
  // side IS the home handicap — makes both orders the same contract.
  const forward = resolveContract(ev('FHOT', [
    { name: '-10.5' }, { name: '+10.5' },
  ]));
  const reversed = resolveContract(ev('FHOT', [
    { name: '+10.5' }, { name: '-10.5' },
  ]));
  assert.equal(forward.family, 'ASIAN_HANDICAP');
  assert.equal(reversed.family, 'ASIAN_HANDICAP');
  assert.equal(forward.lineKey, '-10.5/10.5', 'the home handicap leads the key');
  assert.equal(reversed.lineKey, forward.lineKey, 'leg order must not split the contract');
});

test('betano FTGO ("Game-uri", a tennis games total) is withheld, not a goals total', () => {
  // Measured on the live feed: FTGO is "Game-uri" on Tennis events (Peste/Sub
  // 21.5 games), not goals. As a bare OVER_UNDDER line it shared a bucket with a
  // goals line of the same value, which are entirely different contracts.
  const c = resolveContract(ev('FTGO', [
    { name: 'Peste 22.5' }, { name: 'Sub 22.5' },
  ]));
  assert.equal(c, null, 'a tennis games total must not resolve as a goal total');
});

test('betano TGOT (P X.X / S X.X) → OVER_UNDER', () => {
  const c = resolveContract(ev('TGOT', [
    { name: 'P 5.5' }, { name: 'S 5.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '5.5');
});

test('FEG ufo:mtyp:02-06 (CS total rounds +/-) → OVER_UNDER', () => {
  const c = resolveContract(ev('ufo:mtyp:02-06', [
    { name: '+ 21.5' }, { name: '- 21.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '21.5');
});

test('FEG ufo:mtyp:14-02 (MMA total rounds) → OVER_UNDER', () => {
  const c = resolveContract(ev('ufo:mtyp:14-02', [
    { name: '+ 9.5' }, { name: '- 9.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
});

test('FEG ufo:mtyp:04-01 (Dota 2 team-vs-team) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('ufo:mtyp:04-01', [
    { name: 'BB Team' }, { name: 'OG' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('superbet 919 (1|2 cricket) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('919', [
    { name: '1' }, { name: '2' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('betano H2HT (tennis player names) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('H2HT', [
    { name: 'ENCE' }, { name: 'Aimhaus' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
  // With ctx provided, ENCE matches homeTeam → 'home'
  assert.equal(canonicalOutcomeFor('ENCE', c, { homeTeam: 'ENCE', awayTeam: 'Aimhaus' }), 'home');
  assert.equal(canonicalOutcomeFor('Aimhaus', c, { homeTeam: 'ENCE', awayTeam: 'Aimhaus' }), 'away');
});

test('betano DNOB (draw no bet) → DRAW_NO_BET, never arbitrable', () => {
  // Measured on the live betano feed: DNOB is "Niciun pariu pe egal" with the
  // two team names as its sides. It used to resolve as a 2-way MATCH_ODDS,
  // which put a DNB leg in the same bucket as a real full-time result.
  const c = resolveContract(ev('DNOB', [
    { name: 'Belgia' }, { name: 'Franța' },
  ]));
  assert.equal(c.family, 'DRAW_NO_BET');
  assert.equal(c.arbEligible, false, 'a draw refunds the stake, so the pair is not exhaustive');
});

test('FEG ufo:mtyp:00-03 (Victorie fara egal) → DRAW_NO_BET, never arbitrable', () => {
  // Same defect, second feed: 00-03 is draw-no-bet with literal 1/2 sides, so
  // it collided with the full-time result contract on both legs.
  const c = resolveContract(ev('ufo:mtyp:00-03', [
    { name: '1' }, { name: '2' },
  ]));
  assert.equal(c.family, 'DRAW_NO_BET');
  assert.equal(c.arbEligible, false);
});

test('draw no bet is a different family from a match result, so they never bucket together', () => {
  const dnb = resolveContract(ev('DNOB', [{ name: 'Belgia' }, { name: 'Franța' }]));
  const result = resolveContract(ev('MRES', [{ name: '1' }, { name: 'X' }, { name: '2' }]));
  assert.equal(result.family, 'MATCH_ODDS');
  assert.notEqual(dnb.family, result.family, 'a DNB leg must never share a bucket with a result leg');
});

test('a genuine two-way match winner is still arbitrable (the fix is narrow)', () => {
  // Guards against the DNB fix over-reaching: H2HT is a real 2-outcome winner
  // and must keep resolving as an arbitrable MATCH_ODDS.
  const c = resolveContract(ev('H2HT', [{ name: 'ENCE' }, { name: 'Aimhaus' }]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.notEqual(c.arbEligible, false);
});

test('non-goal totals are withheld: a corners line is not a goals line', () => {
  // Measured on the live betano feed. CNOU "Cornere Peste/Sub" was resolving as
  // OVER_UNDER/8.5 — the same bucket a goals 8.5 uses — so a corners price and
  // a goals price from two books would pair as one contract.
  for (const [key, name, sels] of [
    ['CNOU', 'Cornere Peste/Sub', [{ name: 'Peste 8.5' }, { name: 'Sub 8.5' }]],
    ['TCOU', 'Total cartonașe Peste/Sub', [{ name: 'Peste 3.5' }, { name: 'Sub 3.5' }]],
    ['TSMF', 'Total Hărți', [{ name: 'Peste 3.5' }, { name: 'Sub 3.5' }]],
    ['FTPO', 'Total Puncte', [{ name: 'Peste 41.5' }, { name: 'Sub 41.5' }]],
  ]) {
    assert.equal(resolveContract({ key, name, period: 'fulltime', selections: sels }), null,
      `${key} (${name}) must not resolve as a goal total`);
  }
});

test('a goals total is still arbitrable (the withholding is narrow)', () => {
  const c = resolveContract({
    key: 'HCTG', name: 'Total goluri Peste/Sub', period: 'fulltime',
    selections: [{ name: 'Peste 2.5' }, { name: 'Sub 2.5' }],
  });
  assert.equal(c.family, 'OVER_UNDER');
  assert.equal(c.lineKey, '2.5');
  assert.notEqual(c.arbEligible, false);
});

test('a first-half total never shares a bucket with the full-time total of the same line', () => {
  // betano hardcodes period:'fulltime' on every market, so its first-half goals
  // total declared fulltime and landed in OVER_UNDER/0.5 — identical to a real
  // full-time goals 0.5. Both the diacritic and the stripped spelling of
  // "prima repriza" have to be caught.
  for (const name of ['Goluri prima repriză Peste/Sub', 'Goluri prima repriza Peste/Sub']) {
    const half = resolveContract({ key: 'OUH1', name, period: 'fulltime', selections: [{ name: 'Peste 0.5' }, { name: 'Sub 0.5' }] });
    const full = resolveContract({ key: 'TOTAL', name: 'Total goluri', period: 'fulltime', selections: [{ name: 'Peste 0.5' }, { name: 'Sub 0.5' }] });
    assert.equal(half.period, 'half1', `"${name}" must resolve as first half`);
    assert.equal(full.period, 'fulltime');
    assert.equal(half.lineKey, full.lineKey, 'same line, so only the period can separate them');
    assert.notEqual(half.period, full.period);
  }
});

test('a second-half total resolves as half2', () => {
  const c = resolveContract({
    key: 'X', name: 'Goluri a doua repriză', period: 'fulltime',
    selections: [{ name: 'Peste 0.5' }, { name: 'Sub 0.5' }],
  });
  assert.equal(c.period, 'half2');
});

test('betano BTSC (BTTS yes/no in Romanian) → BTTS', () => {
  const c = resolveContract(ev('BTSC', [
    { name: 'Da (GG)' }, { name: 'Nu (NG)' },
  ]));
  assert.equal(c.family, 'BTTS');
  assert.deepEqual(c.outcomes, ['yes', 'no']);
});

test('betano 4191 (winner) → MATCH_ODDS 2-way', () => {
  const c = resolveContract(ev('4191', [
    { name: 'Chicago Bears' }, { name: 'Philadelphia Eagles' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('generic fallback: any 2 clean non-totals names → MATCH_ODDS 2-way', () => {
  // Anything not literals peste/sub/over/under/handicap with two distinct non-
  // empty names resolves as a 2-way match winner.
  const c = resolveContract(ev('XYZZY', [
    { name: 'Falcons' }, { name: 'Eagles' },
  ]));
  assert.equal(c.family, 'MATCH_ODDS');
  assert.deepEqual(c.outcomes, ['home', 'away']);
});

test('generic fallback: 2 distinct names that look like totals → still OVER_UNDER', () => {
  // If the names contain peste/sub, the resolver prefers the O/U family even
  // on a non-whitelisted key.
  const c = resolveContract(ev('XYZZY', [
    { name: 'Peste 1.5' }, { name: 'Sub 1.5' },
  ]));
  assert.equal(c.family, 'OVER_UNDER');
});

test('classifyAndExtractLine: half-line AH half rejected (whole line)', () => {
  const result = classifyAndExtractLine(
    [{ name: '1 (-1)' }, { name: '2 (+1)' }],
    { kind: 'AH' },
  );
  assert.equal(result, null, 'whole-line AH is excluded (push semantics differ)');
});

test('classifyAndExtractLine: half-line AH half accepted', () => {
  const result = classifyAndExtractLine(
    [{ name: '1 (-1.5)' }, { name: '2 (+1.5)' }],
    { kind: 'AH' },
  );
  assert.ok(result);
  assert.equal(result.family, 'ASIAN_HANDICAP');
  assert.equal(result.lineKey, '-1.5/1.5');
});

test('a handicap buckets the same whichever order the provider lists its legs', () => {
  // The lineKey is the join key between two books, so it has to mean the same
  // thing on both sides. It used to be read off array position, so "1 -1.5"/
  // "2 +1.5" and "2 +1.5"/"1 -1.5" — the same contract, and both live on the
  // FEG feed — landed in different buckets and could never be paired. The
  // engine already labels the sides by their own 1/2 token, so the key is
  // ordered by side too.
  const shapes = [
    [[{ name: '1 -1.5' }, { name: '2 +1.5' }], '1 / 2 naming'],
    [[{ name: '2 +1.5' }, { name: '1 -1.5' }], '2 / 1 naming'],
    [[{ name: 'H1 -1.5' }, { name: 'H2 1.5' }], 'H1 / H2 naming'],
    [[{ name: 'H2 1.5' }, { name: 'H1 -1.5' }], 'H2 / H1 naming'],
    [[{ name: '1 (-1.5)' }, { name: '2 (1.5)' }], 'netbet parentheses'],
    [[{ name: '2 (1.5)' }, { name: '1 (-1.5)' }], 'netbet reversed'],
  ];
  for (const [selections, what] of shapes) {
    const r = classifyAndExtractLine(selections, { kind: 'AH' });
    assert.ok(r, `${what}: must resolve`);
    assert.equal(r.family, 'ASIAN_HANDICAP', `${what}: must stay a handicap`);
    assert.equal(r.lineKey, '-1.5/1.5', `${what}: home/away order, not array order`);
  }
});

test('a handicap with no side token keeps a stable key rather than a guessed one', () => {
  // "- 6.5"/"+ 6.5" names no side, so there is nothing to order by. Stability
  // for one provider is the point; inventing a home/away order is not.
  const r = classifyAndExtractLine([{ name: '- 6.5' }, { name: '+ 6.5' }], { kind: 'AH' });
  assert.ok(r);
  assert.equal(r.lineKey, '-6.5/6.5');
});

test('classifyAndExtractLine: OU signed +/- converts to a single magnitude', () => {
  const result = classifyAndExtractLine(
    [{ name: '+ 17.5' }, { name: '- 17.5' }],
    { kind: 'OU' },
  );
  assert.equal(result.family, 'OVER_UNDER');
  assert.equal(result.lineKey, '17.5');
});

test('FEG American Football DC (ufo:mtyp:0c-01) → DOUBLE_CHANCE on any sport', () => {
  // FEG encodes DC per sport (00 football, 11 handball, 0c American football,
  // ...). All variants share the {1X/12/X2} selection shape. Spot-check that
  // the resolver accepts any sportId when the shape matches.
  const c = resolveContract({
    key: 'ufo:mtyp:0c-01',
    period: 'unknown',
    selections: [{ name: '1X' }, { name: '12' }, { name: 'X2' }],
  });
  assert.equal(c.family, 'DOUBLE_CHANCE');
  assert.equal(c.arbEligible, false);
});

test('FEG degraded DC: 2 of 3 outcomes is catalogued but flagged', () => {
  // FEG feeds sometimes publish a DC market with only 2 of 3 outcomes
  // (e.g. X2 missing). The engine cannot arb this — backing 2 double-chances
  // is not a surebet — but the contract is recognised so the catalogue sees
  // it.
  const c = resolveContract({
    key: 'ufo:mtyp:11-0t',
    period: 'unknown',
    selections: [{ name: '1X' }, { name: '12' }],
  });
  assert.equal(c.family, 'DOUBLE_CHANCE');
  assert.equal(c.degraded, true);
  assert.equal(c.arbEligible, false);
});

test('current_frame_winner (snooker frame 2-way) resolves to nothing, not the match winner', () => {
  // This test used to assert MATCH_ODDS 2-way here, on the reasoning that the
  // literal "1" / "2" labels make it a clean 2-way winner regardless of key.
  // That is the defect, not the defence: the shape says nothing about WHICH
  // contest is being won, and netbet publishes "Frame 4 Castigator" and
  // "Castigator Meci" on the same snooker event. Both resolve off "1"/"2" into
  // MATCH_ODDS/_ with lineKey "_", so the frame price and the match price land
  // in one bucket — measured on the 2026-09-29 capture, all 4 snooker events
  // that carried both. findArbitrage refuses to pair one book with itself, so
  // it reports nothing today, but against a second book quoting that match the
  // engine would offer a frame price as a match price and book an arbitrage
  // between two contracts that settle on different events.
  //
  // The key is therefore authoritative: it resolves to nothing at all, not to
  // a 2-way match winner by shape.
  const c = resolveContract({
    key: 'current_frame_winner',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: '2' }],
  });
  assert.equal(c, null, 'a frame winner must not resolve as the match winner');

  // The guard must not over-reach: the match winner on the same event still
  // resolves, and so does a plain 2-way market under an ordinary key.
  const match = resolveContract({
    key: 'default',
    period: 'fulltime',
    selections: [{ name: '1' }, { name: '2' }],
  });
  assert.equal(match.family, 'MATCH_ODDS');
  assert.deepEqual(match.outcomes, ['home', 'away']);
});
