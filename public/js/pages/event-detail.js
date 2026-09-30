// Dedicated, bookmarkable event view; query values are never rendered as HTML.
(function () {
  'use strict';
  arbiterApp.mount('dashboard');
  const en = arbiterI18n.lang === 'en';
  const copy = en ? {
    back: 'Back to dashboard', title: 'Event details', loading: 'Loading markets and odds…',
    error: 'Could not load event odds. Please try again.', retry: 'Retry',
    invalid: 'This event link is incomplete. Return to the dashboard and select an event.',
  } : {
    back: 'Înapoi la dashboard', title: 'Detalii eveniment', loading: 'Se încarcă piețele și cotele…',
    error: 'Cotele nu au putut fi încărcate. Încearcă din nou.', retry: 'Reîncearcă',
    invalid: 'Linkul evenimentului este incomplet. Revino la dashboard și selectează un eveniment.',
  };
  const input = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  for (const key of ['sport', 'home', 'away', 'kickoff']) params.set(key, input.get(key) || '');
  const body = document.getElementById('event-markets');
  const status = document.getElementById('event-status');
  const retry = document.getElementById('event-retry');
  const liveBadge = document.getElementById('event-live');
  document.getElementById('event-back').textContent = copy.back;
  retry.textContent = copy.retry;
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
    const heading = home && away ? `${home} ${arbiterI18n.t('vs')} ${away}` : copy.title;
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
    status.textContent = copy.loading;
    if (!params.get('sport') || !params.get('home') || !params.get('away')) {
      status.textContent = copy.invalid;
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
      status.textContent = copy.error;
      retry.hidden = false;
    } finally {
      body.setAttribute('aria-busy', 'false');
    }
  }
  retry.addEventListener('click', load);
  load();
})();
