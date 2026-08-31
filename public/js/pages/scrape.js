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

    async function init() {
      scrapers = (await arbiterApi.get('/api/scrapers')).jobs || [];
      profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
      const sel = $('profile');
      sel.innerHTML = profiles.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
      sel.value = profiles[0]?.id || '';
      sel.addEventListener('change', () => applyProfile());
      applyProfile();

      const list = $('bookmaker-list');
      list.innerHTML = scrapers.map((s) => `
        <label class="chip"><input type="checkbox" value="${s.id}" data-source="${s.id}" checked> ${s.name}</label>
      `).join('');
      $('bm-total').textContent = scrapers.length;
      list.addEventListener('change', () => {
        const checked = [...list.querySelectorAll('input[type=checkbox]:checked')].length;
        $('bm-selected').textContent = checked;
        refreshJobRows();
      });

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
    }

    function refreshJobRows() {
      const state = lastState || {};
      const jobs = state.jobs || [];
      const list = $('bookmaker-list');
      const selectedIds = [...list.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
      const rows = $('job-rows');
      const fromState = new Map(jobs.map((j) => [j.id, j]));
      rows.innerHTML = selectedIds.length ? selectedIds.map((id) => {
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
      }).join('') : '<div class="empty">no bookmakers selected</div>';
    }

    function renderState(state) {
      if (!state) return;
      lastState = state;
      const status = state.status || 'idle';
      $('m-status').innerHTML = `<span class="status ${status}">${status}</span>`;
      $('head-status').textContent = status;
      const dot = $('head-dot');
      dot.className = 'dot ' + (status === 'running' ? 'live pulse' : status === 'failed' ? 'error' : status === 'completed' ? 'live' : '');

      const summary = state.summary || {};
      $('m-completed').textContent = summary.completed || 0;
      $('m-failed').textContent = summary.failed || 0;
      $('m-events').textContent = (summary.events || 0).toLocaleString();
      $('m-started').textContent = state.startedAt ? new Date(state.startedAt).toLocaleString() : 'awaiting trigger';
      $('m-finished').textContent = state.finishedAt ? 'finished ' + new Date(state.finishedAt).toLocaleTimeString() : '';
      const failedJobs = (state.jobs || []).filter((j) => !j.valid && j.status !== 'skipped');
      $('m-failed-detail').textContent = failedJobs.length ? failedJobs.map((j) => j.id).slice(0, 3).join(', ') : '';

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
      document.querySelectorAll('.stepper .step').forEach((el, i) => {
        el.classList.remove('active', 'done', 'error');
        if (running && i === idx) el.classList.add('active');
        else if (running && i < idx) el.classList.add('done');
        else if (!running && i === 4) {
          if (status === 'completed') el.classList.add('done');
          else if (status === 'completed-with-errors') el.classList.add('error');
        }
      });

      $('act-line').textContent = state.currentActivity || status;
      const active = jobs.find((j) => j.status === 'running');
      $('act-book').textContent = active ? active.id : '—';
      $('act-qf').textContent = `${done} / ${total}`;
      $('act-events').textContent = `${(summary.events || 0).toLocaleString()} / ${jobs.reduce((acc, j) => acc + (j.events || 0), 0).toLocaleString()}`;
      $('act-profile').innerHTML = state.options?.minRoiPercent !== undefined
        ? `<span class="chip ${Number(state.options.minRoiPercent) > 0 ? 'yellow' : 'green'}">${Number(state.options.minRoiPercent) > 0 ? 'Review' : 'Trusted'}</span>`
        : '—';
      $('act-runid').textContent = state.runId ? state.runId.slice(0, 19) : '—';

      const errBox = $('error-box');
      if (!running && state.error) {
        errBox.classList.remove('hidden');
        errBox.textContent = `${state.error.name}: ${state.error.message}`;
      } else if (!running && status === 'completed-with-errors') {
        errBox.classList.remove('hidden');
        errBox.textContent = `Scrape finished with errors. ${(state.jobs || []).filter(j => !j.valid).length} job(s) failed.`;
      } else {
        errBox.classList.add('hidden');
      }

      refreshJobRows();
    }

    async function refreshLastRun() {
      try {
        const run = await arbiterApi.get('/api/scrape-run');
        const tbody = document.querySelector('#last-run-table');
        if (!run || !run.jobs) {
          tbody.innerHTML = '<tr><td colspan="4" class="muted">no run yet</td></tr>';
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
        $('m-arb-summary').textContent = `opps: ${opps}`;
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
        const s = await arbiterApi.get('/api/scheduler');
        $('sched-enabled').checked = !!s.enabled;
        $('sched-interval').value = s.intervalMinutes || 15;
        $('sched-last').textContent = s.lastRun
          ? `last run: ${new Date(s.lastRun.at).toLocaleString()} (${s.lastRun.ok ? 'ok' : 'failed'})`
          : 'never ran';
        if (s.lastError) $('sched-last').textContent += ` · last error: ${s.lastError.message}`;
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
      };
      try {
        log(`starting scrape: ${bookIds.length} books, bankroll=${scanOptions.bankroll}`, 'info', 'orchestrator');
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
    $('save-btn').addEventListener('click', () => log('defaults are defined by the selected profile and applied when a scrape starts', 'info'));
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
      }
    });

    init();
