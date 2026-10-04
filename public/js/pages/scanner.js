/* global createDropdown */

    const $ = (id) => document.getElementById(id);
    let _sportsData = [];
    let _isFirstScanLoad = true;
    let _optionsSeeded = false;
    // The document the tables were last drawn from, kept so the sport control
    // can redraw the same scan under a new selection instead of waiting for the
    // next refresh (or re-running the engine for a filter change).
    let _lastScan = null;

    let _alertWatcher = null;

    /**
     * The alert settings, read out of the form.
     *
     * Read as strings and posted as they are: the server owns the coercion, and
     * a second implementation of "what is a valid threshold" in the page is a
     * second thing to keep in step. The checkboxes are the exception — the
     * browser already holds a real boolean there.
     */
    function readAlertForm() {
      return {
        minRoiPercent: ($('alert-min-roi') || {}).value,
        minMiddleRoiPercent: ($('alert-mid-roi') || {}).value,
        cooldownSeconds: ($('alert-cooldown') || {}).value,
        includeLive: Boolean($('alert-live') && $('alert-live').checked),
        channels: {
          desktop: Boolean($('alert-desktop') && $('alert-desktop').checked),
          sound: Boolean($('alert-sound') && $('alert-sound').checked),
        },
        quietHours: {
          from: ($('alert-quiet-from') || {}).value,
          to: ($('alert-quiet-to') || {}).value,
          enabled: Boolean($('alert-quiet-enabled') && $('alert-quiet-enabled').checked),
        },
      };
    }

    /**
     * Fill the form from the server's settings.
     *
     * Skips whichever field the user is currently in. A scan-update arrives on
     * its own schedule, and one landing mid-edit is the kind of thing that
     * silently throws away half-typed input.
     */
    function fillAlertForm(prefs) {
      const set = (id, value) => {
        const el = $(id);
        if (!el || el === document.activeElement) return;
        if (el.type === 'checkbox') el.checked = value === true;
        else el.value = value === null || value === undefined ? '' : String(value);
      };
      set('alert-min-roi', prefs.minRoiPercent);
      set('alert-mid-roi', prefs.minMiddleRoiPercent);
      set('alert-cooldown', prefs.cooldownSeconds);
      set('alert-live', prefs.includeLive);
      set('alert-desktop', prefs.channels.desktop);
      set('alert-sound', prefs.channels.sound);
      set('alert-quiet-enabled', prefs.quietHours.enabled);
      set('alert-quiet-from', prefs.quietHours.from);
      set('alert-quiet-to', prefs.quietHours.to);
    }

    /**
     * When the event kicks off, or nothing at all.
     *
     * The engine writes `kickoff` on every opportunity and every middle
     * (src/scanner/engine.mjs:521, 611, 650) and the dashboard's own opportunity
     * row prints it beside the league (public/js/pages/dashboard.js:492). The
     * alert row had the league and no time, so a list of alerts could not say
     * whether the thing it was warning about starts in five minutes or in five
     * days — which is the one question an alert list is asked before it is acted
     * on.
     *
     * Local rather than `arbiterFormat.formatKickoff`, and not by accident: the
     * admin pages do not load /js/format.js, and the object common.js builds for
     * them defines 7 keys, none of them formatKickoff
     * (public/js/pages/common.js:212). This is that function's tolerant parse —
     * a missing or malformed stamp yields '' and never the string "Invalid Date"
     * — and the same `new Date(...).toLocaleString()` the scan's own stamp
     * already takes a few lines below. `Date.parse(undefined)` is already NaN,
     * so the tolerance is the `Number.isFinite` and not a default argument.
     */
    function kickoffLabel(kickoff) {
      const at = Date.parse(kickoff);
      return Number.isFinite(at) ? new Date(at).toLocaleString() : '';
    }

    /**
     * What the arbitrage wins, in money, or nothing at all.
     *
     * `withBankroll` writes `guaranteedProfit: null` on every middle by
     * construction (src/scanner/scanner.mjs:473) — a middle can lose, so there
     * is no guaranteed profit to quote and the cell stays empty rather than
     * showing a zero that reads like a claim. On an arbitrage it is a real
     * number, and the row already prints the stake that number is the profit on
     * while quoting only the percentage above it: 11.31% of 1000 is not
     * something a reader does in their head, and this same page prints the same
     * field for the same signals four hundred lines down.
     *
     * The percentage cannot rebuild it either. Measured over a driven scan the
     * rounded allocation left 113.10 where the guaranteed profit is 113.05, so
     * a reader who worked it out from the two printed numbers would be off by
     * five bani on every row — small, wrong, and wrong in the direction that
     * flatters the trade.
     */
    function profitOnAlert(t, alert) {
      const profit = alert.guaranteedProfit;
      if (profit === null || profit === undefined) return '';
      return `<div class="secondary mono text-xs">${escapeHtml(`${t('guaranteedProfit')} ${Math.round(profit)}`)}</div>`;
    }

    function renderAlerts(payload) {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const counts = payload.counts || { arbitrages: 0, middles: 0 };
      const shown = (payload.alerts.arbitrages || []).concat(payload.alerts.middles || []);
      $('alerts-count').textContent = payload.published
        ? `${counts.arbitrages} ${t('alertsArb')} · ${counts.middles} ${t('alertsMiddle')}`
        : t('alertsNoScan');

      // Where "nothing has been scanned" is told apart from "nothing cleared
      // the thresholds". Without this an empty list reads as a claim about the
      // market, which on a fresh install it is not.
      const truncated = ((payload.truncated || {}).arbitrages || 0) + ((payload.truncated || {}).middles || 0);
      $('alerts-note').textContent = !payload.published
        ? t('alertsNoScanNote')
        : truncated > 0
          ? t('alertsTruncated').replace('{n}', String(truncated))
          : payload.quietNow
            ? t('alertsQuietNow')
            // The event count is the denominator the counts above need. The route
            // published it beside the scan's timestamp for exactly this — see the
            // note at src/router.mjs:278 — and it was the one field of that
            // reference nothing read, so "12 arbitrages" stood alone with nothing
            // to say whether that was a lot or a trickle out of 4 events or 40 000.
            : t('alertsSinceScan')
              .replace('{when}', new Date(payload.scan.scrapedAt).toLocaleString())
              .replace('{count}', Number(payload.scan.eventCount || 0).toLocaleString());

      const body = document.querySelector('#alerts-table tbody');
      if (!shown.length) {
        body.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(payload.published ? t('alertsNone') : t('alertsNoScan'))}</td></tr>`;
        return;
      }
      body.innerHTML = shown.map((a) => `
        <tr>
          <td><div class="strong">${escapeHtml(a.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(a.awayTeam)}</div><div class="secondary"><span class="chip chip-sport">${escapeHtml(a.sport || 'Football')}</span> ${liveBadge(t, a)} ${escapeHtml([a.league, kickoffLabel(a.kickoff)].filter(Boolean).join(' · '))}</div></td>
          <td><div class="mono text-xs">${escapeHtml(a.marketKey || '—')}</div><div class="secondary mono text-xs">${escapeHtml(a.type)}</div></td>
          <td class="num tabnum"><span class="strong ${a.type === 'middle' ? 'purple' : 'green'}">+${(a.roiPercent || 0).toFixed(2)}</span>${profitOnAlert(t, a)}</td>
          <td class="num tabnum">${a.type === 'middle' ? `<span class="yellow">${(a.riskPercent || 0).toFixed(2)}</span>` : '—'}</td>
          <td><div class="secondary">${escapeHtml((a.sourceIds || []).join(' · '))}</div><div class="secondary">${a.totalStake === null || a.totalStake === undefined ? '' : escapeHtml(`${t('alertStake')} ${Math.round(a.totalStake)}`)}</div></td>
          <td>${verificationCell(t, { verification: a.verified ? { status: a.verified } : null })}</td>
        </tr>
      `).join('');
    }

    /**
     * Ask the browser for permission the first time the desktop channel is used.
     *
     * Only from a click, because a permission prompt raised unprompted is one
     * users dismiss without reading and then never get offered again. A refusal
     * is not an error — the banner still runs, and the checkbox now describes
     * what will actually happen.
     */
    async function ensureNotificationPermission() {
      if (!window.Notification || window.Notification.permission !== 'default') return;
      try {
        await window.Notification.requestPermission();
      } catch (err) {
        console.warn('notification permission request failed', err);
      }
    }

    async function saveAlerts() {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const button = $('alerts-save');
      const wanted = readAlertForm();
      if (wanted.channels.desktop) await ensureNotificationPermission();
      if (button) button.disabled = true;
      try {
        // The route answers with the alerts evaluated under the settings just
        // saved, so this one call both persists and re-renders — and cannot
        // render a list computed under thresholds the form no longer shows.
        const payload = await arbiterApi.post('/api/alerts', { preferences: wanted });
        fillAlertForm(payload.preferences);
        renderAlerts(payload);
        if (window.showToast) window.showToast(t('alertsSaved'), 'success');
      } catch (err) {
        console.warn('saving alert settings failed', err);
        if (window.showToast) window.showToast(err.message || t('failedToLoad'), 'error');
      } finally {
        if (button) button.disabled = false;
      }
    }

    /**
     * The notification watcher, if alerts.js made it onto the page.
     *
     * Optional on purpose: the list and the settings form are the feature, and
     * the interruption is an extra. A page that renders nothing because a
     * second script failed to load has traded the useful part for the
     * optional one.
     */
    function alertWatcher() {
      if (_alertWatcher !== null) return _alertWatcher;
      if (!window.arbiterAlerts || typeof window.arbiterAlerts.createAlertWatcher !== 'function') return null;
      _alertWatcher = window.arbiterAlerts.createAlertWatcher({
        deliver: (p) => window.arbiterAlerts.deliverNotification(p, {
          bridge: window.arbiter,
          NotificationApi: window.Notification,
          banner: (x) => window.showToast && window.showToast(`${x.title} — ${x.body}`, 'warning'),
        }),
      });
      return _alertWatcher;
    }

    async function refreshAlerts() {
      const t = arbiterI18n.t.bind(arbiterI18n);
      try {
        const payload = await arbiterApi.get('/api/alerts');
        fillAlertForm(payload.preferences);
        renderAlerts(payload);
        const watcher = alertWatcher();
        if (watcher) {
          watcher.setCooldownSeconds(payload.preferences.cooldownSeconds);
          await watcher.ingest(payload, {
            quiet: payload.quietNow,
            channels: payload.preferences.channels,
          });
        }
      } catch (err) {
        console.warn('alerts unavailable', err);
        $('alerts-note').textContent = err.message || t('failedToLoad');
        $('alerts-count').textContent = '—';
        const body = document.querySelector('#alerts-table tbody');
        if (body) body.innerHTML = `<tr><td colspan="6" class="empty scanner-error">${escapeHtml(err.message || t('failedToLoad'))}</td></tr>`;
      }
    }

    function evMatchLabel(eventKey) {
      const parts = String(eventKey || '').split('|').slice(-2);
      const vs = arbiterI18n.t.bind(arbiterI18n)('vs');
      return parts.map(escapeHtml).join(` <span class="muted">${vs}</span> `);
    }

    function verificationCell(t, o) {
      if (!o.verification) return `<span class="muted text-xs">${escapeHtml(t('unverified'))}</span>`;
      // The status alone is a verdict with no reasoning attached. `reason` is
      // published on every verified signal and was read by nothing, so a
      // rejected row showed a bare "rejected" for what is always a specific
      // sentence — an odds drift with both prices, or the leg that could not be
      // re-quoted. It is the whole explanation of why the trade is not there.
      const reason = o.verification.reason ? ` title="${escapeHtml(o.verification.reason)}"` : '';
      return `<span class="status ${escapeHtml(o.verification.status)}"${reason}>${escapeHtml(o.verification.status)}</span>`;
    }

    /**
     * The four verification counters, as one line.
     *
     * These are the aggregate the per-row status cannot show. A rejected or
     * expired opportunity is not greyed out in these tables — it is gone, so
     * the list only ever shows the ones that survived. Without the counts a
     * trader cannot tell "the run found three good ones" from "the run found
     * three good ones and threw away twenty".
     *
     * `at` is the field that separates the two zeroes: four counters with no
     * `at` mean verification never ran, which is not the same claim as a pass
     * that ran and confirmed nothing.
     */
    function verificationMix(t, summary) {
      const s = summary || {};
      if (!s.at) return t('notVerifiedYet');
      const n = (v) => Number(v || 0).toLocaleString();
      return [t('confirmed'), t('rejected'), t('expired'), t('unverified')]
        .map((label, i) => `${label} ${n([s.confirmed, s.rejected, s.expired, s.unconfirmed][i])}`)
        .join(' · ');
    }

    /**
     * The in-play price window, read from the scan rather than written out.
     *
     * It used to be the literal "90s" in a translation string, which meant the
     * UI asserted a backend constant it had no way to observe. `options` now
     * carries the window the scan actually applied, so changing
     * DEFAULT_LIVE_MAX_AGE_MS changes this line too — and a scan published
     * before the field existed says so instead of guessing.
     */
    function liveWindowNote(t, scan) {
      const ms = Number((scan.options || {}).liveMaxAgeMs);
      if (!Number.isFinite(ms) || ms <= 0) return t('liveWindowUnknown');
      return t('livePreviewNote').replace('{seconds}', String(Math.round(ms / 1000)));
    }

    /**
     * The in-play marker.
     *
     * It reads the signal's own `live`, which the engine takes from the market
     * the price came from — never from the fixture's kickoff. A match whose
     * kickoff is in the past is a pre-match price that has simply gone stale,
     * and badging it LIVE would teach the trader to ignore the one badge whose
     * whole job is to say "this price expires in 90 seconds".
     */
    function liveBadge(t, signal) {
      return signal && signal.live === true
        ? `<span class="chip red live-badge" title="${escapeHtml(t('liveTooltip'))}">${escapeHtml(t('live'))}</span>`
        : '';
    }

    /**
     * The rounding marker, beside the profit it explains.
     *
     * The engine refuses any allocation whose inverse sum is not under 1
     * (market-contracts.mjs:180), so a surviving arbitrage always has a
     * positive theoretical edge — but the stake split it prints is rounded to
     * cents, and an edge smaller than half a cent per leg loses. `roundingRisk`
     * is the engine naming that case, and it is a flag, not a number: the
     * allocation writes it as `guaranteedProfit < 0`.
     *
     * The same flag is already disclosed on the event-detail panel
     * (event-detail-modal.js:380,415), so this is not a new disclosure — it is
     * the one surface that lists arbitrages and did not carry it, which left a
     * row reading +0.00% ROI beside -0.01 profit with nothing connecting them.
     * Measured on the real allocator, the flag is not theoretical: over the
     * thin tail of the inverse sum it fires 40 of 200 allocations at a 1000
     * bankroll and 120 of 200 at a bankroll of 1, and 8 of 36 three-leg arbs.
     *
     * The label and the hint are the two keys the event-detail panel already
     * used for this, so both surfaces say the same thing in both languages. An
     * earlier draft added `roundingRisk` and a `roundingRiskTooltip` here, which
     * was a duplicate key: the object literal is not a syntax error about it,
     * the later entry silently won, and test/i18n-dictionary.test.mjs caught
     * the pair. Reusing the keys was the cheaper fix and the better one.
     */
    function roundingRiskBadge(t, signal) {
      return signal && signal.roundingRisk === true
        ? `<span class="chip yellow" title="${escapeHtml(t('roundingRiskHint'))}">${escapeHtml(t('roundingRisk'))}</span>`
        : '';
    }

    async function init() {
      const [profiles, sportsData] = await Promise.all([
        arbiterApi.get('/api/profiles').then((d) => d.profiles || []),
        arbiterApi.get('/api/sports').then((d) => d.sports || []).catch(() => []),
      ]);
      _sportsData = sportsData;
      $('profile').innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
      $('profile').value = profiles[0]?.id || '';
// Create sport filter dropdown with persistence using common helper
      createDropdown('sport-filter', [{value: '', text: arbiterI18n.t('allSports')}].concat(sportsData.map(s => ({value: s.id, text: s.name}))), {storageKey: 'arbiter.scannerSportFilter'});
      // createDropdown restores the stored value and stores a new one; its own
      // listener draws nothing. This one is what applies the selection — without
      // it the control moved while the tables, the banner and the export links
      // kept the previous sport until the next refresh or scan-update.
      $('sport-filter').addEventListener('change', () => {
        if (_lastScan) render(_lastScan);
      });

      $('profile').addEventListener('change', () => {
        const p = profiles.find((x) => x.id === $('profile').value);
        if (!p) return;
        const d = p.defaults || {};
        if (d.bankroll !== null && d.bankroll !== undefined) $('bankroll').value = d.bankroll;
        if (d.minRoiPercent !== null && d.minRoiPercent !== undefined) $('min-roi').value = d.minRoiPercent;
        if (d.maxMiddleRiskPercent !== null && d.maxMiddleRiskPercent !== undefined) $('mid-risk').value = d.maxMiddleRiskPercent;
        if (d.minMiddleRoiPercent !== null && d.minMiddleRoiPercent !== undefined) $('mid-roi').value = d.minMiddleRoiPercent;
      });
      await Promise.all([refreshPublished(), refreshAlerts()]);
    }

    function setTableState(message, className = 'empty') {
      [['arb-table', 6], ['mid-table', 5], ['ev-table', 7], ['low-table', 5]].forEach(([id, colspan]) => {
        const body = document.querySelector(`#${id} tbody`);
        if (body) body.innerHTML = `<tr><td colspan="${colspan}" class="${className}">${escapeHtml(message)}</td></tr>`;
      });
    }

    function setLoading() {
      [['arb-table', 6], ['mid-table', 5], ['ev-table', 7], ['low-table', 5]].forEach(([id, colspan]) => {
        const body = document.querySelector(`#${id} tbody`);
        if (body) body.innerHTML = `<tr class="loading-row"><td colspan="${colspan}"><span class="skeleton skeleton-line lg">Loading scan results</span></td></tr>`;
      });
    }

    async function refreshPublished() {
      try {
        setLoading();
        render(await arbiterApi.get('/api/scan'));
      } catch (err) {
        const t = arbiterI18n.t.bind(arbiterI18n);
        console.warn('published scan unavailable', err);
        setTableState(err.message || t('failedToLoad'), 'scanner-error');
        $('health-state').textContent = t('failedToLoad');
        $('health-state').className = 'health-error';
      }
    }

    async function previewScan() {
      const button = $('rescan');
      button.disabled = true;
      button.classList.add('pulse');
      setLoading();
      try {
        const sportVal = $('sport-filter').value || undefined;
        const data = await arbiterApi.post('/api/scan', {
          bankroll: Number($('bankroll').value),
          minRoiPercent: Number($('min-roi').value),
          maxMiddleRiskPercent: Number($('mid-risk').value),
          minMiddleRoiPercent: Number($('mid-roi').value),
          includeLive: $('inc-live') ? $('inc-live').checked : false,
          includePast: false,
          ...(sportVal ? { sport: sportVal } : {}),
        });
        render(data);
      } catch (err) {
        console.warn('scan preview failed', err);
        setTableState(err.message || arbiterI18n.t('failedToLoad'), 'scanner-error');
      } finally {
        button.disabled = false;
        button.classList.remove('pulse');
      }
    }

    /**
     * Re-run verification against the published scan.
     *
     * Verification otherwise only ever runs as step 2 of a full scrape, so a
     * confirmation on screen can be hours old — and an arbitrage whose event
     * has since started is no longer an arbitrage. The route re-reads the
     * books for the legs in the published scan, writes the verdicts back into
     * it, and retires confirmations whose event has settled.
     *
     * The response is the verdict counters, not the scan, so the page re-reads
     * /api/scan afterwards rather than rendering what came back. This does not
     * broadcast a scan-update, so the refresh is explicit.
     */
    async function reverifyPublished() {
      const button = $('reverify');
      const t = arbiterI18n.t.bind(arbiterI18n);
      if (!button || button.disabled) return;
      button.disabled = true;
      button.classList.add('pulse');
      const label = button.textContent;
      button.textContent = t('reverifyRunning');
      try {
        const result = await arbiterApi.post('/api/verify', {});
        await refreshPublished();
        const counts = [
          [t('confirmed'), result.confirmed],
          [t('rejected'), result.rejected],
          [t('expired'), result.expired],
          [t('unverified'), result.unconfirmed],
        ].map(([name, n]) => `${name} ${Number(n || 0)}`).join(' · ');
        if (window.showToast) window.showToast(counts, 'success');
      } catch (err) {
        // ENOSCAN is the route saying there is nothing published to verify,
        // which is a state the trader can act on rather than a fault.
        const message = err.code === 'ENOSCAN' ? t('reverifyNoScan') : (err.message || t('reverifyFailed'));
        if (window.showToast) window.showToast(message, 'warning');
        else setTableState(message, 'scanner-error');
      } finally {
        button.disabled = false;
        button.classList.remove('pulse');
        button.textContent = label;
      }
    }

    function filterBySport(items, sport) {
      if (!sport) return items;
      // No default sport. A signal the engine could not classify matches no
      // sport filter, which is a different statement from being football — the
      // fallback this replaced filed every unlabelled signal under football and
      // then reported the filter as having applied.
      return (items || []).filter((o) => String(o.sport || '').toLowerCase() === sport.toLowerCase());
    }

    /**
     * Point the four export links at the selection the tables are drawn under.
     *
     * The `?type=` stays in the markup — the family is fixed per table — while
     * the sport is whatever is selected when the page draws, so it is written
     * here rather than in the href. Without this the two answers disagreed: the
     * table showed the selected sport, the downloaded file held every sport,
     * and nothing on screen said so.
     *
     * An empty selection writes no parameter: the link as shipped, and the same
     * pass-through `filterBySport` applies — no selection means all records.
     */
    function syncExportSport(sport) {
      document.querySelectorAll('a[href*="/api/scan/export.csv"]').forEach((link) => {
        const [path, query = ''] = (link.getAttribute('href') || '').split('?');
        const params = new URLSearchParams(query);
        if (sport) params.set('sport', sport);
        else params.delete('sport');
        const search = params.toString();
        link.setAttribute('href', search ? `${path}?${search}` : path);
      });
    }

    function render(scan) {
      const t = arbiterI18n.t.bind(arbiterI18n);
      _lastScan = scan;
      const health = scan.dataHealth || {};
      const healthStatus = health.status || 'empty';
      const noData = healthStatus !== 'fresh';
      // Whether a scan has ever been published is a different question from how
      // fresh the one on disk is, and only the route can answer it. The served
      // document is the fallback scan when nothing is published, and that
      // fallback mints a `scrapedAt` of now — so without this flag a fresh
      // install shows the moment the page was opened as its "last updated",
      // and the "no fresh data" box below reads as a verdict on stale odds
      // rather than on the fact that nothing has ever run.
      const published = scan.published !== false;

      // Update data-freshness banner (A4)
      if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
        window.arbiterConnectionStatus.setDataHealth(health);
      }
      const healthLabel = healthStatus === 'fresh' ? t('freshSources') : healthStatus;
      $('health-state').textContent = healthLabel;
      $('health-state').className = `health-${escapeHtml(healthStatus)}`;
      $('health-detail').textContent = `${Number(health.actionableSourceCount || 0)} ${t('freshSources')}`;
      // `scrapedAt` is when the observations were captured; `scanStartedAt` is
      // when the scan began reading them. This asked for `scannedAt`, which no
      // scan has ever published, so it silently fell through to the second and
      // showed the start of the pass as the age of the data.
      const capturedAt = scan.scrapedAt || scan.scanStartedAt;
      $('scan-updated').textContent = !published
        ? t('neverRan')
        : capturedAt ? new Date(capturedAt).toLocaleString() : '—';
      $('scan-events').textContent = `${Number(scan.eventCount || 0).toLocaleString()} events`;
      // The settings the published scan was actually produced under, put back
      // into the form that re-runs it. The form carried hardcoded defaults, so
      // a scan published with a 5000 bankroll and a 2% minimum ROI was on screen
      // with its stakes and ROI rendered, and a re-run silently used 1000 and
      // 0 — the reader could not tell which run they were looking at.
      //
      // Seeded once and only from the published document: `render` also draws
      // the preview response, and seeding from that would overwrite whatever is
      // being typed on every scan-update.
      if (published && !_optionsSeeded) {
        _optionsSeeded = true;
        const opts = scan.options || {};
        const put = (id, value) => {
          if (value !== undefined && value !== null && $(id)) $(id).value = value;
        };
        put('bankroll', opts.bankroll);
        put('min-roi', opts.minRoiPercent);
        put('mid-risk', opts.maxMiddleRiskPercent);
        put('mid-roi', opts.minMiddleRoiPercent);
        put('sport-filter', opts.sport);
        if ($('inc-live')) $('inc-live').checked = opts.includeLive === true;
      }
      // Read after the seed, not before it: the block above writes this very
      // select when the published scan was run under a sport. Read first, the
      // control ended up claiming that sport while the tables below were drawn
      // unfiltered and the banner stayed hidden — the page disagreed with itself
      // until the next refresh, which does read the seeded value.
      const activeSport = $('sport-filter')?.value || '';
      // The export links carry the same selection the tables are drawn under.
      syncExportSport(activeSport);
      $('verification-mix').textContent = verificationMix(t, scan.verificationSummary);
      const windowNote = $('live-window-note');
      if (windowNote) windowNote.textContent = liveWindowNote(t, scan);

      const emptyBox = $('scan-empty');
      if (noData && !(scan.opportunities || []).length && !(scan.middles || []).length && !(scan.positiveEv || []).length) {
        emptyBox.className = 'alert warn';
        // Two different messages for two different facts. "No fresh data" is a
        // verdict on odds that were captured and have since gone stale; on an
        // install that has never scraped there are no odds to be stale, and
        // telling the trader to wait for fresher data sends them nowhere.
        emptyBox.innerHTML = published
          ? `${escapeHtml(t('noFreshData'))} <a href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>`
          : `${escapeHtml(t('noPublishedScan'))} <a href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>`;
      } else {
        emptyBox.className = 'hidden';
      }

      // Show active sport filter indicator with display name
      const sportBanner = $('scan-sport-indicator');
      if (sportBanner) {
        if (activeSport) {
          const sportName = _sportsData.find((s) => s.id === activeSport)?.name || activeSport;
          sportBanner.textContent = `${t('sport')}: ${sportName}`;
          sportBanner.className = 'chip chip-sport';
        } else {
          sportBanner.textContent = '';
          sportBanner.className = 'hidden';
        }
      }

      const arb = document.querySelector('#arb-table tbody');
      const opps = filterBySport(scan.opportunities || [], activeSport).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('arb-count').textContent = `${opps.length} ${t('opps')}`;
      $('signal-mix').textContent = `${opps.length} arb · ${(scan.middles || []).length} middle · ${(scan.positiveEv || []).length} EV`;
      arb.innerHTML = opps.length ? opps.map((o) => {
        const cls = o.verification?.status === 'confirmed' ? 'row-confirmed' :
                    o.verification?.status === 'rejected' ? 'row-rejected' : '';
        const legRows = (o.legs || []).map((l) => `
          <tr class="arb-detail-row" style="display:none">
            <td>${escapeHtml(l.sourceId)}</td>
            <td>${escapeHtml(l.selection)}</td>
            <td>${escapeHtml(l.handicap || '—')}</td>
            <td class="num tabnum">${(l.odds || 0).toFixed(2)}</td>
            <td class="num tabnum">${(l.stake || 0).toFixed(0)}</td>
            <td class="num tabnum">${(l.profit || 0).toFixed(2)}</td>
          </tr>
        `).join('');
        return `
        <tr class="arb-main-row ${cls}" data-arb-toggle aria-expanded="false">
          <td>
            <div class="strong">${escapeHtml(o.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(o.awayTeam)}</div>
            <div class="secondary"><span class="chip chip-sport">${escapeHtml(o.sport || 'Football')}</span> ${liveBadge(t, o)} ${escapeHtml(o.league || '')}${o.kickoff ? ` · <span class="mono">${escapeHtml(new Date(o.kickoff).toLocaleString())}</span>` : ''}</div>
          </td>
          <td>
            <div class="mono">${escapeHtml(o.marketKey)}</div>
            <div class="secondary">${(o.legs || []).map((l) => escapeHtml(l.sourceId)).join(' · ')}</div>
          </td>
          <td class="num tabnum"><span class="strong green">+${(o.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${(o.totalStake || 0).toFixed(0)}</td>
          <td class="num tabnum"><span class="strong">${(o.guaranteedProfit || 0).toFixed(2)}</span> ${roundingRiskBadge(t, o)}</td>
          <td>${verificationCell(t, o)}</td>
        </tr>${legRows}`;
      }).join('') : `<tr><td colspan="6" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noArbsFound'))}</td></tr>`;

      const mid = document.querySelector('#mid-table tbody');
      const mids = filterBySport(scan.middles || [], activeSport).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('mid-count').textContent = `${mids.length} ${t('middles')}`;
      mid.innerHTML = mids.length ? mids.map((m) => `
        <tr class="${m.verification?.status === 'confirmed' ? 'row-confirmed' : ''}">
          <td><div class="strong">${escapeHtml(m.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(m.awayTeam)}</div><div class="secondary"><span class="chip chip-sport">${escapeHtml(m.sport || 'Football')}</span> ${liveBadge(t, m)}</div></td>
          <td><div class="mono text-xs market-label">${escapeHtml(m.marketKey || '—')}${Number.isFinite(m.gap) ? `<span class="muted"> · ${escapeHtml(t('gap'))} ${Math.abs(Number(m.gap))}</span>` : ''}</div>${(m.legs || []).map((l) => `<div class="mono text-xs">${escapeHtml(l.sourceId)} ${escapeHtml(l.selection)} ${escapeHtml(l.handicap)} <span class="muted">@</span> <span class="strong">${(l.odds || 0).toFixed(2)}</span></div>`).join('')}</td>
          <td class="num tabnum"><span class="strong purple">+${(m.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum"><span class="yellow">${(m.riskPercent || 0).toFixed(2)}</span></td>
          <td>${verificationCell(t, m)}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noMiddlesFound'))}</td></tr>`;

      const ev = document.querySelector('#ev-table tbody');
      const evs = filterBySport(scan.positiveEv || [], activeSport).sort((a, b) => (b.evPercent || 0) - (a.evPercent || 0)).slice(0, 100);
      ev.innerHTML = evs.length ? evs.map((e) => `
        <tr>
          <td><div class="strong">${evMatchLabel(e.eventKey)} ${liveBadge(t, e)}</div><div class="secondary mono">${escapeHtml(e.marketKey || '—')}</div></td>
          <td>${escapeHtml(e.selection)}</td>
          <td class="mono">${escapeHtml(e.sourceId)}</td>
          <td class="num tabnum">${(e.odds || 0).toFixed(2)}</td>
          <td class="num tabnum"><span class="strong yellow">+${(e.evPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${Number.isFinite(e.consensusProbability) ? (e.consensusProbability * 100).toFixed(1) + '%' : '—'}</td>
          <td class="num tabnum">${(e.legs?.[0]?.stake || 0).toFixed(2)}</td>
        </tr>
      `).join('') : `<tr><td colspan="7" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noEvFound'))}</td></tr>`;

      // Low hold. The engine has published this family on every scan since it
      // was written; until now the only reader was analytics.js counting the
      // array, so a trader could see "12 low hold" on one page and nothing at
      // all on the page the signals belong to.
      //
      // It used to be held out of filterBySport because a low-hold record
      // carried no `sport`, and the helper then defaulted a missing sport to
      // football. findLowHold publishes the event's sport now, so all four
      // families go through the same filter and the low count describes the
      // rows on screen.
      const low = document.querySelector('#low-table tbody');
      const lows = filterBySport(scan.lowHold || [], activeSport)
        .slice().sort((a, b) => Number(a.holdPercent || 0) - Number(b.holdPercent || 0));
      $('low-count').textContent = String(lows.length);
      low.innerHTML = lows.length ? lows.map((l) => `
        <tr>
          <td><div class="strong">${evMatchLabel(l.eventKey)}</div></td>
          <td><div class="mono text-xs">${escapeHtml(l.marketKey || '—')}</div></td>
          <td>${escapeHtml(l.sourceId || '—')}</td>
          <td class="num tabnum">${Number(l.selectionCount || 0)}</td>
          <td class="num tabnum"><span class="strong">${(l.holdPercent || 0).toFixed(2)}</span></td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noLowHoldFound'))}</td></tr>`;

      // Counted across the three tables, because "in-play" is a property of the
      // price and not of the strategy: an in-play middle is just as perishable as
      // an in-play arbitrage. Counted after the sport filter, so the number
      // describes the rows on screen.
      const liveSignals = [...opps, ...mids, ...evs].filter((s) => s.live === true).length;
      const liveCell = $('live-count');
      if (liveCell) {
        liveCell.textContent = String(liveSignals);
        liveCell.className = liveSignals > 0 ? 'text-red' : '';
      }

      // Flash effect on data update (skip first load)
      if (!_isFirstScanLoad) {
        document.querySelectorAll('.summary-item').forEach((el, i) => {
          setTimeout(() => el.classList.add('flash'), i * 40);
          setTimeout(() => el.classList.remove('flash'), 500 + i * 40);
        });
        document.querySelectorAll('.scanner-section').forEach((el, i) => {
          setTimeout(() => el.classList.add('flash'), i * 60);
          setTimeout(() => el.classList.remove('flash'), 700 + i * 60);
        });
      }
      _isFirstScanLoad = false;
    }

    $('rescan').addEventListener('click', previewScan);
    $('reverify').addEventListener('click', reverifyPublished);
    $('alerts-save').addEventListener('click', saveAlerts);

    // Arb table: click to expand/collapse per-leg detail
    document.addEventListener('click', (e) => {
      const mainRow = e.target.closest('tr.arb-main-row');
      if (!mainRow) return;
      const expanded = mainRow.getAttribute('aria-expanded') === 'true';
      mainRow.setAttribute('aria-expanded', String(!expanded));
      const next = mainRow.nextElementSibling;
      if (next && next.classList.contains('arb-detail-row')) {
        next.style.display = expanded ? 'none' : '';
      }
    });
    // A `scan-update` is the only event that can change what clears the alert
    // thresholds, so that is the one that re-reads them. `scrape-update` fires
    // on every book as a run progresses, and re-reading the alerts on each of
    // those would be forty identical requests for a scan that has not been
    // published yet.
    arbiterSse.connect((type) => {
      if (type === 'scan-update') {
        refreshPublished();
        refreshAlerts();
      } else if (type === 'scrape-update') {
        refreshPublished();
      }
    });
    window.arbiterApp.mount('scanner');
    init();
