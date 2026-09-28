/* global createDropdown */
const $ = (id) => document.getElementById(id);

/**
 * Cap on log-panel DOM nodes; oldest lines evicted beyond this.
 * @const {number}
 */
const MAX_LOG_LINES = 500;

let _isFirstScrapeLoad = true;
let _sse = null;

const log = (line, level = 'info', tag = null) => {
  const el = document.createElement('div');
  el.className = 'line ' + level;
  const t = escapeHtml(new Date().toLocaleTimeString());
  const tagEl = tag ? `<span class="tag">${escapeHtml(tag)}</span>` : '';
  el.innerHTML = `<span class="time">${t}</span>${tagEl}<span class="log-line-flex">${escapeHtml(line)}</span>`;
  const panel = $('log-panel');
  panel.appendChild(el);
  // Only a problem is worth pulling the user into the log for. The old `|| !tag`
  // clause also fired on ordinary informational lines that happened to be
  // untagged, so the panel popped open during a healthy run.
  if (level === 'error' || level === 'warn') {
    const details = panel.closest('details');
    if (details) details.open = true;
  }
  panel.scrollTop = panel.scrollHeight;
  while (panel.childNodes.length > MAX_LOG_LINES) panel.removeChild(panel.firstChild);
};

let lastState = null;
let scrapers = [];
let profiles = [];
let validatedIds = new Set();
let selectedIds = new Set();
let jobById = new Map();
let launchPending = false;

function isFailedJob(job) {
  return !['pending', 'running', 'skipped', 'cancelled'].includes(job.status)
    && (job.valid === false || ['failed', 'timeout', 'locked', 'unknown'].includes(job.status));
}

