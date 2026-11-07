/**
 * age.ts — how old the feed is, written so a stale number cannot hide.
 *
 * The sidebar printed seconds below a minute and raw minutes above it, so a
 * scan that stopped two days ago read `3902m` — a number a trader reads as
 * "about an hour" at a glance, because nothing on the line separates it from
 * `65m`. That is the one distinction the line exists to make: a feed that is
 * seconds old and a feed that has been dead since Tuesday were rendered in the
 * same unit, with only the digits to tell them apart.
 *
 * Hours and days fix that. The units are the dealer's own shorthand and are
 * identical in both interface languages except days — Romanian writes `z`
 * (zile), English `d` — so only the day unit is injected by the caller. This
 * module stays locale-free and dictionary-free for the same reason
 * `claims.ts` does: it decides how a duration is stated, not what language it
 * is stated in.
 */
export type DayUnit = (days: number) => string;

/** A duration in seconds, as `45s`, `12m`, `3h`, `2z 17h` / `2d 17h`. */
export function formatAge(seconds: number, dayUnit: DayUnit): string {
  // A clock that jumped backwards would otherwise produce a negative age, and
  // `-3s` reads as a guarantee that the feed is fresher than it is.
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) return `${Math.floor(total / 3600)}h`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  // Whole days drop the hours rather than printing a `0h` that looks like a
  // measurement someone took.
  return hours ? `${dayUnit(days)} ${hours}h` : dayUnit(days);
}
