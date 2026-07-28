/**
 * Operator-channel-sacred (outbound) — the ROUTE-level Know-Your-Principal
 * resolution. The load-bearing leak boundary: recipientClass='operator' ONLY for
 * a VERIFIED, locally-auth-bound, single-human-operator topic; 'external' on ANY
 * ambiguity. Spec: outbound-gate-tiered-fail-direction (mandatory route-level ratchet).
 */
import { describe, it, expect } from 'vitest';
import { resolveToneRecipientClass } from '../../src/server/toneRecipientClass.js';
import { reviewWithinBudget } from '../../src/server/outboundGateBudget.js';
import type { ToneReviewResult } from '../../src/core/MessagingToneGate.js';

const store = (over: Partial<{ verified: unknown; all: Record<string, { uid?: string }> }> = {}) => ({
  asVerifiedOperator: () => ('verified' in over ? over.verified : { uid: 'op-1' }),
  all: () => over.all ?? { '100': { uid: 'op-1' } },
});

describe('resolveToneRecipientClass — verified operator + single-human guard, fail-closed default', () => {
  it("OPERATOR: verified binding AND a single distinct operator across topics", () => {
    expect(resolveToneRecipientClass(store({ all: { '100': { uid: 'op-1' }, '200': { uid: 'op-1' } } }), 100)).toBe('operator');
  });
  it("EXTERNAL: no topicId (ambiguity)", () => {
    expect(resolveToneRecipientClass(store(), null)).toBe('external');
    expect(resolveToneRecipientClass(store(), undefined)).toBe('external');
  });
  it("EXTERNAL: no store", () => {
    expect(resolveToneRecipientClass(null, 100)).toBe('external');
    expect(resolveToneRecipientClass(undefined, 100)).toBe('external');
  });
  it("EXTERNAL: no verified binding for the topic (the mandatory absent-binding→hold case)", () => {
    expect(resolveToneRecipientClass(store({ verified: null }), 100)).toBe('external');
  });
  it("EXTERNAL: more than one distinct operator (a multi-user agent — leak boundary)", () => {
    expect(resolveToneRecipientClass(store({ all: { '100': { uid: 'op-1' }, '200': { uid: 'op-2' } } }), 100)).toBe('external');
  });
  it("EXTERNAL: asVerifiedOperator throws → fail-closed", () => {
    const throwing = { asVerifiedOperator: () => { throw new Error('resolve fault'); }, all: () => ({}) };
    expect(resolveToneRecipientClass(throwing, 100)).toBe('external');
  });
  it("EXTERNAL: all() throws → fail-closed", () => {
    const throwing = { asVerifiedOperator: () => ({ uid: 'op-1' }), all: () => { throw new Error('store fault'); } };
    expect(resolveToneRecipientClass(throwing, 100)).toBe('external');
  });
});

// ── the route-budget-timeout seam — the path that ACTUALLY held the live replies ──
describe('reviewWithinBudget — operator-channel tag on a budget-timeout deliver', () => {
  const never = (): Promise<ToneReviewResult> => new Promise(() => { /* never resolves → budget fires */ });
  const fireNow = (cb: () => void) => cb(); // schedule fires immediately

  it("operator deliver (failClosedOnBudget=false, operatorChannelDeliver=true) → failedOpenOperatorChannel", async () => {
    const r = await reviewWithinBudget(never(), 10, () => 1000, fireNow, false, true);
    expect(r.pass).toBe(true);
    expect(r.failedOpenOperatorChannel).toBe(true);
    expect(r.failedOpen).toBeUndefined();
    expect(r.budgetExceeded).toBe(true);
  });
  it("external deliver (legacy fail-open, operatorChannelDeliver=false) → legacy failedOpen", async () => {
    const r = await reviewWithinBudget(never(), 10, () => 1000, fireNow, false, false);
    expect(r.pass).toBe(true);
    expect(r.failedOpen).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });
  it("hold (failClosedOnBudget=true) → failedClosed regardless of operator flag", async () => {
    const r = await reviewWithinBudget(never(), 10, () => 1000, fireNow, true, true);
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });
});