function updateRunControls() {
  const busy = ['running', 'cancelling'].includes(lastState?.status);
  $('run-btn').disabled = launchPending || busy || !selectedIds.size;
  $('cancel-btn').disabled = lastState?.status !== 'running';
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function countUp(el, to, locale = false) {
  if (!el) return;
  const from = Number(el.dataset.prev || 0);
  if (from === to) { el.textContent = locale ? to.toLocaleString() : to; return; }
  el.dataset.prev = to;
  if (reducedMotion()) { el.textContent = locale ? to.toLocaleString() : to; return; }
  const start = performance.now();
  const dur = 450;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    const ease = 1 - Math.pow(1 - k, 3);
    const val = from + (to - from) * ease;
    el.textContent = locale ? Math.round(val).toLocaleString() : String(Math.round(val));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

/**
 * Count jobs that have reached a terminal state (used for progress %).
 * @param {Array<object>} jobs
 * @returns {number}
 */
function countDoneJobs(jobs) {
  return jobs.filter((j) => j.status === 'ok' || j.status === 'failed' || j.status === 'skipped' || j.status === 'timeout' || j.status === 'locked').length;
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
    return `<label class="chip ${validated ? 'green' : ''}" title="${escapeHtml(reason)}" data-name="${escapeHtml((s.name || s.id).toLowerCase())}">
      <input type="checkbox" value="${escapeHtml(s.id)}" data-source="${escapeHtml(s.id)}" ${selectedIds.has(s.id) ? 'checked' : ''}>
      ${dot}
      <span class="name">${escapeHtml(s.name)} · ${escapeHtml(status)}</span>
      ${ev}
    </label>`;
  };

  const group = (title, items, groupKey, open = true) => {
    const allChecked = items.length > 0 && items.every((s) => selectedIds.has(s.id));
    const noneChecked = items.every((s) => !selectedIds.has(s.id));
    const stateCls = allChecked ? ' all-checked' : noneChecked ? ' none-checked' : ' some-checked';
    return `<div class="chip-group chip-group-full" data-group="${groupKey}">
      <div class="chip-group-head">
        <button type="button" class="chip-group-toggle" aria-expanded="${open}" aria-controls="group-${groupKey}">
          <svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          <span class="group-title">${escapeHtml(title)}</span> <span class="tabnum group-count">${items.length}</span>
        </button>
        <label class="group-select${stateCls}" title="Toggle group">
          <input type="checkbox" aria-label="${escapeHtml(title)}" data-group-check="${groupKey}" ${allChecked ? 'checked' : ''}>
          <span class="group-selected-count"></span>
        </label>
      </div>
      <div class="chip-row-wrap row" id="group-${groupKey}" ${open ? '' : 'hidden'}>${items.map(chip).join('')}</div>
    </div>`;
  };

  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  // Render validated group first
  let html = '';
  html += group(t('validatedGroup'), byGroup.validated, 'validated', true);
  // Only render experimental group if it has items
  if (byGroup.experimental.length > 0) {
    html += group(t('experimentalGroup'), byGroup.experimental, 'experimental', false);
  }
  $('bookmaker-list').innerHTML = html;

  // Wire group toggle buttons (collapse/expand)
  $('bookmaker-list').querySelectorAll('.chip-group-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const groupId = btn.getAttribute('aria-controls');
      const body = document.getElementById(groupId);
      if (!body) return;
      const open = body.hidden;
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  // Wire group-select checkboxes
  $('bookmaker-list').querySelectorAll('[data-group-check]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const groupId = cb.getAttribute('data-group-check');
      const body = document.getElementById(`group-${groupId}`);
      const chips = body ? body.querySelectorAll('input[type=checkbox]') : [];
      chips.forEach((el) => {
        const id = el.value;
        if (cb.checked) {
          selectedIds.add(id);
          el.checked = true;
        } else {
          selectedIds.delete(id);
          el.checked = false;
        }
      });
      updateSelectionCounts();
      updateGroupSelectState();
    });
  });

  // Wire live filter box
  const filterInput = $('bm-filter');
  if (filterInput) {
    filterInput.oninput = () => {
      const q = filterInput.value.trim().toLowerCase();
      document.querySelectorAll('#bookmaker-list .chip-group').forEach((grp) => {
        let anyVisible = false;
        grp.querySelectorAll('label.chip').forEach((el) => {
          const name = el.getAttribute('data-name') || el.textContent.toLowerCase();
          const match = !q || name.includes(q);
          el.hidden = !match;
          if (match) anyVisible = true;
        });
        const body = grp.querySelector('.chip-row-wrap');
        const toggle = grp.querySelector('.chip-group-toggle');
        if (q && !body.dataset.beforeSearch) body.dataset.beforeSearch = toggle.getAttribute('aria-expanded');
        if (q && anyVisible) { body.hidden = false; toggle.setAttribute('aria-expanded', 'true'); }
        if (!q && body.dataset.beforeSearch) {
          body.hidden = body.dataset.beforeSearch !== 'true';
          toggle.setAttribute('aria-expanded', body.dataset.beforeSearch);
          delete body.dataset.beforeSearch;
        }
        grp.hidden = !anyVisible;
      });
    };
    filterInput.oninput();
  }

  updateSelectionCounts();
  updateGroupSelectState();
}

function updateGroupSelectState() {
  document.querySelectorAll('#bookmaker-list .chip-group').forEach((grp) => {
    const body = grp.querySelector('.chip-row-wrap');
    if (!body) return;
    const chips = body.querySelectorAll('input[type=checkbox]');
    const groupCheck = grp.querySelector('[data-group-check]');
    if (!groupCheck || !chips.length) return;
    const checked = [...chips].filter((c) => c.checked).length;
    const allChecked = checked === chips.length;
    groupCheck.checked = allChecked;
    groupCheck.indeterminate = checked > 0 && !allChecked;
    const label = groupCheck.closest('.group-select');
    label.className = `group-select ${allChecked ? 'all-checked' : checked === 0 ? 'none-checked' : 'some-checked'}`;
    const count = label.querySelector('.group-selected-count');
    if (count) count.textContent = allChecked ? `${chips.length}/${chips.length}` : `${checked}/${chips.length}`;
  });
}

