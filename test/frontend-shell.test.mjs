/**
 * frontend-shell.test.mjs — the decisions the app shell makes before it draws.
 *
 * The app has no DOM test harness and deliberately does not grow one: no jsdom,
 * no extra dependency, and Node's type stripping cannot read `.tsx` at all. So
 * anything written only inside a component body is unguarded by construction.
 * Three defects fixed in this shell were exactly that shape — a feed rendered
 * under a "read-only placeholder" panel, an execution slip whose close button
 * re-opened the row it had just dismissed, and a workspace whose nav button had
 * no handler — and each of them took a browser walkthrough to find, because
 * nothing but a human could ask the question.
 *
 * `workspace.ts` and `age.ts` exist to move those decisions somewhere a test can
 * reach them. This file is the other half of that move: for each decision it
 * reintroduces the defect the decision was extracted to fix and requires the
 * suite to go red on it.
 *
 * What it still cannot see is the rendering itself — that the gates are wired to
 * the returned value, that the slip is passed `desiredSelection`'s answer, that
 * the nav button's `onClick` navigates. That half stays a walkthrough, and this
 * file's job is to keep the reasoning from rotting in the meantime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { formatAge } from '../frontend/src/age.ts';
import {
  DEFAULT_FILTER_CRITERIA,
  DEFAULT_VIEW,
  NAV_VIEWS,
  TERMINAL_VIEWS,
  WORKSPACES,
  criteriaForPreset,
  desiredSelection,
  filterOpportunities,
  hashForView,
  isTerminalView,
  viewFromHash,
} from '../frontend/src/workspace.ts';

const ALL_VIEWS = Object.keys(WORKSPACES);

/** The dictionary's two day letters, printed the way the app composes them. */
const roDay = (days) => `${days}z`;
const enDay = (days) => `${days}d`;

test('the controls: a hash resolves, junk does not, every view round-trips', () => {
  // Without the first half a broken import would read as "no workspace is
  // reachable", and without the second a table that answered anything would
  // read as working.
  assert.equal(viewFromHash('#/settings'), 'Settings');
  assert.equal(viewFromHash('#/opportunities'), 'Opportunities');
  assert.equal(DEFAULT_VIEW, 'Opportunities');
  assert.equal(viewFromHash('#/not-a-workspace'), null);
  assert.equal(viewFromHash(''), null);
  assert.equal(viewFromHash('#/'), null);
  // The deep link the sidebar writes has to be the one it reads back, or a
  // reload lands on the default view while the URL still claims otherwise.
  for (const view of ALL_VIEWS) {
    assert.equal(viewFromHash(hashForView(view)), view, `${view} does not survive its own deep link`);
  }
  assert.deepEqual(ALL_VIEWS.map((view) => hashForView(view)).sort(),
    ['#/analytics', '#/bookmakers', '#/dashboard', '#/opportunities', '#/plans', '#/scanner', '#/settings']);
});

test('only the Opportunities workstation is a terminal view that owns the execution slip', () => {
  // Named exhaustively, so adding a workspace has to be classified here rather
  // than silently inheriting whichever branch it falls into. Scanner now owns
  // its dedicated scrape, verification and automation control center instead of
  // duplicating the virtualized opportunity feed.
  assert.deepEqual([...TERMINAL_VIEWS], ['Opportunities']);
  const terminal = ALL_VIEWS.filter((view) => isTerminalView(view));
  assert.deepEqual(terminal, ['Opportunities'],
    'the virtualized feed and execution slip belong exclusively to Opportunities');
  assert.equal(terminal.length, 1);
  assert.deepEqual(ALL_VIEWS.filter((view) => !isTerminalView(view)),
    ['Dashboard', 'Scanner', 'Bookmakers', 'Analytics', 'Plans', 'Settings']);
});

test('the sidebar offers every distinct workspace in navigation order', () => {
  // Every entry in NAV_VIEWS now renders a distinct workspace rather than a
  // duplicate door onto Opportunities.
  assert.deepEqual([...NAV_VIEWS], ['Dashboard', 'Opportunities', 'Scanner', 'Bookmakers', 'Analytics', 'Plans', 'Settings']);
  for (const view of NAV_VIEWS) assert.ok(ALL_VIEWS.includes(view), `${view} is not a workspace`);
  assert.equal(new Set(NAV_VIEWS).size, ALL_VIEWS.length, 'every workspace is reachable once in navigation');
});

