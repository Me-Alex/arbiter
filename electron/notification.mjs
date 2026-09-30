/**
 * notification.mjs — what a desktop notification is allowed to say.
 *
 * The renderer is the one that decides an alert is worth interrupting for, but
 * it is also the one that hands the strings over. Splitting the two keeps the
 * main process's notification code down to "show this" and puts every decision
 * that can be tested — what survives, how long it is, when there is nothing
 * left to say — here, where a plain `node --test` can reach it. A module that
 * imports `electron` cannot be tested at all without a running app, and
 * `main.mjs` has no test file.
 *
 * It also decides the *identity* of a notification. Electron's Notification has
 * no `tag`, so nothing upstream collapses a repeat: without one of these, a
 * scan that publishes twenty matching opportunities twenty times would stack
 * twenty identical toasts, and the twenty-first is the one the trader reads.
 */

import { sanitizeLogLine } from '../src/shared/sanitize.mjs';

/** Long enough to name the market, short enough to fit a toast on a phone-sized display. */
export const NOTIFICATION_LIMITS = Object.freeze({ title: 120, body: 400, tag: 160 });

/** Used when there is a body but no title, so the toast is never a bare paragraph. */
export const DEFAULT_TITLE = 'Arbiter';

/**
 * Reduce whatever the renderer sent to a notification the main process can show.
 *
 * @param {unknown} payload
 * @returns {{title: string, body: string, tag: string, silent: boolean}|null}
 *   `null` when there is nothing left to say — an empty toast is worse than no
 *   toast, because it still costs the trader a glance.
 */
export function normalizeNotification(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const title = clip(sanitizeLogLine(payload.title), NOTIFICATION_LIMITS.title);
  const body = clip(sanitizeLogLine(payload.body), NOTIFICATION_LIMITS.body);
  if (!title && !body) return null;
  return {
    title: title || DEFAULT_TITLE,
    body,
    // The alert key, when there is one: the same opportunity re-alerted
    // replaces its own toast instead of queueing behind it.
    tag: clip(sanitizeLogLine(payload.tag), NOTIFICATION_LIMITS.tag),
    // Default to speaking up. Silence is a setting the user has to ask for, and
    // a truthy string from a form post counts as asking.
    silent: payload.silent === true || payload.silent === 'true',
  };
}

/**
 * Truncate without splitting a surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 units, so clipping a title that ends
 * in an emoji can leave half a character behind, and some notification
 * backends render that as a replacement glyph in the middle of a team's name.
 */
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = Array.from(text).slice(0, max).join('');
  return cut.length < text.length ? `${cut}…` : cut;
}