function updateSelectionCounts() {
  $('bm-selected').textContent = selectedIds.size;
  $('bm-total').textContent = scrapers.length;
  refreshJobRows();
  updateGroupSelectState();
  updateRunControls();
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
    if (dot) {
      const prevClass = dot.className;
      const newClass = 'dot ' + statusDotClass(job);
      dot.className = newClass;
      // Pop the dot when status actually changes, briefly (skip under reduced motion)
      if (prevClass !== newClass && !reducedMotion()) {
        dot.classList.add('pop');
        setTimeout(() => dot.classList.remove('pop'), 500);
      }
    }
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
  // Select only what the orchestrator will actually run.
  //
  // The promotion gate in src/scrape-orchestrator.mjs excludes a job whose
  // validationStatus is not "validated", so selecting on `enabled` alone ticked
  // jobs that were then dropped server-side. The run reported success over
  // N-1 books with no notice — the same "reports an unavailable source as an
  // empty one" failure the project's own rules refuse. Keep this predicate in
  // step with the orchestrator's.
  selectedIds = new Set(
    scrapers.filter((s) => s.enabled !== false && validatedIds.has(s.id)).map((s) => s.id)
  );
  profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
  const sel = $('profile');
  sel.innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
  sel.value = profiles[0]?.id || '';
  sel.addEventListener('change', () => applyProfile());
  applyProfile();

  // Populate sport filter dropdown using common helper
  try {
    const sportsRes = await arbiterApi.get('/api/sports');
    createDropdown('sport-filter', [{value: '', text: arbiterI18n.t('allSports')}].concat(sportsRes.sports.map(s => ({value: s.id, text: s.name}))), {storageKey: 'arbiter.scrapeSportFilter'});
    // No further handling needed; createDropdown restores value and persists changes.
  } catch (_) { /* sport endpoint optional */ }

  if ($('max-events')) {
    $('max-events').addEventListener('change', () => { $('max-events').dataset.userSet = '1'; });
  }
  renderBookmakerChips();
  const list = $('bookmaker-list');
  list.addEventListener('change', () => {
    selectedIds = new Set([...list.querySelectorAll('input[data-source]:checked')].map((c) => c.value));
    updateSelectionCounts();
  });

  const btnAll = $('btn-select-all');
  if (btnAll) {
    btnAll.addEventListener('click', () => {
      list.querySelectorAll('input[data-source]').forEach((cb) => {
        selectedIds.add(cb.value);
        cb.checked = true;
      });
      updateSelectionCounts();
    });
  }
  const btnVal = $('btn-select-validated');
  if (btnVal) {
    btnVal.addEventListener('click', () => {
      list.querySelectorAll('input[data-source]').forEach((cb) => {
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
      list.querySelectorAll('input[data-source]').forEach((cb) => { cb.checked = false; });
      selectedIds.clear();
      updateSelectionCounts();
    });
  }

  const state = (await arbiterApi.get('/api/scrape/state')).state;
  lastState = state;
  renderState(state);
  refreshJobRows();
  refreshLastRun();
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

// Intentionally no setDataHealth() here: unlike dashboard/scanner/analytics/AI,
// this page is the scrape runner itself and does not fetch /api/scan, so the
// data-freshness banner (whose CTA is "Run scrape") would be circular. The
// scrape job list is the page's own freshness signal.
function refreshJobRows() {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const state = lastState || {};
  const jobs = state.jobs || [];
  const rows = $('job-rows');
  rows.innerHTML = jobs.length ? jobs.map((j) => {
    const id = j.id;
    const evs = j.events || 0;
    const ms = j.durationMs || 0;
    // `error` arrives as an object from the batch envelope but as a plain
    // string from some state payloads; `j.error.message` on a string renders
    // nothing at all, so the failure reason silently disappeared.
    const errorText = !j.error
      ? ''
      : typeof j.error === 'string' ? j.error : (j.error.message || j.error.code || '');
    // Table rows, not divs: the page renders a 26-row queue, and a table is
    // what gives the event count and the duration a column that lines up. The
    // previous markup put a status word between the name and the numbers, so
    // both drifted freely and the eye had to pair them by position.
    return `<tr role="listitem">
      <td class="mono">${escapeHtml(id)}</td>
      <td class="sl-num mono">${(evs).toLocaleString()}</td>
      <td class="sl-num mono">${fmtDuration(ms) || ms + 'ms'}</td>
      <td><span class="status ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>${errorText ? `<div class="job-error">${escapeHtml(errorText)}</div>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" class="sl-empty">${escapeHtml(t('noRunYet'))}</td></tr>`;
}

/**
 * Update the KPI strip (status chip, completed/failed counts, events, failed detail).
 * @param {object} state
 * @param {function} t - i18n translator
 * @param {string} statusLabel - pre-resolved localized status label
 */
function updateKpiCard(state, t, statusLabel) {
  const summary = state.summary || {};
  const status = state.status || 'idle';
  $('m-status').innerHTML = `<span class="status ${escapeHtml(status)}" title="${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>`;
  $('head-status').textContent = statusLabel;
  const dot = $('head-dot');
  dot.className = 'dot ' + (status === 'running' ? 'live pulse' : status === 'failed' ? 'error' : status === 'completed' ? 'live' : '');

  countUp($('m-completed'), summary.completed || 0);
  const failed = summary.failed || 0;
  countUp($('m-failed'), failed);
  $('m-failed').className = `value tabnum ${failed > 0 ? 'red' : 'green'}`;
  countUp($('m-events'), summary.events || 0, true);
  countUp($('act-events'), summary.events || 0, true);
  $('m-started').textContent = state.startedAt ? new Date(state.startedAt).toLocaleString() : t('awaitingTrigger');
  $('m-finished').textContent = state.finishedAt ? t('finished') + ' ' + new Date(state.finishedAt).toLocaleTimeString() : '';
  const failedJobs = (state.jobs || []).filter((j) => isFailedJob(j));
  const shownFailed = failedJobs.slice(0, 3).map((j) => j.id).join(', ');
  const moreFailed = failedJobs.length - 3;
  $('m-failed-detail').textContent = failedJobs.length
    ? (failedJobs.length > 3 ? `${shownFailed} · ${moreFailed} ${t('moreShort')}` : shownFailed)
    : '';
  $('m-failed-detail').title = failedJobs.map((j) => j.id).join(', ');
}

/**
 * Update the live progress card (bar, percentage, ring, ETA, activity line).
 * @param {object} state
 * @param {function} t - i18n translator
 */
function updateProgressCard(state, _t) {
  const status = state.status || 'idle';
  const running = ['running', 'cancelling'].includes(status);
  $('progress-card').classList.toggle('hidden', !running);
  const jobs = state.jobs || [];
  const total = jobs.length || 1;
  const done = countDoneJobs(jobs);
  const pct = Math.round((done / total) * 100);
  $('progress-bar').style.right = `${100 - pct}%`;
  $('progress-pct').textContent = `${pct}%`;
  $('progress-activity').textContent = state.currentActivity || '—';
  // Update ARIA progressbar + ring
  const progressEl = document.querySelector('.progress[role="progressbar"]');
  if (progressEl) progressEl.setAttribute('aria-valuenow', pct);
  const ring = $('progress-ring');
  if (ring) {
    ring.style.setProperty('--p', pct);
    const fill = ring.querySelector('.ring-fill');
    if (fill) fill.style.strokeDashoffset = String(113.1 - (113.1 * pct / 100));
    const ringLabel = $('progress-ring-pct');
    if (ringLabel) ringLabel.textContent = `${pct}%`;
    ring.classList.toggle('complete', pct >= 100);
    ring.classList.toggle('failed', status === 'failed');
  }
}

/**
 * Update the 5-stage pipeline stepper (active/done/error states, terminal label).
 * @param {object} state
 * @param {function} t - i18n translator
 */
function updateStepper(state, t) {
  const status = state.status || 'idle';
  const running = ['running', 'cancelling'].includes(status);
  const idx = state.currentStep?.index;
  const terminal = !running && (status === 'completed' || status === 'completed-with-errors');
  document.querySelectorAll('.stepper .step').forEach((el, i) => {
    const wasDone = el.classList.contains('done');
    el.classList.remove('active', 'done', 'error');
    if (running && i === idx) el.classList.add('active');
    // No stage history is supplied: prior stages may have been skipped or failed.
    else if (terminal && idx === 4 && i === 4) el.classList.add(status === 'completed' ? 'done' : 'error');
    else if (!running && state.error && i === idx) el.classList.add('error');
    el.setAttribute('aria-current', running && i === idx ? 'step' : 'false');
    // Step-done pop: brief scale when a step transitions to done
    if (!wasDone && el.classList.contains('done') && !reducedMotion()) {
      el.classList.remove('step-pop');
      void el.offsetWidth;
      el.classList.add('step-pop');
    }
  });

  // Terminal step label reflects the actual outcome, not a fixed word.
  const stepLabel = $('step-complete');
  if (stepLabel) {
    stepLabel.textContent = !running && status === 'completed-with-errors'
      ? t('completedWithErrors')
      : !running && status === 'failed' ? t('statusFailed') : t('complete');
  }
}

/**
 * Update the activity line (current activity, active bookmaker, queue/finished, result chips, profile, run id, duration).
 * @param {object} state
 * @param {function} t - i18n translator
 */
function updateActivityLine(state, t) {
  const status = state.status || 'idle';
  const summary = state.summary || {};
  const running = ['running', 'cancelling'].includes(status);
  const jobs = state.jobs || [];

  // Human-readable activity line instead of the raw status string.
  const isIdle = status === 'idle';
  $('act-line').textContent = running
    ? state.currentActivity || t('scraping')
    : isIdle ? status
      : status === 'completed-with-errors' ? `${summary.completed || 0} ${t('okShort')} · ${summary.failed || 0} ${t('failedShort')}`
        : status === 'completed' ? t('completedClean')
          : status === 'failed' ? t('statusFailed') : state.currentActivity || status;

  const active = jobs.find((j) => j.status === 'running');
  $('act-book').textContent = active ? active.id : '—';
  const total = jobs.length || 1;
  const done = countDoneJobs(jobs);
  $('act-qf').textContent = `${done} / ${total}`;

  const ok = jobs.filter((j) => j.status === 'ok').length;
  const failedCount = jobs.filter((j) => isFailedJob(j)).length;
  const res = $('act-result');
  if (running) {
    res.innerHTML = `<span class="chip ${ok > 0 ? 'green' : ''}">${ok} ${t('okShort')}</span> <span class="chip ${failedCount > 0 ? 'red' : ''}">${failedCount} ${t('failedShort')}</span>`;
  } else if (status === 'completed' || status === 'completed-with-errors') {
    res.innerHTML = `<span class="chip green">${ok} ${t('okShort')}</span> <span class="chip ${failedCount > 0 ? 'red' : 'green'}">${failedCount} ${t('failedShort')}</span>`;
  } else {
    res.textContent = '—';
  }

  // Resolved options do not identify the profile that launched the run.
  $('act-profile').textContent = '—';
  $('act-runid').textContent = state.runId ? state.runId.slice(0, 19) : '—';
  const dur = $('act-duration');
  if (dur) {
    dur.textContent = (state.startedAt && state.finishedAt)
      ? `ran ${fmtDuration(Date.parse(state.finishedAt) - Date.parse(state.startedAt))}`
      : '';
  }
}

/**
 * Update the error/alert box (shown on completed-with-errors or explicit error).
 * @param {object} state
 * @param {function} t - i18n translator
 */
function updateErrorBox(state, t) {
  const status = state.status || 'idle';
  const running = ['running', 'cancelling'].includes(status);
  const errBox = $('error-box');
  if (!running && state.error) {
    errBox.className = 'alert error-visible';
    // `state.error` is an object from the orchestrator but a string from some
    // payloads; reading `.name` off a string yields "undefined: undefined".
    const err = typeof state.error === 'string'
      ? { name: 'Error', message: state.error }
      : state.error;
    errBox.innerHTML = `${escapeHtml(err.name || 'Error')}: ${escapeHtml(err.message || '')}`;
  } else if (!running && status === 'completed-with-errors') {
    const failedCount = (state.jobs || []).filter((j) => isFailedJob(j)).length;
    errBox.className = 'alert warn error-visible';
    errBox.innerHTML =
      `${escapeHtml(`${t('scrapeErrorsPrefix')} ${failedCount} ${t('jobsFailed')}`)} `
      + `<a href="#job-rows">${escapeHtml(t('viewFailedJobs'))}</a>`;
  } else {
    errBox.className = 'alert hidden';
  }
}

/**
 * Render a scrapeState payload into the DOM.
 *
 * @param {object} state — the scrapeState payload { status, summary, jobs, currentStep, currentActivity, options, runId, startedAt, finishedAt, error }
 */
function renderState(state) {
  if (!state) return;
  const prevStatus = lastState?.status;
  lastState = state;
  const status = state.status || 'idle';
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);

  const statusLabel = status === 'completed-with-errors' ? t('completedWithErrors')
    : status === 'completed' ? t('completedClean')
      : status === 'failed' ? t('statusFailed')
        : status;

  // Announced status change to screen readers only (aria-live=polite)
  if (status !== prevStatus) {
    const live = $('live-summary');
    if (live) live.textContent = statusLabel;
  }

  updateRunControls();
  updateKpiCard(state, t, statusLabel);
  updateProgressCard(state, t);
  updateStepper(state, t);
  updateActivityLine(state, t);
  updateErrorBox(state, t);

  const jobs = state.jobs || [];
  updateChipStatus(jobs);
  refreshJobRows();

  // Flash effect on KPI cards (skip first load)
  if (!_isFirstScrapeLoad && status !== 'idle') {
    document.querySelectorAll('.scrape-kpis .kpi-card').forEach((card, i) => {
      setTimeout(() => card.classList.add('flash'), i * 40);
      setTimeout(() => card.classList.remove('flash'), 500 + i * 40);
    });
  }
  _isFirstScrapeLoad = false;
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
    tbody.innerHTML = run.jobs.map((j) => {
      // Same shape question as refreshJobRows: the error may be a string.
      const errCode = !j.error
        ? ''
        : typeof j.error === 'string' ? j.error : (j.error.code || j.error.message || '');
      return `
      <tr>
        <td class="mono">${escapeHtml(j.id)}</td>
        <td class="num tabnum">${(j.events || 0).toLocaleString()}</td>
        <td class="num tabnum">${escapeHtml(fmtDuration(j.durationMs || 0) || '—')}</td>
        <td><span class="status ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>${errCode ? ` <span class="muted mono">${escapeHtml(errCode)}</span>` : ''}</td>
      </tr>`;
    }).join('');
    const opps = run.opportunitiesCount || 0;
    $('m-arb-summary').textContent = `${t('opps')}: ${opps}`;
  } catch (_err) { /* ignore */ }
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
  const bookIds = [...selectedIds];
  if (!bookIds.length || launchPending || ['running', 'cancelling'].includes(lastState?.status)) return;
  launchPending = true;
  updateRunControls();
  const scanOptions = {
    bankroll: Number($('bankroll').value),
    minRoiPercent: Number($('min-roi').value),
    minEvPercent: Number($('min-ev').value),
    maxMiddleRiskPercent: Number($('mid-risk').value),
    minMiddleRoiPercent: Number($('mid-roi').value),
    includeLive: $('inc-live').checked,
    includePast: $('inc-past').checked,
    maxEvents: selectedMaxEvents(),
    sport: $('sport-filter')?.value || undefined,
  };
  try {
    log(`starting scrape: ${bookIds.length} books, max events=${scanOptions.maxEvents}${scanOptions.sport ? `, sport=${scanOptions.sport}` : ''}`, 'info', 'orchestrator');
    const result = await arbiterApi.post('/api/scrape', { bookIds, scanOptions });
    if (result.state) renderState(result.state);
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    if (typeof window.showToast === 'function') window.showToast(t('toastScrapeStarted'), 'success');
  } catch (err) {
    log(`failed to launch: ${err.message}`, 'error', 'orchestrator');
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    if (typeof window.showToast === 'function') window.showToast(t('failedShort'), 'error');
  } finally {
    launchPending = false;
    updateRunControls();
  }
});
$('cancel-btn').addEventListener('click', async () => {
  try {
    const result = await arbiterApi.post('/api/scrape/cancel', {});
    if (result.state) renderState(result.state);
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    if (result.cancelled) {
      log('cancellation requested', 'warn', 'orchestrator');
      if (typeof window.showToast === 'function') window.showToast(t('toastScrapeCancelled'), 'warning');
    } else {
      log('no active scrape to cancel', 'info', 'orchestrator');
      if (typeof window.showToast === 'function') window.showToast(t('toastNothingToCancel'), 'info');
    }
  } catch (err) {
    log(err.message || 'unable to cancel scrape', 'error', 'orchestrator');
  }
});
$('save-btn').addEventListener('click', () => log(window.arbiterI18n.t('profileDefaultsNote'), 'info'));
$('sched-save').addEventListener('click', async () => {
  const enabled = $('sched-enabled').checked;
  if (enabled && !selectedIds.size) { log(window.arbiterI18n.t('noBookmakersSelected'), 'warn'); return; }
  const intervalMinutes = Number($('sched-interval').value);
  const bookIds = [...document.querySelectorAll('#bookmaker-list input[data-source]:checked')].map((checkbox) => checkbox.value);
  const scanOptions = {
    bankroll: Number($('bankroll').value),
    minRoiPercent: Number($('min-roi').value),
    minEvPercent: Number($('min-ev').value),
    maxMiddleRiskPercent: Number($('mid-risk').value),
    minMiddleRoiPercent: Number($('mid-roi').value),
    includeLive: $('inc-live').checked,
    includePast: $('inc-past').checked,
    maxEvents: selectedMaxEvents(),
    sport: $('sport-filter')?.value || undefined,
  };
  try {
    await arbiterApi.post('/api/scheduler', { enabled, intervalMinutes, bookIds, scanOptions });
    log(`scheduler ${enabled ? 'enabled' : 'disabled'} (${intervalMinutes}m)`, 'success', 'scheduler');
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    if (typeof window.showToast === 'function') window.showToast(t('toastSchedulerSaved'), 'success');
    refreshScheduler();
  } catch (err) {
    log(err.message || 'unable to save scheduler', 'error', 'scheduler');
  }
});

_sse = arbiterSse.connect((type, payload) => {
  if (type === 'scrape-update') {
    renderState(payload);
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

// Close the SSE connection on page unload so repeated navigation doesn't leak
// EventSource handles.
window.addEventListener('beforeunload', () => {
  if (_sse) { _sse.close(); _sse = null; }
});

window.arbiterApp.mount('scrape');
init().catch((err) => {
  console.error('Scrape initialization failed', err);
  const message = arbiterI18n.lang === 'ro'
    ? 'Configurarea nu a putut fi încărcată. Reîncarcă pagina pentru a încerca din nou.'
    : 'Unable to load configuration. Reload the page to try again.';
  const list = $('bookmaker-list');
  if (list) {
    list.setAttribute('role', 'alert');
    list.textContent = `${message} ${err.message || ''}`;
  }
});
