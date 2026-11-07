/**
 * smoke-verdict.mjs — the one decision the live gate makes about a job that
 * answered, kept out of the gate so it can be tested without the network.
 *
 * The gate cannot be imported: loading it scrapes every enabled book. That made
 * its floor rules reachable only by running a real one, so the test that was
 * supposed to pin the floor failed whenever the book failed in transport first
 * — a superbet timeout reported `status timeout (TimeoutError: aborted)` and the
 * assertion about `expected >= 999999` never had a chance to run.
 *
 * This function has no imports and no side effects, and it is the same call the
 * gate makes, so the wording it produces is the wording the report carries.
 */

/**
 * The verdict for a job whose adapter returned a report.
 *
 * A job may declare its own `minEvents`, which overrides the global
 * `--min-events` default. The default is deliberately 1: an unconfigured book
 * is expected to return events, and a book that stops publishing is a change
 * worth being told about rather than absorbed. A per-job floor exists for the
 * opposite case — a source whose coverage is legitimately small, where a global
 * floor of 1 would still pass on a single stray event after real coverage had
 * silently collapsed.
 *
 * @param {object} args
 * @param {{minEvents?: number}} args.job the job as written in the config
 * @param {number} args.minEvents the global floor
 * @param {number} args.events how many events the adapter collected
 * @returns {{verdict: 'ok'|'FAIL', floor: number, why: string|null}}
 */
export function floorVerdict({ job, minEvents, events }) {
  // Only a positive integer is a floor. `0`, `undefined` and a stray string all
  // mean "this job declares none", and the global default applies.
  const declaresFloor = Number.isInteger(job.minEvents) && job.minEvents > 0;
  const floor = declaresFloor ? job.minEvents : minEvents;
  if (events >= floor) return { verdict: 'ok', floor, why: null };
  return {
    verdict: 'FAIL',
    floor,
    // The reason names which threshold applied, because a reader looking at a
    // failing book cannot otherwise tell a quiet day from a broken parser.
    why: `collected ${events} event(s), expected >= ${floor}${declaresFloor ? ' (job floor)' : ''}`,
  };
}
