/**
 * jobFailureCurrency — is a job's recorded failure CURRENT, or history?
 *
 * `consecutiveFailures` is durable job state. It never self-clears: only a
 * successful run resets it. So a failure recorded once is reported forever, and
 * /health summed every job's count with no bound.
 *
 * EARNED (2026-10-21). /health reported `consecutiveJobFailures: 119` on an agent
 * with nothing wrong. 118 of those belonged to `w29-working-set-mirror`, which was
 * switched OFF and had last run on 2026-09-26 — twenty-five days earlier. Because a
 * disabled job never runs, that count could never come down, so the agent was
 * permanently "degraded" over something nothing could fix, and an operator was
 * nearly told it was an active fire. A number that cannot decrease is not a health
 * signal.
 *
 * The same lesson is already encoded one layer over, in
 * `DegradationReporter.HEALTH_WINDOW_MS`, whose comment says a single old transient
 * "would otherwise pin the dashboard 'Degraded' badge red for the whole process
 * lifetime even after recovery". The job-failure sum never received that treatment.
 *
 * TWO EXCLUSIONS, AND BOTH ARE REPORTED — never hidden. Dropping a failure quietly
 * would be the opposite defect: an honest surface moves the information, it does not
 * lose it. The caller renders `stale` beside the current count.
 */

/**
 * How recently a job must have RUN for its failures to count as current. Sibling of
 * `DegradationReporter.HEALTH_WINDOW_MS` (30 min), deliberately much wider: a job's
 * cadence is its own, so an hourly or daily job that failed this morning IS a current
 * failure, while a 30-minute window would drop it. 24h covers every cadence shorter
 * than a day.
 */
export const JOB_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Why a job's failures were excluded from the current count. */
export type StaleFailureReason = 'disabled' | 'stale';

export interface StaleFailureEntry {
  slug: string;
  failures: number;
  /** ISO timestamp of the job's last run, or null when it has never run. */
  lastRun: string | null;
  reason: StaleFailureReason;
}

export interface JobFailureSummary {
  /** Sum of `consecutiveFailures` over jobs whose failures are CURRENT. */
  current: number;
  /** Excluded entries, most failures first. Bounded by `maxStaleEntries`. */
  stale: StaleFailureEntry[];
  /** Sum of `failures` across every excluded job, including any beyond the cap. */
  staleTotal: number;
}

export interface JobFailureInput {
  slug: string;
  /** A job definition's `enabled`; `undefined` is treated as enabled (the default). */
  enabled?: boolean;
  failures: number;
  lastRun?: string | null;
}

/**
 * Split recorded job failures into current and stale.
 *
 * FAIL TOWARD VISIBILITY: a job with an absent or unparseable `lastRun` counts as
 * CURRENT. The alternative — treating an unreadable timestamp as stale — would let a
 * state-file corruption silence a real failure, which is the direction that hides
 * problems rather than the direction that over-reports them.
 */
export function summarizeJobFailures(
  jobs: readonly JobFailureInput[],
  now: number = Date.now(),
  windowMs: number = JOB_FAILURE_WINDOW_MS,
  maxStaleEntries = 20,
): JobFailureSummary {
  let current = 0;
  let staleTotal = 0;
  const stale: StaleFailureEntry[] = [];

  for (const job of jobs) {
    if (!Number.isFinite(job.failures) || job.failures <= 0) continue;
    const lastRunMs = job.lastRun ? Date.parse(job.lastRun) : NaN;
    const isStale = Number.isFinite(lastRunMs) && (now - lastRunMs) > windowMs;
    const isDisabled = job.enabled === false;
    if (isDisabled || isStale) {
      staleTotal += job.failures;
      stale.push({
        slug: job.slug,
        failures: job.failures,
        lastRun: job.lastRun ?? null,
        // A disabled job is reported as disabled even when it is ALSO stale: that is
        // the reason an operator can act on (re-enable it, or delete it), whereas
        // "stale" on a job that cannot run is a consequence, not a cause.
        reason: isDisabled ? 'disabled' : 'stale',
      });
      continue;
    }
    current += job.failures;
  }

  stale.sort((a, b) => b.failures - a.failures);
  return { current, stale: stale.slice(0, maxStaleEntries), staleTotal };
}
