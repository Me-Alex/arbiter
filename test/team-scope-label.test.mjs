/**
 * team-scope-label.test.mjs — the side the engine measured has to reach the
 * trader, on both of the surfaces the site renders from.
 *
 * The engine publishes `team` on a surebet or a middle only when it resolved a
 * real side, because a home total and the match total are two different bets
 * that settle on different numbers. Nothing read the field, so both surfaces
 * drew a team's own line as the market's line: the React row titled it the
 * match total, and the console chip - which is derived from the market key and
 * never had a subject layer at all - said the same thing for the same reason.
 *
 * The two halves are tested against the real thing rather than against a copy:
 * the React half imports the normalizer and the label module the browser runs,
 * and the console half drives the real page through the same harness the
 * bankroll tests use, reading the expected words out of the real dictionary so
 * the assertion holds in either language.
 *
 * Each rule is paired with the control that would fail without it: a row with
 * no side must be untouched, and a side that names nothing ('match' is the
 * absence of a scope) must not invent a word.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeScan } from '../frontend/src/api.ts';
import { localizeMarketLabel } from '../frontend/src/labels.ts';
import { page, settle, MIDDLE } from './helpers/arbitrage-page.mjs';

const EVENT = 'football|2026-10-17T11:30:00.000Z|home|away';

/** The harness's middle, which is a plain match total until a side is set. */
const mid = (overrides = {}) => ({ ...MIDDLE, eventKey: EVENT, ...overrides });

const react = (overrides) => normalizeScan({ middles: [mid(overrides)] })[0];

/** A literal for a regex, so a dictionary word cannot be read as a pattern. */
const rx = (text) => new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// ---------------------------------------------------------------------------
// The React row.
// ---------------------------------------------------------------------------

test('the React row names the side, as a prefix and nowhere else', () => {
  const plain = react({});
  // The whole rule, stated as a difference rather than as two hand-written
  // strings: the scoped label IS the unscoped label with one word in front of
  // it. A second difference - a dropped period, a changed line - fails here.
  for (const [team, word] of [['home', 'Home'], ['away', 'Away'], ['AWAY', 'Away']]) {
    const scoped = react({ team });
    assert.equal(scoped.marketName, `${word} ${plain.marketName}`, `team=${team}`);
    assert.deepEqual(
      scoped.legs.map((leg) => leg.marketName),
      plain.legs.map((leg) => `${word} ${leg.marketName}`),
      `the legs of a team-scoped row must name the same side as its card, for team=${team}`,
    );
  }
});

test('a side that names nothing leaves the row exactly as it was', () => {
  const plain = react({});
  // 'match' is the absence of a scope, not a third side: publishing it would
  // put the word "Match" on every ordinary total and name nothing new. An
  // engine that sent it, or a junk value, must not reach the label.
  for (const team of ['match', 'both', 'Home Team', '', undefined]) {
    const row = react({ team });
    assert.equal(row.marketName, plain.marketName, `team=${JSON.stringify(team)} moved the label`);
    assert.deepEqual(row.legs.map((leg) => leg.marketName), plain.legs.map((leg) => leg.marketName));
  }
});

test('the word is a prefix the label table translates, not an English leak', () => {
  // The React row keeps an English label and `labels.ts` translates it at
  // render. A prefix the table does not know would sit untranslated in the
  // middle of a Romanian label, which is the failure this pins.
  const key = (name) => `<${name}>`;
  assert.equal(
    localizeMarketLabel(react({ team: 'home', period: 'fulltime' }).marketName, key),
    '<appSideHome> <marketTotalGoals> 1.5 \u00b7 <appPeriodFullTime>',
  );
  assert.equal(
    localizeMarketLabel(react({ team: 'away', period: 'fulltime' }).marketName, key),
    '<appSideAway> <marketTotalGoals> 1.5 \u00b7 <appPeriodFullTime>',
  );
});

// ---------------------------------------------------------------------------
// The console chip.
// ---------------------------------------------------------------------------

/** The middle grid's HTML after the page has loaded and drawn. */
async function consoleGrid(overrides) {
  const p = page({ scan: { middles: [mid(overrides)] } });
  await settle();
  await settle();
  const html = String(p.get('middle-grid').innerHTML || '');
  const t = p.context.arbiterI18n.t;
  return { html, t };
}

test('the console chip names the same side, read off the same field', async () => {
  const { html: homeHtml, t } = await consoleGrid({ team: 'home' });
  const home = t('appSideHome');
  const away = t('appSideAway');
  const market = t('marketTotalGoals');

  // Both directions on one render: the side it was given, and not the other
  // one. A chip that printed a constant would satisfy the first half alone.
  assert.match(homeHtml, rx(home), `the chip must name the side the engine resolved: ${home}`);
  assert.doesNotMatch(homeHtml, rx(away), 'the other side must not appear on this row');
  assert.match(homeHtml, new RegExp(`${rx(home).source}[^<]*${rx(market).source}`),
    'the side belongs to the market chip, beside the market it scopes');
});

test('the console chip is untouched without a side, and takes the other one', async () => {
  const plain = (await consoleGrid({})).html;
  const awayResult = await consoleGrid({ team: 'away' });
  const home = awayResult.t('appSideHome');
  const away = awayResult.t('appSideAway');

  assert.doesNotMatch(plain, rx(home), 'a match total must not claim a side');
  assert.doesNotMatch(plain, rx(away));
  assert.match(awayResult.html, rx(away));
  assert.doesNotMatch(awayResult.html, rx(home));
});
