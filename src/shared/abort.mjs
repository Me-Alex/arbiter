/**
 * Combine multiple AbortSignals into one. The resulting signal aborts when any
 * of the input signals abort.
 *
 * @param {...AbortSignal} signals
 * @returns {AbortSignal|undefined}
 */
export function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