test('the slip opens on arrival when nothing is selected', () => {
  // The behaviour auto-selection exists for: the panel is not empty on arrival.
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: false, selectedId: null, selectedStillPresent: false, firstCandidateId: 'a' }), 'a');
});

test('a dismissed slip stays dismissed while the feed is unchanged', () => {
  // The defect: with `selected` in the effect's dependency list, closing the
  // slip set it to null and the very next run of the same effect put the row
  // straight back, so the X button looked dead. Dismissal has to outrank
  // auto-selection, not race it.
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: true, selectedId: null, selectedStillPresent: false, firstCandidateId: 'a' }), null);
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: true, selectedId: null, selectedStillPresent: false, firstCandidateId: 'a' }),
    null, 'a changed feed must not resurrect a slip the trader closed');
  // And dismissal is not a clear: a row that is open when the X is pressed is
  // the one being closed, so there is nothing to re-open either way.
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: true, selectedId: 'a', selectedStillPresent: true, firstCandidateId: 'b' }), 'a');
});

test('the slip never survives leaving the terminal', () => {
  // A slip is a terminal instrument. On non-terminal workspaces there is no
  // virtualized feed to select from.
  for (const view of ['Dashboard', 'Scanner', 'Bookmakers', 'Analytics', 'Plans', 'Settings']) {
    assert.equal(desiredSelection({ view, dismissed: false, selectedId: 'a', selectedStillPresent: true, firstCandidateId: 'b' }), null,
      `${view} kept a selection although it does not render the feed`);
    assert.equal(desiredSelection({ view, dismissed: false, selectedId: null, selectedStillPresent: false, firstCandidateId: 'a' }), null,
      `${view} auto-selected from a feed it does not render`);
  }
});

test('a selection the feed no longer contains falls back to the first card', () => {
  // The row expired, was filtered away, or was re-priced off the board. A slip
  // describing an opportunity that no longer exists is worse than no slip.
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: false, selectedId: 'gone', selectedStillPresent: false, firstCandidateId: 'a' }), 'a');
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: false, selectedId: 'gone', selectedStillPresent: false, firstCandidateId: null }), null);
  // The control: a row that is still there is not stolen away from the trader
  // just because it is no longer first in the ranking. A version that answered
  // `firstCandidateId` unconditionally would pass the two above and fail here.
  assert.equal(desiredSelection({ view: 'Opportunities', dismissed: false, selectedId: 'a', selectedStillPresent: true, firstCandidateId: 'b' }), 'a');
});

test('the gate and the gate it duplicates cannot drift apart', () => {
  // `desiredSelection` re-checks the view rather than taking a boolean, so the
  // terminal question has one answer. This asserts that on all six workspaces,
  // which is what makes it safe for the render gates to ask `isTerminalView`
  // while the slip asks `desiredSelection` — the two cannot disagree about a
  // workspace someone adds later without this failing first.
  for (const view of ALL_VIEWS) {
    const selected = desiredSelection({ view, dismissed: false, selectedId: null, selectedStillPresent: false, firstCandidateId: 'a' });
    assert.equal(selected !== null, isTerminalView(view), `${view}: the slip and the feed disagree about whether this is the terminal`);
  }
});

test('the controls: a fresh feed still reads in seconds and minutes', () => {
  // The units below an hour are the ones that were already right, and the fix
  // above them must not have moved the boundary.
  assert.equal(formatAge(0, roDay), '0s');
  assert.equal(formatAge(5, roDay), '5s');
  assert.equal(formatAge(59, roDay), '59s');
  assert.equal(formatAge(60, roDay), '1m');
  assert.equal(formatAge(3599, roDay), '59m');
  assert.equal(formatAge(3600, roDay), '1h');
  assert.equal(formatAge(86399, roDay), '23h');
  // Reading exactly one hour as `60m` or exactly one day as `24h` would be the
  // same defect one unit down: the reader has to divide to know it is a day.
  assert.notEqual(formatAge(3600, roDay), '60m');
  assert.notEqual(formatAge(86400, roDay), '24h');
});

