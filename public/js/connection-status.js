/**
 * connection-status.js — global connection indicators & error toasts.
 *
 * Loads after sse.js and common.js. Auto-wires into the SSE client via
 * arbiterSse.connect(), updates any `.sse-status` elements on the page,
 * and shows transient toasts on reconnection or fetch errors.
 *
 * It also owns the `GET /api/health` chip it puts next to the connection chip
 * in the header: the SSE chip answers "is the socket open", that one answers
 * "is the API still answering", and the two fail independently.
 *
 * @module connection-status
 */

/**
 * Decide what the connection-status UI should do for an SSE state transition.
 *
 * Pure decision function (no DOM, no timers) so the debounce/filter rules can
 * be unit tested in isolation:
 * - identical states are ignored (no toast, no indicator update),
 * - rapid re-flips within 2s are debounced except when we don't yet know the
 *   previous state,
 * - meaningful transitions map to a toast ('lost' | 'reconnected') or none.
 *
 * @param {string} prev       - Previous SSE state ('unknown' | 'open' | 'reconnecting').
 * @param {string} next       - New SSE state ('open' | 'reconnecting').
 * @param {number} now        - Current epoch ms.
 * @param {number} lastChange - Epoch ms of the last ACCEPTED transition.
 * @returns {{act: boolean, toast: 'lost'|'reconnected'|null, willUpdate: boolean}}
 *   `act` controls whether the caller should proceed (update lastChange, toast,
 *   refresh indicators). `willUpdate` mirrors `act` for readability.
 */
function decideStateTransition(prev, next, now, lastChange) {
  if (prev === next) return { act: false, toast: null };
  if (now - lastChange < 2000 && prev !== 'unknown') return { act: false, toast: null };
  if (next === 'reconnecting' && prev === 'open') return { act: true, toast: 'lost' };
  if (next === 'open' && prev === 'reconnecting') return { act: true, toast: 'reconnected' };
  return { act: true, toast: null };
}

/**
 * Decide what the data-freshness banner should show for a scan dataHealth.
 *
 * Pure decision function (no DOM) so the status→visibility/variant rules can be
 * unit tested in isolation. `health` is the `dataHealth` object from `/api/scan`
 * ({ status, actionableSourceCount }).
 *
 * @param {object} health - The dataHealth payload.
 * @returns {{visible: boolean, className: string, status: string, actionable: number, empty: boolean}}
 *   `className` is the full banner class when visible, empty otherwise.
 *   `status`/`actionable`/`empty` are the raw inputs the caller needs to
 *   compose a translated, escaped message (i18n is an effect, not a decision).
 */
function decideHealthBanner(health) {
  // Only known statuses may reach the HTML sink; anything else — including
  // malicious/unknown tokens — is treated as 'unknown' (no banner).
  const raw = (health && health.status) || 'unknown';
  const KNOWN = new Set(['fresh', 'stale', 'partial', 'empty']);
  const status = KNOWN.has(raw) ? raw : 'unknown';
  const actionable = Number(health && health.actionableSourceCount) || 0;

  if (status === 'fresh' || status === 'unknown') {
    return { visible: false, className: '', status, actionable: 0, empty: false };
  }

  const isStale = status === 'stale' || status === 'partial';
  const className = 'data-freshness-banner visible' + (isStale ? '' : ' info');

  return { visible: true, className, status, actionable, empty: status === 'empty' };
}

/**
 * Format a process uptime in seconds as a compact, language-neutral string.
 *
 * Pure (no DOM, no timers, no i18n) so the compaction rules can be unit
 * tested on their own. The unit symbols are the same in Romanian and
 * English, so the result needs no translation.
 *
 * At most two units are kept, largest first — `1d 2h`, `12h 5m`, `9m`,
 * `45s` — because a header chip has no room for `1d 2h 3m 4s` and the dropped
 * detail is not what this chip is for. Seconds are printed only when no
 * larger unit exists (`9m`, never `1m 30s`), so a chip reading `5h 12m` ticks
 * once a minute instead of changing on every poll.
 *
 * The input is checked for type, not coerced: `Number(null)` and
 * `Number('')` are both 0, and printing `0s` for a value that was never sent
 * would be a claim this function cannot back up.
 *
 * @param {number} seconds - Process uptime in seconds (`/api/health`).
 * @returns {string} Compact uptime, or `''` when the input is unusable.
 */
function formatUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  // No floor() here on purpose: Math.floor(rest / size) inside the loop already
  // truncates, so flooring the input first was measured to change nothing for
  // any input (see scratch/mut-health-chip.mjs).
  let rest = seconds;
  const UNITS = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  const parts = [];
  for (let i = 0; i < UNITS.length; i++) {
    const size = UNITS[i][1];
    const n = Math.floor(rest / size);
    rest -= n * size;
    const isSeconds = i === UNITS.length - 1;
    if (n === 0) {
      // '0s' is the one zero worth printing: it is the only way the chip can
      // say "the process just started" instead of going blank.
      if (isSeconds && parts.length === 0) parts.push('0s');
      continue;
    }
    // Seconds change on every repaint, so they are printed only when there is
    // nothing larger to print. A chip reading '5h 12m' then ticks once a
    // minute; with a seconds unit it would change on every 30s poll instead,
    // which reads as an unstable widget rather than a clock.
    if (isSeconds && parts.length > 0) break;
    parts.push(n + UNITS[i][0]);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/**
 * Decide what the `GET /api/health` chip should show for one poll result.
 *
 * Pure decision function (no DOM, no i18n) so the state rules can be unit
 * tested in isolation, like the two above. `health` is the parsed
 * `/api/health` payload, or `null` when the request itself failed.
 *
 * The payload's own `ok` flag is not read: it is hardcoded `true` in
 * src/router.mjs, so a constant is not a signal. The response arriving at all
 * is the signal, and `uptimeSeconds` is what the chip has to show.
 *
 * `unknown` is deliberately not folded into `unreachable`: the route answered
 * 200 with a body this chip cannot read (an interstitial proxy page, a
 * truncated response), so painting it red would report an outage that is
 * not happening.
 *
 * @param {object|null} health - The payload, or null when unreachable.
 * @returns {{state: 'ok'|'unreachable'|'unknown', className: string, uptimeSeconds: number, uptimeText: string}}
 *   `uptimeText` is the raw compact uptime for the caller to place; the
 *   translated labels are composed by the caller (i18n is an effect, not a
 *   decision — same rule as decideHealthBanner).
 */
function decideHealthChip(health) {
  if (!health) {
    return { state: 'unreachable', className: 'chip red', uptimeSeconds: 0, uptimeText: '' };
  }
  const uptime = health.uptimeSeconds;
  if (typeof uptime !== 'number' || !Number.isFinite(uptime) || uptime < 0) {
    return { state: 'unknown', className: 'chip yellow', uptimeSeconds: 0, uptimeText: '' };
  }
  return {
    state: 'ok',
    className: 'chip green',
    uptimeSeconds: Math.floor(uptime),
    uptimeText: formatUptime(uptime),
  };
}

(function () {
  'use strict';

  /** Last known connection state. */
  let state = 'unknown';

  /** Timestamp of last state change (used to avoid duplicate "reconnected" toasts). */
  let lastChange = 0;

  /**
   * How often the `/api/health` chip re-polls. The route is a synchronous
   * constant read and the rate limiter refills at 10/s, so 30s costs two
   * requests a minute and still catches a server that dies mid-session.
   */
  const HEALTH_POLL_MS = 30_000;

  /** The health chip element, created once next to the SSE chip. */
  let healthChip = null;

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

    const decision = decideStateTransition(prev, newState, now, lastChange);
    if (!decision.act) return;
    lastChange = now;

    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;

    if (decision.toast === 'lost') {
      if (typeof window.showToast === 'function') {
        window.showToast(t('connectionLost') || 'Connection lost — reconnecting…', 'warning', { duration: 4000 });
      }
    } else if (decision.toast === 'reconnected') {
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

    // The liveness panel for GET /api/health, polled independently of the SSE
    // stream: the header can then say whether the API itself is answering,
    // which the Live chip cannot (a socket can stay open against a dead
    // handler). ensureHealthChip() renders the neutral chip first, so there
    // is something on screen for the whole first round trip.
    ensureHealthChip();
    pollHealth();
    // The handle is deliberately dropped: an admin page lives as long as its
    // tab, so there is nothing to tear the timer down from.
    window.setInterval(pollHealth, HEALTH_POLL_MS);
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

    const decision = decideHealthBanner(health);
    if (!decision.visible) {
      banner.classList.remove('visible');
      return;
    }

    banner.className = decision.className;

    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;

// t() returns the key string itself when a key is missing, so compare the
    // result against the key rather than relying on truthiness; unknown statuses
    // fall back to the raw server token (only reachable for allowlisted statuses
    // whose translation is absent).
    const statusKey = 'status' + decision.status.charAt(0).toUpperCase() + decision.status.slice(1);
    const translated = t(statusKey);
    const statusLabel = translated === statusKey ? decision.status : translated;
    const message = decision.empty
      ? t('noFreshData')
      : `${t('dataHealth')}: ${statusLabel}${decision.actionable ? ` (${decision.actionable} ${t('freshSources')})` : ''}`;
    const link = `<a href="/admin/scrape.html">${t('runScrape')}</a>`;

    const iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    banner.innerHTML = `${iconSvg}<span class="banner-text">${escapeHtml(message)} &mdash; ${link}</span>`;
  }

  /**
   * Create the `/api/health` chip immediately after the SSE chip, once.
   *
   * Every admin page carries `id="sse-status"` in its header — three as
   * `.sse-status`, scrape.html as `.sl-live` — so the id is the one anchor all
   * four share. Returns the chip, or null when the page has no such anchor:
   * the panel is a header decoration, not a hard requirement.
   *
   * The initial class is the neutral `chip outline`, never green: until the
   * first answer arrives the chip knows nothing, and a chip that claims a
   * healthy server before it has asked is a lie the user reads as data.
   *
   * @returns {Element|null} The chip, or null when no anchor was found.
   */
  function ensureHealthChip() {
    // Memoised, and safe to memoise: the four admin pages ship a static header
    // and no page script rewrites it (measured — nothing assigns innerHTML on
    // .page-header / .sl-head-state), so the node cannot be swapped out from
    // under us. If a page ever does rewrite the header, this needs a re-query
    // against the document rather than a cached reference.
    if (healthChip) return healthChip;
    const anchor = document.getElementById('sse-status');
    if (!anchor || !anchor.parentNode || typeof anchor.parentNode.insertBefore !== 'function') {
      return null;
    }

    const chip = document.createElement('span');
    chip.id = 'health-status';
    chip.className = 'chip outline';
    // role="status" announces a change of state, which is the announcement
    // worth having here: the user learns the API stopped answering without
    // watching the header. It also announces the uptime ticking, so the
    // once-a-minute rule in formatUptime is what keeps that to once a minute
    // instead of once per 30s poll — and the mutation runner breaks that rule
    // to prove the property is tested rather than hoped for.
    chip.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    chip.appendChild(dot);
    chip.appendChild(text);
    anchor.parentNode.insertBefore(chip, anchor.nextSibling);

    healthChip = chip;
    return chip;
  }

  /**
   * Paint one poll result into the health chip.
   *
   * `health` is a `/api/health` payload or null when the route could not be
   * reached. The three states get three different texts, because two of them
   * are claims about the server and one is only a label:
   *
   *   - ok          → the uptime, which is the payload's only live field,
   *   - unreachable → a named failure, since "red" alone next to a green Live
   *                  chip would leave the reader guessing which one died,
   *   - unknown     → the plain system-health label, which asserts nothing.
   *
   * The dot is static in all three states. `.dot.live` pulses, and that
   * pulse already means "the socket is reconnecting" on the chip next to it;
   * a second pulsing dot would merge the two signals into one.
   *
   * @param {object|null} health - The payload, or null when unreachable.
   */
  function renderHealth(health) {
    const chip = ensureHealthChip();
    if (!chip) return;

    const t = (typeof window.arbiterI18n !== 'undefined')
      ? window.arbiterI18n.t.bind(window.arbiterI18n)
      : (k) => k;
    const d = decideHealthChip(health);
    const unreachableLabel = t('healthUnreachable');
    const text = d.state === 'ok' ? d.uptimeText
      : d.state === 'unreachable' ? unreachableLabel
      : t('systemHealth');

    chip.className = d.className;
    // textContent, never innerHTML, and never pre-escaped: escapeHtml in front
    // of textContent double-encodes ('run&7' → 'run&amp;7' read back). The
    // values are a machine-formatted uptime and two dictionary strings.
    const textSpan = chip.querySelector('span:last-child');
    if (textSpan) textSpan.textContent = text;
    // The tooltip names the field so the bare uptime is not read as a level.
    // Assigned on every state, including the two where it repeats the visible
    // label: writing it conditionally would let a title from a previous poll
    // linger and describe a state the chip is no longer in.
    chip.title = d.state === 'ok' ? t('systemHealth') + ': ' + d.uptimeText : text;
    const dot = chip.querySelector('.dot');
    if (dot) {
      dot.className = 'dot ' + (d.state === 'ok' ? 'ok' : d.state === 'unreachable' ? 'error' : 'warn');
    }
  }

  /**
   * Poll `GET /api/health` and repaint the chip. Never rejects.
   *
   * This goes through `window.fetch` and not `window.arbiterApi.get` on
   * purpose: wrapApiForToasts() above turns every API error into a toast, and a
   * probe that is *meant* to fail while the server is down would then raise an
   * error toast every 30 seconds and bury the page under its own diagnosis. A
   * liveness check has to be able to fail quietly. `cache: 'no-store'` keeps a
   * proxy or the bfcache from answering with a stale 200 and hiding the very
   * outage this chip exists to show.
   *
   * @returns {Promise<void>}
   */
  async function pollHealth() {
    let res;
    try {
      res = await window.fetch('/api/health', { cache: 'no-store' });
    } catch (_e) {
      renderHealth(null); // offline, refused, wrong port — all the same here
      return;
    }
    if (!res || !res.ok) {
      renderHealth(null); // the route answered, with an error
      return;
    }
    let payload;
    try {
      payload = await res.json();
    } catch (_e) {
      renderHealth({}); // reached the route, body is not the JSON we expect
      return;
    }
    renderHealth(payload);
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
    /** Re-poll GET /api/health and repaint the chip (e.g. after a wake). */
    refreshHealth: pollHealth,
  };
})();
