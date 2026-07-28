/**
 * Unit tests for LlmQueue — priority-laned shared LLM queue.
 *
 * Covers the Phase 1 spec surface:
 *  - Background calls run when concurrency is free.
 *  - Interactive arrivals preempt in-flight background calls via AbortController.
 *  - Interactive lane reserve (≥40%) prevents background from consuming
 *    the whole daily budget.
 *  - LlmAbortedError is surfaced to aborted background callers.
 */
import { describe, it, expect } from 'vitest';
import { LlmQueue, LlmAbortedError } from '../../src/monitoring/LlmQueue.js';

function deferred<T = string>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('LlmQueue', () => {
  it('runs a single background call to completion', async () => {
    const q = new LlmQueue({ maxConcurrent: 2, interactiveReservePct: 0.4, maxDailyCents: 100 });
    const result = await q.enqueue('background', async () => 'ok', 1);
    expect(result).toBe('ok');
    expect(q.getDailySpendCents()).toBe(1);
  });

  it('preempts in-flight background when interactive arrives at capacity', async () => {
    const q = new LlmQueue({ maxConcurrent: 1, interactiveReservePct: 0.4, maxDailyCents: 100 });

    // Start a background call that never finishes on its own.
    const bgDef = deferred<string>();
    let sawAbort = false;
    const bgPromise = q.enqueue('background', (signal) => {
      signal.addEventListener('abort', () => { sawAbort = true; });
      return bgDef.promise;
    }, 1);

    // Give the microtask queue a chance to start the bg call.
    await new Promise(resolve => setImmediate(resolve));
    expect(q.getInFlightCount()).toBe(1);

    // Enqueue an interactive call — should preempt the bg.
    const interactivePromise = q.enqueue('interactive', async () => 'interactive-done', 1);

    await expect(bgPromise).rejects.toBeInstanceOf(LlmAbortedError);
    expect(sawAbort).toBe(true);

    await expect(interactivePromise).resolves.toBe('interactive-done');
  });

  it('rejects background calls that would breach the interactive reserve', async () => {
    // Daily cap = 10, reserve 40% = 4, so background may consume at most 6.
    const q = new LlmQueue({ maxConcurrent: 1, interactiveReservePct: 0.4, maxDailyCents: 10 });

    // 6 cents of background is allowed (remaining after = 4 = reserve).
    await q.enqueue('background', async () => 'x', 6);
    expect(q.getDailySpendCents()).toBe(6);

    // Another 1 cent would drop remaining to 3, which breaches the 4-cent reserve.
    await expect(q.enqueue('background', async () => 'y', 1)).rejects.toThrow(/reserve/);

    // Interactive, however, can still spend.
    await expect(q.enqueue('interactive', async () => 'ok', 1)).resolves.toBe('ok');
  });

  it('blocks further enqueue when the daily cap is already exhausted', async () => {
    const q = new LlmQueue({ maxConcurrent: 1, interactiveReservePct: 0.4, maxDailyCents: 5 });
    await q.enqueue('interactive', async () => 'a', 5);
    await expect(q.enqueue('interactive', async () => 'b', 1)).rejects.toThrow(/cap exceeded/);
  });

  it('interactive waiters jump ahead of background waiters in the queue', async () => {
    const q = new LlmQueue({ maxConcurrent: 1, interactiveReservePct: 0.4, maxDailyCents: 100 });
    // Fill the single slot with a long-running interactive call.
    const busyDef = deferred<string>();
    const busy = q.enqueue('interactive', () => busyDef.promise, 1);
    await new Promise(resolve => setImmediate(resolve));

    const completionOrder: string[] = [];
    const bg = q.enqueue('background', async () => { completionOrder.push('bg'); return 'bg'; }, 1);
    const int = q.enqueue('interactive', async () => { completionOrder.push('int'); return 'int'; }, 1);

    // Release the busy slot.
    busyDef.resolve('busy');
    await busy;
    await int;
    await bg;

    expect(completionOrder).toEqual(['int', 'bg']);
  });

  // Herd-aware background drain pacing (Resilient Degradation Ladder §3c).
  it('paces a second BACKGROUND dispatch when backgroundDispatchMinGapMs is set, even with a free slot', async () => {
    const q = new LlmQueue({ maxConcurrent: 3, maxDailyCents: 100, backgroundDispatchMinGapMs: 40 });
    const a = deferred();
    const b = deferred();
    const pa = q.enqueue('background', () => a.promise); // dispatched immediately (first)
    const pb = q.enqueue('background', () => b.promise); // paced — deferred despite a free slot

    expect(q.getInFlightCount()).toBe(1); // only the first is in flight
    expect(q.getWaitingCount()).toBe(1);  // the second waits out the pacing gap

    a.resolve('a');
    b.resolve('b');
    expect(await pa).toBe('a');
    expect(await pb).toBe('b'); // the paced re-drain eventually runs the second
  });

  it('does NOT pace when backgroundDispatchMinGapMs is 0/off (today behavior — both start at once)', async () => {
    const q = new LlmQueue({ maxConcurrent: 3, maxDailyCents: 100 }); // no pacing
    const a = deferred();
    const b = deferred();
    const pa = q.enqueue('background', () => a.promise);
    const pb = q.enqueue('background', () => b.promise);

    expect(q.getInFlightCount()).toBe(2); // both dispatched immediately (no gap)
    expect(q.getWaitingCount()).toBe(0);

    a.resolve('a');
    b.resolve('b');
    await pa;
    await pb;
  });

  it('interactive dispatch BYPASSES background pacing (latency-sensitive)', async () => {
    const q = new LlmQueue({ maxConcurrent: 3, maxDailyCents: 100, backgroundDispatchMinGapMs: 1000 });
    const bgD = deferred();
    const intD = deferred();
    const pbg = q.enqueue('background', () => bgD.promise);   // first bg dispatched
    const pint = q.enqueue('interactive', () => intD.promise); // interactive NOT paced

    expect(q.getInFlightCount()).toBe(2); // bg + interactive both running; interactive bypassed pacing
    expect(q.getWaitingCount()).toBe(0);

    bgD.resolve('bg');
    intD.resolve('int');
    await pbg;
    await pint;
  });

  it('atomically meters component budgets and reconciles actual usage', async () => {
    const q = new LlmQueue({ maxConcurrent: 1, maxDailyCents: 100 });
    const request = { component: 'claim-verification', estimatedInputTokens: 100, maxOutputTokens: 50,
      estimatedCostCents: 1, hourly: { requests: 1 },
      daily: { requests: 2, inputTokens: 1_000, outputTokens: 1_000, costCents: 10 },
      run: async (_signal: AbortSignal, report: (usage: { inputTokens: number; outputTokens: number }) => void) => {
        report({ inputTokens: 40, outputTokens: 10 }); return 'ok';
      } };
    await expect(q.enqueueMetered(request)).resolves.toBe('ok');
    expect(q.getMeteredUsage('claim-verification')).toEqual({ requests: 1, inputTokens: 40, outputTokens: 10, costCents: 1 });
    await expect(q.enqueueMetered(request)).rejects.toThrow(/budget exhausted/);
  });
});
