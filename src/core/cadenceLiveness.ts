/**
 * A cadence detector has three states, not two. Before the first observed tick,
 * there is no evidence of either health or staleness. Keeping that state
 * explicit prevents boot-time "absence means failure" false positives.
 */
export type CadenceLiveness =
  | { state: 'uninitialized' }
  | { state: 'healthy'; ageMs: number }
  | { state: 'stale'; ageMs: number };

export function classifyCadenceLiveness(
  lastObservedMonoMs: number,
  nowMonoMs: number,
  staleAfterMs: number,
): CadenceLiveness {
  if (
    !Number.isFinite(lastObservedMonoMs) || lastObservedMonoMs <= 0 ||
    !Number.isFinite(nowMonoMs) ||
    !Number.isFinite(staleAfterMs) || staleAfterMs < 0
  ) {
    return { state: 'uninitialized' };
  }
  const ageMs = Math.max(0, nowMonoMs - lastObservedMonoMs);
  return ageMs <= staleAfterMs
    ? { state: 'healthy', ageMs }
    : { state: 'stale', ageMs };
}
