/**
 * Spec stale-process-login-expired D2: NeverSilent never swaps or moves a session whose stored login
 * works while its in-place restart is pending or possible, and never holds off past 3 minutes.
 */
import { describe, it, expect } from 'vitest';
import { decideNeverSilentAction, renderNotice, STALE_LOGIN_WAIT_REASON, type PolicyInput } from '../../src/monitoring/neverSilent/NeverSilentPolicy.js';

const base: PolicyInput = {
  silenceClass: 'engine-login', confidence: 0.95, truncated: false, actionsSinceMessage: 'none', pinned: false,
  actionsEnabled: true, frameworkFallbackEnabled: true, confidenceFloor: 0.8, sameEngineHealthy: true,
  fallbackEngine: 'codex-cli', swapTried: false, protectedSession: false, recentlyRestored: false,
};

describe('NeverSilent policy: stale login', () => {
  it('a pending probe ⇒ wait (no swap, no move)', () => {
    expect(decideNeverSilentAction({ ...base, loginProbe: 'pending' })).toEqual({ action: 'wait', reason: STALE_LOGIN_WAIT_REASON });
  });
  it('an ok probe with an in-place refresh possible ⇒ wait', () => {
    expect(decideNeverSilentAction({ ...base, loginProbe: 'ok', inPlaceRefreshPossible: true }).action).toBe('wait');
  });
  it('an ok probe but no refresh possible ⇒ today (swap)', () => {
    expect(decideNeverSilentAction({ ...base, loginProbe: 'ok', inPlaceRefreshPossible: false }).action).toBe('swap');
  });
  it('the 3-minute hold-off ran out ⇒ today, whatever the probe says', () => {
    expect(decideNeverSilentAction({ ...base, loginProbe: 'pending', staleHoldExpired: true }).action).toBe('swap');
    expect(decideNeverSilentAction({ ...base, loginProbe: 'ok', inPlaceRefreshPossible: true, staleHoldExpired: true }).action).toBe('swap');
  });
  it('refused, inconclusive or no probe ⇒ today', () => {
    for (const loginProbe of ['refused', 'inconclusive', undefined] as const) {
      expect(decideNeverSilentAction({ ...base, loginProbe }).action).toBe('swap');
    }
  });
  it('the waiting notice says what is happening in plain words', () => {
    const t = renderNotice({ kind: 'waiting', count: 1, silenceClass: 'engine-login', framework: 'claude-code', action: null, outcome: null, waitingReason: 'restarting-sign-in' });
    expect(t).toMatch(/restarting it on its own sign-in/);
  });
});
