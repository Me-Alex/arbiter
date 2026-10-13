import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveContract, canonicalOutcomeFor, bucketKeyForContract, isMatchResultMarket } from '../src/scanner/market-contracts.mjs';
import { buildSelectionIndex, groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';
import { indexEventsByContract, buildCoverageRows } from '../scripts/market-coverage.mjs';
import { snapshotQuality } from '../src/shared/data-quality.mjs';
import { canonicalSport, eventIdentityKey, normalizeClubIdentity } from '../src/shared/text.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';
import { leaguesMatch } from '../src/scanner/league-aliases.mjs';

// Verbatim market/event fields, including prices and ids, from the named captures.
const captures = JSON.parse(readFileSync(new URL('./fixtures/market-coverage-captures.json', import.meta.url)));
const market = (i) => JSON.parse(JSON.stringify(captures[i].event.markets[0]));
const reaudit = JSON.parse(readFileSync(new URL('./fixtures/market-reaudit-captures.json', import.meta.url)));

test('reaudit witnesses retain verbatim captured event fields and selections', (t) => {
  const snapshots = new Map();
  const witnesses = [];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.workspace && value.book && value.event) witnesses.push(value);
    else for (const child of Object.values(value)) collect(child);
  }
  collect(reaudit);
  assert.ok(witnesses.length > 0, 'no reaudit witnesses were enumerated');
  let compared = 0;
  const refreshedFiles = new Set();
  for (const { workspace, book, event } of witnesses) {
    const file = `${workspace}/${book}_events.json`;
    if (!snapshots.has(file)) {
      const directory = new URL(`../${workspace}/`, import.meta.url);
      assert.ok(readdirSync(directory).includes(`${book}_events.json`), `${file}: capture missing`);
      snapshots.set(file, JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url))).events);
    }
    const events = snapshots.get(file);
    assert.ok(events.length > 0, `${file}: no events to census`);
    // A refreshed workspace can retire an event. Its current schema must still
    // carry the witness fields, at every level, even when its prices change.
    for (const [level, actual, expected] of [
      ['event', events, [event]],
      ['market', events.flatMap((e) => e.markets || []), event.markets],
      ['selection', events.flatMap((e) => (e.markets || []).flatMap((m) => m.selections || [])),
        event.markets.flatMap((m) => m.selections || [])],
    ]) {
      assert.ok(actual.length > 0 && expected.length > 0, `${file}: empty ${level} census`);
      const keys = new Set(actual.flatMap(Object.keys));
      for (const key of new Set(expected.flatMap(Object.keys))) {
        assert.ok(keys.has(key), `${file}: ${level}.${key} is absent from every current row`);
      }
    }
    // Live files are replaced by subsequent scrapes, including prices for the
    // same event id. They support a schema census, not historical provenance.
    // The frozen archive below still has to retain exact fields and selections.
    if (workspace === 'data/workspace') {
      refreshedFiles.add(file);
      continue;
    }
    const { markets, ...fields } = event;
    const source = events.find((e) => e.id === event.id);
    assert.ok(source, `${file}: ${event.id} missing from the archived capture`);
    const { markets: originalMarkets, ...originalFields } = source;
    assert.deepEqual(fields, originalFields);
    for (const m of markets) assert.ok(originalMarkets.some((original) =>
      JSON.stringify(original) === JSON.stringify(m)), `${file}: ${m.key}`);
    compared++;
  }
  assert.ok(compared > 0, 'no witness could be compared verbatim with a captured event');
  if (refreshedFiles.size) t.diagnostic(`${refreshedFiles.size} refreshed workspace files checked for field coverage; historical values checked against the frozen archive only`);
});

test('unsupported capture shapes stay refused without a complete comparable settlement', () => {
  for (const { event } of reaudit.unsupported) {
    assert.equal(resolveContract(event.markets[0]), null);
    assert.equal(indexEventsByContract([event]).size, 0);
  }
});

