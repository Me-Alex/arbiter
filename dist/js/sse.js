// sse.js — Server-Sent Events client with auto-reconnect.
//
// The frame types are the ones the server actually emits. There was a
// `job-complete` listener here that the server has never sent: the orchestrator
// folds a completed job into the state it publishes as `scrape-update`
// (scrape-orchestrator.mjs:413), so the branch that read it was unreachable and
// the per-book log line it printed never appeared. The four `verify-*` frames
// are here for the re-quote: how many prices are being checked across how many
// books, one line per book as it lands, the batch's own outcome, and the verdict.
// The zeroed placeholder on `verify-job-start` is not — it carries an empty
// record (scraper-service.mjs:157) and nothing reads it;
// test/events-channel-census.test.mjs measures all of that.
(function () {
  function connect(onMessage, onState) {
    const es = new EventSource('/api/events');
    es.addEventListener('scrape-update', (e) => safe(onMessage, 'scrape-update', JSON.parse(e.data)));
    es.addEventListener('scan-update', (e) => safe(onMessage, 'scan-update', JSON.parse(e.data)));
    es.addEventListener('verify-start', (e) => safe(onMessage, 'verify-start', JSON.parse(e.data)));
    es.addEventListener('verify-batch-start', (e) => safe(onMessage, 'verify-batch-start', JSON.parse(e.data)));
    es.addEventListener('verify-job-complete', (e) => safe(onMessage, 'verify-job-complete', JSON.parse(e.data)));
    es.addEventListener('verify-batch-end', (e) => safe(onMessage, 'verify-batch-end', JSON.parse(e.data)));
    es.addEventListener('verify-end', (e) => safe(onMessage, 'verify-end', JSON.parse(e.data)));
    es.addEventListener('heartbeat', () => { /* keepalive */ });
    es.onopen = () => { if (onState) safe(onState, 'open'); };
    es.onerror = () => { if (onState) safe(onState, 'reconnecting'); /* browser will auto-reconnect */ };
    return es;
  }
  function safe(fn, type, payload) {
    try { fn(type, payload); } catch (e) { console.warn('sse handler failed', e); }
  }
  window.arbiterSse = { connect };
})();
