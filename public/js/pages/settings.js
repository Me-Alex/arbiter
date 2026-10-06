// settings.js — ArbEdge console: the engine settings this app actually owns.
//
// The mockup's Settings page had an Account card (display name, email, plan),
// a Notifications card (four toggles), Trading Preferences, a Bookmaker APIs
// table of masked keys, a Display card, and a Danger Zone that deleted the
// account.
//
// Three of those have no counterpart here and are not imitated. There is no auth
// — admin/login.html says so itself — so there is no account to name, no plan to
// show, and no currency preference, because every amount in the app is EUR (see
// market-contracts.mjs). Nothing anywhere sends email, push, Discord or SMS, so
// four notification toggles would be four switches wired to nothing.
//
// What replaces them are the settings an operator can actually change, in the
// same card shapes: the run the engine performs, the thresholds it reads, the
// sources it reads them from, the one real display choice, and a danger zone
// that deletes stored data instead of an account that does not exist.

(function () {
  arbiterApp.mount('settings');

  const $ = (id) => document.getElementById(id);
  // Local rather than window.arbiterFormat: the harness in
  // test/scan-fields-census.test.mjs runs this file with that global set to null
  // on purpose, to catch a reader that assumes the object exists at load time.
  const count = (n) => Number(n || 0).toLocaleString('en-US');
  const t = (key) => window.arbiterI18n.t(key);
  // window.showToast, guarded. It is the one shared helper eslint does not
  // declare as a global, because a page is allowed to run without it —
  // pages/common.js owns it and analytics.js guards the same call.
  const toast = (message, type, opts) => {
    if (typeof window.showToast === 'function') window.showToast(message, type, opts);
  };

  const state = { scheduler: null, scrapers: null, health: null, sports: null, profiles: null };

  // The sources table is one row per configured bookmaker and there are 26 of
  // them today, which is fine; the cap is here so a config that grows past
  // MAX_ROWS degrades into a stated partial view rather than a slow one.
  const MAX_ROWS = 200;

  // ---- reading the current configuration -----------------------------------

  async function refresh() {
    const settled = await Promise.allSettled([
      arbiterApi.get('/api/scheduler'),
      arbiterApi.get('/api/scrapers'),
      arbiterApi.get('/api/health'),
      arbiterApi.get('/api/sports'),
      // Profiles live in scan-profiles.json and are published by their own
      // route. `GET /api/scrapers` answers with `jobs` and three counters, and
      // no profiles key among them, so reading them off that answer — which is
      // what this page did — left the select permanently empty.
      arbiterApi.get('/api/profiles'),
    ]);
    const [scheduler, scrapers, health, sports, profiles] = settled;

    if (scheduler.status === 'fulfilled') state.scheduler = scheduler.value;
    if (scrapers.status === 'fulfilled') state.scrapers = scrapers.value;
    if (health.status === 'fulfilled') state.health = health.value;
    if (sports.status === 'fulfilled') state.sports = sports.value;
    if (profiles.status === 'fulfilled') state.profiles = profiles.value;

    renderEngine();
    renderFields();
    renderSources();
  }

  function options(list, selected, labelOf) {
    return list.map((item) => {
      const value = typeof item === 'string' ? item : item.id;
      const label = labelOf ? labelOf(item) : value;
      const mark = value === selected ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${mark}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  const profilesList = () => (state.profiles && state.profiles.profiles) || [];

  /**
   * The profile whose own defaults the stored scanOptions already equal.
   *
   * Nothing stores "which profile is active" — the route keeps the resolved
   * numbers, not the name they came from — so the select is refilled from the
   * one profile that would have produced them. It is checked on the profile's
   * keys only: the form's own fields and `sport` sit beside them in the same
   * object and are none of this comparison's business.
   */
  function matchingProfile(scanOptions) {
    return profilesList().find((p) => p.defaults
      && typeof p.defaults === 'object'
      && Object.entries(p.defaults).every(([key, value]) => scanOptions[key] === value)) || null;
  }

  /**
   * What the selected profile adds that this form has no input for.
   *
   * scan-profiles.json carries `maxMiddleRiskPercent`, `minMiddleRoiPercent`
   * and `includeLive` beside the three fields shown here, and the route reads
   * them out of `scanOptions` like every other key — so a profile applied only
   * through the visible inputs would lose exactly the thresholds that
   * distinguish it. The form wins where it has a field, the profile everywhere
   * else.
   */
  function profileDefaults() {
    const id = $('set-profile').value;
    const profile = profilesList().find((p) => p.id === id);
    return profile && profile.defaults && typeof profile.defaults === 'object' ? { ...profile.defaults } : {};
  }

  function renderEngine() {
    const s = state.scheduler || {};
    const on = s.enabled === true;
    $('engine-dot').className = 'status-dot ' + (on ? 'bg-[var(--edge-green)]' : 'bg-[var(--edge-textMuted)]');
    $('engine-dot').setAttribute('aria-hidden', 'true');
    $('engine-state').textContent = on ? t('running') : t('stopped');
    $('set-interval').value = s.intervalMinutes || '';
  }

  function renderFields() {
    const s = state.scheduler || {};
    const books = (state.scrapers && state.scrapers.jobs) || [];
    const profiles = profilesList();

    // A scheduled run is driven by a single book, so this is a select and not a
    // multi-select — but the route forwards `bookIds`, an array, and
    // `scheduler.enable()` refuses an empty one. The stored list is read back
    // through its first entry; there was no `bookId` on the status to read, so
    // this select never showed which book the schedule was set to.
    const scheduledBook = Array.isArray(s.bookIds) && s.bookIds.length ? s.bookIds[0] : '';
    $('set-book').innerHTML = books.length
      ? options(books, scheduledBook, (j) => j.name || j.id)
      : `<option value="">${escapeHtml(t('none'))}</option>`;

    // Profiles are labelled, and they come from /api/profiles — see refresh().
    const profile = matchingProfile(s.scanOptions || {});
    $('set-profile').innerHTML = profiles.length
      ? options(profiles, profile ? profile.id : '', (p) => p.label || p.name || p.id)
      : `<option value="">${escapeHtml(t('none'))}</option>`;

    $('set-lang').innerHTML = options(
      [{ id: 'ro' }, { id: 'en' }],
      window.arbiterI18n.lang,
      (l) => l.id.toUpperCase(),
    );

    const so = s.scanOptions || {};
    $('set-bankroll').value = so.bankroll === undefined ? '' : so.bankroll;
    $('set-min-ev').value = so.minEvPercent === undefined ? '' : so.minEvPercent;
    $('set-max-stake').value = so.maxStake === undefined ? '' : so.maxStake;
    $('set-min-margin').value = so.minMarginPercent === undefined ? '' : so.minMarginPercent;
    $('set-max-age').value = so.maxAgeMinutes === undefined ? '' : so.maxAgeMinutes;
    $('set-include-past').checked = so.includePast === true;
    $('set-include-past-label').textContent = so.includePast === true ? t('enabled') : t('disabled');
    $('set-compact').checked = localStorage.getItem('arbiter-compact') === '1';
  }

  function renderSources() {
    const body = document.getElementById('table-sources');
    if (!body) return;
    const jobs = (state.scrapers && state.scrapers.jobs) || [];
    if (!jobs.length) {
      body.innerHTML = `<tr><td colspan="4"><div class="edge-empty">${escapeHtml(t('noEvents'))}</div></td></tr>`;
      return;
    }
    const shown = Math.min(jobs.length, MAX_ROWS);
    body.innerHTML = jobs.slice(0, MAX_ROWS).map((j) => `<tr>
      <td class="px-3 py-2">
        <div class="text-[var(--edge-textBright)]">${escapeHtml(j.name || j.id)}</div>
        <div class="font-mono text-xs text-[var(--edge-textMuted)]">${escapeHtml(j.id)}</div>
      </td>
      <td class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">${escapeHtml(j.validationStatus || '\u2014')}</td>
      <td class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">${escapeHtml(j.endpointVerifiedAt || '\u2014')}</td>
      <td class="px-3 py-2 text-right">
        <button type="button" class="text-xs text-[var(--edge-blue)] hover:underline focus-ring" data-scrape="${escapeHtml(j.id)}">${escapeHtml(t('scrape'))}</button>
      </td>
    </tr>`).join('')
      + (jobs.length > shown
        ? `<tr><td colspan="4" class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">${count(shown)} ${escapeHtml(t('of'))} ${count(jobs.length)} ${escapeHtml(t('shown'))}</td></tr>`
        : '');
  }

  // ---- writes --------------------------------------------------------------

  function scanOptionsFromForm() {
    const num = (id) => {
      const raw = $(id).value.trim();
      return raw === '' ? undefined : Number(raw);
    };
    const out = {};
    const bankroll = num('set-bankroll');
    const minEv = num('set-min-ev');
    const maxStake = num('set-max-stake');
    const minMargin = num('set-min-margin');
    const maxAge = num('set-max-age');
    if (bankroll !== undefined) out.bankroll = bankroll;
    if (minEv !== undefined) out.minEvPercent = minEv;
    if (maxStake !== undefined) out.maxStake = maxStake;
    if (minMargin !== undefined) out.minMarginPercent = minMargin;
    if (maxAge !== undefined) out.maxAgeMinutes = maxAge;
    out.includePast = $('set-include-past').checked;
    return out;
  }

  // The keys this form has an input for. They are rebuilt on every save, so
  // their stored copies must not survive an empty field — absence is what
  // makes resolveScanRequest fall back to its defaults, and, for `maxStake`
  // and `maxAgeMinutes`, lifts the cap rather than replacing it. Both caps
  // are read now (clamped by clampOptional, applied by the resolver and the
  // scanner), and test/settings-page-wiring.test.mjs pins their readers to
  // exactly those two files so a third cannot arrive unnoticed.
  const FORM_KEYS = ['bankroll', 'minEvPercent', 'maxStake', 'minMarginPercent', 'maxAgeMinutes', 'includePast'];

  function save() {
    const bookIds = $('set-book').value ? [$('set-book').value] : [];
    const enabled = (state.scheduler && state.scheduler.enabled) === true;
    // Refuse before anything is sent when the schedule itself is off. The
    // route answers `enabled: false` with disable(), and disable() keeps the
    // stored scanOptions — so the form would show the operator values the
    // server just declined to take, with nothing on screen to say so. The
    // sentence lives in both dictionaries, and
    // test/settings-page-wiring.test.mjs executes this branch end to end.
    if (!enabled) {
      $('save-state').textContent = t('failedShort');
      toast(t('schedulerDisabledSave'), 'error');
      return Promise.resolve();
    }
    // scheduler.enable() refuses an empty list outright — EBADINPUT, "scheduler
    // requires at least one bookmaker" — and the route only reaches enable()
    // while `enabled` is not false, so an enabled schedule with the book select
    // cleared answered 400 with a message this page never showed. Refuse it
    // here first, in words the operator has (both dictionaries, test 4).
    if (enabled && !bookIds.length) {
      $('save-state').textContent = t('failedShort');
      toast(t('noBookmakersSelected'), 'error');
      return Promise.resolve();
    }
    // Three sources, in order: what the stored options keep — everything this
    // form does not own, `sport` and `maxEvents` included — then the selected
    // profile's defaults, then the form. The form is last because it is the
    // only one of the three whose values are on screen while they are saved.
    const stored = (state.scheduler && state.scheduler.scanOptions) || {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => !FORM_KEYS.includes(key)));
    const payload = {
      enabled,
      intervalMinutes: Number($('set-interval').value) || undefined,
      bookIds,
      scanOptions: { ...kept, ...profileDefaults(), ...scanOptionsFromForm() },
    };
    $('save-state').textContent = t('saving');
    return arbiterApi.post('/api/scheduler', payload)
      .then((saved) => {
        state.scheduler = saved || payload;
        renderEngine();
        $('save-state').textContent = t('saved');
        toast(t('saved'), 'success');
      })
      .catch((err) => {
        $('save-state').textContent = t('failedShort');
        toast((err && err.error && err.error.message) || t('failedShort'), 'error');
      });
  }

  // ---- wiring --------------------------------------------------------------

  const NUMERIC = ['set-interval', 'set-bankroll', 'set-min-ev', 'set-max-stake', 'set-min-margin', 'set-max-age'];
  NUMERIC.concat(['set-book']).forEach((id) => {
    $(id).addEventListener('change', save);
  });

  // Applying a profile is an act of this page, not of the route: no file under
  // src/ reads `profileId`, so there is nothing server-side to apply it to.
  // The profile's numbers are written into the inputs the operator can see and
  // then saved through the same path as any other edit; what this form has no
  // input for — maxMiddleRiskPercent, minMiddleRoiPercent, includeLive — rides
  // along inside scanOptions through profileDefaults().
  $('set-profile').addEventListener('change', () => {
    const d = profileDefaults();
    if (d.bankroll !== undefined) $('set-bankroll').value = d.bankroll;
    if (d.minMarginPercent !== undefined) $('set-min-margin').value = d.minMarginPercent;
    if (d.includePast !== undefined) {
      $('set-include-past').checked = d.includePast === true;
      $('set-include-past-label').textContent = d.includePast === true ? t('enabled') : t('disabled');
    }
    save();
  });

  $('set-include-past').addEventListener('change', (e) => {
    $('set-include-past-label').textContent = e.target.checked ? t('enabled') : t('disabled');
    save();
  });

  $('set-lang').addEventListener('change', (e) => {
    if (e.target.value && e.target.value !== window.arbiterI18n.lang) {
      window.arbiterI18n.setLang(e.target.value);
      location.reload();
    }
  });

  // Compact is a presentation preference with no server-side state, so it is the
  // one setting here stored on the client rather than posted.
  $('set-compact').addEventListener('change', (e) => {
    localStorage.setItem('arbiter-compact', e.target.checked ? '1' : '0');
    toast(t('saved'), 'success', { duration: 1500 });
  });

  // `POST /api/scrape` is the launch route and it takes `bookIds`, not
  // `sourceIds` — a scrape job is selected by the book it captures, which is the
  // id in scrapers.json. Sending the other name would silently start a run over
  // every book instead of the one that was clicked.
  $('btn-scrape-now').addEventListener('click', async () => {
    const bookIds = $('set-book').value ? [$('set-book').value] : [];
    try {
      await arbiterApi.post('/api/scrape', { bookIds });
      toast(t('running'), 'success');
    } catch (err) {
      toast((err && err.error && err.error.message) || t('failedShort'), 'error');
    }
  });

  document.getElementById('table-sources').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-scrape]');
    if (!btn) return;
    try {
      await arbiterApi.post('/api/scrape', { bookIds: [btn.dataset.scrape] });
      toast(btn.dataset.scrape + ' \u2192 ' + t('running'), 'success');
    } catch (err) {
      toast((err && err.error && err.error.message) || t('failedShort'), 'error');
    }
  });

  // The danger zone does not call an endpoint, because there is no route that
  // deletes stored data: src/router.mjs publishes no DELETE and no maintenance
  // POST, and the cleanup that does exist is scripts/cleanup.mjs, run from the
  // CLI. So the button confirms, then hands over the command that does it —
  // which is what an operator actually needs, rather than a 404 dressed as a
  // success.
  $('btn-purge').addEventListener('click', () => {
    if (!window.confirm(t('confirmPurge'))) return;
    $('purge-command').classList.remove('hidden');
    toast(t('purgeCommand'), 'info', { duration: 8000 });
  });

  refresh();

  arbiterSse.connect((type) => {
    if (type === 'scrape-update' || type === 'scan-update') refresh();
  });
})();
