/**
 * Normalize the per-book event limit. `all` means all events available from
 * the provider's bounded feed/window; numeric values remain bounded locally.
 */
export function maxEvents(value, fallback, ceiling) {
  if (String(value ?? '').trim().toLowerCase() === 'all') return Infinity;
  const numeric = Number(value);
  // `numeric || fallback` treats an explicit 0 as "unset" and silently swapped a
  // deliberate zero-cap for the fallback, so maxEvents(0, 120, 1000) returned
  // 120. Only a non-finite value (NaN from garbage input) takes the fallback.
  const effective = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(1, Math.min(ceiling, effective));
}

export function isUnlimited(limit) {
  return limit === Infinity;
}

export function serializedMaxEvents(limit) {
  return isUnlimited(limit) ? 'all' : limit;
}

export function limitReached(count, limit) {
  return !isUnlimited(limit) && count >= limit;
}