test('missing youth/gender identity and distinct clubs are not spelling aliases', () => {
  for (const { label, captures: pair } of reaudit.ambiguousIdentities) {
    assert.equal(pair[0].event.kickoff, pair[1].event.kickoff, label);
    assert.notEqual(eventIdentityKey(pair[0].event), eventIdentityKey(pair[1].event), label);
    assert.equal(groupByEvent(pair.map((c) => c.event)).size, 2, label);
  }
  assert.notEqual(normalizeClubIdentity('CS Dinamo București'), normalizeClubIdentity('Dinamo Bucureşti'));
  assert.notEqual(normalizeClubIdentity('Rosenborg BK'), normalizeClubIdentity('Rosenborg U19'));
  assert.equal(leaguesMatch('Romania 1', 'Liga II 2026/2027'), false);
  assert.equal(leaguesMatch('Romania 2', 'Liga I 2026/2027'), false);
});

test('every captured total retains subject, team and settlement period', () => {
  for (const workspace of ['data-market-run/workspace', 'data/workspace']) {
    const directory = new URL(`../${workspace}/`, import.meta.url);
    let count = 0;
    for (const file of readdirSync(directory).filter((f) => f.endsWith('_events.json'))) {
      for (const event of JSON.parse(readFileSync(new URL(file, directory))).events) {
        for (const m of event.markets) {
          const c = resolveContract(m);
          if (c?.family !== 'OVER_UNDER') continue;
          assert.ok(c.subject, `${file}: ${m.key} subject`);
          assert.ok(['match', 'home', 'away'].includes(c.team), `${file}: ${m.key} team`);
          assert.ok(c.period, `${file}: ${m.key} period`);
          if (canonicalSport(event.sport) === 'football') {
            assert.ok(['fulltime', 'half1', 'half2'].includes(c.period), `${file}: ${m.key} football period`);
          }
          assert.equal(Number(c.lineKey) % 1, 0.5, 'push-capable totals stay excluded');
          count++;
        }
      }
    }
    assert.ok(count > 0);
  }
});

test('captured club spellings meet on the same fixture across independent feeds', () => {
  for (const { label, captures: pair } of reaudit.identities) {
    const [a, b] = pair;
    assert.equal(isSharedFeed(a.book, b.book), false, label);
    assert.equal(a.event.kickoff, b.event.kickoff, label);
    assert.equal(eventIdentityKey(a.event), eventIdentityKey(b.event), label);
    assert.equal(groupByEvent(pair.map((c) => c.event)).size, 1, label);
    const rows = buildCoverageRows(new Map(pair.map((c) => [c.book, indexEventsByContract([c.event])])));
    assert.ok(rows.some((r) => r.overlapping === 1), label);
  }
});

test('captured BTTS threshold and both-halves variants cannot price plain BTTS', () => {
  for (const { event } of reaudit.bttsVariants) {
    assert.equal(resolveContract(event.markets[0]), null);
    assert.equal(indexEventsByContract([event]).size, 0);
    assert.equal(buildSelectionIndex([event]).size, 0);
  }
});

test('captured encoded totals resolve with complete sides, subject, line and period', () => {
  for (const [i, line, period] of [[0, '0.5', 'half1'], [1, '2.5', 'fulltime']]) {
    const m = market(i);
    const c = resolveContract(m);
    assert.deepEqual(c, { family: 'OVER_UNDER', period, lineKey: line,
      outcomes: ['over', 'under'], subject: 'goals', team: 'match' });
    assert.deepEqual(m.selections.map((s) => canonicalOutcomeFor(s.name, c)), ['over', 'under']);
    // It meets the existing name-encoded contract without changing captured prices.
    const inline = { ...m, key: 'TOTAL_GOALS', selections: m.selections.map((s) => ({ ...s, name: `${s.name} ${line}` })) };
    assert.equal(bucketKeyForContract('event', c), bucketKeyForContract('event', resolveContract(inline)));
    assert.equal(buildSelectionIndex([captures[i].event]).size, 2, 'verification can find the recovered legs');
    assert.equal(indexEventsByContract([captures[i].event]).size, 1);
  }
});

