import { BACKOFF_SCHEDULE_MS } from '../../monitoring/delivery-failure-sentinel/recovery-policy.js';

/** Local refusals retain a pacing interval and the original wall-clock bound. */
export function nextOriginLocalRefusal(now: number, deadlineAt: number): number | undefined {
  const next = now + BACKOFF_SCHEDULE_MS[0];
  return Number.isSafeInteger(next) && next < deadlineAt ? next : undefined;
}

/** lease-freshness-lapse-retry — the runtime's retry steps after a send was refused for the lease at the
 * network boundary: 2 s (a late renewal confirmation landing once a stall ends), then 5 s, 10 s and 30 s,
 * spanning one renewal cadence plus confirmation latency. After the last step the sentinel's regular pass is
 * the floor. Four steps; never grows. */
export const LEASE_LAPSE_RETRY_SCHEDULE_MS: ReadonlyArray<number> = Object.freeze([2_000, 5_000, 10_000, 30_000]);
/** The lifetime assumed for the per-lifetime retry budget when no lease coordinator reports one. */
export const LEASE_LAPSE_FALLBACK_LIFETIME_MS = 60_000;

/** A lease refusal is due again after the first retry step (2 s), inside the original deadline, exactly as
 * `nextOriginLocalRefusal` paces the other local refusals at 30 s. */
export function nextOriginLeaseLapse(now: number, deadlineAt: number): number | undefined {
  const next = now + LEASE_LAPSE_RETRY_SCHEDULE_MS[0];
  return Number.isSafeInteger(next) && next < deadlineAt ? next : undefined;
}

/** Only callers with definite non-delivery may schedule. The existing recovery
 * schedule and original outbox continue to own every attempt and deadline. */
export function nextOriginKnownFailure(input: { attempt: number; maxAttempts: number; deadlineAt: number;
  now: number; minimumDelayMs?: number }): number | undefined {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt >= input.maxAttempts) return;
  const next = input.now + Math.max(BACKOFF_SCHEDULE_MS[input.attempt - 1] ?? Infinity, input.minimumDelayMs ?? 0);
  return Number.isSafeInteger(next) && next < input.deadlineAt ? next : undefined;
}
