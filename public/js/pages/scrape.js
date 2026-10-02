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
// The last `/api/live` payload, kept so the poll's status line can be re-rendered
// from an orchestrator transition without asking again. `refreshLive()` is
// deliberately not called on every scrape update (that would be a request per
// book per tick), which is correct for the measured duration — a number that
// only changes when a poll ends — and wrong for "a poll is running right now",
// which changes when one starts. One cached payload serves both.
let lastLive = null;
let scrapers = [];
let profiles = [];
let validatedIds = new Set();
let selectedIds = new Set();
let jobById = new Map();
let launchPending = false;
// The last /api/scheduler payload, kept so the stored-vs-form comparison can be
// re-run when the form changes under it (a profile switch rewrites six of the
// nine fields without touching the page's scheduler block at all).
let lastScheduler = null;

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

/**
 * The scan profile's name, in the page's language.
 *
 * The label came out of config/scan-profiles.json verbatim, so a Romanian
 * operator was picking between "Trusted · Prematch" and "Review · Live + Past"
 * in English — the two keys that name those modes, `trusted` and `review`, were
 * already in the dictionary and already translated, translated nothing.
 *
 * The mode is translated; the scope is derived from the profile's own defaults,
 * because a third scope in the config should not need a third key to say which
 * one it is. A mode the dictionary has never heard of comes back from t() as
 * its own name, which is the right answer for it, and the whole label falls
 * back to the config's own string rather than to a blank option.
 *
 * @param {object} profile - one entry of GET /api/profiles
 * @param {function(string):string} t
 * @returns {string}
 */
function profileLabel(profile, t) {
  const mode = profile.mode ? t(profile.mode) : '';
  if (!mode) return profile.label || '';
  const d = profile.defaults || {};
  const scope = d.includeLive || d.includePast ? t('profileScopeLivePast') : t('profileScopePrematch');
  return scope ? `${mode} · ${scope}` : mode;
}

/**
 * The selected profile's own sentence, hung on the select as its hint.
 *
 * `profileLabel` above builds the option's text from `mode` and the defaults and
 * never reads `description`, which left one field of GET /api/profiles with no
 * place on the page. Measured over config/scan-profiles.json that field is the
 * only one carrying what a profile is *for*: "Independent feeds with plausibility
 * checks" and "Lower-confidence feeds — verify prices before placing stakes" say
 * what each mode costs the operator, where the mode itself translates to a single
 * word and the scope is derived from booleans.
 *
 * The prose is shown as the config wrote it, untranslated, because that is what
 * the tooltip already does with `validationReason` — a string the operator's own
 * config file carries is not a string this page owns, and translating it here
 * would put two languages in one file.
 *
 * A `title` rather than a line of text: the runbar is a dense row of nine fields
 * and `max-events` already carries its hint exactly this way.
 */
