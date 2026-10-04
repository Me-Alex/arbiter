// The endpoint registry is only worth having if something checks it. These
// tests pin the reconciliation between the recorded captures, the scraper
// config, and the hand-declared feed groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadEndpointRegistry,
  platformOf,
  booksOnPlatform,
  ungroupedPlatformPeers,
  unscrapedBooks,
  feedStatusConflicts,
} from './helpers/endpoints.mjs';
import { FEED_GROUPS } from '../src/scanner/feed-groups.mjs';

const cfg = JSON.parse(readFileSync(join('config', 'scrapers.json'), 'utf8'));
const jobs = cfg.jobs || cfg;

test('registry loads and has one record per book', () => {
  const reg = loadEndpointRegistry();
  assert.ok(reg, 'data/endpoints/endpoints.json must exist');
  assert.equal(reg.schemaVersion, 1);
  assert.ok(Object.keys(reg.books).length > 20, 'registry should cover the known books');
  for (const [book, rec] of Object.entries(reg.books)) {
    assert.equal(rec.book, book, `record key must match its book name (${book})`);
  }
});

test('every scraper job is represented in the registry', () => {
  const reg = loadEndpointRegistry();
  const missing = jobs.map((j) => j.id).filter((id) => !reg.books[id]);
  assert.deepEqual(missing, [], 'no configured job may be absent from the registry');
});

test('every enabled job carries the platform the registry recorded', () => {
  const reg = loadEndpointRegistry();
  for (const job of jobs) {
    if (!job.enabled) continue;
    const rec = reg.books[job.id];
    assert.ok(rec.platform, `${job.id} has no recorded platform`);
    assert.equal(job.platform, rec.platform, `${job.id} config platform drifted from the registry`);
  }
});

test('the registry corroborates the declared feed groups', () => {
  // Two directions, because there are two ways a group stops being corroborated.
  //
  // The second one was missing, and the check could not fail without it. The set
  // of platforms was built with `.filter(Boolean)`, so a member the registry has
  // stopped describing contributed nothing: drop one and the group still sits on
  // a single platform, and the assertion still held. Removing every member of
  // every group left an empty evidence set that also passed. What the comment
  // here used to promise — "if a book migrates provider, the group silently
  // stops being true and this fails" — held for the migration and not for the
  // disappearance, and a check that names a failure it cannot see is worse than
  // no check, because the next reader stops looking.
  const unrecorded = [];
  const split = [];
  for (const group of FEED_GROUPS) {
    const seen = group.members.map((m) => ({ member: m, platform: platformOf(m) }));
    for (const { member, platform } of seen) {
      if (!platform) unrecorded.push(`${group.id}/${member}`);
    }
    const platforms = new Set(seen.map((s) => s.platform).filter(Boolean));
    if (platforms.size > 1) split.push(`${group.id} spans ${[...platforms].join(', ')}`);
  }
  assert.deepEqual(unrecorded, [],
    'these declared group members are not described by the registry at all, so the group is corroborated by nothing');
  assert.deepEqual(split, [],
    'a declared group no longer sits on a single recorded platform, which is what makes it one feed');
});

test('maxbet stays outside the nsoft group for the measured reason', () => {
  // maxbet is on the same NSoft platform as admiral/stanleybet but under a
  // different company UUID, and its prices genuinely differ. The registry now
  // proves the platform is shared; the group must still exclude it, or the
  // measured opportunity disappears.
  const platforms = new Set(['admiral', 'stanleybet', 'maxbet'].map(platformOf));
  assert.equal(platforms.size, 1, 'all three are on the nsoft platform');
  const nsoft = FEED_GROUPS.find((g) => g.id === 'nsoft-company');
  assert.ok(nsoft.members.includes('admiral') && nsoft.members.includes('stanleybet'));
  assert.ok(!nsoft.members.includes('maxbet'), 'maxbet must not be grouped');
});

test('ungroupedPlatformPeers surfaces maxbet as a candidate, not a verdict', () => {
  const nsoft = FEED_GROUPS.find((g) => g.id === 'nsoft-company');
  const peers = ungroupedPlatformPeers(nsoft.members);
  const hit = peers.find((p) => p.platform === 'nsoft');
  assert.ok(hit, 'nsoft should have partially-grouped members');
  assert.ok(hit.ungrouped.includes('maxbet'));
});

test('unscrapedBooks tells the rows that have evidence from the rows that do not', () => {
  const un = unscrapedBooks();
  const byBook = new Map(un.map((b) => [b.book, b]));
  const names = [...byBook.keys()];
  // The two rows this test has always named are named for a reason: they are on
  // the list because a capture exists, not only a platform string. That is the
  // claim the function's own note overreached on — it described the whole list
  // as books waiting for an adapter, while `realCapture` is what earns a row
  // its place and most rows do not carry it. No total is pinned here: it moves
  // every time the crawl gains a row, and pinning one would train the reader to
  // bump it without reading what it is for.
  for (const book of ['888sport', 'mrplay']) {
    assert.ok(names.includes(book), `${book} has a digitain capture and no job`);
    assert.equal(byBook.get(book).realCapture, true,
      `${book} is named here as a book that already has evidence, and its capture no longer says so`);
  }
  assert.ok(!names.includes('favbet'), 'a scraped book must not be listed as a candidate');
  for (const job of jobs) assert.ok(!names.includes(job.id), `${job.id} is configured`);
});

test('feedStatusConflicts is clean: unibet is no longer a conflict', () => {
  // This used to assert the opposite. Unibet was the single conflict in the
  // registry — config said `validated`, the archive said `browser-only` — and
  // that conflict was the honest record of a job that pointed at a dead Kambi
  // endpoint while claiming to be validated. Its feed was recovered on
  // 2026-09-28 (Kindred sports BFF, see src/scrapers/unibet.mjs), the archive
  // now says `verified`, and a test still asserting the conflict would keep
  // the reconciliation check permanently red for a resolved problem.
  const conflicts = feedStatusConflicts(jobs);
  assert.deepEqual(conflicts, [], 'no book may disagree with the archive any more');

  // The check itself must still be able to fire, or an empty list proves
  // nothing. Unibet's old state is exactly the pair it is meant to catch, so
  // feed it back through a synthetic registry.
  const unibet = jobs.find((j) => j.id === 'unibet');
  assert.equal(unibet.validationStatus, 'validated');
  const flagged = feedStatusConflicts([unibet], {
    books: { unibet: { book: 'unibet', feedStatus: 'browser-only' } },
  });
  assert.deepEqual(flagged, [
    { book: 'unibet', registry: 'browser-only', config: 'validated', enabled: true },
  ]);

  // The opposite direction is deliberately not a conflict: a `verified` feed
  // with an `experimental` scraper is two separate claims, not a contradiction.
  assert.deepEqual(
    feedStatusConflicts([{ id: 'unibet', validationStatus: 'experimental' }], {
      books: { unibet: { book: 'unibet', feedStatus: 'verified' } },
    }),
    [],
    'reachability and scraper trust are separate axes',
  );
});

test('booksOnPlatform returns a sorted member list', () => {
  const exa = booksOnPlatform('exalogic-xsport');
  assert.deepEqual(exa, ['excelbet', 'las-vegas', 'magnumbet', 'winboss']);
});
