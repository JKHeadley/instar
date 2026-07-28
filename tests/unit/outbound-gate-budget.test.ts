/**
 * Unit tests for the outbound tone/relevance-gate budget (reviewWithinBudget).
 *
 * Regression context (2026-06-08): the outbound message gate is FAIL-OPEN by
 * design, but `MessagingToneGate.review` will wait up to RATE_LIMIT_WAIT_MS
 * (120s) for a rate-limit window PLUS the call, all inside a single un-raced
 * `await` in `checkOutboundMessage`. Under rate-limit pressure the gate finished
 * at 121s–185s (observed live, all failedOpen), past the 120s outbound route
 * budget — so `/telegram/post-update` and `/telegram/reply` 408'd, and the
 * calling session fell back to dumping the update note into whatever topic it
 * was active in. `reviewWithinBudget` caps the gate at a budget well under the
 * route's and fails OPEN past it.
 *
 * The budget/timer are injected so the fail-open semantics are proven instantly
 * and deterministically — no real 20s wait.
 */

import { describe, it, expect } from 'vitest';
import { reviewWithinBudget } from '../../src/server/outboundGateBudget.js';
import {
  buildDegradedToneResult,
  type ToneReviewResult,
} from '../../src/core/MessagingToneGate.js';
import {
  OUTBOUND_GATE_REVIEW_BUDGET_MS,
  OUTBOUND_MESSAGING_TIMEOUT_MS,
} from '../../src/server/middleware.js';

const PASS_RESULT: ToneReviewResult = {
  pass: true,
  rule: '',
  issue: '',
  suggestion: '',
  latencyMs: 12,
};

const BLOCK_RESULT: ToneReviewResult = {
  pass: false,
  rule: 'B3_OVERSELL',
  issue: 'Overstates a dark feature as finished',
  suggestion: 'Label it experimental',
  latencyMs: 34,
};

/** A schedule that never fires — forces the review promise to win the race. */
const neverSchedule = (_cb: () => void, _ms: number) => {
  /* intentionally never invokes cb */
};

/** A schedule that fires synchronously — forces the budget to win the race. */
const immediateSchedule = (cb: () => void, _ms: number) => {
  cb();
};

