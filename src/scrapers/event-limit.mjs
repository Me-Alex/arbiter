import { ValidationError } from '../shared/errors.mjs';

/** A result cap never removes the provider request/body/window bounds. */
export function eventLimit(value = process.env.ARBITER_MAX_EVENTS_PER_BOOK ?? 'all') {
  if (String(value).trim().toLowerCase() === 'all') return Infinity;
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new ValidationError('maxEvents must be a positive integer or all');
  }
  return count;
}
