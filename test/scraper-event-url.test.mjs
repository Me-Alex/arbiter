// What a scraper's events actually carry as `sourceUrl`, and whether that value
// is something a bettor can be sent to. See the event-link feature in
// public/js/pages/event-detail-modal.js.
//
// This file used to assert a contract it could not see. It claimed every scraper
// emits "a per-event browseable sourceUrl", then checked two things. The first
// looked for the text `sourceUrl:` inside the function body — the key's
// presence standing in for its value. The second checked that any hardcoded
// `https://` literal inside that body is browseable, and it had nothing to check:
// across every `sourceUrl` assignment in every `extractEvents` in the tree, not
// one takes the value from an http literal. They all take it from a variable —
// `this.sourceUrl`, `this.baseUrl`, `directUrl` — which is the endpoint the
// capture was pulled from. A census over zero entries reports zero and calls it
// a finding.
//
// So the second check was vacuous and the first measured the key rather than its
// value, and the set the file excused on the way past was itself wrong: it
// excluded two books as "WebSocket-only", while their stored events carry real
// per-event pages. What is left here is a measurement over the captures, through
// the same gate the frontend calls. The gate is imported from
// src/shared/event-url.mjs rather than copied: a denylist transcribed into a test
// is a denylist that drifts from the file that decides.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEventUrl } from '../src/shared/event-url.mjs';

const ROOT = join(import.meta.dirname, '..');
const CAPTURE_DIR = join(ROOT, 'data-market-run/workspace');

/** What the stored captures say, per book. */
function censusCaptures() {
  const files = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('_events.json'));
  const books = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(CAPTURE_DIR, file), 'utf8'));
    const events = doc.events || [];
    const urls = new Set(
      events.map((e) => (typeof e.sourceUrl === 'string' && e.sourceUrl.trim() ? e.sourceUrl : null)),
    );
    books.push({
      id: doc.sourceId || file.replace('_events.json', ''),
      events: events.length,
      withUrl: events.filter((e) => typeof e.sourceUrl === 'string' && e.sourceUrl.trim()).length,
      urls,
    });
  }
  return books;
}

describe('what the stored captures carry as sourceUrl', () => {
  const books = censusCaptures();
  const floor = `measured over ${books.length} stored captures —`;

  it('the census read the captures rather than reporting an empty set', () => {
    // A count over a missing or renamed directory is 0, and 0 is the value that
    // makes every claim below true. The pass has to have read something first.
    assert.ok(books.length >= 20, `${floor} only ${books.length} captures were read`);
    const events = books.reduce((a, b) => a + b.events, 0);
    assert.ok(events > 1000, `${floor} the captures hold ${events} events in total`);
  });

  it('a book publishes a URL on all of its events or on none of them', () => {
    // This is the property the old file could not check, and it is what makes
    // "per event" mean anything: a URL on some rows of a book would be a
    // per-event URL, and every count here would need re-deriving.
    const partial = books.filter((b) => b.events > 0 && b.withUrl !== 0 && b.withUrl !== b.events);
    assert.deepEqual(
      partial.map((b) => `${b.id} ${b.withUrl}/${b.events}`), [],
      `${floor} these books put a URL on some events and not others — the URL is no longer a property of the book`,
    );
  });

  it('the books whose URL is a browseable page are named, and the rest are feed endpoints', () => {
    const urlOf = (b) => [...b.urls].find(Boolean);
    const pages = books.filter((b) => b.withUrl > 0 && isEventUrl(urlOf(b)));
    const feeds = books.filter((b) => b.withUrl > 0 && !isEventUrl(urlOf(b)));
    // Both sides non-empty on purpose: "everything passes" and "nothing passes"
    // are the two readings under which this assertion would say nothing at all.
    assert.ok(pages.length > 0,
      `${floor} no book publishes a browseable event page, so the gate rejects everything and the distinction is untested`);
    assert.ok(feeds.length > 0,
      `${floor} every book's URL passes the gate, so the denylist no longer matches the endpoints the adapters publish`);
    assert.deepEqual(
      feeds.map((b) => b.id).sort(),
      ['admiral', 'betano', 'casa-pariurilor', 'excelbet', 'favbet', 'fortuna', 'las-vegas',
        'magnumbet', 'maxbet', 'netbet', 'stanleybet', 'superbet', 'winboss', 'winner'],
      `${floor} the set of books pointing at a feed endpoint changed — every excuse and every frontend path that assumed the old set needs re-reading`,
    );
  });

  it('the renderer offers a leg link only where the gate passes', () => {
    // The measurement above only matters if the frontend obeys it. Both render
    // paths of a leg are checked for the CONDITIONAL, not for the name: a bare
    // /eventUrl/ also matches the attribute, a comment, or a line that no longer
    // decides anything — which is how this passed while rendering a link to JSON.
    const modal = readFileSync(join(ROOT, 'public/js/pages/event-detail-modal.js'), 'utf8');
    const bodyOf = (name) => {
      const from = modal.indexOf(`function ${name}`);
      assert.notEqual(from, -1, `event-detail-modal.js no longer declares ${name}`);
      return modal.slice(from, modal.indexOf('function ', from + 1));
    };
    assert.match(
      bodyOf('renderLeg'),
      /isEventUrl\(\s*l\.eventUrl\s*\)/,
      'event-detail-modal.js no longer gates the card leg link on isEventUrl, so a leg on a feed-endpoint book opens JSON again',
    );
    assert.match(
      bodyOf('buildFallbackFromLegs'),
      /isEventUrl\(\s*leg\.eventUrl\s*\)/,
      'event-detail-modal.js no longer gates the snapshot leg link on isEventUrl, so the card and the dialog disagree about when a link exists',
    );
  });
});