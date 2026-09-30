/**
 * alerts.js — deciding when to interrupt the trader, and how loudly.
 *
 * The server already answers "what deserves attention" (see src/alert-engine.mjs).
 * What it cannot answer is "when did this tab last shout about it", because it
 * has no idea which tabs are open, or which of them the trader is actually
 * looking at. The cooldown therefore lives here, per tab, and is deliberately
 * not shared: two windows on the same dashboard should not silence each other,
 * and a page that was closed is a page whose cooldown is gone.
 *
 * Delivery degrades rather than fails. An alert that could not interrupt anyone
 * is a bug, so the ladder is: the Electron main process (the only channel that
 * works when the window is in the background on any platform), then the browser
 * Notification API, then an in-page banner that cannot fail at all. A false at
 * any rung is a downgrade to the next, never a dropped alert.
 *
 * @module alerts
 */
(function () {
  /**
   * Show one alert through the best channel available.
   *
   * @param {{title: string, body: string, tag?: string, silent?: boolean}} payload
   * @param {object} [deps]
   * @param {{notify: Function}} [deps.bridge]  `window.arbiter` from preload.
   * @param {Function} [deps.NotificationApi]   `window.Notification`.
   * @param {Function} [deps.banner]             In-page fallback, called with the payload.
   * @returns {Promise<'electron'|'browser'|'banner'|'none'>} Which rung carried it.
   */
  async function deliverNotification(payload, deps = {}) {
    const { bridge, NotificationApi, banner } = deps;

    if (bridge && typeof bridge.notify === 'function') {
      try {
        const result = await bridge.notify(payload);
        if (result && result.ok) return 'electron';
        // 'empty' is the main process saying there was nothing left to say
        // after sanitising. Falling through would just re-render the same
        // nothing, one rung down.
        if (result && result.reason === 'empty') return 'none';
      } catch (err) {
        console.warn('desktop notification failed, falling back', err);
      }
    }

    if (typeof NotificationApi === 'function' && NotificationApi.permission === 'granted') {
      try {
        new NotificationApi(payload.title, {
          body: payload.body,
          // Browsers do collapse same-tag notifications, which is the same rule
          // the main process applies by hand since Electron has no tag.
          tag: payload.tag || undefined,
          silent: payload.silent === true,
        });
        return 'browser';
      } catch (err) {
        console.warn('browser notification failed, falling back', err);
      }
    }

    if (typeof banner === 'function') {
      try {
        banner(payload);
        return 'banner';
      } catch (err) {
        console.warn('in-page banner failed', err);
      }
    }
    return 'none';
  }

  /**
   * Track which alerts have already been delivered to this tab.
   *
   * The first payload primes the map without notifying. Opening the dashboard
   * on a scan that has been sitting there for an hour should not produce a
   * dozen notifications for opportunities the trader has already had on screen
   * the whole time — only what changes *after* they arrive is news.
   *
   * @param {object} [deps]
   * @param {(payload: object) => Promise<string>} deps.deliver
   * @param {() => number} [deps.now]
   * @param {(payload: object) => void} [deps.onBanner] Called when delivery drops to the banner.
   */
  function createAlertWatcher({ deliver, now = () => Date.now(), onBanner } = {}) {
    const lastSeen = new Map();
    let cooldownMs = 60_000;
    let primed = false;

    return {
      /**
       * Adopt the cooldown the server stored, so both halves agree.
       *
       * Only a real number or a numeric string is accepted. `Number(null)` and
       * `Number('')` are both 0, and 0 here means "announce on every single
       * poll" — so a missing value must fall back to a minute rather than
       * quietly turn a setting into a machine gun. The server normalizes its
       * own output, which is exactly why this needs its own guard: the one
       * thing this method cannot be handed is the value it would mishandle.
       */
      setCooldownSeconds(seconds) {
        const n = typeof seconds === 'number'
          ? seconds
          : (typeof seconds === 'string' && seconds.trim() !== '' ? Number(seconds) : NaN);
        cooldownMs = Number.isFinite(n) && n >= 0 ? n * 1000 : 60_000;
      },

      /**
       * Consider one alert payload.
       *
       * @param {object} payload  The `GET /api/alerts` body.
       * @param {{quiet?: boolean, channels?: {desktop?: boolean, sound?: boolean}}} [opts]
       * @returns {Promise<{sent: object[], suppressed: number, quiet: boolean, skipped: number}>}
       */
      async ingest(payload, opts = {}) {
        const all = collect(payload);
        const desktop = opts.channels ? opts.channels.desktop !== false : true;
        const sound = Boolean(opts.channels && opts.channels.sound);
        const quiet = Boolean(opts.quiet);
        const at = now();

        if (!primed) {
          primed = true;
          for (const alert of all) lastSeen.set(alert.key, at);
          // Not a failure: this is the page catching up with the world, and
          // telling the user so is the honest description of an empty count.
          return { sent: [], suppressed: all.length, quiet, skipped: all.length, primed: true };
        }

        const sent = [];
        let suppressed = 0;
        for (const alert of all) {
          const previous = lastSeen.get(alert.key);
          if (previous !== undefined && at - previous < cooldownMs) {
            suppressed++;
            continue;
          }
          lastSeen.set(alert.key, at);
          if (quiet || !desktop) {
            // Still recorded as seen. Queueing them for when quiet hours end
            // would hand the trader a burst of stale alerts on waking up, and
            // an alert about a price that expired an hour ago is worse than no
            // alert at all.
            continue;
          }
          sent.push(alert);
        }

        for (const alert of sent) {
          const channel = await deliver(toPayload(alert), onBanner);
          if (channel === 'none') continue;
          if (sound) playTone();
        }
        return { sent, suppressed, quiet, skipped: all.length - sent.length - suppressed, primed: false };
      },

      /** Forget everything, so the next payload is treated as an arrival again. */
      reset() {
        lastSeen.clear();
        primed = false;
      },

      /** Exposed for the settings panel; not part of the delivery path. */
      size() {
        return lastSeen.size;
      },
    };

    function collect(payload) {
      const alerts = (payload && payload.alerts) || {};
      return [...(alerts.arbitrages || []), ...(alerts.middles || [])].filter((a) => a && a.key);
    }
  }

  /** Turn an alert into the three strings a notification carries. */
  function toPayload(alert) {
    const t = (key, fallback) => (window.arbiterI18n && window.arbiterI18n.t(key)) || fallback;
    const teams = [alert.homeTeam, alert.awayTeam].filter(Boolean).join(' vs ');
    const roi = `${Number(alert.roiPercent || 0).toFixed(2)}%`;
    const books = (alert.sourceIds || []).join(', ');
    const stake = alert.totalStake === null || alert.totalStake === undefined
      ? '—'
      : String(Math.round(alert.totalStake));
    const head = teams || t('alertUntitled', 'Opportunity');
    // `alertStakeValue` is a template, deliberately not the same key the table
    // uses for the bare noun: one key serving both meant the translation was
    // free to drop the placeholder, and the notification then ended in a
    // dangling "stake" with no number after it.
    const stakePart = t('alertStakeValue', 'stake {value}').replace('{value}', stake);
    const parts = alert.type === 'middle'
      ? [
        t('alertMiddleRoi', '{roi} middle, {risk}% risk').replace('{roi}', roi).replace('{risk}', String(Number(alert.riskPercent || 0).toFixed(2))),
        alert.marketKey, books, stakePart,
      ]
      : [
        t('alertArbRoi', '{roi} arbitrage').replace('{roi}', roi),
        alert.marketKey, books, stakePart,
      ];
    return {
      title: `${head} · ${roi}`,
      body: parts.filter(Boolean).join(' · '),
      // The same key the server used, so a re-alerted opportunity replaces its
      // own notification instead of queueing behind the previous one.
      tag: alert.key,
      silent: false,
    };
  }

  /**
   * A short two-note chime for the sound channel.
   *
   * Built lazily because a page that has never played a sound cannot hold an
   * AudioContext without every autoplay policy on the planet deciding it is
   * suspicious, and a channel the user has to unlock by clicking something
   * first is not a channel.
   */
  let audioCtx = null;
  function playTone() {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const now = audioCtx.currentTime;
      for (const [index, freq] of [880, 1174].entries()) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + index * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.15, now + index * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + index * 0.12);
        osc.stop(now + index * 0.12 + 0.2);
      }
      return true;
    } catch (err) {
      console.warn('alert sound failed', err);
      return false;
    }
  }

  window.arbiterAlerts = { deliverNotification, createAlertWatcher, toPayload };
})();
