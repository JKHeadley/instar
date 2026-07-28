/**
 * selfQuotaState — compute a machine's placement-eligibility block for the capacity
 * heartbeat (spec: docs/specs/placement-llm-circuit-aware-quota.md).
 *
 * `quotaState.blocked` is the signal `PlacementExecutor` reads to decide whether a machine
 * may serve a new LLM session. It is a **placement-eligibility** signal — "this machine
 * cannot serve LLM work right now" — NOT a pure account-quota readout. Until now its only
 * cause was account-quota exhaustion; an OPEN llm-circuit (the machine's provider calls are
 * actually failing, rate-limited) is a second, more direct cause and MUST also block. The
 * live test caught the gap: a machine with an open circuit reported `blocked:false` and
 * placement routed a session onto it that died on arrival (2026-06-16, the Mac Mini).
 *
 * Extracted as a pure function so the two-signal contract (account-quota OR circuit) is
 * unit-testable and cannot silently regress to quota-only.
 */

export interface QuotaSnapshot {
  blockedUntil?: string | null;
  fiveHourPercent?: number | null;
  blockReason?: string | null;
}

/**
 * Type-level discriminator for the block CAUSE so consumers branch on a closed set, not a
 * free string. `provider-block` / `five-hour-*` = account quota; `llm-circuit-open` =
 * operational unavailability. Free-form legacy quota strings still flow through, typed as the
 * open `string` arm (back-compat).
 */
export type SelfQuotaBlockReason =
  | 'llm-circuit-open'
  | 'five-hour-exhausted'
  | 'provider-block'
  | (string & {});

export interface SelfQuotaBlock {
  blocked: boolean;
  blockedUntil?: string;
  reason?: SelfQuotaBlockReason;
}

/**
 * Compute this machine's placement-eligibility block from BOTH the account-quota snapshot and
 * the live llm-circuit availability.
 *
 * @param quota the account-quota snapshot (`quotaTracker.getState()`), or null/undefined when
 *   there is no tracker.
 * @param circuitAvailable `llmCircuitAvailable()` — `true` when the breaker is disabled OR
 *   closed; `false` only when it is enabled AND open/half-open.
 * @returns a block object, `{ blocked: false }`, or `undefined` (unknown ≠ blocked).
 *
 * Fail-open is preserved: an open circuit is the ONLY thing that newly blocks, and only on a
 * *positively observed* unavailable circuit — missing information (no tracker + closed
 * circuit) still returns `undefined`, which `PlacementExecutor` treats as not-blocked.
 */
export function computeSelfQuotaState(
  quota: QuotaSnapshot | null | undefined,
  circuitAvailable: boolean,
  now: number = Date.now(),
): SelfQuotaBlock | undefined {
  // An open llm-circuit is a hard block regardless of the account-quota poll — the machine's
  // provider calls are failing right now, so it cannot serve a session. This wins even when
  // there is no quota snapshot (a machine with no tracker but an open circuit is still blocked).
  if (!circuitAvailable) return { blocked: true, reason: 'llm-circuit-open' };
  if (!quota) return undefined; // no tracker + circuit ok = unknown ≠ blocked
  const blockActive = !!quota.blockedUntil && Date.parse(quota.blockedUntil) > now;
  const fiveHourExhausted = (quota.fiveHourPercent ?? 0) >= 95;
  if (!blockActive && !fiveHourExhausted) return { blocked: false };
  return {
    blocked: true,
    blockedUntil: quota.blockedUntil ?? undefined,
    reason:
      quota.blockReason ??
      (fiveHourExhausted ? `5-hour window at ${quota.fiveHourPercent}%` : 'provider block'),
  };
}
