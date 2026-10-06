/**
 * alert-engine.mjs — decides which signals in a published scan deserve to
 * interrupt the trader.
 *
 * This used to be two hand-written preference objects in tracker-service.mjs
 * that nothing read. `minMarginPercent`, `minMiddleRoiPercent`, `channels`,
 * `quietHours` and `cooldownSeconds` were written to
 * data/alert-preferences.json on every save and consulted by no code at all,
 * and the defaults disagreed with DEFAULT_SCAN_OPTIONS anyway (1% / 25% against
 * 0% / 20%), so the file was a second, drifting copy of a decision the scanner
 * had already made.
 *
 * The split of responsibility is deliberate:
 *   - the server decides WHAT deserves attention, deterministically, from the
 *     published scan and the stored preferences;
 *   - the page decides WHEN it last shouted about it, because the cooldown is
 *     per-tab and the server has no idea which tabs are open.
 *
 * Everything here is pure. No clock reads of its own beyond the `now` it is
 * handed, and no I/O — which is what makes the threshold and quiet-hours rules
 * testable without a workspace, a browser or a sleep.
 */

export const ALERT_SCHEMA = 1;

/** The most either family reports, so a 900-opportunity scan is not shipped whole. */
export const MAX_ALERTS_PER_FAMILY = 25;

const MINUTE_MS = 60 * 1000;

/**
 * The stored settings. These numbers are deliberately stricter than the
 * scanner's own filters: a scan computes everything above 0% ROI because
 * computing costs nothing, whereas an alert is an interruption and should
 * only fire for something worth being interrupted for.
 */
export const DEFAULT_ALERT_PREFERENCES = Object.freeze({
  minMarginPercent: 1,
  minMiddleRoiPercent: 25,
  includeLive: false,
  channels: Object.freeze({ desktop: true, sound: false }),
  quietHours: Object.freeze({ from: '23:00', to: '07:00', enabled: false }),
  cooldownSeconds: 60,
});

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Coerce whatever was stored or submitted into a usable preferences object.
 *
 * Every field falls back to its default independently. A settings file is
 * edited by hand and survives version changes, so treating "this field is
 * nonsense" as "this whole file is nonsense" would throw away settings the
 * user never touched — and treating a nonsense value as usable would let a
 * threshold arrive as NaN, which compares false against everything and
 * silently alerts on nothing at all.
 *
 * @param {object} [raw]
 * @returns {object} A complete, valid preferences object.
 */
export function normalizeAlertPreferences(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const channels = source.channels && typeof source.channels === 'object' ? source.channels : {};
  const quiet = source.quietHours && typeof source.quietHours === 'object' ? source.quietHours : {};
  return {
    minMarginPercent: clampNumber(source.minMarginPercent, -50, 100, DEFAULT_ALERT_PREFERENCES.minMarginPercent),
    minMiddleRoiPercent: clampNumber(source.minMiddleRoiPercent, 0, 1000, DEFAULT_ALERT_PREFERENCES.minMiddleRoiPercent),
    includeLive: toBoolean(source.includeLive, DEFAULT_ALERT_PREFERENCES.includeLive),
    channels: {
      desktop: toBoolean(channels.desktop, DEFAULT_ALERT_PREFERENCES.channels.desktop),
      sound: toBoolean(channels.sound, DEFAULT_ALERT_PREFERENCES.channels.sound),
    },
    quietHours: {
      from: normalizeTimeOfDay(quiet.from, DEFAULT_ALERT_PREFERENCES.quietHours.from),
      to: normalizeTimeOfDay(quiet.to, DEFAULT_ALERT_PREFERENCES.quietHours.to),
      enabled: toBoolean(quiet.enabled, DEFAULT_ALERT_PREFERENCES.quietHours.enabled),
    },
    cooldownSeconds: Math.round(clampNumber(source.cooldownSeconds, 0, 86400, DEFAULT_ALERT_PREFERENCES.cooldownSeconds)),
  };
}

/**
 * Whether the current time falls inside the configured quiet window.
 *
 * The default window (23:00 → 07:00) crosses midnight, so this is not a simple
 * range test: a window whose end is earlier than its start wraps. A window
 * whose start and end are equal is treated as covering nothing rather than
 * everything — a user who set both to 08:00 means "no quiet hours", not
 * "muted all day", and guessing the other way would silence the app for good.
 *
 * @param {object} preferences
 * @param {{ now?: Date|number }} [opts]
 * @returns {boolean}
 */
export function isQuietNow(preferences, { now = new Date() } = {}) {
  const quiet = normalizeAlertPreferences(preferences).quietHours;
  if (!quiet.enabled) return false;
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  if (from === to) return false;
  // Wraps past midnight, e.g. 23:00 → 07:00.
  return from > to ? (minutes >= from || minutes < to) : (minutes >= from && minutes < to);
}

/**
 * The signals in a scan that are worth interrupting for.
 *
 * The two families are reported separately and each sorted by its own ROI,
 * never merged into one list. An arbitrage ROI and a middle ROI are not the
 * same unit of risk: a 30% middle sits on a wide handicap line that can push
 * either way, while a 4% arb is a locked-in edge. Ranked together the middle
 * would bury the arb and the list would read as "the best opportunities" when
 * it is not saying anything of the kind.
 *
 * In-play signals are refused outright unless `includeLive` is set. That is
 * the same fail-closed rule the scanner applies: an in-play price expires in
 * 90 seconds, and an alert that names one is an alert the trader cannot act
 * on by the time it arrives.
 *
 * @param {object|null} scan  A published scan.
 * @param {object} [preferences]
 * @returns {{alerts: {arbitrages: object[], middles: object[]},
 *            counts: {arbitrages: number, middles: number},
 *            truncated: {arbitrages: number, middles: number},
 *            thresholds: object, quietNow: boolean, evaluatedAt: string}}
 */
