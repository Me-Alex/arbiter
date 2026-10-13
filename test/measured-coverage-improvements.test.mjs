import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import { SchedulerService } from '../src/scheduler-service.mjs';
import { groupByEvent } from '../src/scanner/engine.mjs';
import { normalizeClubIdentity } from '../src/shared/text.mjs';
import { leaguesMatch } from '../src/scanner/league-aliases.mjs';
import { indexEventsByContract, buildCoverageRows } from '../scripts/market-coverage.mjs';

const { jobs } = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url)));
const capture = (workspace, book, home) => JSON.parse(readFileSync(
  new URL(`../${workspace}/${book}_events.json`, import.meta.url),
)).events.find((event) => event.homeTeam === home);

test('captured midnight neighbours pair in both the engine and coverage report', () => {
  const a = capture('data-market-run/workspace', 'baumbet', 'Union Omaha SC');
  const b = capture('data-market-run/workspace', 'excelbet', 'Union Omaha SC');
  assert.equal(Math.abs(Date.parse(a.kickoff) - Date.parse(b.kickoff)), 3 * 3600000);
  assert.equal(groupByEvent([a, b]).size, 1);
  const rows = buildCoverageRows(new Map([
    ['baumbet', indexEventsByContract([a])], ['excelbet', indexEventsByContract([b])],
  ]));
  assert.ok(rows.some((row) => row.overlapping === 1));
  // Adversarial controls derived from these captured fixtures, not new offers.
  for (const changed of [
    { ...b, league: 'Different competition' },
    { ...b, league: 'Unknown' },
    { ...b, homeTeam: b.awayTeam, awayTeam: b.homeTeam },
    { ...b, kickoff: new Date(Date.parse(a.kickoff) + 3 * 3600000 + 1).toISOString() },
  ]) assert.equal(groupByEvent([a, changed]).size, 2);
});

test('same-day rematches and ambiguous neighbours cannot merge through a tolerance chain', () => {
  const a = capture('data-market-run/workspace', 'baumbet', 'Union Omaha SC');
  const b = capture('data-market-run/workspace', 'excelbet', 'Union Omaha SC');
  const rematch = { ...a, id: `${a.id}-rematch`, providerEventId: 'rematch',
    eventKey: `${a.eventKey}-rematch`, kickoff: new Date(Date.parse(a.kickoff) + 3600000).toISOString() };
  for (const events of [[a, b, rematch], [rematch, b, a], [b, a, rematch]]) {
    assert.equal(groupByEvent(events).size, 3);
  }
  const later = { ...b, sourceId: 'netbet', kickoff: new Date(Date.parse(a.kickoff) + 3 * 3600000).toISOString() };
  assert.equal(groupByEvent([b, a, later]).size, 2, 'a six-hour chain exceeds the three-hour window');
});

test('captured Inter San Carlos rows 43 hours apart remain separate', () => {
  // Measured live 2026-10-08 and stored verbatim, because data/workspace is a
  // rotating buffer: the fixture is quoted at two kickoffs 43 hours apart (the
  // winner/bet7 edition at 02:00Z, the unibet/maxbet edition at 21:00Z the next
  // day) and a scrape that rotates one book's window drops the pair, which is
  // exactly how this test broke when read from the live workspace.
  const { books } = JSON.parse(readFileSync(
    new URL('./fixtures/inter-san-carlos-captures.json', import.meta.url)));
  const a = books.winner;
  const b = books.unibet;
  assert.equal(Math.abs(Date.parse(a.kickoff) - Date.parse(b.kickoff)), 43 * 3600000);
  assert.equal(normalizeClubIdentity(a.awayTeam), normalizeClubIdentity(b.awayTeam),
    'the same opponent is spelled with and without diacritics');
  assert.equal(groupByEvent([a, b]).size, 2);
});

test('Romanian sponsor aliases agree without merging divisions or CS Dinamo', () => {
  for (const league of ['Casa Liga 1', 'Superliga', 'Liga 1 Betano']) {
    assert.equal(leaguesMatch(league, 'Liga I'), true, league);
    assert.equal(leaguesMatch(league, 'Liga II'), false, league);
  }
  assert.equal(normalizeClubIdentity('Dinamo B.'), normalizeClubIdentity('ACS FC Dinamo Bucuresti'));
  assert.notEqual(normalizeClubIdentity('CS Dinamo Bucuresti'), normalizeClubIdentity('FC Dinamo Bucuresti'));
});

test('configured capture-backed caps reach adapters and explicit caller limits win', () => {
  for (const job of jobs.filter((j) => j.enabled && j.maxEvents)) {
    assert.equal(instantiate(job.id, { jobConfig: job }).maxEvents, job.maxEvents === 'all' ? Infinity : job.maxEvents, job.id);
    assert.equal(instantiate(job.id, { jobConfig: job, maxEvents: 12 }).maxEvents, 12, job.id);
  }
});

test('new schedules default to five minutes and retain environment overrides', () => {
  const previous = process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES;
  try {
    delete process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES;
    assert.equal(new SchedulerService({}).intervalMinutes, 5);
    process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES = '11';
    assert.equal(new SchedulerService({}).intervalMinutes, 11);
  } finally {
    if (previous === undefined) delete process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES;
    else process.env.ARBITER_SCHEDULER_INTERVAL_MINUTES = previous;
  }
});
