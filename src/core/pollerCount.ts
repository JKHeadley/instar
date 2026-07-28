/**
 * B5 (multimachine-lease-poll-robustness, Decision 11) — the exactly-one-listener
 * decision.
 *
 * Telegram allows exactly ONE getUpdates poller per bot token. Zero pollers =
 * silence (the 3.5h incident); ≥2 = a 409-conflict war + split handling. This
 * pure decision answers "how many of my machines are polling?" THREE-valued so a
 * dark peer never produces a false alarm:
 *   - ok            exactly one FRESH poller observed, no peer dark/unknown.
 *   - dual          ≥2 pollers positively observed, OR a local Telegram 409
 *                   (partition-immune evidence of a 2nd poller even when the
 *                   peer's heartbeat is dark — the case heartbeat-counting alone
 *                   can't see).
 *   - silence       zero pollers, and every peer is fresh + known (so it's a real
 *                   zero, not a visibility gap).
 *   - indeterminate a peer is dark or reports an unknown poll state, so the exact
 *                   count can't be confirmed — surface "can't confirm ingress",
 *                   NEVER a false silence/ok alarm (the adversarial-review rule).
 *
 * Pure + deterministic → fully unit-testable. SIGNAL only (observe), never gates.
 */

export interface PollerObservation {
  machineId: string;
  /**
   * Whether this machine's lifeline is ACTUALLY polling. `undefined` = an older
   * peer that doesn't emit the field yet (mid-rollout) OR genuinely unknown —
   * treated as a visibility gap (→ indeterminate), never as "not polling".
   */
  pollingActive: boolean | undefined;
  /** Heartbeat-fresh (not dark). A dark peer's poll state is unknowable. */
  fresh: boolean;
}

export type PollerCountVerdict = 'ok' | 'dual' | 'silence' | 'indeterminate';

export interface PollerCountResult {
  verdict: PollerCountVerdict;
  /** Pollers positively observed (fresh AND pollingActive === true). */
  activePollers: number;
  /** True if any peer is dark or reports an unknown poll state. */
  hasVisibilityGap: boolean;
  /** One-line reason for the surface. */
  reason: string;
}

/**
 * @param observations one row per pool machine (INCLUDING self — self is always
 *   fresh + a known poll state).
 * @param localSaw409 did THIS machine's lifeline recently get a Telegram 409
 *   (someone else is polling the same token)? Partition-immune dual evidence.
 */
export function evaluatePollerCount(
  observations: PollerObservation[],
  localSaw409: boolean,
): PollerCountResult {
  const activePollers = observations.filter((o) => o.fresh && o.pollingActive === true).length;
  const hasVisibilityGap = observations.some((o) => !o.fresh || o.pollingActive === undefined);

  // 409 is ground truth that a 2nd poller exists — even if its heartbeat is dark.
  if (localSaw409) {
    return { verdict: 'dual', activePollers, hasVisibilityGap,
      reason: 'Telegram 409 conflict — a second machine is polling the same bot token' };
  }
  // We positively SEE ≥2 pollers → dual regardless of any unknown peers.
  if (activePollers >= 2) {
    return { verdict: 'dual', activePollers, hasVisibilityGap,
      reason: `${activePollers} machines are polling Telegram (dual-poll → 409 war)` };
  }
  // A visibility gap means we can't assert exactly-one or zero → indeterminate.
  if (hasVisibilityGap) {
    return { verdict: 'indeterminate', activePollers, hasVisibilityGap,
      reason: 'cannot confirm ingress — a peer is unreachable or on an older version' };
  }
  // Everyone fresh + known, <2 active.
  if (activePollers === 1) {
    return { verdict: 'ok', activePollers, hasVisibilityGap, reason: 'exactly one machine is polling Telegram' };
  }
  return { verdict: 'silence', activePollers, hasVisibilityGap,
    reason: 'NO machine is polling Telegram — inbound is not being received' };
}

/**
 * Adapter — evaluate the exactly-one-listener verdict directly over the pool's
 * MachineCapacity rows (from `?scope=pool`). `online` is the freshness signal
 * (a dark peer → not fresh → indeterminate), `pollingActive` the truth field
 * (absent on an older peer → unknown). This is what a `/guards` surface calls.
 */
export function poolPollerVerdict(
  capacities: Array<{ machineId: string; online?: boolean; pollingActive?: boolean }>,
  localSaw409: boolean,
): PollerCountResult {
  return evaluatePollerCount(
    capacities.map((c) => ({ machineId: c.machineId, pollingActive: c.pollingActive, fresh: !!c.online })),
    localSaw409,
  );
}