function applyProfileHint() {
  const sel = $('profile');
  if (!sel) return;
  const found = (profiles || []).find((p) => p.id === sel.value);
  const description = found && found.description;
  if (description) sel.title = description;
  else sel.removeAttribute('title');
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

  // The tooltip is the only place a 26-item list can carry evidence without
  // costing layout density, so it answers three questions about one book: what
  // the adapter is, why it was accepted, and when the provider's endpoint was
  // last checked against a real response.
  //
  // That third one is not decoration. `endpointVerifiedAt` is carried by 25 of
  // 26 jobs and it is not uniform — 22 of them read 2026-09-01 while unibet,
  // betmen, prowin and ultrabet were re-checked a month later. A book whose
  // endpoint was last proven weeks before its siblings is making a quieter
  // claim about how much the price can be trusted, and the page could not say
  // so before: it showed the reason prose and never the date.
  //
  // `feedStatus` is deliberately not shown. All 26 wired jobs measure
  // `verified` and none disagrees with its own `validationStatus`, so today it
  // is a constant that would only add a word to every chip. It belongs here
  // when it starts to vary — which is the moment it starts to mean something.
  const chipTitle = (s, validated) => {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const lines = [s.validationReason || (validated ? t('sourceValidated') : t('sourceExperimental'))];
    if (s.endpointVerifiedAt) lines.push(`${t('endpointVerified')}: ${s.endpointVerifiedAt}`);
    const adapter = adapterLine(s, t);
    if (adapter) lines.push(adapter);
    const deep = deepModeLine(s, t);
    if (deep) lines.push(deep);
    const floor = smokeFloorLine(s, t);
    if (floor) lines.push(floor);
    const live = liveEvidenceLine(s, t);
    if (live) lines.push(live);
    return lines.join('\n');
  };

  /**
   * The adapter behind a book: which integration family collects it, and which
   * file does the work.
   *
   * The tooltip above already answers "what is this adapter" — in prose, from
   * the validation reason. The machine-readable answer was in this route's
   * payload the whole time and read by no page. Measured over config/scrapers.json:
   * `engine` takes 13 distinct values across the 26 jobs, and `script` is the
   * finer grain beneath it, because excelbet, winboss, las-vegas and magnumbet
   * share the `exalogic-xsport` engine behind four different adapter files.
   * `engine` alone would call those four books the same book; an operator
   * comparing two books that both went quiet needs the file, not the family.
   */
  function adapterLine(s, t) {
    const parts = [s.engine, s.script].filter(Boolean);
    return parts.length ? `${t('feedAdapter')}: ${parts.join(' · ')}` : '';
  }

  /**
   * What deep mode costs this book, which is the reason a run of the same
   * events can take minutes.
   *
   * Both adapters that set `fullMarkets` spend one extra detail request per
   * event, and that request is what turns a 1X2-only preview into goals
   * totals, BTTS and handicaps (src/scrapers/unibet.mjs:46, superbet.mjs:210).
   * `detailLimit` caps how many events get it: 100 for Superbet, 700 for
   * Unibet, whose football crawl is that large — without the cap a deep run
   * issues a detail call for every contest the feed advertises. Two of 26 jobs
   * carry the pair, so two chips gain a line and the other 24 do not.
   */
  function deepModeLine(s, t) {
    if (!s.fullMarkets) return '';
    const deep = t('feedDeepMode');
    return Number.isInteger(s.detailLimit) && s.detailLimit > 0
      ? `${deep} · ${t('feedDeepLimit').replace('{limit}', String(s.detailLimit))}`
      : deep;
  }

  /**
   * The floor the live smoke script holds this book to.
   *
   * `minEvents` is the one job-scoped key on this route with a consumer
   * outside the app: scripts/smoke-live.mjs:116 overrides its global floor with
   * it, and betmen declares 20 because its coverage is legitimately small
   * rather than collapsed. The page could not say so, so a book failing that
   * smoke looked like any other failing book.
   */
  function smokeFloorLine(s, t) {
    return Number.isInteger(s.minEvents) && s.minEvents > 0
      ? t('feedSmokeFloor').replace('{events}', String(s.minEvents))
      : '';
  }

  /**
   * Whether this book can quote an in-play price at all, as measured on the
   * provider's own field — and if not, whether anyone looked.
   *
   * This is the per-book half of the live feature, and until the route carried
   * it the answer existed only inside the adapters' coverage strings. Measured
   * over the real registry: 26 jobs, 24 of them with a row in LIVE_EVIDENCE,
   * and exactly 5 that can actually publish in-play — fortuna and
   * casa-pariurilor off `market.kind`, unibet off `contest.status`, superbet and
   * winner off their own live clock. The other 19 were measured and have no such
   * field; the last 2 (prowin, ultrabet) are disabled experiments nobody has
   * ever collected, which is a different sentence and is rendered as one.
   *
   * `started` is reported rather than implied. It is how many in-play events
   * that book published inside the measurement window, so `0` is a fact about
   * that hour — not a verdict on the feed — and two of the five capable books
   * read 0. A tooltip that printed "0 in-play events" next to "can go live"
   * would read as a contradiction.
   */
  function liveEvidenceLine(s, t) {
    const c = s && s.liveCapability;
    if (!c) return '';
    if (!c.live) return c.measured === true ? t('liveNoField') : t('liveNotMeasured');
    const scope = c.scope === 'market' ? t('liveScopeMarket') : t('liveScopeEvent');
    const seen = Number(c.started) > 0
      ? t('liveStartedCount').replace('{started}', String(c.started))
      : t('liveStartedNone');
    return `${t('liveCapable')} · ${scope} · ${c.field || '—'} · ${seen}`;
  }

  const chip = (s) => {
    const validated = validatedIds.has(s.id);
    const status = s.validationStatus || 'experimental';
    const job = jobById.get(s.id);
    const dot = `<span class="dot ${statusDotClass(job)}"></span>`;
    const ev = `<span class="muted ev" ${job && job.events ? '' : 'hidden'}>${job && job.events ? job.events.toLocaleString() : ''} ev</span>`;
    // The one word that answers "can this book be part of a live trade" without
    // opening anything. It reuses the `.muted` chip styling, so a 26-book list
    // keeps its density and nothing here needs a stylesheet of its own; the
    // measured field, scope and window count are in the tooltip beside it.
    const cap = s.liveCapability && s.liveCapability.live
      ? `<span class="muted live-cap">${escapeHtml(window.arbiterI18n.t('liveCapableShort'))}</span>`
      : '';
    return `<label class="chip ${validated ? 'green' : ''}" title="${escapeHtml(chipTitle(s, validated))}" data-name="${escapeHtml((s.name || s.id).toLowerCase())}">
      <input type="checkbox" value="${escapeHtml(s.id)}" data-source="${escapeHtml(s.id)}" ${selectedIds.has(s.id) ? 'checked' : ''}>
      ${dot}
      <span class="name">${escapeHtml(s.name)} · ${escapeHtml(status)}</span>
      ${cap}
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

// ══ Book price board ══════════════════════════════════════════════════════
// GET /api/odds/:book is the only per-book price feed the app publishes, and
// until this panel existed nothing under public/ called it. The scanner
// compares books against one another, the event view shows one event across
// books, and nothing showed one book's own board.
//
// Measured over data-market-run/workspace before this was written: 22 of the
// 26 registered jobs carry a capture (24.829 events, 31.927 markets, 93.600
// selections) and four do not — unibet and betmen among them, both enabled and
// both validated. So the selector lists every job the backend registers and a
// 404 becomes a sentence on screen. Guessing which books have a capture would
// need a route that says so, and adding one to answer a question this panel
// already asks out loud is the wrong trade.

/** Market and event keys seen on the board, offered back as suggestions. */
const priceSuggestions = { markets: new Set(), events: new Set() };

/**
 * The URL this panel asks for.
 *
 * Every parameter the route accepts is here, and the empty ones are left off
 * rather than sent blank: the route filters on
 * `String(market.key).toUpperCase() !== marketKey`, so `?marketKey=` would
 * match nothing and turn "no filter" into an empty board.
 *
 * `marketKey` is uppercased client-side to match the route's own comparison,
 * so a reader who types `over_under_2_5` gets that market and not an empty
 * table — the route already uppercases, and doing it here makes the request
 * readable in a log line rather than hiding the work in the server.
 *
 * @returns {string} '' when no book is chosen — the panel has nothing to ask.
 */
function priceBoardUrl() {
  const book = String($('odds-book')?.value || '').trim();
  if (!book) return '';
  const params = new URLSearchParams();
  const market = String($('odds-market')?.value || '').trim().toUpperCase();
  if (market) params.set('marketKey', market);
  const eventKey = String($('odds-event')?.value || '').trim();
  if (eventKey) params.set('eventKey', eventKey);
  const limit = Number.parseInt(String($('odds-limit')?.value || ''), 10);
  params.set('limit', String(Number.isFinite(limit) && limit > 0 ? limit : 50));
  return `/api/odds/${encodeURIComponent(book)}?${params}`;
}

/**
 * One row of the board.
 *
 * `live` is a marker and never a word: the route publishes a boolean on both
 * the event and the market, so a row can be in-play at either level and the
 * two are shown from the same pill. Nothing is written for a row that is not
 * in-play — "pre-match" is a claim about the capture, and the capture this
 * panel reads is the one the operator last ran.
 */
function priceRow(r, t) {
  const market = r.market || {};
  const live = r.live === true || market.live === true;
  const name = market.name || market.key || '—';
  const odds = (Array.isArray(market.selections) ? market.selections : [])
    .map((s) => `<span class="sl-num">${escapeHtml(s.name)} @ ${escapeHtml(window.arbiterFormat.fmtOdds(s.odds))}</span>`)
    .join(' · ');
  const teams = `${r.homeTeam || ''} – ${r.awayTeam || ''}`.trim();
  return `<tr>
      <td>${escapeHtml(teams)}<div class="sl-stat-foot">${escapeHtml(r.league || '')} · ${escapeHtml(r.kickoff || '')}</div></td>
      <td>${escapeHtml(name)}${live ? ` <span class="status ok">${escapeHtml(t('live'))}</span>` : ''}</td>
      <td>${odds}</td>
    </tr>`;
}

/**
 * Render a board payload, and say what is not in it.
 *
 * The note carries three facts the table cannot: when the capture was taken
 * (a price without a timestamp is not a price you can act on), how many rows
 * came back, and whether the row count hit the limit — which is the only
 * signal the route offers that the capture is larger than what is on screen.
 */
function renderPriceBoard(payload, t) {
  const rows = $('odds-rows');
  const note = $('odds-note');
  if (!rows || !note) return;
  const results = Array.isArray(payload?.results) ? payload.results : [];

  for (const r of results) {
    if (r?.market?.key) priceSuggestions.markets.add(String(r.market.key).toUpperCase());
    if (r?.eventKey) priceSuggestions.events.add(String(r.eventKey));
  }
  const fill = (el, values) => {
    if (!el) return;
    el.innerHTML = [...values].sort().map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  };
  fill($('odds-market-keys'), priceSuggestions.markets);
  fill($('odds-event-keys'), priceSuggestions.events);

  rows.innerHTML = results.length
    ? results.map((r) => priceRow(r, t)).join('')
    : `<tr><td class="sl-empty" colspan="3">${escapeHtml(t('pricesNoneForFilter'))}</td></tr>`;

  const bits = [t('pricesCount').replace('{count}', String(results.length))];
  const limit = Number.parseInt(String($('odds-limit')?.value || ''), 10);
  if (results.length && Number.isFinite(limit) && results.length >= limit) {
    bits.push(t('pricesTruncated').replace('{count}', String(results.length)));
  }
  const liveCount = results.filter((r) => r.live === true || r?.market?.live === true).length;
  if (liveCount) bits.push(t('pricesLiveCount').replace('{count}', String(liveCount)));
  if (payload?.capturedAt) {
    bits.push(`${t('capturedAt')}: ${payload.capturedAt}`);
  }
  note.textContent = bits.join(' · ');
}

/** The selector: every registered job, because the backend cannot say which have a capture. */
function renderPriceBookOptions() {
  const sel = $('odds-book');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = scrapers
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`)
    .join('');
  if (keep && scrapers.some((s) => s.id === keep)) sel.value = keep;
}

