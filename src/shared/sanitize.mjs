/**
 * Strip newlines, control chars, and oversize payloads from anything that
 * could end up in a log line, SSE event, or HTTP response body.
 */

const MAX_LEN = 4096;

export function sanitizeLogLine(input) {
  if (input === null || input === undefined) return '';
  const s = typeof input === 'string' ? input : safeStringify(input);
  return s
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * A scraper result, reduced to what a client can be shown.
 *
 * `events` is a count in both shapes this has to survive, and reading only one
 * of them was why nothing routed through this function: the scraper envelope
 * carries a number (base.mjs:215) and `Array.isArray` was false for every real
 * result, so each one came out of here claiming zero events — the count the page
 * prints beside every book. A caller still holding the raw selections passes an
 * array, so both are accepted.
 *
 * `id` and `name` are kept because a result without them is not attributable to
 * a book, and both are scalars on the envelope. `outputs[]` is not: it is a path
 * on the machine that ran the scrape, and a client has no use for it.
 */
export function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {
    id: String(result.id ?? ''),
    name: String(result.name ?? ''),
    valid: Boolean(result.valid),
    status: result.status || (result.valid ? 'ok' : 'failed'),
    events: Array.isArray(result.events) ? result.events.length : Number.isFinite(result.events) ? result.events : 0,
    rawSize: Number.isFinite(result.rawSize) ? result.rawSize : 0,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
  };
  if (result.error) {
    out.error = {
      name: String(result.error.name || 'Error'),
      message: sanitizeLogLine(result.error.message || ''),
      field: result.error.field || null,
      code: result.error.code || null,
    };
  }
  if (result.reason) out.reason = String(result.reason);
  return out;
}

export function sanitizeReport(report) {
  if (!report) return null;
  return {
    runId: String(report.runId || ''),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status,
    jobs: Array.isArray(report.jobs) ? report.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      sourceIds: Array.isArray(j.sourceIds) ? j.sourceIds : [],
      valid: Boolean(j.valid),
      status: j.status,
      events: Number.isFinite(j.events) ? j.events : 0,
      durationMs: Number.isFinite(j.durationMs) ? j.durationMs : 0,
      error: j.error ? {
        name: String(j.error.name || 'Error'),
        message: sanitizeLogLine(j.error.message || ''),
        field: j.error.field || null,
      } : null,
    })) : [],
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
