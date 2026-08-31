// sse.js — Server-Sent Events client with auto-reconnect.
(function () {
  function connect(onMessage) {
    const es = new EventSource('/api/events');
    es.addEventListener('scrape-update', (e) => safe(onMessage, 'scrape-update', JSON.parse(e.data)));
    es.addEventListener('scan-update', (e) => safe(onMessage, 'scan-update', JSON.parse(e.data)));
    es.addEventListener('verify-start', (e) => safe(onMessage, 'verify-start', JSON.parse(e.data)));
    es.addEventListener('verify-end', (e) => safe(onMessage, 'verify-end', JSON.parse(e.data)));
    es.addEventListener('job-complete', (e) => safe(onMessage, 'job-complete', JSON.parse(e.data)));
    es.addEventListener('heartbeat', () => { /* keepalive */ });
    es.onerror = () => { /* browser will auto-reconnect */ };
    return es;
  }
  function safe(fn, type, payload) {
    try { fn(type, payload); } catch (e) { console.warn('sse handler failed', e); }
  }
  window.arbiterSse = { connect };
})();
