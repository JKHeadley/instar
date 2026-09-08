import { BACKOFF_SCHEDULE_MS } from '../../monitoring/delivery-failure-sentinel/recovery-policy.js';

/** Only callers with definite non-delivery may schedule. The existing recovery
 * schedule and original outbox continue to own every attempt and deadline. */
export function nextOriginKnownFailure(input: { attempt: number; maxAttempts: number; deadlineAt: number;
  now: number; minimumDelayMs?: number }): number | undefined {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt >= input.maxAttempts) return;
  const next = input.now + Math.max(BACKOFF_SCHEDULE_MS[input.attempt - 1] ?? Infinity, input.minimumDelayMs ?? 0);
  return Number.isSafeInteger(next) && next < input.deadlineAt ? next : undefined;
}
