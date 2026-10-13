// dist/snapshot.js - snapshot build only. Not part of the application, and it
// lives in dist/ rather than public/ so it can never reach the local app.
//
// Arbiter is local-first: it serves its scan from a loopback API that computes
// the document per request. A static host cannot do that, and it does not
// recognise an extensionless path - every /api/* request it cannot resolve is
// rewritten to index.html, so the page was fetching its own HTML back and
// rendering an empty terminal.
//
// This shim does two things, and nothing else:
//
//   1. Sends GET /api/scan to /api/scan.json instead. That file holds the exact
//      bytes the running server returned for that route, so the data on screen
//      is the real scan and not a reconstruction of it.
//   2. Stops the page opening an EventSource. A snapshot has no live stream to
//      connect to, and without this the browser logs a MIME-type error on every
//      load for a connection that could never have carried anything.
//
// GET /api/health is deliberately left alone. A snapshot genuinely is not
// connected to a running server, and letting that probe fail is what makes the
// connection badge tell the truth instead of claiming a live backend.
(function () {
  var REAL_FETCH = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url === '/api/scan' || url.endsWith('/api/scan')) {
      return REAL_FETCH('/api/scan.json', init);
    }
    return REAL_FETCH(input, init);
  };

  // No stream exists here. Swallowing the constructor keeps the console clean
  // without pretending a connection was established.
  var NativeEventSource = window.EventSource;
  function OfflineEventSource() {
    this.readyState = 2;
    this.onopen = this.onmessage = this.onerror = null;
  }
  OfflineEventSource.CONNECTING = 0;
  OfflineEventSource.OPEN = 1;
  OfflineEventSource.CLOSED = 2;
  OfflineEventSource.prototype.close = function () {};
  OfflineEventSource.prototype.addEventListener = function () {};
  OfflineEventSource.prototype.removeEventListener = function () {};
  window.EventSource = OfflineEventSource;
  window.__snapshotNoStream = true;
})();