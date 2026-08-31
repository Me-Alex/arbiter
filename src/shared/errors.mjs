/**
 * Common error shape so the UI can render cause-by-cause.
 */
export class ValidationError extends Error {
  constructor(message, { field = null, code = 'EVALIDATION', cause = null } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class UpstreamError extends Error {
  constructor(message, { status = null, code = 'EUPSTREAM', cause = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class TimeoutError extends Error {
  constructor(message = 'timeout', { code = 'ETIMEOUT' } = {}) {
    super(message);
    this.name = 'TimeoutError';
    this.code = code;
  }
}

export function isRetryable(err) {
  if (!err) return false;
  if (err.code === 'ETIMEOUT') return true;
  if (err.code === 'EUPSTREAM') return Number(err.status) >= 500;
  // network errors
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
  return codes.includes(err.code);
}

/** Exponential backoff with cap. */
export function backoffMs(attempt, { base = 1000, cap = 30_000 } = {}) {
  const ms = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  // full jitter
  return Math.floor(Math.random() * ms);
}