/**
 * Read the board for whatever the three controls currently say.
 *
 * The panel is a viewer, not a control surface for the run: it never posts, it
 * never changes the chip selection, and a book with no capture leaves the rest
 * of the page exactly as it found it.
 */
async function loadPriceBoard() {
  const note = $('odds-note');
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const url = priceBoardUrl();
  if (!url) {
    if (note) note.textContent = '';
    const rows = $('odds-rows');
    if (rows) rows.innerHTML = `<tr><td class="sl-empty" colspan="3">${escapeHtml(t('pricesPickBook'))}</td></tr>`;
    return;
  }
  if (note) note.textContent = t('pricesLoading');
  try {
    renderPriceBoard(await arbiterApi.get(url), t);
  } catch (err) {
    // ENOTFOUND is the route's own answer for "this book has no capture" and
    // it is the common case here: two enabled, validated jobs have none. It
    // gets its own sentence, because "could not be read" would tell the
    // operator to retry something that will never succeed on its own.
    const rows = $('odds-rows');
    if (rows) {
      rows.innerHTML = `<tr><td class="sl-empty" colspan="3">${
        escapeHtml(err.status === 404 ? t('pricesNoCapture') : `${t('pricesError')}: ${err.message || ''}`)
      }</td></tr>`;
    }
    if (note) note.textContent = '';
  }
}

/**
 * The sport half of the orchestrator's promotion gate, copied from
 * `src/scrape-orchestrator.mjs:110` clause for clause.
 *
 * The orchestrator runs a job when all three conditions hold — enabled,
 * validated, and `jobMatchesSport` — and `resolveScanRequest` always supplies a
 * sport, so the third clause is live on every run, not only when a filter is
 * visibly set. The page pre-selected on the first two alone, so choosing a
 * non-football sport ticked 24 books and POSTed a request the orchestrator
 * reduced to one: HTTP 400, "no runnable bookmaker jobs selected", with every
 * book on screen showing as checked.
 *
 * Absence is not refusal, and that is the clause easiest to get backwards: a
 * job carrying no `supportedSports` (26 jobs in the registry, exactly one —
 * `unibet`) has never stated a capability, which is not the same as declaring
 * it cannot serve the sport. Excluding those instead would empty the selection
 * again, which is the mistake the orchestrator comment at line 100 records
 * having already been made once.
 */
function jobMatchesSport(job, sport) {
  if (!sport) return true;
  if (!Array.isArray(job.supportedSports) || job.supportedSports.length === 0) return true;
  return job.supportedSports.includes(sport);
}

/** The chosen sport, normalised the way the orchestrator normalises it. */
function currentSport() {
  return String($('sport-filter')?.value || '').trim().toLowerCase();
}

/** All three orchestrator conditions, so the default cannot drift from them. */
function passesPromotionGate(job, sport = currentSport()) {
  return job.enabled !== false && validatedIds.has(job.id) && jobMatchesSport(job, sport);
}

