/**
 * Tier-1 tests for computeSelfQuotaState (spec: placement-llm-circuit-aware-quota.md).
 * Proves the fix for the live-test finding: a machine with an OPEN llm-circuit must report
 * `blocked:true` for placement even when its account-quota poll says fine — so quota-aware
 * placement stops misrouting sessions onto a rate-limited machine that can't serve them.
 * Both sides of every decision boundary.
 */
import { describe, it, expect } from 'vitest';
import { computeSelfQuotaState } from '../../src/core/selfQuotaState.js';

const FIXED_NOW = Date.parse('2026-06-16T07:00:00.000Z');

describe('computeSelfQuotaState', () => {
  it('THE FIX (the Mini case): circuit OPEN ⇒ blocked even when account quota is healthy', () => {
    const r = computeSelfQuotaState({ blockedUntil: null, fiveHourPercent: 10 }, /*circuitAvailable*/ false, FIXED_NOW);
    expect(r).toEqual({ blocked: true, reason: 'llm-circuit-open' });
  });

  it('circuit OPEN ⇒ blocked even with NO quota snapshot (open circuit wins over missing tracker)', () => {
    expect(computeSelfQuotaState(null, false, FIXED_NOW)).toEqual({ blocked: true, reason: 'llm-circuit-open' });
    expect(computeSelfQuotaState(undefined, false, FIXED_NOW)).toEqual({ blocked: true, reason: 'llm-circuit-open' });
  });

  it('circuit available + quota healthy ⇒ { blocked: false }', () => {
    expect(computeSelfQuotaState({ blockedUntil: null, fiveHourPercent: 42 }, true, FIXED_NOW)).toEqual({ blocked: false });
  });

  it('circuit available (e.g. breaker DISABLED) + no tracker ⇒ undefined (unknown ≠ blocked, no false-positive)', () => {
    expect(computeSelfQuotaState(null, true, FIXED_NOW)).toBeUndefined();
    expect(computeSelfQuotaState(undefined, true, FIXED_NOW)).toBeUndefined();
  });

  it('account 5-hour window >= 95% ⇒ blocked (account-quota cause preserved)', () => {
    const r = computeSelfQuotaState({ fiveHourPercent: 96 }, true, FIXED_NOW);
    expect(r?.blocked).toBe(true);
    expect(r?.reason).toBe('5-hour window at 96%');
  });

  it('account blockedUntil in the future ⇒ blocked; in the past ⇒ not blocked', () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    const past = new Date(FIXED_NOW - 60_000).toISOString();
    const blocked = computeSelfQuotaState({ blockedUntil: future, blockReason: 'provider block' }, true, FIXED_NOW);
    expect(blocked).toEqual({ blocked: true, blockedUntil: future, reason: 'provider block' });
    expect(computeSelfQuotaState({ blockedUntil: past, fiveHourPercent: 5 }, true, FIXED_NOW)).toEqual({ blocked: false });
  });

  it('a custom account blockReason is preserved over the generic provider-block string', () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    const r = computeSelfQuotaState({ blockedUntil: future, blockReason: 'weekly cap reached' }, true, FIXED_NOW);
    expect(r?.reason).toBe('weekly cap reached');
  });

  it('circuit-open block takes precedence over an account block (one reason, llm-circuit-open)', () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    // Both signals say blocked; the circuit check is first → its reason wins (it is the more
    // immediate operational truth). Either way `blocked` is true; this pins the reason.
    const r = computeSelfQuotaState({ blockedUntil: future, fiveHourPercent: 99 }, false, FIXED_NOW);
    expect(r).toEqual({ blocked: true, reason: 'llm-circuit-open' });
  });
});
