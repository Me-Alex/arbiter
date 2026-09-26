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
  vm.runInContext(source.slice(source.indexOf('function renderOppGroup('), source.indexOf('// Badge age thresholds')), context);
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
      assert.equal(node('event-heading').textContent, '<img> vs B');
    }
    if (mode === 'empty') assert.equal(node('event-status').textContent, 'noOddsFound');
    if (mode === 'error') { assert.equal(node('event-retry').hidden, false); assert.match(node('event-status').textContent, /Could not load/); }
    if (mode === 'invalid') { assert.equal(calls, 0); assert.match(node('event-status').textContent, /incomplete/); }
  }
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