async function init() {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const scraperResponse = await arbiterApi.get('/api/scrapers');
  scrapers = scraperResponse.jobs || [];
  validatedIds = new Set((scraperResponse.validatedJobs || []).map((scraper) => scraper.id));
  // The default selection is derived further down, once the sport filter
  // exists — see the note at that derivation for why it cannot happen here.
  profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
  const sel = $('profile');
  sel.innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(profileLabel(p, t))}</option>`).join('');
  sel.value = profiles[0]?.id || '';
  applyProfileHint();
  // The hint is refreshed from inside onProfileChange rather than from a second
  // listener here: one registration, one place that reacts to the operator
  // having chosen a different profile, and the shape of this line is pinned by
  // test/scrape-page.test.mjs as the proof that switching re-runs the comparison.
  sel.addEventListener('change', () => onProfileChange());
  applyProfile();

  // Populate sport filter dropdown using common helper
  try {
    const sportsRes = await arbiterApi.get('/api/sports');
    createDropdown('sport-filter', [{value: '', text: arbiterI18n.t('allSports')}].concat(sportsRes.sports.map(s => ({value: s.id, text: s.name}))), {storageKey: 'arbiter.scrapeSportFilter'});
    // createDropdown restores the persisted value synchronously (common.js:34),
    // so the operator's last sport is already in the form by the time this line
    // returns. It persists on change but fires none for the restore itself, so
    // the gate is applied once to the restored value below and again on every
    // later change.
    $('sport-filter')?.addEventListener('change', onSportFilterChange);
  } catch (_) { /* sport endpoint optional */ }

  // Derived here, not above the dropdown, and that ordering is the point. The
  // persisted sport lives in localStorage and only reaches the form when
  // createDropdown runs; a derivation placed before it reads "" no matter what
  // the operator last chose, and pre-selects the unfiltered set. If the sports
  // route failed, the catch above left the form on its empty default, and "" is
  // the correct filter for that — this is the safe side to land on.
  selectedIds = new Set(scrapers.filter((s) => passesPromotionGate(s)).map((s) => s.id));

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
  refreshScanSummary();
  refreshScheduler();
  refreshLive();

  // Last, because the book list is what fills it. The board is a viewer over
  // the captures this page's own run produces, so it reads the first book once
  // and again whenever one of its four controls changes. Nothing here touches
  // the chip selection above — reading one book's prices is not choosing it
  // for the next run.
  renderPriceBookOptions();
  for (const id of ['odds-book', 'odds-market', 'odds-event', 'odds-limit']) {
    $(id)?.addEventListener('change', () => { loadPriceBoard(); });
  }
  loadPriceBoard();
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

/**
 * Switch profile, then re-run the stored-vs-form comparison.
 *
 * Kept out of applyProfile() on purpose: applying a profile is writing nine
 * inputs, and the comparison is a readout that needs the i18n dictionary and
 * the scheduler payload. Folding the second into the first made a function that
 * only ever touched the form depend on two globals it has no business knowing
 * about, and made it unusable from anywhere that lacked them.
 */
function onProfileChange() {
  applyProfileHint();
  applyProfile();
  renderSchedulerScan(lastScheduler && lastScheduler.scanOptions);
}

/**
 * Drop ticked books the gate refuses under the newly chosen sport.
 *
 * Intersect, never re-derive. The gate is a constraint on the selection, not a
 * new default for it: it may take books away, but it has no business putting
 * any back. A book the operator unticked stays unticked, and a book they never
 * asked for must not appear. Re-deriving the full default on every filter
 * change would silently undo manual work each time the filter is touched;
 * adding would tick books nobody selected. Both are worse than what is left
 * here, and the operator can restore either with "Select validated" — an
 * explicit act — rather than having it happen to them.
 *
 * An id with no job behind it is dropped too: the orchestrator would refuse it
 * as "not in the registry", and a stale id here is exactly the state that
 * produced a ticked book the server had never heard of.
 */
function onSportFilterChange() {
  const sport = currentSport();
  const kept = [...selectedIds].filter((id) => {
    const source = scrapers.find((s) => s.id === id);
    return !!source && passesPromotionGate(source, sport);
  });
  if (kept.length === selectedIds.size) return;
  selectedIds = new Set(kept);
  // The redraw is also what refreshes the count: renderBookmakerChips() ends
  // by calling updateSelectionCounts() itself, so a second call here would be
  // the same work twice and a mutation run proved it — dropping it changed
  // nothing observable.
  renderBookmakerChips();
}

function selectedMaxEvents() {
  const value = String($('max-events')?.value || 'all').trim().toLowerCase();
  if (value === 'all') return 'all';
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 'all';
}

/**
 * The scan configuration exactly as the form currently reads it.
 *
 * This was the same nine-line object literal written out twice — once for a
 * manual run, once for the scheduler — and the scheduler copy is what gets
 * persisted to disk and replayed on every tick for the next 24 hours. Two
 * copies of a payload that must not drift is how the stored copy ends up
 * describing a form nobody is looking at any more, and there is one function
 * of it now so the thing that is compared, shown and saved is the same object.
 */
function currentScanOptions() {
  return {
    bankroll: Number($('bankroll').value),
    minRoiPercent: Number($('min-roi').value),
    minEvPercent: Number($('min-ev').value),
    maxMiddleRiskPercent: Number($('mid-risk').value),
    minMiddleRoiPercent: Number($('mid-roi').value),
    includeLive: $('inc-live').checked,
    includePast: $('inc-past').checked,
    maxEvents: selectedMaxEvents(),
    // One function answers "which sport is this" for both callers. The page used
    // to send the raw form value here and normalise a second copy inside the
    // gate, so a value that was not already a registry id could gate on one
    // string and be run on another — the backend trims and lowercases whatever
    // arrives, and nothing here did the same.
    sport: currentSport() || undefined,
  };
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
  // The announced one is the track. The ring carries role="progressbar" too, but
  // it is aria-hidden and is updated separately below, from its own id.
  //
  // This asked for `.progress[role="progressbar"]` for as long as the page
  // existed, and the markup has never had a class called `progress` — the track
  // is `sl-progress-track`. querySelector returned null, the `if` below swallowed
  // it, and `aria-valuenow` sat at the value scrape.html ships while the bar
  // moved: a screen reader was told the run was at 0% for its whole length.
  const progressEl = document.querySelector('.sl-progress-track[role="progressbar"]');
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

  // The poll's "running right now" half is decided by this transition, and this
  // is the only place it is observable without a request per book per tick.
  // Drawn from the cached payload, so a scrape started elsewhere costs nothing;
  // before the first one arrives there is nothing to draw and renderLiveMeasured
  // clears the line rather than throwing on it.
  renderLiveMeasured(lastLive, window.arbiterI18n.t.bind(window.arbiterI18n));

  // Flash effect on KPI cards (skip first load)
  if (!_isFirstScrapeLoad && status !== 'idle') {
    document.querySelectorAll('.scrape-kpis .kpi-card').forEach((card, i) => {
      setTimeout(() => card.classList.add('flash'), i * 40);
      setTimeout(() => card.classList.remove('flash'), 500 + i * 40);
    });
  }
  _isFirstScrapeLoad = false;
}

/**
 * The scan summary under the events card, in one place.
 *
 * Two writers used to fight over this line. The `scan-update` frame wrote the
 * four real counts; `refreshLastRun()` wrote `Opps: ${run.opportunitiesCount ||
 * 0}` over the top of them, and no run report carries that field. The writer
 * that had no data behind it also won every time, because the terminal
 * `scrape-update` that triggers it arrives after the `scan-update` of the same
 * run — see the note in `refreshLastRun`. The card read "Opps: 0" seconds after
 * the log said "scan: 12 opps, 3 middles".
 *
 * Both sources are the same scan, and they spell it differently: the SSE frame
 * publishes four numbers (`scan.opportunities.length` and its three siblings,
 * scrape-orchestrator.mjs:331) while `GET /api/scan` publishes the four arrays
 * themselves. Counting both shapes here is what lets the card be drawn from a
 * live frame and from the stored document without printing `undefined` in one
 * of them.
 *
 * @param {object} scan a `scan-update` payload or a `GET /api/scan` document
 * @param {Function} t the translation lookup
 * @returns {string}
 */
function scanSummaryText(scan, t) {
  const n = (value) => (Array.isArray(value) ? value.length : (Number.isFinite(Number(value)) ? Number(value) : 0));
  return `${t('opps')}: ${n(scan.opportunities)} · ${t('middles')}: ${n(scan.middles)} · `
    + `${t('positiveEv')}: ${n(scan.positiveEv)} · ${t('lowHoldLabel')}: ${n(scan.lowHold)}`;
}

/**
 * Write the summary card.
 *
 * `published` is the only thing separating "a scan found nothing" from "no
 * scan has run": `readPublishedScan` answers an empty document — real keys,
 * zero findings, a fresh id — in both cases, and says so only through the flag
 * the route rides on the served scan (router.mjs:93). A card that counted the
 * empty document would report a quiet market on a machine that has never
 * scraped anything, which is the same claim `neverRan` is here to refuse.
 *
 * @param {object} scan
 * @param {Function} t
 * @param {boolean} [published] true for a live frame — it exists only because a
 *   scan just ran — and for a stored document only when the route says so.
 */
function renderScanSummary(scan, t, published = true) {
  $('m-arb-summary').textContent = published && scan ? scanSummaryText(scan, t) : t('neverRan');
}

/**
 * Put the last scan's counts back on screen after a reload.
 *
 * `scan-update` is a live frame: it arrives once per run and is gone when the
 * tab is reloaded. `GET /api/scan` serves the document the same pass persisted
 * (scrape-orchestrator.mjs:371 writes `latest-scan.json` after the scan and any
 * verification pass), so the card says what it said before the refresh instead
 * of staying blank until the next run.
 */
async function refreshScanSummary() {
  try {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const scan = await arbiterApi.get('/api/scan');
    renderScanSummary(scan, t, Boolean(scan && scan.published));
  } catch (_e) { /* ignore */ }
}

async function refreshLastRun() {
  try {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const run = await arbiterApi.get('/api/scrape-run');
    const tbody = document.querySelector('#last-run-table');
    // Which run, and when it ran. runId, startedAt and finishedAt are in this
    // same payload and were rendered by nothing: a panel titled "the last run"
    // whose table could not say which run it was, or whether the run it is
    // showing is a day old. It is a note in the panel head rather than two more
    // columns, because these three values are properties of the run and not of
    // each of the 24 job rows — as columns they would repeat the same instant
    // down the whole table.
    //
    // `finishedLabel` and not `finished`: that key already exists, and it is a
    // caption under a capitalised stat label at line 514 — lowercase on
    // purpose. A second `finished` here would have been a duplicate key in the
    // dictionary object, where the later one silently wins and the first is
    // dead. Same reason `etaLabel` exists next to `eta`.
    //
    // No escapeHtml here, and that is not an oversight. This is a textContent
    // write, and a Text node's data is literal — only the HTML parser decodes
    // entities. Measured in a browser (playwright chromium, the escaper copied
    // from common.js:23): `textContent = escapeHtml('run&7')` reads back as the
    // six characters `run&amp;7`, while `innerHTML = escapeHtml('run&7')` reads
    // back as `run&7`. Escaping here would put `&amp;` on the page in front of
    // the reader, on the one sink in the repo that does not want it; every other
    // escapeHtml call in public/js feeds an innerHTML template.
    const when = $('last-run-when');
    if (when) {
      const fmt = (value) => (value ? new Date(value).toLocaleString() : null);
      const parts = [];
      if (run && run.runId) parts.push(`${t('runId')}: ${run.runId}`);
      const started = run && fmt(run.startedAt);
      if (started) parts.push(`${t('started')}: ${started}`);
      const finished = run && fmt(run.finishedAt);
      if (finished) parts.push(`${t('finishedLabel')}: ${finished}`);
      when.textContent = parts.join(' · ');
    }
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
    // This panel does not write the scan summary card, and the reason is a
    // measurement rather than a preference. It used to, as
    // `Opps: ${run.opportunitiesCount || 0}`, and that field is in no run
    // report: `persistRunReport` persists `sanitizeReport(report)`, whose top
    // level is runId, startedAt, finishedAt, status, parallel, books and jobs.
    // The stored copy on this machine measures five keys — runId, startedAt,
    // finishedAt, status, jobs — and `opportunitiesCount` is not among them.
    // Its only writer anywhere was the route's own fallback for a machine with
    // no report file at all, which is exactly the case in which there are no
    // opportunities to count.
    //
    // So the writer was harmless-looking and wrong every time: it ran on the
    // terminal `scrape-update`, which arrives AFTER the `scan-update` of the
    // same run (the counts are broadcast inside the scan phase,
    // scrape-orchestrator.mjs:331; the terminal state is set after the
    // verification pass), and overwrote four real numbers with a zero. The
    // counts belong to the scan, so they are read from the scan — see
    // refreshScanSummary.
  } catch (_err) { /* ignore */ }
}

/**
 * What to print for the scheduler's last tick.
 *
 * The backend writes `lastRun` in three distinct shapes and the middle one is
 * not a failure: a tick that finds a scrape already in flight records
 * `{ ok: false, skipped: true, reason }`, because the work it wanted started is
 * already running and starting it twice would be the bug. Reading `ok` alone
 * calls that "failed", which is the same mistake the job table above refuses to
 * make — and worse here, because a 15-minute scheduler ticking into a scrape
 * that takes longer than 15 minutes would sit permanently red while the app was
 * in fact working.
 *
 * `reason` is the backend's own English sentence, printed as-is for the same
 * reason `lastError.message` is: it is diagnostic text, not chrome, and
 * translating one string while leaving its neighbours raw would be a half
 * measure that reads as a bug.
 */
function schedulerLastRunText(s, t) {
  if (!s.lastRun) return t('neverRan');
  const at = new Date(s.lastRun.at).toLocaleString();
  const verdict = s.lastRun.skipped ? t('skippedShort') : s.lastRun.ok ? t('okShort') : t('failedShort');
  const why = s.lastRun.skipped && s.lastRun.reason ? ` — ${s.lastRun.reason}` : '';
  return `${t('lastRun')}: ${at} (${verdict})${why}`;
}

/**
 * The error the service recorded, and when.
 *
 * On the tick path both services write the error beside the run it came from —
 * `lastRun = { ok: false }` and `lastError = { message, at }` in the same catch
 * (scheduler-service.mjs:127-128, live-service.mjs:234-235) — so the run
 * timestamp already on the line dates that failure and printing the moment twice
 * would be noise.
 *
 * The two interval callbacks are the exception: they record the error and no run
 * (scheduler-service.mjs:109, live-service.mjs:184), because their rejection
 * comes from outside the launch, which has its own catch. On that path the run on
 * the line is the previous tick's and a reader has no way to tell the error is
 * newer than the run printed beside it. `lastRun.ok` settles it without
 * comparing clocks: an error recorded by a tick always sits beside a run with
 * `ok: false`, so a run that is not a failure is not the run this error came
 * from — and neither is a panel that has never run.
 *
 * `at` is read before the branch decides, so the field is read on every error
 * rather than only on the ones this run happens to have.
 */
function lastErrorSegment(s, t) {
  const stamp = s.lastError.at ? new Date(s.lastError.at).toLocaleString() : '';
  const undated = !s.lastRun || s.lastRun.ok !== false;
  const when = undated && stamp ? ` ${stamp}:` : ':';
  return ` · ${t('lastError')}${when} ${s.lastError.message}`;
}

/**
 * Which books the scheduler will actually run.
 *
 * The scheduler keeps its own list, restored from disk at boot, and it is not
 * the chip selection: the page defaults the chips from the bookmaker registry,
 * so after a restart the two can describe different sets without the user ever
 * having touched anything. Saving writes the chips over the scheduler, which
 * means changing the interval quietly also changes which books run — so the
 * list that is actually in force is shown rather than implied by a checkbox.
 *
 * Names, not ids: the chips are labelled by name, and a line of raw ids next to
 * a list of names would be unreadable rather than informative.
 */
function renderSchedulerBooks(s) {
  const el = $('sched-books');
  if (!el) return;
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const ids = Array.isArray(s.bookIds) ? s.bookIds : [];
  if (!s.enabled && !ids.length) { el.textContent = ''; return; }
  const names = ids.map((id) => scrapers.find((b) => b.id === id)?.name || id);
  el.textContent = `${t('schedulerBooks')}: ${names.length ? names.join(', ') : '—'}`
    + (s.resumed ? ` · ${t('schedulerResumed')}` : '');
}

/**
 * The nine scan fields, each with the label the form already shows for it.
 *
 * Order is the order the form reads them in, and the keys are the ones the
 * backend stores — the comparison is a named field list, not a deep equality,
 * because the stored object is allowed to carry fields the form does not have
 * and a `JSON.stringify` comparison would call that a difference on every load.
 */
const SCHEDULER_SCAN_FIELDS = [
  ['bankroll', 'bankroll'],
  ['minRoiPercent', 'minRoi'],
  ['minEvPercent', 'minEv'],
  ['maxMiddleRiskPercent', 'maxMiddleRisk'],
  ['minMiddleRoiPercent', 'minMiddleRoi'],
  ['includeLive', 'includeLive'],
  ['includePast', 'includePast'],
  ['maxEvents', 'eventCollection'],
  ['sport', 'sport'],
];

/**
 * Which stored scan options no longer match the form.
 *
 * This is the same defect as the book list above, one level down, and on this
 * machine it is one profile switch away: `data/scheduler-state.json` holds
 * bankroll 1000 / ROI 0 / risk 15 / middle 20 with live and past off, which is
 * profile 1 (`trusted-prematch`) — and switching the form to profile 2
 * (`review-live`, bankroll 500 / ROI 1 / risk 10 / middle 30, live and past on)
 * changes what a manual run scans without changing what the scheduler will scan
 * at the next tick, silently, because the form is the only place the two were
 * ever visible and it shows one of them.
 *
 * A field the stored copy does not carry is not a difference. The state file
 * predates `maxEvents` and `sport` being sent, and reporting `undefined → all`
 * for them would be a difference the operator cannot act on.
 */
function schedulerScanDiff(saved, current) {
  if (!saved || typeof saved !== 'object') return [];
  return SCHEDULER_SCAN_FIELDS
    .filter(([field]) => saved[field] !== undefined && saved[field] !== current[field])
    .map(([field, labelKey]) => ({ field, labelKey, theirs: saved[field], ours: current[field] }));
}

/**
 * A stored-vs-form difference, as one line.
 *
 * `includeLive` is the one field the live poll does not take from the form:
 * LiveService.status() forces it on, so comparing the stored copy against the
 * form's own box would report a difference on every poll whose form has live
 * off — and one the operator cannot act on, since the poll ignores that box
 * either way. So the caller passes the form's values with includeLive already
 * set to what the driver will actually use, and the field never shows up.
 */
function scanDiffLine(saved, current, headlineKey) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const show = (value) => (typeof value === 'boolean' ? t(value ? 'yesShort' : 'noShort') : String(value));
  const diff = schedulerScanDiff(saved, current);
  return diff.length
    ? `${t(headlineKey)}: ${diff.map((d) => `${t(d.labelKey)} ${show(d.theirs)} → ${show(d.ours)}`).join(', ')}`
    : '';
}

function renderSchedulerScan(saved) {
  const el = $('sched-scan');
  if (!el) return;
  el.textContent = scanDiffLine(saved, currentScanOptions(), 'schedulerScanDiffers');
}

/**
 * The same defect as `sched-scan`, one panel over, and the live poll has it
 * for the same measured reason: `live-save` posts the form's own scan options
 * with includeLive forced on (scrape.js, live-save handler), the service stores
 * them, and the next tick replays that stored copy for as long as the poll
 * stays armed. Switching the scrape form to another profile rewrites those
 * values without touching the live panel, so a profile switch silently
 * re-scopes what the poll collects at the next tick — and `live-state.json` is
 * the only record of what it will actually use.
 *
 * Without this line the payload's `scanOptions` had no reader at all on this
 * page: the books and the measured duration were drawn, the thresholds the poll
 * will actually apply were not.
 */
function renderLiveScan(l) {
  const el = $('live-scan');
  if (!el) return;
  // Same guard as the measured line above: nothing has drawn yet on the first
  // render, and an absent payload is not a configuration to compare.
  if (!l) { el.textContent = ''; return; }
  el.textContent = scanDiffLine(l.scanOptions, { ...currentScanOptions(), includeLive: true }, 'liveScanDiffers');
}

async function refreshScheduler() {
  try {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const s = await arbiterApi.get('/api/scheduler');
    lastScheduler = s;
    $('sched-enabled').checked = !!s.enabled;
    $('sched-interval').value = s.intervalMinutes || 15;
    renderSchedulerBooks(s);
    renderSchedulerScan(s.scanOptions);
    $('sched-last').textContent = schedulerLastRunText(s, t);
    if (s.lastError) $('sched-last').textContent += lastErrorSegment(s, t);
  } catch (_e) { /* ignore */ }
}

/**
 * The live poll's own status line.
 *
 * The number that matters here is the MEASURED duration of the last completed
 * poll, not the configured interval. At this cadence the two differ by design:
 * a full 24-book batch was measured at 55-118s wall clock, so a poll configured
 * at 60s routinely takes longer than its own interval and the next tick finds
 * the previous one still running. Showing the configured number alone would
 * report a 60s cadence while the app was actually refreshing every ~64s, and
 * showing only green would report that the 90s live window is being met when
 * the worst measured batch (117.9s) is not.
 */
function renderLiveMeasured(l, t) {
  const el = $('live-measured');
  if (!el) return;
  // A re-render driven by an orchestrator transition can land before the first
  // /api/live answer arrives; there is nothing to draw from yet.
  if (!l) { el.textContent = ''; return; }
  if (!l.enabled) { el.textContent = ''; return; }
  const bits = [];
  if (l.scanningAllBooks) {
    bits.push(t('livePollAllBooks'));
  } else {
    const ids = Array.isArray(l.bookIds) ? l.bookIds : [];
    const names = ids.map((id) => scrapers.find((b) => b.id === id)?.name || id);
    bits.push(`${t('schedulerBooks')}: ${names.length ? names.join(', ') : '—'}`);
  }
  // The window this driver exists to serve, read from the backend rather than
  // spelled out here, so a change to DEFAULT_LIVE_MAX_AGE_MS shows up.
  if (Number.isFinite(Number(l.liveMaxAgeMs)) && Number(l.liveMaxAgeMs) > 0) {
    bits.push(t('liveWindowSeconds').replace('{seconds}', String(Math.round(Number(l.liveMaxAgeMs) / 1000))));
  }
  const last = l.lastRun;
  if (last && Number.isFinite(Number(last.durationMs))) {
    const measured = fmtDuration(Number(last.durationMs)) || '—';
    // A poll slower than the live window cannot produce a price a trader can
    // still place, and that is a fact about the measurement, not a warning to
    // dress up. It is stated plainly.
    const overWindow = Number(l.liveMaxAgeMs) > 0 && Number(last.durationMs) > Number(l.liveMaxAgeMs);
    bits.push(`${t('livePollLastDuration')}: ${measured}${overWindow ? ` · ${t('livePollOverWindow')}` : ''}`);
    // The service's own verdict, and a different question from the line above.
    // It compares the measured duration with the poll's own interval — is the
    // driver falling behind its cadence — where `overWindow` compares it with
    // the 90s live window. At the 60s default a 75s poll is over its interval and
    // still inside the window, so the page's own arithmetic would have called
    // it fine. `keepingUp` is the backend answering the question it was written
    // to answer (live-service.mjs, header item 3), and it was computed and
    // published on every settled poll without anything reading it.
    if (last.keepingUp === false) bits.push(t('livePollBehind'));
  }
  if (livePollInFlight(l)) {
    bits.push(t('livePollPending').replace('{time}', fmtClock(l.pending.startedAt)));
  }
  if (Number(l.skippedTicks) > 0) {
    // The count alone cannot be acted on. At this cadence skips are the normal
    // case — a batch measured at 55-118s on a 60s interval skips by design — so
    // "12 skipped" says nothing about whether the driver is stuck now or was
    // merely unlucky an hour ago. `lastSkippedAt` is in the same payload and was
    // rendered nowhere.
    const skipped = t('livePollSkipped').replace('{count}', String(l.skippedTicks));
    bits.push(l.lastSkippedAt
      ? `${skipped} · ${t('livePollLastSkip').replace('{time}', fmtClock(l.lastSkippedAt))}`
      : skipped);
  }
  // Same field, same meaning, same treatment as the scheduler's readout above:
  // the driver was already armed when this process started, so nothing on this
  // page did it.
  if (l.resumed) bits.push(t('schedulerResumed'));
  el.textContent = bits.join(' · ');
}

/**
 * Is a poll of THIS driver running right now?
 *
 * `pending` is not that on its own, and printing it as if it were would be a
 * lie in the one direction that matters. LiveService clears `_pending` on the
 * next tick (`_settlePending()` runs at the top of `_tick`), not when the run
 * reports terminal, so between a poll finishing and the following tick the field
 * is still set while nothing is running. The page would show "poll in flight"
 * for a finished poll, for up to one interval, right after it completed.
 *
 * So it is confirmed against the orchestrator state the page already holds. Both
 * halves are required and neither is sufficient alone: `pending` without a
 * running status is a finished poll awaiting settlement, and a running status
 * without `pending` is somebody's own scrape. When both name the same run the
 * answer is unambiguous.
 *
 * The runId comparison is skipped rather than failed when either side lacks one
 * — `lastRun.runId` is written as `state.runId ?? null`, so a payload can carry
 * null on either side, and demanding equality against a null would report "not
 * running" for a poll that plainly is.
 */
function livePollInFlight(l) {
  const pending = l && l.pending;
  if (!pending || !pending.startedAt) return false;
  if (!['running', 'cancelling'].includes(lastState?.status)) return false;
  // Normalised so the comparison below can test for null rather than for
  // "not defined", which `!==` reports as a difference.
  const pendingRunId = pending.runId ?? null;
  const currentRunId = lastState.runId ?? null;
  if (pendingRunId !== null && currentRunId !== null && pendingRunId !== currentRunId) return false;
  return true;
}

/** A wall-clock time for the status line, or the dash the page uses for absent values. */
function fmtClock(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : '—';
}

async function refreshLive() {
  try {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const l = await arbiterApi.get('/api/live');
    $('live-enabled').checked = !!l.enabled;
    $('live-interval').value = l.intervalSeconds || 60;
    $('live-last').textContent = l.lastRun ? schedulerLastRunText(l, t) : t('neverRan');
    if (l.lastError) $('live-last').textContent += lastErrorSegment(l, t);
    lastLive = l;
    renderLiveMeasured(l, t);
    renderLiveScan(l);
  } catch (_e) { /* ignore */ }
}

$('run-btn').addEventListener('click', async () => {
  const bookIds = [...selectedIds];
  if (!bookIds.length || launchPending || ['running', 'cancelling'].includes(lastState?.status)) return;
  launchPending = true;
  updateRunControls();
  const scanOptions = currentScanOptions();
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
  const scanOptions = currentScanOptions();
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

$('live-save').addEventListener('click', async () => {
  const enabled = $('live-enabled').checked;
  const intervalSeconds = Number($('live-interval').value);
  // Deliberately NOT the chip selection, and not currentScanOptions() either.
  //
  // The chips describe the manual scrape. Inheriting them here would make a
  // toggle labelled "live" quietly re-scope which books it polls, and the
  // poll's own job is to run every runnable book: a subset would leave the
  // untouched books on the previous run's runId, which the scanner's
  // expectedRunId check drops as stale. So the poll sends an empty book list,
  // which the service reads as "all", and only the risk thresholds with
  // includeLive forced on.
  try {
    await arbiterApi.post('/api/live', {
      enabled,
      intervalSeconds,
      bookIds: [],
      scanOptions: { ...currentScanOptions(), includeLive: true },
    });
    log(`live poll ${enabled ? 'enabled' : 'disabled'} (${intervalSeconds}s)`, 'success', 'live');
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    if (typeof window.showToast === 'function') window.showToast(t('toastLiveSaved'), 'success');
    refreshLive();
  } catch (err) {
    log(err.message || 'unable to save live poll', 'error', 'live');
  }
});

// ── The verification pass ──────────────────────────────────────────────────
// A pass re-quotes every leg by re-scraping the books those legs came from
// (verification.mjs:106) and answers with four counts (verification.mjs:157).
// Both ends of that have been on the wire since the pass was written, and until
// now nothing here read either: for the length of the re-quote — 34s to 54s per
// book, measured over nine runs and recorded at scrape-orchestrator.mjs:239 —
// this page said "Verificare" and nothing else, and afterwards the verdict that
// decides whether a published price is real had no screen at all.
let _requoteBooks = 0;
let _requoteDone = 0;

/** The scope of a pass: how many prices, across how many books. `verify-start`. */
function renderVerificationStart(payload) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  _requoteBooks = 0;
  _requoteDone = 0;
  const books = payload.books || [];
  $('m-verified-detail').textContent = `${t('reverify')}: ${payload.targets} · ${t('booksShort')}: ${books.length}`;
  log(`${t('reverify')} — ${payload.targets} · ${t('booksShort')}: ${books.length} (${books.join(', ')})`, 'info', 'verify');
}

/** The denominator for the re-quote progress. `verify-batch-start`. */
function renderRequoteStart(payload) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  _requoteBooks = Number(payload.total) || 0;
  _requoteDone = 0;
  const names = (payload.books || []).join(', ');
  log(`${t('requotingBooks')} — ${_requoteBooks} ${t('booksShort')} (${names})`, 'info', 'verify');
}

/**
 * One book re-quoted. `verify-job-complete`.
 *
 * The per-book line the dead `job-complete` branch used to print, restored on
 * the frame that is actually sent. The `error` shape is the one `refreshLastRun`
 * handles at line 1153: it may be a string rather than an object.
 */
function renderRequoteProgress(payload) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const r = payload.result || {};
  _requoteDone += 1;
  // Every field is read on every frame, not behind the branch that happens to
  // be true in this run: `r.name || payload.jobId` never touches `jobId` on a
  // job that has a name, and `!r.valid && r.reason` never touches `reason` on a
  // job that succeeded — so both would have read as unread while the page
  // plainly renders them.
  const label = `${r.name} (${payload.jobId})`;
  const state = r.valid ? r.status : `${r.status} (${t('failedShort')})`;
  const why = !r.error
    ? ''
    : typeof r.error === 'string' ? r.error : (r.error.code || r.error.message || '');
  const detail = `${r.events || 0} ${t('events').toLowerCase()} · ${fmtDuration(r.durationMs || 0)}`;
  const whyPart = why || r.reason ? ` · ${why || r.reason}` : '';
  log(
    `${t('requotingBooks')} ${_requoteDone}/${_requoteBooks} — ${label} ${state} (${detail}${whyPart})`,
    r.valid ? 'success' : 'warn',
    'verify',
  );
}

/**
 * The re-quote batch's own outcome. `verify-batch-end`.
 *
 * The status the batch reached, how long it took, and the concurrency it ran
 * with — which is `verify-batch-start`'s requested figure clamped to the number
 * of books it had (scraper-service.mjs:133), so it is a different number from
 * the one that frame published, and the one worth drawing: asking for twelve
 * slots and re-quoting two books means two, not twelve.
 */
function renderRequoteEnd(payload) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  const r = payload.report || {};
  const started = Date.parse(r.startedAt || '');
  const finished = Date.parse(r.finishedAt || '');
  const elapsed = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? fmtDuration(finished - started)
    : '';
  const concurrency = Number(r.parallel) > 0 ? `${t('concurrency')}: ${r.parallel}` : '';
  const parts = [r.status, elapsed, concurrency].filter(Boolean);
  log(
    `${t('requotingBooks')} ${_requoteDone}/${_requoteBooks}${parts.length ? ` — ${parts.join(' · ')}` : ''}`,
    r.status === 'ok' ? 'success' : 'warn',
    'verify',
  );
}

/** The verdict. `verify-end`. */
function renderVerificationEnd(payload) {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  $('m-verified').textContent = String(payload.confirmed || 0);
  $('m-verified-detail').textContent =
    `${t('confirmed')}: ${payload.confirmed || 0} · ${t('rejected')}: ${payload.rejected || 0} · `
    + `${t('expired')}: ${payload.expired || 0} · ${t('unconfirmed')}: ${payload.unconfirmed || 0}`;
  log(
    `${t('verifying')} — ${t('confirmed')}: ${payload.confirmed || 0} · ${t('rejected')}: ${payload.rejected || 0} · `
    + `${t('expired')}: ${payload.expired || 0} · ${t('unconfirmed')}: ${payload.unconfirmed || 0}`,
    payload.confirmed ? 'success' : 'warn',
    'verify',
  );
}

_sse = arbiterSse.connect((type, payload) => {
  const t = window.arbiterI18n.t.bind(window.arbiterI18n);
  if (type === 'scrape-update') {
    // A run that finds no opportunity never reaches the verification pass, so
    // the card would keep the previous run's verdict across a fresh scrape.
    // The run id is how the page knows a fresh run has started: the state the
    // last frame carried, against the state this one carries. Read before
    // renderState, which is what makes `lastState` the previous frame rather
    // than this one.
    const previousRunId = lastState ? lastState.runId : null;
    renderState(payload);
    if (payload?.status === 'running' && previousRunId && previousRunId !== lastState.runId) {
      $('m-verified').textContent = '—';
      $('m-verified-detail').textContent = '';
      _requoteBooks = 0;
      _requoteDone = 0;
    }
    // A poll shows up here as an ordinary scrape, so the live panel's measured
    // latency only updates when a run actually ends. Polling /api/live on every
    // job event would be a request per book per tick.
    if (!['running', 'cancelling'].includes(payload?.status)) {
      refreshLive();
      // The last-run table is fed from the persisted report, and the report is
      // written once the pipeline reaches a terminal status — the same frame that
      // ends the run. This used to hang off a `job-complete` branch the server
      // never sent, so the table was drawn once at page load and then never
      // again for the whole session.
      refreshLastRun();
    }
  } else if (type === 'scan-update') {
    log(
      `scan: ${payload.opportunities} ${t('opps')}, ${payload.middles} ${t('middles')}, `
      + `${payload.positiveEv} ${t('positiveEv')}, ${payload.lowHold} ${t('lowHoldLabel')}`,
      'success',
      'engine',
    );
    // Same formatter as the reload path, so the card cannot print the four
    // numbers one way live and another way after a refresh. `true` is the
    // frame's own claim: it is broadcast only after a scan produced a result.
    renderScanSummary(payload, t, true);
  } else if (type === 'verify-start') {
    renderVerificationStart(payload);
  } else if (type === 'verify-batch-start') {
    renderRequoteStart(payload);
  } else if (type === 'verify-job-complete') {
    renderRequoteProgress(payload);
  } else if (type === 'verify-batch-end') {
    renderRequoteEnd(payload);
  } else if (type === 'verify-end') {
    renderVerificationEnd(payload);
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
  // This was a hardcoded bilingual pair, the one place on this page that chose
  // its language by reading arbiterI18n.lang itself instead of asking for a
  // string — so it could not follow a language switch, and the dictionary's own
  // failedToLoadMsg was translated in two languages for this exact sentence.
  const message = window.arbiterI18n.t('failedToLoadMsg');
  const list = $('bookmaker-list');
  if (list) {
    list.setAttribute('role', 'alert');
    list.textContent = `${message} ${err.message || ''}`;
  }
});
