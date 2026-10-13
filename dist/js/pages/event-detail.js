// Dedicated, bookmarkable event view; query values are never rendered as HTML.
(function () {
  'use strict';
  arbiterApp.mount('dashboard');
  // Every string below is resolved through t() at the moment it is written, not
  // captured once at load. The page used to carry a private bilingual literal —
  // `const en = arbiterI18n.lang === 'en'` and a `copy` object — which had two
  // costs the dictionary made visible: none of the six texts had a key, so no
  // translation surface could reach them, and three of them were duplicated a
  // second time in event.html as plain Romanian literals.
  //
  // The frozen capture was measured, not assumed: driving this real controller
  // over the real i18n.js, switching language and re-rendering through the page's
  // own retry click, the empty path's status — t('noOddsFound'), written inside
  // load() — followed the switch while the error path's status did not. Same
  // context, same trigger, same switch; only the expression differed.
  //
  // It was not user-reachable, and that is stated rather than glossed: both
  // language switches in the app reload the page (app.js:168, common.js:184), so
  // the captured copy could not go stale under a real click. It was a private
  // second source of truth that the dictionary's own dead-key and both-languages
  // checks could not see, which is the property worth removing.
  const input = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  for (const key of ['sport', 'home', 'away', 'kickoff']) params.set(key, input.get(key) || '');
  const body = document.getElementById('event-markets');
  const status = document.getElementById('event-status');
  const retry = document.getElementById('event-retry');
  const liveBadge = document.getElementById('event-live');
  document.getElementById('event-back').textContent = arbiterI18n.t('eventBack');
  retry.textContent = arbiterI18n.t('eventRetry');
  const headingNode = document.getElementById('event-heading');
  const metaNode = document.getElementById('event-meta');

  // The query is what the page was opened with, so it is enough to find the
  // event — but it is not the event. The route matches on a normalized club
  // identity, so the names in the URL can differ in case, diacritics or
  // abbreviation from the ones the book actually publishes, and the league and
  // the in-play flag are not in the URL at all. Once the payload arrives, the
  // matched event is the authority on what this page is about; the query stays
  // as the fallback for the render that happens before it does.
  let ev = null;
  function paintIdentity() {
    const home = (ev && ev.homeTeam) || params.get('home') || '';
    const away = (ev && ev.awayTeam) || params.get('away') || '';
    const heading = home && away ? `${home} ${arbiterI18n.t('vs')} ${away}` : arbiterI18n.t('eventDetailsTitle');
    headingNode.textContent = heading;
    document.title = `Arbiter — ${heading}`;
    metaNode.textContent = [
      (ev && ev.sport) || params.get('sport'),
      window.arbiterFormat.formatKickoff((ev && ev.kickoff) || params.get('kickoff')),
      (ev && ev.league) || '',
    ].filter(Boolean).join(' · ');
    if (liveBadge) {
      const isLive = ev ? ev.live === true : false;
      liveBadge.hidden = !isLive;
      if (isLive) {
        liveBadge.textContent = arbiterI18n.t('live');
        liveBadge.title = arbiterI18n.t('liveTooltip');
      }
    }
  }
  paintIdentity();
  window.EventDetailModal.init({ ...window.arbiterFormat, escapeHtml: window.escapeHtml, arbiterI18n, arbiterApi, arbiterFormat: window.arbiterFormat });

  async function load() {
    retry.hidden = true;
    body.replaceChildren();
    body.setAttribute('aria-busy', 'true');
    status.textContent = arbiterI18n.t('eventLoading');
    if (!params.get('sport') || !params.get('home') || !params.get('away')) {
      status.textContent = arbiterI18n.t('eventInvalidLink');
      body.setAttribute('aria-busy', 'false');
      return;
    }
    try {
      const data = await arbiterApi.get(`/api/event-detail?${params}`);
      window.EventDetailModal.renderEventDetail(data, { target: body });
      const events = data.events || [];
      // One fixture can be quoted by several books, and the route returns one
      // entry per book. They agree on the event, so the first one that carries
      // an identity is as good as any; the whole list is searched so a book
      // that omitted its own team names cannot leave the header empty.
      ev = events.find((e) => e && (e.homeTeam || e.awayTeam)) || events[0] || null;
      paintIdentity();
      status.textContent = events.some(e => e.markets && e.markets.length) ? '' : arbiterI18n.t('noOddsFound');
    } catch {
      status.textContent = arbiterI18n.t('eventLoadError');
      retry.hidden = false;
    } finally {
      body.setAttribute('aria-busy', 'false');
    }
  }
  retry.addEventListener('click', load);
  load();
})();