describe('reviewWithinBudget — outbound gate budget', () => {
  it('returns the PASS verdict unchanged when the gate answers within budget', async () => {
    const result = await reviewWithinBudget(
      Promise.resolve(PASS_RESULT),
      20_000,
      () => 1000,
      neverSchedule,
    );
    expect(result).toEqual(PASS_RESULT);
    expect(result.budgetExceeded).toBeUndefined();
  });

  it('returns the BLOCK verdict unchanged when the gate answers within budget (blocks still work)', async () => {
    const result = await reviewWithinBudget(
      Promise.resolve(BLOCK_RESULT),
      20_000,
      () => 1000,
      neverSchedule,
    );
    // A real block must survive the budget wrapper — the wrapper only protects
    // against SLOW gates, it must never weaken a gate that actually decided.
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B3_OVERSELL');
    expect(result.budgetExceeded).toBeUndefined();
  });

  it('FAILS OPEN with budgetExceeded when the gate hangs past budget (default / kill-switch off)', async () => {
    // A review promise that never resolves — the hang the fix exists to survive.
    const neverResolves = new Promise<ToneReviewResult>(() => {});
    let clock = 1000;
    const result = await reviewWithinBudget(
      neverResolves,
      20_000,
      () => {
        const t = clock;
        clock += 20_000; // advance the clock between start and timeout reads
        return t;
      },
      immediateSchedule,
      // failClosedOnBudget defaults false — legacy fail-open contract preserved.
    );
    expect(result.pass).toBe(true); // delivered, not blocked
    expect(result.failedOpen).toBe(true);
    expect(result.budgetExceeded).toBe(true);
    expect(result.rule).toBe('');
  });

  it('FAILS CLOSED (holds) on budget-exceed when failClosedOnBudget=true (§Design 6 — closes the easiest bypass)', async () => {
    // Attacker-induced latency must not deliver an ungated message: the route
    // opts into fail-closed (gated by the failClosedOnExhaustion kill-switch).
    const neverResolves = new Promise<ToneReviewResult>(() => {});
    let clock = 1000;
    const result = await reviewWithinBudget(
      neverResolves,
      20_000,
      () => {
        const t = clock;
        clock += 20_000;
        return t;
      },
      immediateSchedule,
      true, // failClosedOnBudget
    );
    expect(result.pass).toBe(false); // HELD, not delivered
    expect(result.failedClosed).toBe(true);
    expect(result.budgetExceeded).toBe(true);
  });

  // tone-gate-graceful-degradation F4: the SLOW manifestation of the rate-limit
  // outage (the gate stalling past budget) is the DOCUMENTED 2026-06-08 failure.
  // By default the route now passes a budgetDegrade callback so the timeout
  // degrades to the SAME deterministic leak floor as a fast provider throw —
  // closing the F4 gap for the slow path, not just the fast one.
  it('DEGRADES and SENDS a clean message on budget-exceed when budgetDegrade is supplied (F4 slow path)', async () => {
    const neverResolves = new Promise<ToneReviewResult>(() => {});
    let clock = 1000;
    const result = await reviewWithinBudget(
      neverResolves,
      20_000,
      () => {
        const t = clock;
        clock += 20_000;
        return t;
      },
      immediateSchedule,
      true, // failClosedOnBudget — budgetDegrade must take PRECEDENCE over it
      false, // operatorChannelDeliver
      (latencyMs) => buildDegradedToneResult('I will push the change for you.', latencyMs, 'budget-timeout'),
    );
    expect(result.pass).toBe(true); // clean → sent, not silently held
    expect(result.degradedToDeterministic).toBe(true);
    expect(result.budgetExceeded).toBe(true);
  });

  it('DEGRADES and HOLDS a leaked artifact on budget-exceed (F4 leak-safety on the slow path)', async () => {
    const neverResolves = new Promise<ToneReviewResult>(() => {});
    let clock = 1000;
    const result = await reviewWithinBudget(
      neverResolves,
      20_000,
      () => {
        const t = clock;
        clock += 20_000;
        return t;
      },
      immediateSchedule,
      true,
      false, // operatorChannelDeliver
      (latencyMs) => buildDegradedToneResult('see /Users/justin/.instar/config.json', latencyMs, 'budget-timeout'),
    );
    expect(result.pass).toBe(false); // a real leak is still HELD on the slow path
    expect(result.failedClosed).toBe(true);
    expect(result.degradedToDeterministic).toBe(true);
    expect(result.budgetExceeded).toBe(true);
    expect(result.rule).toBe('B2_FILE_PATH');
  });

  it('records a non-negative latencyMs on the budget-exceeded fail-open', async () => {
    const neverResolves = new Promise<ToneReviewResult>(() => {});
    let clock = 5000;
    const result = await reviewWithinBudget(
      neverResolves,
      20_000,
      () => {
        const t = clock;
        clock += 19_500;
        return t;
      },
      immediateSchedule,
    );
    expect(result.budgetExceeded).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a gate that rejects propagates (the route catch fails open) — wrapper does not swallow rejections silently as pass', async () => {
    // reviewWithinBudget does not catch; MessagingToneGate.review never rejects
    // (it catches internally and returns failedOpen). But if a future provider
    // surfaced a rejection, it must propagate to the route's try/catch — not be
    // silently converted to a pass here. Documents the contract.
    await expect(
      reviewWithinBudget(
        Promise.reject(new Error('provider exploded')),
        20_000,
        () => 1000,
        neverSchedule,
      ),
    ).rejects.toThrow('provider exploded');
  });

  it('INVARIANT: the gate budget is strictly below the outbound route timeout', () => {
    // This is the whole point — if the two ever cross, the route 408s before the
    // gate fails open and the original hang returns. Guard it structurally.
    expect(OUTBOUND_GATE_REVIEW_BUDGET_MS).toBeLessThan(OUTBOUND_MESSAGING_TIMEOUT_MS);
    expect(OUTBOUND_GATE_REVIEW_BUDGET_MS).toBeGreaterThan(0);
  });
});
