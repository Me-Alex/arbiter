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

export function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {
    valid: Boolean(result.valid),
    status: result.status || (result.valid ? 'ok' : 'failed'),
    events: Array.isArray(result.events) ? result.events.length : 0,
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