test('encoded total refusals cannot be reopened by the legacy result fallback', () => {
  const original = market(1);
  const variants = [
    { ...original, key: 'OVER_UNDER_2' },
    { ...original, key: 'OVER_UNDER_2_25' },
    { ...original, key: 'OVER_UNDER_2_5_extra' },
    { ...original, line: 3.5 },
    { ...original, selections: [original.selections[0]] },
    { ...original, selections: [original.selections[0], original.selections[0]] },
    { ...original, selections: original.selections.map((s) => ({ ...s, handicap: 3.5 })) },
    { ...original, selections: original.selections.map((s) => ({ ...s, name: `${s.name} 3.5` })) },
    { ...original, name: 'Total Goluri Echipă Peste/Sub' },
    { ...market(0), period: 'half2' },
  ];
  for (const m of variants) {
    assert.equal(resolveContract(m), null, JSON.stringify(m));
    assert.equal(isMatchResultMarket(m), false);
    assert.equal(indexEventsByContract([{ ...captures[1].event, markets: [m] }]).size, 0);
  }
  const half = resolveContract(market(0));
  const full = resolveContract({ ...market(0), name: 'Total goluri Peste/Sub', key: 'OVER_UNDER_0_5' });
  assert.notEqual(bucketKeyForContract('', half), bucketKeyForContract('', full));
});

test('measured FEG signed goal/point totals reach total buckets and price both sides', () => {
  for (const [i, subject, line] of [[2, 'goals', '9.5'], [3, 'points', '58.5']]) {
    const m = market(i);
    const c = resolveContract(m);
    assert.deepEqual(c, { family: 'OVER_UNDER', period: 'fulltime', lineKey: line,
      outcomes: ['over', 'under'], subject, team: 'match' });
    assert.deepEqual(m.selections.map((s) => canonicalOutcomeFor(s.name, c)).sort(), ['over', 'under']);
    assert.equal(bucketKeyForContract('', c), bucketKeyForContract('', resolveContract({
      ...m, key: 'TOTAL', selections: m.selections.map((s) => ({ ...s,
        name: `${s.name.trim().startsWith('+') ? 'Peste' : 'Sub'} ${line}` })),
    })));
    assert.equal(resolveContract({ ...m, name: 'Meci' }), null, 'the name must confirm the measured meaning');
    assert.equal(resolveContract({ ...m, selections: m.selections.map((s) => ({ ...s, name: s.name.replace(line, '2.25') })) }), null);
    assert.equal(resolveContract({ ...m, selections: [m.selections[0], m.selections[0]] }), null);
  }
});

test('recovered totals preserve shared-feed exclusion and historical freshness', () => {
  const event = captures[1].event;
  const books = new Map(['getsbet', 'contibet'].map((id) => [id, indexEventsByContract([event])]));
  const [row] = buildCoverageRows(books);
  assert.equal(row.books, 2);
  assert.equal(row.pairs, 0);
  assert.equal(row.overlapping, 0);
  assert.deepEqual(findArbitrage(groupByEvent(['getsbet', 'contibet'].map((sourceId) => ({ ...event, sourceId })))), []);
  assert.equal(snapshotQuality({ ...captures[1], events: [event] }, { now: Date.parse('2026-10-08T00:00:00Z') }).status, 'stale');
});

test('every encoded total in the frozen capture recovers without losing subject or period', () => {
  let count = 0;
  for (const book of ['betano', 'getsbet', 'contibet']) {
    const snapshot = JSON.parse(readFileSync(new URL(`../data-market-run/workspace/${book}_events.json`, import.meta.url)));
    for (const event of snapshot.events) for (const m of event.markets) {
      if (!m.key.startsWith('OVER_UNDER_')) continue;
      const c = resolveContract(m);
      assert.equal(c?.family, 'OVER_UNDER', `${book}: ${m.key}`);
      assert.equal(c.subject, 'goals');
      assert.equal(c.team, 'match');
      assert.equal(c.period, /repriz/i.test(m.name) ? 'half1' : 'fulltime');
      count++;
    }
  }
  assert.equal(count, 504);
});
