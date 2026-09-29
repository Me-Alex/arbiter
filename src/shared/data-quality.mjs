const MINUTE_MS = 60 * 1000;

export const DATA_STATUS = Object.freeze({
  FRESH: 'fresh',
  EMPTY: 'empty',
  PARTIAL: 'partial',
  FAILED: 'failed',
  STALE: 'stale',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

export const DEFAULT_PREMATCH_MAX_AGE_MS = 10 * MINUTE_MS;
export const DEFAULT_LIVE_MAX_AGE_MS = 90 * 1000;

export function snapshotQuality(snapshot, {
  now = Date.now(),
  prematchMaxAgeMs = DEFAULT_PREMATCH_MAX_AGE_MS,
  liveMaxAgeMs = DEFAULT_LIVE_MAX_AGE_MS,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { status: DATA_STATUS.UNKNOWN, reason: 'snapshot missing', ageMs: null };
  }

  const status = snapshot.dataStatus || (Array.isArray(snapshot.events) && snapshot.events.length ? DATA_STATUS.FRESH : DATA_STATUS.EMPTY);
  if (status === DATA_STATUS.FAILED || status === DATA_STATUS.CANCELLED || status === DATA_STATUS.PARTIAL) {
    return { status, reason: `snapshot is ${status}`, ageMs: null };
  }
  if (status === DATA_STATUS.EMPTY) return { status, reason: 'source observed no usable events', ageMs: null };

  const capturedAt = Date.parse(snapshot.capturedAt || snapshot.observedAt || '');
  if (!Number.isFinite(capturedAt)) return { status: DATA_STATUS.UNKNOWN, reason: 'capturedAt missing or invalid', ageMs: null };

  const ageMs = Math.max(0, now - capturedAt);
  const hasLive = Array.isArray(snapshot.events) && snapshot.events.some((event) => event && event.live === true);
  const maxAgeMs = hasLive ? liveMaxAgeMs : prematchMaxAgeMs;
  if (ageMs > maxAgeMs) {
    return { status: DATA_STATUS.STALE, reason: `snapshot age ${ageMs}ms exceeds ${maxAgeMs}ms`, ageMs };
  }
  return { status: DATA_STATUS.FRESH, reason: null, ageMs };
}

export function isActionableKickoff(value, { now = Date.now(), includeLive = false } = {}) {
  if (includeLive) return true;
  const kickoff = Date.parse(value || '');
  return Number.isFinite(kickoff) && kickoff > now;
}

export function sourceHealthSummary(sources = []) {
  const counts = Object.fromEntries(Object.values(DATA_STATUS).map((status) => [status, 0]));
  for (const source of sources) {
    const status = source?.dataStatus || DATA_STATUS.UNKNOWN;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}
