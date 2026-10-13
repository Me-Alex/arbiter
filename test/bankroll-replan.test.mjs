import test from 'node:test';
import assert from 'node:assert/strict';

import {
  page, settle, cardLegs, OPPORTUNITY, MIDDLE,
  DECLARED_IDS, REQUESTED_IDS,
} from './helpers/arbitrage-page.mjs';

/**
 * The bankroll control, driven the way the operator drives it.
 *
 * This page had a `replan()` that was fully written, fully documented, and
 * called by nothing, until the control was wired to it. Every test that read
 * the source or called a render function directly passed while the control was
 * decorative, because the defect is only visible through the page's own `input`
 * listener. So this file dispatches the real event and reads the DOM back.
 *
 * The promise under test is the one the card makes to the person placing the
 * money: the legs on a card add up to that card's own total. The Dutch split is
 * exact to the cent and the guarantee is computed from the cent values, so a
 * card that rounded each leg to whole units for display printed stakes that did
 * not sum to the total printed beside them (1,721 + 432 + 348 under a stated
 * 2,500), and a card that rounded each scaled leg independently printed 39.99
 * under a stated 40.
 */
const ARB_GRID = 'arb-grid';
const MIDDLE_GRID = 'middle-grid';
const BANKROLL = 'f-bankroll';
const STATED = 'k-stake';

/** The legs actually on a grid, with the money as it was printed. */
const legsOn = (p, grid) => cardLegs({ innerHTML: String(p.get(grid).innerHTML || '') });
const sumOf = (legs) => legs.reduce((a, l) => a + (l.stake === null ? 0 : l.stake), 0);

/** Money out of a node's rendered text: "1,000.00" -> 1000 */
const numberIn = (el) => {
  const n = Number(String(el.textContent || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function loaded() {
  const p = page();
  await settle();
  await settle();
  return p;
}

/** Type into the real control, exactly as a keypress does. */
function bankroll(p, value) {
  const input = p.get(BANKROLL);
  input.value = String(value);
  input.fire('input');
}

test('the page asks only for ids the markup declares', () => {
  // A control whose node is missing throws inside the IIFE, and a throw there
  // silently stops every listener below it from ever being attached — the half
  // of the page under the missing node is dead, with nothing in the console to
  // point at it.
  for (const id of REQUESTED_IDS) {
    assert.ok(DECLARED_IDS.has(id), `arbitrage.html declares no #${id}`);
  }
});

test('the control actually re-plans, rather than only relabelling the masthead', async () => {
  const p = await loaded();
  const before = legsOn(p, ARB_GRID).map((l) => l.stakeText);
  bankroll(p, 2500);
  const after = legsOn(p, ARB_GRID).map((l) => l.stakeText);
  assert.notDeepEqual(after, before, 'typing a bankroll changed no leg stake');
  assert.deepEqual(after, ['1,720.80', '431.55', '347.65']);
});

test('the legs on a card sum to that card total, at every bankroll', async () => {
  const p = await loaded();

  // 40 is in the list because it is the one that used to fail: each leg rounded
  // on its own gave 27.53 + 6.90 + 5.56 = 39.99 under a stated 40.
  for (const budget of [2500, 137.5, 40, 0.07, 12345.67, 1]) {
    bankroll(p, budget);

    for (const [grid, published] of [[ARB_GRID, OPPORTUNITY], [MIDDLE_GRID, MIDDLE]]) {
      const legs = legsOn(p, grid);
      assert.equal(legs.length, published.legs.length,
        `${grid} should render ${published.legs.length} legs at ${budget}`);

      const sum = sumOf(legs);
      assert.ok(
        Math.abs(sum - budget) <= 0.005,
        `${grid}: legs sum to ${sum.toFixed(2)} under a stated ${budget} — `
        + legs.map((l) => l.stakeText).join(' + '),
      );
    }
  }
});

test('the KPI total is the re-planned total, not the published one', async () => {
  const p = await loaded();
  for (const budget of [2500, 40, 12345.67]) {
    bankroll(p, budget);
    const stated = numberIn(p.get(STATED));
    // One opportunity in the fixture, so the KPI carries exactly one budget.
    assert.ok(Math.abs(stated - budget) <= 0.5,
      `KPI says ${stated} at a ${budget} bankroll`);
  }
});

test('every leg keeps its cents once the plan is re-scaled', async () => {
  const p = await loaded();
  bankroll(p, 2500);
  for (const grid of [ARB_GRID, MIDDLE_GRID]) {
    for (const leg of legsOn(p, grid)) {
      assert.match(leg.stakeText, /\.\d{2}$/,
        `${grid}: leg "${leg.stakeText}" lost its cents — a rounded leg is a leg `
        + 'that does not add up to the total printed beside it');
    }
  }
});

test('at the published bankroll the legs are exactly the published stakes', async () => {
  // No scaling, so the card must be quoting the engine and nothing else.
  const p = await loaded();
  const want = [...OPPORTUNITY.legs, ...MIDDLE.legs]
    .map((l) => l.stake)
    .sort((a, b) => a - b);
  const got = [...legsOn(p, ARB_GRID), ...legsOn(p, MIDDLE_GRID)]
    .map((l) => l.stake)
    .sort((a, b) => a - b);
  assert.deepEqual(got, want);
});

test('a bankroll that is not a usable amount changes nothing and shows no NaN', async () => {
  const p = await loaded();
  bankroll(p, 2500);
  const before = [ARB_GRID, MIDDLE_GRID].map((g) => String(p.get(g).innerHTML));

  for (const bad of ['', '0', '-100', 'abc', 'NaN', 'Infinity', '1e999', '  ']) {
    bankroll(p, bad);
    const after = [ARB_GRID, MIDDLE_GRID].map((g) => String(p.get(g).innerHTML));
    assert.ok(!after.join('').includes('NaN'), `bankroll "${bad}" rendered NaN`);
    assert.ok(!after.join('').includes('Infinity'), `bankroll "${bad}" rendered Infinity`);
    assert.deepEqual(after, before, `bankroll "${bad}" re-planned the card anyway`);
  }
});