test('a scan that stopped days ago cannot read as minutes', () => {
  // The defect this module was extracted for. 3,902 minutes is two days and
  // seventeen hours, and the sidebar printed `3902m` — a number that sits
  // beside `65m` with nothing but digits between them, so a feed that had been
  // dead since Tuesday read as an hour old.
  const minutes = 3902;
  assert.equal(formatAge(minutes * 60, roDay), '2z 17h');
  assert.equal(formatAge(minutes * 60, enDay), '2d 17h');
  assert.ok(!formatAge(minutes * 60, roDay).endsWith('m'), 'a multi-day age is still being reported in minutes');
  // And the hour it holds has to be an hour: the composed value is the unit
  // letter's, so a dictionary that left the day blank would fail here.
  assert.match(formatAge(minutes * 60, roDay), /^\d+z \d+h$/);
  assert.match(formatAge(minutes * 60, enDay), /^\d+d \d+h$/);
});

test('whole days do not print a zero hour', () => {
  // `2z 0h` looks like a measurement someone took. The day alone is the claim.
  assert.equal(formatAge(86400, roDay), '1z');
  assert.equal(formatAge(2 * 86400, roDay), '2z');
  assert.equal(formatAge(2 * 86400, enDay), '2d');
  assert.equal(formatAge(2 * 86400 + 3600, roDay), '2z 1h');
  // A high day count stays grouped the way the caller formats it, and stays
  // readable: a feed three weeks stale is still stated in days.
  assert.equal(formatAge(21 * 86400 + 6 * 3600, roDay), '21z 6h');
});

test('a clock that jumped backwards does not claim freshness', () => {
  // `-3s` reads as a guarantee. An unreadable age is worse than a wrong one,
  // and a wrong one is worse than none — so the floor is `0s`.
  assert.equal(formatAge(-1, roDay), '0s');
  assert.equal(formatAge(-100000, roDay), '0s');
  assert.equal(formatAge(Number.NaN, roDay), '0s');
  assert.equal(formatAge(Number.POSITIVE_INFINITY, roDay), '0s');
  // Fractional seconds floor rather than round: the age may never be stated as
  // younger than it is.
  assert.equal(formatAge(59.9, roDay), '59s');
  assert.equal(formatAge(119.9, roDay), '1m');
});

function fixtureOpp(overrides = {}) {
  return {
    id: overrides.id ?? 'arb:1',
    type: 'surebet',
    sport: 'football',
    league: 'Premier League',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    startTime: '2026-10-26T19:00:00.000Z',
    isLive: false,
    profitPercent: 3.5,
    createdAt: 0,
    lastUpdatedAt: 0,
    legs: [
      {
        bookmakerId: 'betano',
        bookmakerName: 'Betano',
        selection: 'Over 2.5',
        rawOdds: 2.1,
        effectiveOdds: 2.1,
        marketKey: 'TOTAL_GOALS',
        marketName: 'Total Goals 2.5',
      },
      {
        bookmakerId: 'superbet',
        bookmakerName: 'Superbet',
        selection: 'Under 2.5',
        rawOdds: 2.02,
        effectiveOdds: 2.02,
        marketKey: 'TOTAL_GOALS',
        marketName: 'Total Goals 2.5',
      },
    ],
    ruleSafety: { severity: 'safe', isCompatible: true },
    ttlSeconds: 600,
    sourceCount: 2,
    marketName: 'Total Goals 2.5 · FT',
    scannedAt: 0,
    evConsensusSuspect: false,
    ...overrides,
  };
}

test('filter presets configure distinct, safe-by-default signal views', () => {
  assert.deepEqual(criteriaForPreset('safe_surebets'), {
    type: 'surebet',
    safety: 'safe_only',
    timing: 'all',
    minProfit: 0,
    sortBy: 'recommended',
  });
  assert.equal(criteriaForPreset('middles').type, 'middle');
  assert.equal(criteriaForPreset('verified_ev').type, 'positive_ev');
  assert.equal(criteriaForPreset('verified_ev').safety, 'hide_blocked');
  assert.equal(criteriaForPreset('live_now').timing, 'live');
  assert.deepEqual(criteriaForPreset('all'), DEFAULT_FILTER_CRITERIA);
});

