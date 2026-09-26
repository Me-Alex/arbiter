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
  document.getElementById('event-back').textContent = copy.back;
  retry.textContent = copy.retry;
  const heading = params.get('home') && params.get('away')
    ? `${params.get('home')} ${arbiterI18n.t('vs')} ${params.get('away')}` : copy.title;
  document.getElementById('event-heading').textContent = heading;
  document.title = `Arbiter — ${heading}`;
  document.getElementById('event-meta').textContent = [params.get('sport'), window.arbiterFormat.formatKickoff(params.get('kickoff'))].filter(Boolean).join(' · ');
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
      status.textContent = data.events?.some(event => event.markets?.length) ? '' : arbiterI18n.t('noOddsFound');
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
