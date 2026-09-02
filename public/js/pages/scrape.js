arbiterApp.mount('scrape');

    const $ = (id) => document.getElementById(id);
    const log = (line, level = 'info', tag = null) => {
      const el = document.createElement('div');
      el.className = 'line ' + level;
      const t = new Date().toLocaleTimeString();
      const tagEl = tag ? `<span class="tag">${tag}</span>` : '';
      el.innerHTML = `<span class="time">${t}</span>${tagEl}<span style="flex:1">${line}</span>`;
      const panel = $('log-panel');
      panel.appendChild(el);
      panel.scrollTop = panel.scrollHeight;
      while (panel.childNodes.length > 500) panel.removeChild(panel.firstChild);
    };

    let lastState = null;
    let scrapers = [];
    let profiles = [];
    let validatedIds = new Set();
    let selectedIds = new Set();
    let jobById = new Map();

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      })[char]);
    }

    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const s = Math.round(ms / 1000);
      if (s < 1) return `${ms}ms`;
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r ? `${m}m ${r}s` : `${m}m`;
    }

    function statusDotClass(job) {
      if (!job) return '';
      if (job.status === 'ok') return 'live';
      if (job.status === 'running') return 'busy';
      if (['failed', 'timeout', 'unknown'].includes(job.status)) return 'error';
      return '';
    }

    function renderBookmakerChips() {
      const byGroup = { validated: [], experimental: [] };
      for (const s of scrapers) {
        (validatedIds.has(s.id) ? byGroup.validated : byGroup.experimental).push(s);
      }
      const sortByName = (a, b) => (a.name || a.id).localeCompare(b.name || b.id);
      byGroup.validated.sort(sortByName);
      byGroup.experimental.sort(sortByName);

      const chip = (s) => {
        const validated = validatedIds.has(s.id);
        const status = s.validationStatus || 'experimental';
        const reason = s.validationReason || (validated ? 'validated real-data source' : 'experimental source');
        const job = jobById.get(s.id);
        const dot = `<span class="dot ${statusDotClass(job)}"></span>`;
        const ev = `<span class="muted ev" ${job && job.events ? '' : 'hidden'}>${job && job.events ? job.events.toLocaleString() : ''} ev</span>`;
        return `<label class="chip ${validated ? 'green' : ''}" title="${escapeHtml(reason)}">
          <input type="checkbox" value="${escapeHtml(s.id)}" data-source="${escapeHtml(s.id)}" ${selectedIds.has(s.id) ? 'checked' : ''}>
          ${dot}
          <span class="name">${escapeHtml(s.name)} · ${escapeHtml(status)}</span>
          ${ev}
        </label>`;
      };
      const group = (title, items) => `
        <div class="chip-group" style="width:100%;min-width:100%">
          <div class="muted text-xs chip-group-title" style="margin:10px 0 6px;letter-spacing:0.06em;text-transform:uppercase">${title} <span class="tabnum">${items.length}</span></div>
          <div class="row" style="gap:6px;flex-wrap:wrap">${items.map(chip).join('')}</div>
        </div>`;
      const t = window.arbiterI18n.t.bind(window.arbiterI18n);
      $('bookmaker-list').innerHTML =
        group(t('validatedGroup'), byGroup.validated) +
        group(t('experimentalGroup'), byGroup.experimental);

      updateSelectionCounts();
    }

    function updateSelectionCounts() {
      $('bm-selected').textContent = selectedIds.size;
      $('bm-total').textContent = scrapers.length;
      refreshJobRows();
    }

    function updateChipStatus(jobs) {
      if (!Array.isArray(jobs)) return;
      jobById = new Map(jobs.map((j) => [j.id, j]));
      const list = $('bookmaker-list');
      if (!list) return;
      for (const s of scrapers) {
        const label = list.querySelector(`label.chip input[data-source="${s.id}"]`)?.closest('label');
        if (!label) continue;
        const dot = label.querySelector('.dot');
        const job = jobById.get(s.id);
        if (dot) dot.className = 'dot ' + statusDotClass(job);
        const ev = label.querySelector('.ev');
        if (ev) {
          ev.hidden = !(job && job.events);
          ev.textContent = job && job.events ? `${job.events.toLocaleString()} ev` : '';
        }
      }
    }

    async function init() {
      const scraperResponse = await arbiterApi.get('/api/scrapers');
      scrapers = scraperResponse.jobs || [];
      validatedIds = new Set((scraperResponse.validatedJobs || []).map((scraper) => scraper.id));
      selectedIds = new Set(scrapers.filter((s) => s.enabled !== false).map((s) => s.id));
      profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
      const sel = $('profile');
      sel.innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
      sel.value = profiles[0]?.id || '';
      sel.addEventListener('change', () => applyProfile());
      applyProfile();

      if ($('max-events')) {
        $('max-events').addEventListener('change', () => { $('max-events').dataset.userSet = '1'; });
      }
      renderBookmakerChips();
      const list = $('bookmaker-list');
      list.addEventListener('change', () => {
        selectedIds = new Set([...list.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value));
        updateSelectionCounts();
      });

      const btnAll = $('btn-select-all');
      if (btnAll) {
        btnAll.addEventListener('click', () => {
          list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
            selectedIds.add(cb.value);
            cb.checked = true;
          });
          updateSelectionCounts();
        });
      }
      const btnVal = $('btn-select-validated');
      if (btnVal) {
        btnVal.addEventListener('click', () => {
          list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
            cb.checked = validatedIds.has(cb.value);
            if (cb.checked) selectedIds.add(cb.value);
            else selectedIds.delete(cb.value);
          });
          updateSelectionCounts();
        });
      }
      const btnNone = $('btn-select-none');
      if (btnNone) {
        btnNone.addEventListener('click', () => {
          list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
          selectedIds.clear();
          updateSelectionCounts();
        });
      }

      const state = (await arbiterApi.get('/api/scrape/state')).state;
      lastState = state;
      renderState(state);
      refreshJobRows();
      refreshLastRun();
      refreshRecent();
      refreshScheduler();
    }

    function applyProfile() {
      const p = profiles.find((x) => x.id === $('profile').value);
      if (!p || !p.defaults) return;
      $('bankroll').value = p.defaults.bankroll;
      $('min-roi').value = p.defaults.minRoiPercent;
      $('mid-risk').value = p.defaults.maxMiddleRiskPercent;
      $('mid-roi').value = p.defaults.minMiddleRoiPercent;
        $('inc-live').checked = !!p.defaults.includeLive;
      $('inc-past').checked = !!p.defaults.includePast;
      if ($('max-events') && !$('max-events').dataset.userSet) {
        $('max-events').value = p.defaults.maxEvents === undefined ? 'all' : String(p.defaults.maxEvents);
      }
    }

  function selectedMaxEvents() {
    const value = String($('max-events')?.value || 'all').trim().toLowerCase();
    if (value === 'all') return 'all';
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 'all';
  }

    function refreshJobRows() {
      const t = window.arbiterI18n.t.bind(window.arbiterI18n);
      const state = lastState || {};
      const jobs = state.jobs || [];
      const rows = $('job-rows');
      const fromState = new Map(jobs.map((j) => [j.id, j]));
      rows.innerHTML = selectedIds.size ? [...selectedIds].map((id) => {
        const j = fromState.get(id) || { id, status: 'pending', events: 0, durationMs: 0 };
        const evs = j.events || 0;
        const ms = j.durationMs || 0;
        return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="mono strong">${id}</span>
          <span class="status ${j.status}">${j.status}</span>
          <span class="spacer"></span>
          <span class="muted mono">${evs} ev</span>
          <span class="muted mono" style="min-width:60px;text-align:right">${ms}ms</span>
        </div>`;
      }).join('') : `<div class="empty">${escapeHtml(t('noBookmakersSelected'))}</div>`;
    }

    function renderState(state) {
      if (!state) return;
      lastState = state;
      const status = state.status || 'idle';

      const summary = state.summary || {};
      const t = window.arbiterI18n.t.bind(window.arbiterI18n);
      const statusLabel = status === 'completed-with-errors' ? t('completedWithErrors')
        : status === 'completed' ? t('completedClean')
          : status === 'failed' ? t('statusFailed')
            : status;
      $('m-status').innerHTML = `<span class="status ${status}" title="${status}">${statusLabel}</span>`;
      $('head-status').textContent = statusLabel;
      const dot = $('head-dot');
      dot.className = 'dot ' + (status === 'running' ? 'live pulse' : status === 'failed' ? 'error' : status === 'completed' ? 'live' : '');

      $('m-completed').textContent = summary.completed || 0;
      const failed = summary.failed || 0;
      $('m-failed').textContent = failed;
      $('m-failed').className = `value tabnum ${failed > 0 ? 'red' : 'green'}`;
      $('m-events').textContent = (summary.events || 0).toLocaleString();
      $('m-started').textContent = state.startedAt ? new Date(state.startedAt).toLocaleString() : t('awaitingTrigger');
      $('m-finished').textContent = state.finishedAt ? t('finished') + ' ' + new Date(state.finishedAt).toLocaleTimeString() : '';
      const failedJobs = (state.jobs || []).filter((j) => !j.valid && j.status !== 'skipped');
      const shownFailed = failedJobs.slice(0, 3).map((j) => j.id).join(', ');
      const moreFailed = failedJobs.length - 3;
      $('m-failed-detail').textContent = failedJobs.length
        ? (failedJobs.length > 3 ? `${shownFailed} · ${moreFailed} ${t('moreShort')}` : shownFailed)
        : '';
      $('m-failed-detail').title = failedJobs.map((j) => j.id).join(', ');

      const running = status === 'running';
      $('progress-card').style.display = running ? '' : 'none';
      const jobs = state.jobs || [];
      const total = jobs.length || 1;
      const done = jobs.filter((j) => j.status === 'ok' || j.status === 'failed' || j.status === 'skipped' || j.status === 'timeout' || j.status === 'locked').length;
      const pct = Math.round((done / total) * 100);
      $('progress-bar').style.right = `${100 - pct}%`;
      $('progress-pct').textContent = `${pct}%`;
      $('progress-activity').textContent = state.currentActivity || '—';

      const idx = state.currentStep?.index;
      const terminal = !running && (status === 'completed' || status === 'completed-with-errors');
      document.querySelectorAll('.stepper .step').forEach((el, i) => {
        el.classList.remove('active', 'done', 'error');
        if (running && i === idx) el.classList.add('active');
        else if (running && i < idx) el.classList.add('done');
        else if (terminal && i < 4) el.classList.add('done');
        else if (terminal && i === 4) el.classList.add(status === 'completed' ? 'done' : 'error');
        else if (!running && status === 'failed' && i === 4) el.classList.add('error');
      });

      // Terminal step label reflects the actual outcome, not a fixed word.
      const stepLabel = $('step-complete');
      if (stepLabel) {
        stepLabel.textContent = !running && status === 'completed-with-errors'
          ? t('completedWithErrors')
          : !running && status === 'failed' ? t('statusFailed') : t('complete');
      }

      // Human-readable activity line instead of the raw status string.
      const nonFinal = ['idle'].includes(status);
      $('act-line').textContent = running
        ? state.currentActivity || t('scraping')
        : nonFinal ? status
          : status === 'completed-with-errors' ? `${summary.completed || 0} ${t('okShort')} · ${summary.failed || 0} ${t('failedShort')}`
            : status === 'completed' ? t('completedClean')
              : status === 'failed' ? t('statusFailed') : state.currentActivity || status;

      const active = jobs.find((j) => j.status === 'running');
      $('act-book').textContent = active ? active.id : '—';
      $('act-qf').textContent = `${done} / ${total}`;
      $('act-events').textContent = (summary.events || 0).toLocaleString();

      const ok = jobs.filter((j) => j.status === 'ok').length;
      const failedCount = jobs.filter((j) => !j.valid && j.status !== 'skipped').length;
      const res = $('act-result');
      if (running) {
        res.innerHTML = `<span class="chip ${ok > 0 ? 'green' : ''}">${ok} ${t('okShort')}</span> <span class="chip ${failedCount > 0 ? 'red' : ''}">${failedCount} ${t('failedShort')}</span>`;
      } else if (status === 'completed' || status === 'completed-with-errors') {
        res.innerHTML = `<span class="chip green">${ok} ${t('okShort')}</span> <span class="chip ${failedCount > 0 ? 'red' : 'green'}">${failedCount} ${t('failedShort')}</span>`;
      } else {
        res.textContent = '—';
      }

      $('act-profile').innerHTML = state.options?.minRoiPercent !== undefined
        ? `<span class="chip ${Number(state.options.minRoiPercent) > 0 ? 'yellow' : 'green'}">${Number(state.options.minRoiPercent) > 0 ? t('review') : t('trusted')}</span>`
        : '—';
      $('act-runid').textContent = state.runId ? state.runId.slice(0, 19) : '—';
      const dur = $('act-duration');
      if (dur) {
        dur.textContent = (state.startedAt && state.finishedAt)
          ? `ran ${fmtDuration(Date.parse(state.finishedAt) - Date.parse(state.startedAt))}`
          : '';
      }

      const errBox = $('error-box');
      if (!running && state.error) {
        errBox.className = 'alert';
        errBox.innerHTML = `${escapeHtml(state.error.name)}: ${escapeHtml(state.error.message)}`;
      } else if (!running && status === 'completed-with-errors') {
        const failedCount = (state.jobs || []).filter((j) => !j.valid).length;
        errBox.className = 'alert warn';
        errBox.innerHTML =
          `${escapeHtml(`${t('scrapeErrorsPrefix')} ${failedCount} ${t('jobsFailed')}`)} `
          + `<a href="#job-rows">${escapeHtml(t('viewFailedJobs'))}</a>`;
      } else {
        errBox.className = 'alert hidden';
      }

      updateChipStatus(jobs);
      refreshJobRows();
    }

    async function refreshLastRun() {
      try {
        const t = window.arbiterI18n.t.bind(window.arbiterI18n);
        const run = await arbiterApi.get('/api/scrape-run');
        const tbody = document.querySelector('#last-run-table');
        if (!run || !run.jobs) {
          tbody.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(t('noRunYet'))}</td></tr>`;
          return;
        }
        tbody.innerHTML = run.jobs.map((j) => `
          <tr>
            <td class="mono">${j.id}</td>
            <td class="num tabnum">${(j.events || 0).toLocaleString()}</td>
            <td class="num tabnum">${j.durationMs || 0}</td>
            <td><span class="status ${j.status}">${j.status}</span>${j.error ? ` <span class="muted mono">${j.error.code || ''}</span>` : ''}</td>
          </tr>
        `).join('');
        const opps = run.opportunitiesCount || 0;
        $('m-arb-summary').textContent = `${t('opps')}: ${opps}`;
      } catch (_err) { /* ignore */ }
    }

    async function refreshRecent() {
      try {
        const tbl = document.querySelector('#recent-table');
        tbl.innerHTML = '<tr><td colspan="5" class="muted">—</td></tr>';
      } catch (_e) { /* ignore */ }
    }

    async function refreshScheduler() {
      try {
        const t = window.arbiterI18n.t.bind(window.arbiterI18n);
        const s = await arbiterApi.get('/api/scheduler');
        $('sched-enabled').checked = !!s.enabled;
        $('sched-interval').value = s.intervalMinutes || 15;
        $('sched-last').textContent = s.lastRun
          ? `${t('lastRun')}: ${new Date(s.lastRun.at).toLocaleString()} (${s.lastRun.ok ? t('okShort') : t('failedShort')})`
          : t('neverRan');
        if (s.lastError) $('sched-last').textContent += ` · ${t('lastError')}: ${s.lastError.message}`;
      } catch (_e) { /* ignore */ }
    }

    $('run-btn').addEventListener('click', async () => {
      const bookIds = [...document.querySelectorAll('#bookmaker-list input:checked')].map((c) => c.value);
      const scanOptions = {
        bankroll: Number($('bankroll').value),
        minRoiPercent: Number($('min-roi').value),
        maxMiddleRiskPercent: Number($('mid-risk').value),
        minMiddleRoiPercent: Number($('mid-roi').value),
        includeLive: $('inc-live').checked,
        includePast: $('inc-past').checked,
        maxEvents: selectedMaxEvents(),
      };
      try {
        log(`starting scrape: ${bookIds.length} books, max events=${scanOptions.maxEvents}`, 'info', 'orchestrator');
        await arbiterApi.post('/api/scrape', { bookIds, scanOptions });
      } catch (err) {
        log(`failed to launch: ${err.message}`, 'error', 'orchestrator');
      }
    });
    $('cancel-btn').addEventListener('click', async () => {
      try {
        const result = await arbiterApi.post('/api/scrape/cancel', {});
        log(result.cancelled ? 'cancellation requested' : 'no active scrape to cancel', result.cancelled ? 'warn' : 'info', 'orchestrator');
      } catch (err) {
        log(err.message || 'unable to cancel scrape', 'error', 'orchestrator');
      }
    });
    $('save-btn').addEventListener('click', () => log(window.arbiterI18n.t('profileDefaultsNote'), 'info'));
    $('sched-save').addEventListener('click', async () => {
      const enabled = $('sched-enabled').checked;
      const intervalMinutes = Number($('sched-interval').value);
      const bookIds = [...document.querySelectorAll('#bookmaker-list input:checked')].map((checkbox) => checkbox.value);
      const scanOptions = {
        bankroll: Number($('bankroll').value),
        minRoiPercent: Number($('min-roi').value),
        maxMiddleRiskPercent: Number($('mid-risk').value),
        minMiddleRoiPercent: Number($('mid-roi').value),
        includeLive: $('inc-live').checked,
        includePast: $('inc-past').checked,
        maxEvents: selectedMaxEvents(),
      };
      try {
        await arbiterApi.post('/api/scheduler', { enabled, intervalMinutes, bookIds, scanOptions });
        log(`scheduler ${enabled ? 'enabled' : 'disabled'} (${intervalMinutes}m)`, 'success', 'scheduler');
        refreshScheduler();
      } catch (err) {
        log(err.message || 'unable to save scheduler', 'error', 'scheduler');
      }
    });

    arbiterSse.connect((type, payload) => {
      if (type === 'scrape-update') {
        renderState(payload);
        if (payload.currentActivity) log(payload.currentActivity, 'info', 'pipeline');
      } else if (type === 'job-complete') {
        const r = payload.result || {};
        log(`${r.id} ${r.valid ? 'ok' : 'failed'} (${r.events || 0} events, ${r.durationMs || 0}ms)`, r.valid ? 'success' : 'warn', r.id);
        refreshLastRun();
      } else if (type === 'scan-update') {
        log(`scan: ${payload.opportunities} opps, ${payload.middles} middles`, 'success', 'engine');
        const t = window.arbiterI18n.t.bind(window.arbiterI18n);
        $('m-arb-summary').textContent = `${t('opps')}: ${payload.opportunities} · ${t('middles')}: ${payload.middles}`;
      }
    });

    init();
