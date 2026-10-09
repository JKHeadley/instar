/**
 * Shared stage-budget helper for the operated feedback drain and its triage stage.
 *
 * One model call (or any other stage) races a timer. A call that outlives its budget
 * rejects with StageBudgetExceeded, so the caller can tell "our own clock ran out" from
 * a provider failure. Extracted from FeedbackDrainService so triage reuses the exact
 * same code path (docs/specs/feedback-triage-and-execution.md §1, "Batching").
 */
export class StageBudgetExceeded extends Error { override name = 'StageBudgetExceeded'; }

export async function withStageBudget<T>(stage: string, operation: () => Promise<T>, budgetMs: number, now: () => number = Date.now): Promise<T> {
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StageBudgetExceeded(`${stage} stage budget exceeded`)), budgetMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const result = await Promise.race([operation(), timeout]);
    if (now() - startedAt > budgetMs) throw new StageBudgetExceeded(`${stage} stage budget exceeded`);
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * How many more units fit in the remaining time, from this tick's observed pace with a
 * 25% margin. Before the first call (no pace yet) the caller's full chunk is assumed to fit.
 */
export function unitsThatFit(remainingMs: number, observedMs: number, observedUnits: number, firstChunk: number): number {
  if (observedUnits <= 0) return firstChunk;
  return Math.floor(remainingMs / (1.25 * observedMs / observedUnits));
}