test('filterOpportunities filters by type, sport, bookmaker, safety, timing, minProfit, and search query', () => {
  const rows = [
    fixtureOpp({ id: 'safe-arb', type: 'surebet', sport: 'football', profitPercent: 3.8 }),
    fixtureOpp({
      id: 'blocked-arb',
      type: 'surebet',
      sport: 'football',
      profitPercent: 18.0,
      ruleSafety: { severity: 'blocked', isCompatible: false, ruleMismatchReason: 'not established' },
    }),
    fixtureOpp({
      id: 'tennis-mid',
      type: 'middle',
      sport: 'tennis',
      homeTeam: 'Alcaraz',
      awayTeam: 'Sinner',
      isLive: true,
      profitPercent: 64.0,
      startTime: '2026-10-26T14:00:00.000Z',
      ruleSafety: { severity: 'unverified', isCompatible: false },
      legs: [
        {
          bookmakerId: 'favbet',
          bookmakerName: 'Favbet',
          selection: 'Over 21.5',
          rawOdds: 1.95,
          effectiveOdds: 1.95,
          marketKey: 'TOTAL_GAMES',
          marketName: 'Total Games 21.5',
        },
        {
          bookmakerId: 'betano',
          bookmakerName: 'Betano',
          selection: 'Under 22.5',
          rawOdds: 1.95,
          effectiveOdds: 1.95,
          marketKey: 'TOTAL_GAMES',
          marketName: 'Total Games 22.5',
        },
      ],
    }),
    fixtureOpp({
      id: 'suspect-ev',
      type: 'positive_ev',
      sport: 'basketball',
      profitPercent: 150.0,
      ruleSafety: { severity: 'unverified', isCompatible: false },
      evConsensusSuspect: true,
    }),
  ];

  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, safety: 'safe_only' }).map((r) => r.id),
    ['safe-arb'],
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, safety: 'hide_blocked' }).map((r) => r.id),
    ['safe-arb', 'tennis-mid'],
    'hide_blocked drops both rejected contracts and unreconciled +EV outliers',
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, sport: 'tennis' }).map((r) => r.id),
    ['tennis-mid'],
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, bookmaker: 'favbet' }).map((r) => r.id),
    ['tennis-mid'],
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, timing: 'live' }).map((r) => r.id),
    ['tennis-mid'],
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, minProfit: 50, safety: 'hide_blocked' }).map((r) => r.id),
    ['tennis-mid'],
  );
  assert.deepEqual(
    filterOpportunities(rows, { ...DEFAULT_FILTER_CRITERIA, query: 'alcaraz' }).map((r) => r.id),
    ['tennis-mid'],
  );

  // Recommended preserves incoming certainty order; edge_desc and kickoff_asc sort explicitly.
  const actionable = rows.slice(0, 3).filter((r) => r.id !== 'blocked-arb');
  assert.deepEqual(
    filterOpportunities(actionable, { ...DEFAULT_FILTER_CRITERIA, sortBy: 'recommended' }).map((r) => r.id),
    ['safe-arb', 'tennis-mid'],
  );
  assert.deepEqual(
    filterOpportunities(actionable, { ...DEFAULT_FILTER_CRITERIA, sortBy: 'edge_desc' }).map((r) => r.id),
    ['tennis-mid', 'safe-arb'],
  );
  assert.deepEqual(
    filterOpportunities(actionable, { ...DEFAULT_FILTER_CRITERIA, sortBy: 'kickoff_asc' }).map((r) => r.id),
    ['tennis-mid', 'safe-arb'],
  );
});

test('the shell document declares the icon, so no page asks for a missing /favicon.ico', () => {
  // Every console page under public/admin links /favicon.svg. The React shell
  // was the one document that did not, and the first rendered look at it showed
  // the cost: the browser fell back to /favicon.ico, which this server does not
  // serve, so the page paid a 404 and the tab showed a blank icon.
  //
  // Read from the source of truth, not from `public/app/index.html`: that file is
  // `vite build` output, and a check against it would keep passing on a stale
  // build long after the line had left the document it is built from.
  const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link\s+rel="icon"[^>]*href="\/favicon\.svg"/,
    'the shell document declares no icon, so the browser will ask for /favicon.ico');
  // The icon it names has to be the file the static handler actually serves, or
  // the line is a link to a 404 that reads like a fix.
  assert.ok(existsSync(new URL('../public/favicon.svg', import.meta.url)),
    'the icon the shell links is not in public/, so nothing would serve it');
  // The two declarations that were already right, pinned so a rewrite of this
  // document cannot quietly drop them alongside the icon.
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="theme-color" content="#0b0e14"/);
});
