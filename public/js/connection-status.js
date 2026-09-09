/**
 * connection-status.js — global SSE connection-status indicator & error toasts.
 *
 * Loads after sse.js and common.js. Auto-wires into the SSE client via
 * arbiterSse.connect(), updates any `.sse-status` elements on the page,
 * and shows transient toasts on reconnection or fetch errors.
 *
 * @module connection-status
 */
(function () {
  'use strict';

  /** Last known connection state. */
  let state = 'unknown';

  /** Timestamp of last state change (used to avoid duplicate "reconnected" toasts). */
  let lastChange = 0;

  /**
   * Update every `.sse-status` element on the page to reflect the current
   * SSE connection state. Elements may be any tag; the component reads a
   * `data-connected-text` and `data-disconnected-text` attribute pair, or
   * falls back to localised labels from arbiterI18n.
   *
   * @param {string} sseState - 'open' | 'reconnecting' | 'unknown'
   */
  function updateIndicators(sseState) {
    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;
    const connected = sseState === 'open';
    const label = connected
      ? (t('live') || 'Live')
      : (t('reconnecting') || 'Reconnecting');
    const chipClass = connected ? 'chip green' : 'chip red';

    document.querySelectorAll('.sse-status').forEach((el) => {
      const connectedText = el.getAttribute('data-connected-text') || label;
      const disconnectedText = el.getAttribute('data-disconnected-text') || label;
      el.className = chipClass;
      const textSpan = el.querySelector('span:last-child');
      if (textSpan) {
        textSpan.textContent = connected ? connectedText : disconnectedText;
      }
      const dot = el.querySelector('.dot');
      if (dot) {
        dot.className = 'dot ' + (connected ? 'live' : 'error');
      }
    });

    // Also update the legacy dashboard live-indicator if present
    const dashIndicator = document.getElementById('sse-status');
    if (dashIndicator) {
      dashIndicator.className = 'live-indicator ' + (connected ? 'connected' : 'disconnected');
      const dashLabel = dashIndicator.querySelector('span:last-child');
      if (dashLabel) dashLabel.textContent = label;
    }
  }

  /**
   * Show a toast when the connection state changes (especially on reconnection).
   * Avoids duplicate "connected" toasts when the SSE client reconnects quickly.
   *
   * @param {string} newState - 'open' | 'reconnecting'
   */
  function handleStateChange(newState) {
    const now = Date.now();
    const prev = state;
    state = newState;

    // Only toast on meaningful transitions
    if (prev === newState) return;

    // Avoid rapid-fire toasts (debounce 2 seconds)
    if (now - lastChange < 2000 && prev !== 'unknown') return;
    lastChange = now;

    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;

    if (newState === 'reconnecting' && prev === 'open') {
      // Connection lost
      if (typeof window.showToast === 'function') {
        window.showToast(t('connectionLost') || 'Connection lost — reconnecting…', 'warning', { duration: 4000 });
      }
    } else if (newState === 'open' && prev === 'reconnecting') {
      // Reconnected
      if (typeof window.showToast === 'function') {
        window.showToast(t('reconnected') || 'Reconnected', 'success', { duration: 2500 });
      }
    }

    updateIndicators(newState);
  }

  /**
   * Wrap arbiterApi.get/post/put/del to show error toasts on failures.
   * This is called once; the original methods are replaced with wrappers.
   */
  function wrapApiForToasts() {
    if (typeof window.arbiterApi === 'undefined' || window.arbiterApi._toastsWired) return;

    const orig = {
      get: window.arbiterApi.get,
      post: window.arbiterApi.post,
      put: window.arbiterApi.put,
      del: window.arbiterApi.del,
    };

    function wrapWithToast(fn, _name) {
      return async function wrapped(path, body) {
        try {
          return await fn.call(window.arbiterApi, path, body);
        } catch (err) {
          const msg = (err && err.message) || 'Request failed';
          // Don't toast for expected error codes (auth, CSRF)
          if (err && err.status && (err.status === 403 || err.status === 401)) throw err;
          if (typeof window.showToast === 'function' && !err._silent) {
            window.showToast(msg, 'error', { duration: 5000 });
          }
          throw err;
        }
      };
    }

    window.arbiterApi.get = wrapWithToast(orig.get, 'get');
    window.arbiterApi.post = wrapWithToast(orig.post, 'post');
    window.arbiterApi.put = wrapWithToast(orig.put, 'put');
    window.arbiterApi.del = wrapWithToast(orig.del, 'del');
    window.arbiterApi._toastsWired = true;
  }

  /**
   * Auto-initialise: wire the SSE state callback and wrap the API layer.
   * Must run after sse.js and common.js (which provides showToast).
   */
  function init() {
    // Wrap API calls to show error toasts
    wrapApiForToasts();

    // The SSE connect call is made by each page script. We hook into the
    // global SSE client by wrapping its connect method. The first page to
    // call arbiterSse.connect() will register our state callback.
    if (window.arbiterSse && window.arbiterSse.connect) {
      const origConnect = window.arbiterSse.connect;
      window.arbiterSse.connect = function patchedConnect(onMessage, onState) {
        const wrappedState = function (sseState) {
          handleStateChange(sseState);
          if (onState) onState(sseState);
        };
        return origConnect(onMessage, wrappedState);
      };
    }

    updateIndicators('unknown');
  }

  // Run on DOMContentLoaded or immediately if DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /**
   * Show or hide a data-freshness banner at the top of the page.
   * Pages call this after loading scan data to inform the user when
   * live workspace snapshots are missing or stale.
   *
   * @param {object} health - The dataHealth object from /api/scan.
   */
  function setDataHealth(health) {
    let banner = document.getElementById('data-freshness-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'data-freshness-banner';
      banner.className = 'data-freshness-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      const main = document.querySelector('main');
      if (main) main.insertBefore(banner, main.firstChild);
    }

    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;

    const status = (health && health.status) || 'unknown';
    const actionable = Number(health && health.actionableSourceCount) || 0;

    if (status === 'fresh' || status === 'unknown') {
      banner.classList.remove('visible');
      return;
    }

    const isStale = status === 'stale' || status === 'partial';
    banner.className = 'data-freshness-banner visible' + (isStale ? '' : ' info');

    const iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    const message = status === 'empty'
      ? t('noFreshData')
      : `${t('dataHealth')}: ${status}${actionable ? ` (${actionable} ${t('freshSources')})` : ''}`;
    const link = `<a href="/admin/scrape.html">${t('runScrape')}</a>`;

    banner.innerHTML = `${iconSvg}<span class="banner-text">${escapeHtml(message)} &mdash; ${link}</span>`;
  }

  /** Public API for programmatic status updates. */
  window.arbiterConnectionStatus = {
    /** Manually set the connection state. */
    setState: handleStateChange,
    /** Refresh indicator elements (e.g. after DOM mutation). */
    refresh: updateIndicators,
    /** Get current state. */
    getState: () => state,
    /** Show/hide data-freshness banner based on scan data health. */
    setDataHealth,
  };
})();
