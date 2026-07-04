/**
 * ExternalHogSustained — the STAGE-2 N-window sustained-CPU confirmation (CMT-1901,
 * docs/specs/external-hog-zombie-autokill-sentinel.md §1). PURE over its inputs.
 *
 * Stage-1 candidacy (the sampler) selects processes over the core threshold in the LATEST delta
 * window. That is NOT enough to kill: a single-window spike (a compile, a GC pause, a burst of
 * real work) crosses threshold for one window and is gone. The spec requires a process to exceed
 * the threshold across N CONSECUTIVE delta windows before `sustainedHighCpu` is true — the
 * anti-spike guard that keeps the feature from acting on transient load.
 *
 * This tracker holds the per-signature CONSECUTIVE-window streak. Each tick it is advanced with
 * THIS tick's candidate signatures (those over threshold this window). A signature present this
 * tick has its streak incremented; a signature ABSENT this tick is DROPPED (streak reset to 0) —
 * strict consecutive, the SAFE direction (a one-window dip, e.g. from `ps time=` quantization
 * noise, forces the hog to re-accumulate N windows rather than shortening the path to a kill).
 * A failed/empty parse is passed as an empty candidate set by the caller, which resets every
 * streak — fail toward NOT-sustained (alert-never-kill), matching the §1 fail-closed-on-data rule.
 *
 * Bounded by construction: the next streak map is rebuilt ONLY from this tick's candidate
 * signatures, so it can never grow beyond the live candidate count (typically 0–3) even under
 * fork-storm pid churn — never accumulate-only.
 */

/** The cross-tick identity of a candidate: pid + start-time (defeats pid reuse). MUST match the
 *  sampler's internal idKey format so the same process maps to the same streak across stages. */
export function candidateSignature(pid: number, startTime: string): string {
  return `${pid} ${startTime}`;
}

export interface SustainedState {
  /** candidate signature → consecutive windows over threshold (≥ 1 for any present streak). */
  readonly streaks: ReadonlyMap<string, number>;
}

export const EMPTY_SUSTAINED_STATE: SustainedState = { streaks: new Map() };

export interface SustainedTick {
  readonly nextState: SustainedState;
  /** Consecutive-window streak for a signature AFTER this tick's advance (0 if absent). */
  streakOf(signature: string): number;
}

/**
 * Advance the streaks by one tick. `candidateSignatures` is THIS tick's over-threshold set
 * (the caller passes an empty iterable on a failed/empty parse → every streak resets). Present →
 * prev+1; absent → dropped. Pure — mutates nothing. Duplicate signatures in the input collapse
 * (a signature is counted once per tick).
 */
export function advanceSustained(state: SustainedState, candidateSignatures: Iterable<string>): SustainedTick {
  const next = new Map<string, number>();
  const seen = new Set<string>();
  for (const sig of candidateSignatures) {
    if (typeof sig !== 'string' || sig.length === 0) continue; // ignore a malformed signature (safe: not-sustained)
    if (seen.has(sig)) continue; // one increment per tick, even if a signature appears twice
    seen.add(sig);
    const prev = state.streaks.get(sig) ?? 0;
    next.set(sig, prev + 1);
  }
  return {
    nextState: { streaks: next },
    streakOf: (signature) => next.get(signature) ?? 0,
  };
}

/**
 * Is a signature's streak at/over the N-window threshold? A non-positive/non-finite
 * `sustainedSampleCount` fails CLOSED (never sustained) — a misconfigured N must not let a
 * single-window spike qualify as a kill.
 */
export function isSustained(tick: SustainedTick, signature: string, sustainedSampleCount: number): boolean {
  if (!Number.isFinite(sustainedSampleCount) || sustainedSampleCount <= 0) return false;
  return tick.streakOf(signature) >= sustainedSampleCount;
}
