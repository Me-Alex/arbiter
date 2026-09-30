import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('public/js/pages/dashboard.js');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderer(lang = 'en') {
  const context = { URLSearchParams, escapeHtml, arbiterI18n: { lang, t: key => key }, fmtMarketKey: key => key, formatKickoff: value => value };
  vm.createContext(context);
  // Start at dashLiveBadge, not renderOppGroup: the row renderer calls it, and
  // slicing from the renderer would drop the definition and fail on a
  // ReferenceError rather than on anything about the row.
  vm.runInContext(source.slice(source.indexOf('function dashLiveBadge('), source.indexOf('// Badge age thresholds')), context);
  return context.renderOppGroup;
}
test('110 repeated findings render one compact escaped row with unique market count', () => {
  const opp = { sport: 'Football', homeTeam: '<img src=x>', awayTeam: 'A & B', kickoff: '2026-09-20T21:00:00+03:00', marketKey: 'OVER_UNDER_3_5', roiPercent: 425 };
  const html = renderer()(Array(110).fill(opp));
  assert.equal((html.match(/<tr /g) || []).length, 1);
  assert.equal((html.match(/OVER_UNDER_3_5/g) || []).length, 1);
  assert.match(html, /class="num">1<\/td>/);
  assert.match(html, /\+425\.00%/);
  assert.doesNotMatch(html, /<img|opp-market-chip|<button|aria-haspopup|target=/);
  assert.match(html, /&lt;img/);
  const href = html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const url = new URL(href, 'http://localhost');
  assert.equal(url.pathname, '/event.html');
  for (const [key, field] of [['sport', 'sport'], ['home', 'homeTeam'], ['away', 'awayTeam'], ['kickoff', 'kickoff']]) assert.equal(url.searchParams.get(key), opp[field]);
});
test('row count is unique markets; Romanian type and negative ROI remain accurate', () => {
  const html = renderer('ro')([{ marketKey: 'A', roiPercent: -2 }, { marketKey: 'B' }, { marketKey: 'A' }]);
  assert.match(html, /class="num">2<\/td>/);
  assert.match(html, /Arbitraj/);
  assert.match(html, /-2\.00%/);
});

/**
 * A row is one match with every market found on it, so the row is marked live
 * when any of them is. The control is the ordering: the best-ROI opportunity
 * sorts first and is the one the row is built from, so a `best`-only reading
 * leaves a live match unmarked whenever a cheaper pre-match market wins the sort.
 * That is the case the first assertion pins.
 */
test('a row is marked live when any opportunity in the group is in-play', () => {
  const row = renderer();
  // Control: pre-match best, in-play sibling, best ROI -> still marked.
  const mixed = row([{ marketKey: 'A', roiPercent: 5, live: false }, { marketKey: 'B', roiPercent: 1, live: true }]);
  assert.match(mixed, /class="chip red live-badge"/, 'an in-play sibling marks the row');
  assert.match(mixed, /title="liveTooltip"/);
  assert.match(mixed, />live</);
  // Control: the best opportunity itself is in-play.
  assert.match(row([{ marketKey: 'A', roiPercent: 5, live: true }]), /live-badge/);
  // Negative: nothing in-play, and the field simply absent.
  assert.doesNotMatch(row([{ marketKey: 'A', roiPercent: 5, live: false }]), /live-badge/);
  assert.doesNotMatch(row([{ marketKey: 'A', roiPercent: 5 }]), /live-badge/);
  // A kickoff in the past is stale, not running: the row is not marked from it.
  assert.doesNotMatch(row([{ marketKey: 'A', roiPercent: 5, kickoff: '2000-01-01T00:00:00.000Z' }]), /live-badge/);
});
test('row click follows link while native and modified links remain untouched', () => {
  let clicked = 0;
  const row = { querySelector: () => ({ click: () => clicked++ }) };
  const context = { window: { getSelection: () => '' } };
  vm.createContext(context);
  // Extract just the handler: from its definition to the event subscription
  // that follows it (the subscription line itself needs a real document).
  const start = source.indexOf('function handleOppListClick(');
  const end = source.indexOf("document.getElementById('opp-list')", start);
  vm.runInContext(source.slice(start, end), context);
  context.handleOppListClick({ target: { closest: selector => selector === '.opportunity-row' ? row : null } });
  assert.equal(clicked, 1);
  // A click that already landed on a link is the link's business, not ours.
  context.handleOppListClick({ target: { closest: (s) => (s === '.opportunity-row' ? row : { tagName: 'A' }) } });
  assert.equal(clicked, 1, 'a click on the link itself is not re-dispatched');
  context.handleOppListClick({ ctrlKey: true, target: { closest: selector => selector === '.opportunity-row' ? row : null } });
  assert.equal(clicked, 1, 'a modified click opens a new tab instead');
  // A text selection means the user is copying, not clicking.
  context.window.getSelection = () => 'FCSB';
  context.handleOppListClick({ target: { closest: selector => selector === '.opportunity-row' ? row : null } });
  assert.equal(clicked, 1, 'a selection is not a click');
});
test('dedicated controller handles success, empty, error and invalid context', async () => {
  for (const mode of ['success', 'empty', 'error', 'invalid']) {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren() {}, addEventListener() {} });
      return nodes.get(id);
    };
    let calls = 0;
    let rendered = null;
    const window = { location: { search: mode === 'invalid' ? '' : '?sport=Football&home=%3Cimg%3E&away=B' }, escapeHtml,
      arbiterFormat: { formatKickoff: () => '' }, EventDetailModal: { init() {}, renderEventDetail(data, opts) { rendered = { data, opts }; } } };
    const context = { window, URLSearchParams, document: { getElementById: node }, arbiterApp: { mount() {} }, arbiterI18n: { lang: 'en', t: key => key },
      arbiterApi: { async get(url) { calls++; assert.match(url, /^\/api\/event-detail\?/); if (mode === 'error') throw new Error('failed'); return { events: mode === 'success' ? [{ markets: [{ key: 'A' }] }] : [] }; } } };
    vm.runInNewContext(read('public/js/pages/event-detail.js'), context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(node('event-markets').attrs['aria-busy'], 'false');
    if (mode === 'success') {
      assert.equal(rendered.opts.target, node('event-markets'));
      // The query is the fallback, and it stays one: the fixture's event carries
      // no identity at all, so the heading is still what the URL said. The
      // payload-wins case is the test below; this is the control that the
      // fallback is not a casualty of it.
      assert.equal(node('event-heading').textContent, '<img> vs B');
      assert.equal(node('event-live').hidden, true, 'no event, no in-play badge');
    }
    if (mode === 'empty') assert.equal(node('event-status').textContent, 'noOddsFound');
    if (mode === 'error') { assert.equal(node('event-retry').hidden, false); assert.match(node('event-status').textContent, /Could not load/); }
    if (mode === 'invalid') { assert.equal(calls, 0); assert.match(node('event-status').textContent, /incomplete/); }
  }
});