export function evaluateAlerts(scan, preferences, { now = new Date() } = {}) {
  const prefs = normalizeAlertPreferences(preferences);
  const arbitrages = selectFamily(scan?.opportunities, {
    type: 'arb',
    threshold: prefs.minMarginPercent,
    includeLive: prefs.includeLive,
  });
  const middles = selectFamily(scan?.middles, {
    type: 'middle',
    threshold: prefs.minMiddleRoiPercent,
    includeLive: prefs.includeLive,
  });

  return {
    alerts: {
      arbitrages: arbitrages.items,
      middles: middles.items,
    },
    // The full totals, not the truncated lengths: "12 shown of 40" is the
    // difference between a list and a sample.
    counts: { arbitrages: arbitrages.total, middles: middles.total },
    truncated: { arbitrages: arbitrages.total - arbitrages.items.length, middles: middles.total - middles.items.length },
    thresholds: {
      minMarginPercent: prefs.minMarginPercent,
      minMiddleRoiPercent: prefs.minMiddleRoiPercent,
      includeLive: prefs.includeLive,
    },
    quietNow: isQuietNow(prefs, { now }),
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * Stable identity for a signal, and the unit the page's cooldown counts in.
 *
 * Built from the same three fields verification keys on, so a signal that gets
 * re-verified keeps its cooldown — otherwise every verification pass would look
 * like a brand new opportunity and the trader would be re-alerted for it.
 *
 * Read `type` off the signal, which is only ever set on an alert this module
 * emitted. The raw findings carry no `type` — the family is chosen by which
 * array they were read from — so the engine builds the key itself from the
 * family it is selecting rather than trusting a field the producer never
 * writes. Trusting it would have keyed every alert on `eventKey::marketKey::`,
 * making an arbitrage and a middle on the same market the same alert.
 *
 * Not exported. This was `alertKey`, and its test said it existed so the client
 * could re-derive the same key — the page does not: it counts cooldowns on the
 * `key` it is handed and never rebuilds the string, so the export had a client
 * that did not exist. The format is a wire contract either way, and what holds it
 * is the test, against the delivered key rather than against this function.
 */
function buildKey(eventKey, marketKey, type) {
  return `${eventKey || ''}::${marketKey || ''}::${type || ''}`;
}

function selectFamily(signals, { type, threshold, includeLive }) {
  const list = Array.isArray(signals) ? signals : [];
  const matched = [];
  const seen = new Set();

  for (const signal of list) {
    if (!signal || typeof signal !== 'object') continue;
    // Fail closed on the flag itself: a string 'true' from a feed that was not
    // normalised is not a reason to believe a price is in-play.
    if (!includeLive && signal.live === true) continue;

    const roi = toFiniteNumber(signal.marginPercent ?? signal.roiPercent);
    if (roi === null || roi < threshold) continue;

    const key = buildKey(signal.eventKey, signal.marketKey, type);
    if (seen.has(key)) continue;
    seen.add(key);

    matched.push({
      key,
      type,
      eventKey: signal.eventKey || '',
      marketKey: signal.marketKey || '',
      sport: signal.sport || '',
      league: signal.league || '',
      kickoff: signal.kickoff || null,
      homeTeam: signal.homeTeam || '',
      awayTeam: signal.awayTeam || '',
      live: signal.live === true,
      roiPercent: roi,
      totalStake: toFiniteNumber(signal.totalStake),
      guaranteedProfit: toFiniteNumber(signal.guaranteedProfit),
      riskPercent: toFiniteNumber(signal.riskPercent),
      sourceIds: (Array.isArray(signal.legs) ? signal.legs : [])
        .map((leg) => leg && leg.sourceId)
        .filter(Boolean),
      verified: signal.verification?.status || null,
    });
  }

  // Highest ROI first; a tie breaks on the key so the order is stable across
  // polls and the cooldown map does not reshuffle under the trader.
  matched.sort((a, b) => (b.roiPercent - a.roiPercent) || a.key.localeCompare(b.key));
  return { items: matched.slice(0, MAX_ALERTS_PER_FAMILY), total: matched.length };
}

/**
 * A number, or null when the value is not one.
 *
 * The guards are the whole reason this exists. `Number(null)`, `Number('')` and
 * `Number([])` are all `0`, and `0` is a legitimate answer everywhere a number
 * is read here — so `Number.isFinite(Number(x))` alone is not a test, it is a
 * rubber stamp: a hand-edited `"minMarginPercent": null` would become a 0%
 * threshold, alerting on everything above zero, and a signal with no ROI would
 * pass a threshold of 0 and raise an alert whose own headline could not be
 * printed. Treating a missing value as a *missing* value is the only reading
 * that is safe.
 *
 * So only a real number or a numeric string is accepted. Objects and booleans
 * are refused rather than coerced: `{}` and `[]` are both "not a number" and
 * neither may quietly become one.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value, min, max, fallback) {
  const n = toFiniteNumber(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeTimeOfDay(value, fallback) {
  const text = String(value ?? '').trim();
  return TIME_OF_DAY.test(text) ? text : fallback;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export { MINUTE_MS };
