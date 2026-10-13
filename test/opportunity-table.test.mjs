import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { codeOnly } from './helpers/code-only.mjs';
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
const I18N = read('public/js/i18n.js');
const PAGE = read('public/js/pages/event-detail.js');
const EVENT_IDS = ['event-markets', 'event-status', 'event-retry', 'event-live', 'event-back', 'event-heading', 'event-meta'];

/**
 * The dedicated event page over the REAL dictionary.
 *
 * The page used to carry its own bilingual literal, so a `t: key => key` stub
 * was enough to drive it and the assertions could name the English prose. Now
 * that the six strings are keys like everything else, that stub would only prove
 * the page echoes key names — so the real i18n.js is loaded here instead, and
 * the assertions name the text a user actually sees.
 *
 * The context is its own `window` because in a browser the global object IS
 * `window`: event-detail.js:5 reads bare `arbiterI18n.lang` while i18n.js:894
 * assigns `window.arbiterI18n`. A plain object with a `window` property would
 * leave the page unable to see the dictionary at all.
 */
function eventPage({ lang = 'en', search = '', get, onRender = () => {}, formatKickoff = v => v || '—' }) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        textContent: '', title: '', hidden: false, attrs: {}, handlers: {},
        setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren() {},
        addEventListener(type, fn) { this.handlers[type] = fn; },
      });
    }
    return nodes.get(id);
  };
  EVENT_IDS.forEach(node);
  const store = { 'arbiter.lang': lang };
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const ctx = {
    localStorage,
    document: {
      documentElement: { lang }, title: '', getElementById: node,
      querySelectorAll: () => [], addEventListener() {},
    },
    URLSearchParams, escapeHtml, console,
    arbiterApp: { mount() {} },
    arbiterFormat: { formatKickoff },
    EventDetailModal: { init() {}, renderEventDetail: (data, opts) => onRender(data, opts) },
    arbiterApi: { get },
    addEventListener() {},
  };
  ctx.window = ctx;
  ctx.location = { search };
  vm.createContext(ctx);
  vm.runInContext(I18N, ctx, { filename: 'i18n.js' });
  vm.runInContext(PAGE, ctx, { filename: 'event-detail.js' });
  return { ctx, node };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('dedicated controller handles success, empty, error and invalid context', async () => {
  for (const mode of ['success', 'empty', 'error', 'invalid']) {
    let calls = 0;
    const rendered = [];
    const { node } = eventPage({
      search: mode === 'invalid' ? '' : '?sport=Football&home=%3Cimg%3E&away=B',
      get: async (url) => {
        calls++;
        assert.match(url, /^\/api\/event-detail\?/);
        if (mode === 'error') throw new Error('failed');
        return { events: mode === 'success' ? [{ markets: [{ key: 'A' }] }] : [] };
      },
      onRender: (data, opts) => rendered.push({ data, opts }),
    });
    await settle();
    assert.equal(node('event-markets').attrs['aria-busy'], 'false');
    if (mode === 'success') {
      assert.equal(rendered[0].opts.target, node('event-markets'), 'the panel renders into the markets section');
      // The query is the fallback, and it stays one: the fixture's event carries
      // no identity at all, so the heading is still what the URL said. The
      // payload-wins case is the test below; this is the control that the
      // fallback is not a casualty of it.
      assert.equal(node('event-heading').textContent, '<img> vs B');
      assert.equal(node('event-live').hidden, true, 'no event, no in-play badge');
    }
    if (mode === 'empty') assert.equal(node('event-status').textContent, 'No odds found across bookmakers for this event.');
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
    const { node } = eventPage({
      lang: 'ro', search, formatKickoff: v => (v ? `kickoff(${v})` : ''),
      get: async () => payload,
    });
    await settle();
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
  // Romanian, from the real dictionary: the badge label and its tooltip are
  // keys, not literals, so this asserts the lookup and not a hardcoded prose.
  assert.equal(node('event-live').textContent, 'Live');
  assert.equal(node('event-live').title, 'Meci în desfășurare — cota se expiră în 90 de secunde');

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

/**
 * The page's own copy resolves through the dictionary, at render time.
 *
 * The page used to open with `const en = arbiterI18n.lang === 'en'` and a
 * private `copy` object holding six strings in both languages. Measured over the
 * real dictionary: none of the six had a key, so `t()` could not reach them and
 * the dictionary's dead-key and both-languages checks could not see them either;
 * three were duplicated again in event.html as plain Romanian literals that
 * `apply()` — which rewrites only `[data-i18n]` — had no way to reach.
 *
 * What that private copy cost, measured rather than assumed: driving this real
 * controller over the real i18n.js, switching language with the real `setLang`
 * and re-rendering through the page's own retry click (event-detail.js:86-87),
 * the empty path's status followed the switch and the error path's did not.
 * Same context, same trigger, same switch — only the expression differed.
 *
 * It was not reachable by a user, and that is said here rather than implied:
 * both language switches in the app reload the page (app.js:168, common.js:184),
 * so a captured copy could not go stale under a real click. The property worth
 * keeping is that there is now one source of truth for these strings.
 */
test('the event page resolves its copy through the dictionary, per render', async () => {
  // The control first: a harness that cannot see a language-driven change would
  // report every string below as "stayed put" and pass for the wrong reason.
  // It starts in Romanian on purpose — setLang('en') from an English page is a
  // no-op and would make the control vacuously true.
  const controlled = eventPage({ lang: 'ro', search: '?sport=F&home=A&away=B', get: async () => ({ events: [{ homeTeam: 'A', awayTeam: 'B', markets: [] }] }) });
  await settle();
  const controlledBefore = controlled.node('event-status').textContent;
  assert.equal(controlledBefore, 'Nicio cotă găsită la agenții pentru acest eveniment.', 'the control page is Romanian to begin with');
  controlled.ctx.arbiterI18n.setLang('en');
  controlled.node('event-retry').handlers.click();
  await settle();
  assert.notEqual(controlled.node('event-status').textContent, controlledBefore,
    'the harness cannot observe a language switch, so the assertions below would pass vacuously');

  // The failure path, which is the one the private copy owned.
  for (const [lang, expected] of [['ro', 'Cotele nu au putut fi încărcate. Încearcă din nou.'], ['en', 'Could not load event odds. Please try again.']]) {
    const { ctx, node } = eventPage({ lang, search: '?sport=F&home=A&away=B', get: async () => { throw new Error('down'); } });
    await settle();
    assert.equal(node('event-status').textContent, expected, `${lang}: the error text comes from the dictionary`);
    assert.equal(node('event-back').textContent, lang === 'ro' ? 'Înapoi la dashboard' : 'Back to dashboard',
      `${lang}: the back link comes from the dictionary`);
    assert.equal(node('event-retry').textContent, lang === 'ro' ? 'Reîncearcă' : 'Retry',
      `${lang}: the retry label comes from the dictionary`);

    // And it is resolved again on the next render, not remembered from load.
    ctx.arbiterI18n.setLang(lang === 'ro' ? 'en' : 'ro');
    node('event-retry').handlers.click();
    await settle();
    const flipped = node('event-status').textContent;
    assert.notEqual(flipped, expected, `${lang}: the error text was frozen at load instead of resolved per render`);
    assert.match(flipped, lang === 'ro' ? /Could not load/ : /nu au putut fi încărcate/);
  }

  // Every key the page reads must resolve to something. t() falls back to the
  // key name itself, so a key the dictionary lost renders as `eventRetry` on
  // screen — which is the failure mode this whole change exists to remove.
  const probe = eventPage({ lang: 'en', search: '?sport=F&home=A&away=B', get: async () => ({ events: [] }) });
  for (const key of ['eventBack', 'eventDetailsTitle', 'eventLoading', 'eventLoadError', 'eventRetry', 'eventInvalidLink']) {
    assert.notEqual(probe.ctx.arbiterI18n.t(key), key, `en: ${key} is missing, so t() would print the key name`);
  }
});

test('the event page has no private language snapshot left, and the markup is marked', () => {
  // codeOnly, not the raw text: this file's comments spell out the old
  // `arbiterI18n.lang === 'en'` line they removed, and a plain regex over the
  // source would match the explanation instead of the code.
  const code = codeOnly(read('public/js/pages/event-detail.js'));
  assert.doesNotMatch(code, /arbiterI18n\.lang\s*===/, 'the page still branches on the language it loaded with');
  assert.doesNotMatch(code, /\b(?:back|title|loading|error|retry|invalid):\s*'/, 'a private copy object survived');

  // apply() rewrites [data-i18n] and nothing else, so an unmarked literal stays
  // Romanian in an English session until the controller happens to overwrite it.
  const markup = read('public/event.html');
  for (const [id, key] of [['event-back', 'eventBack'], ['event-heading', 'eventDetailsTitle'], ['event-retry', 'eventRetry']]) {
    assert.match(markup, new RegExp(`id="${id}"[^>]*data-i18n="${key}"`), `#${id} is not marked with ${key}`);
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