test('the page names the event the route matched, not the query it was opened with', async () => {
  // The route matches on a normalized club identity, so the URL's spelling and
  // the book's need not agree — and the league and the in-play flag are not in
  // the URL at all. Reading the identity from the payload is what makes those
  // six published fields readers instead of weight on the wire.
  // Each case gets its own context. Re-pointing the stub's `get` and the
  // location does not re-run anything: the page calls `load()` once at load, and
  // the stub's `addEventListener` is a no-op, so a second payload handed to the
  // same context would never be fetched and the assertions after it would be
  // reading the first render.
  const renderPage = async (search, payload) => {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', title: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren() {}, addEventListener() {} });
      return nodes.get(id);
    };
    const window = {
      location: { search },
      escapeHtml,
      arbiterFormat: { formatKickoff: (v) => (v ? `kickoff(${v})` : '') },
      EventDetailModal: { init() {}, renderEventDetail() {} },
    };
    const context = { window, URLSearchParams, document: { getElementById: node }, arbiterApp: { mount() {} }, arbiterI18n: { lang: 'ro', t: key => key },
      arbiterApi: { async get() { return payload; } } };
    vm.runInNewContext(read('public/js/pages/event-detail.js'), context);
    await new Promise(resolve => setImmediate(resolve));
    return node;
  };

  // Two books quote the one fixture, so the route returns two events; the second
  // is the one that carries the identity. Picking the first blindly would leave
  // the header on the query, which is the failure this is here to catch.
  const node = await renderPage('?sport=Basketball&home=Steaua&away=Dinamo&kickoff=2026-09-20T21%3A00%3A00%2B03%3A00', { events: [
    { sourceId: 'alpha', markets: [] },
    { sourceId: 'beta', sport: 'Fotbal', league: 'Liga I', homeTeam: 'FCSB', awayTeam: 'Dinamo', kickoff: '2026-10-01T18:00:00.000Z', live: true, markets: [{ key: 'A' }] },
  ] });

  assert.equal(node('event-heading').textContent, 'FCSB vs Dinamo', 'the heading is the matched event, not the query');
  assert.match(node('event-meta').textContent, /Fotbal/, 'the sport comes from the event');
  assert.match(node('event-meta').textContent, /Liga I/, 'the league is shown at all — it is not in the URL');
  assert.equal(node('event-live').hidden, false, 'an in-play event is badged on the page itself');
  assert.equal(node('event-live').textContent, 'live');
  assert.equal(node('event-live').title, 'liveTooltip');

  // The page's standing property: nothing from the payload or the URL is ever
  // parsed as HTML. The event's own names go through textContent, so a book
  // that publishes a team called `<img>` cannot inject markup.
  const hostile = await renderPage('?sport=F&home=%3Cimg%20src%3Dx%3E&away=B', { events: [
    { sport: 'F', homeTeam: '<img src=x onerror=boom>', awayTeam: 'B', league: '<b>L</b>', live: false, markets: [{ key: 'A' }] },
  ] });
  assert.equal(hostile('event-heading').textContent, '<img src=x onerror=boom> vs B', 'a hostile team name stays text');
  assert.match(hostile('event-meta').textContent, /<b>L<\/b>/, 'a hostile league stays text');
  assert.equal(hostile('event-live').hidden, true, 'a pre-match event carries no badge');
});

test('page loads shared renderer and the router owns the detail handler', () => {
  const page = read('public/event.html');
  assert.match(page, /href="\/"/);
  assert.doesNotMatch(page, /<dialog/);
  const controller = read('public/js/pages/event-detail.js');
  assert.match(controller, /renderEventDetail\(data, \{ target: body \}\)/);
  assert.match(controller, /textContent = heading/);
  // The event-detail handler is defined once, in the router, and reached via
  // its route table. server.mjs no longer carries a copy of the routes.
  const router = read('src/router.mjs');
  assert.match(router, /export async function readEventDetailRoute/);
  assert.match(router, /'\/api\/event-detail'/);
  assert.doesNotMatch(read('src/server.mjs'), /readEventDetailRoute/);
});
