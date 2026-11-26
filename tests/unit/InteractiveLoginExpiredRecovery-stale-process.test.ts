/**
 * Spec stale-process-login-expired D4: a session stuck on the expired screen while the stored login
 * works is restarted on its OWN account, never swapped to another, with every guard rechecked.
 */
import { describe, it, expect } from 'vitest';
import { InteractiveLoginExpiredRecovery, IN_PLACE_REFRESH_PER_ACCOUNT, type InteractiveLoginExpiredRecoveryDeps } from '../../src/core/InteractiveLoginExpiredRecovery.js';

const signal = (session = 's1') => ({ session, sessionName: session, configHome: '/h/acct', accountId: 'acct', matchedLine: 'Login expired', protected: false });

function make(over: Partial<InteractiveLoginExpiredRecoveryDeps> & { observeResult?: Record<string, unknown> } = {}) {
  const calls = { swap: 0, refresh: 0, contrary: 0, observeOpts: [] as unknown[] };
  let identity = 'id-1';
  const deps: InteractiveLoginExpiredRecoveryDeps = {
    observe: async (_i, opts) => { calls.observeOpts.push(opts); return { accountId: 'acct', marked: false, accountStatus: 'active', probe: 'ok', staleProcess: true, ...(over.observeResult ?? {}) } as never; },
    swap: async () => { calls.swap++; return { swapped: true, toAccountId: 'other', reason: 'ok' }; },
    refreshInPlace: async () => { calls.refresh++; identity = `id-${calls.refresh + 1}`; return { ok: true }; },
    sessionIdentity: () => identity,
    stillShowsExpired: () => true,
    ownsConversation: () => true,
    noteContrary: () => { calls.contrary++; },
    staleProcessEnabled: () => true,
    ...over,
  };
  return { rec: new InteractiveLoginExpiredRecovery(deps), calls, setIdentity: (v: string) => { identity = v; } };
}

describe('InteractiveLoginExpiredRecovery: stale process', () => {
  it('a stale process is refreshed in place on its own account, never swapped; the probe wait is passed', async () => {
    const { rec, calls } = make();
    const r = await rec.handle(signal());
    expect(r.outcome).toBe('refreshed-in-place');
    expect(calls.refresh).toBe(1);
    expect(calls.swap).toBe(0);
    expect(calls.observeOpts[0]).toEqual({ awaitProbeMs: 20_000 });
  });

  it('a pending probe defers the swap', async () => {
    const { rec, calls } = make({ observeResult: { probe: 'pending', staleProcess: undefined, accountStatus: 'needs-reauth', marked: true } });
    expect((await rec.handle(signal())).outcome).toBe('probe-pending');
    expect(calls.swap).toBe(0);
  });

  it('a refused probe takes today\'s swap path', async () => {
    const { rec, calls } = make({ observeResult: { probe: 'refused', staleProcess: undefined, accountStatus: 'needs-reauth', marked: true } });
    expect((await rec.handle(signal())).outcome).toBe('swapped');
    expect(calls.swap).toBe(1);
  });

  it('the stale branch runs even when account swaps are switched off', async () => {
    const { rec, calls } = make({ swapEnabled: () => false });
    expect((await rec.handle(signal())).outcome).toBe('refreshed-in-place');
    expect(calls.swap).toBe(0);
  });

  it('a session that changed, cleared its screen, or is no longer owned is left alone', async () => {
    let n = 0;
    const changed = make({ sessionIdentity: () => (n++ === 0 ? 'a' : 'b') });
    expect((await changed.rec.handle(signal())).outcome).toBe('session-changed');
    const cleared = make({ stillShowsExpired: () => false });
    expect((await cleared.rec.handle(signal())).outcome).toBe('not-showing');
    const moved = make({ ownsConversation: () => false });
    expect((await moved.rec.handle(signal())).outcome).toBe('session-changed');
    expect(changed.calls.refresh + cleared.calls.refresh + moved.calls.refresh).toBe(0);
  });

  it('a failed refresh is refresh-failed and is not contrary evidence', async () => {
    const { rec, calls } = make({ refreshInPlace: async () => ({ ok: false, reason: 'busy' }) });
    expect((await rec.handle(signal())).outcome).toBe('refresh-failed');
    expect(calls.contrary).toBe(0);
    expect(rec.inPlaceRefreshPossible('s1', 'acct')).toBe(false);
  });

  it('a REPLACEMENT process showing the screen again: contrary evidence, and this session is swapped', async () => {
    let call = 0;
    const { rec, calls } = make({ cooldownMs: 0, observe: async () => (call++ === 0
      ? { accountId: 'acct', marked: false, accountStatus: 'active', probe: 'ok', staleProcess: true }
      // After contrary evidence the poller drops the cached ok and marks the account (today's path).
      : { accountId: 'acct', marked: true, accountStatus: 'needs-reauth', probe: 'refused' }) as never });
    expect((await rec.handle(signal())).outcome).toBe('refreshed-in-place');
    const r = await rec.handle({ ...signal() });
    expect(calls.contrary).toBe(1);
    expect(r.outcome).toBe('swapped');
    expect(calls.swap).toBe(1);
  });

  it('at most N in-place refreshes per account per window', async () => {
    const { rec } = make();
    const outcomes: string[] = [];
    for (let i = 0; i < IN_PLACE_REFRESH_PER_ACCOUNT + 1; i++) outcomes.push((await rec.handle(signal(`s${i}`))).outcome);
    expect(outcomes.filter((o) => o === 'refreshed-in-place')).toHaveLength(IN_PLACE_REFRESH_PER_ACCOUNT);
    expect(outcomes[IN_PLACE_REFRESH_PER_ACCOUNT]).toBe('refresh-bounded');
  });

  it('with the switch off (or no refreshInPlace), behaviour is today\'s', async () => {
    const off = make({ staleProcessEnabled: () => false, observeResult: { accountStatus: 'active', staleProcess: undefined, probe: undefined } });
    expect((await off.rec.handle(signal())).outcome).toBe('not-confirmed');
    expect(off.calls.observeOpts[0]).toBeUndefined();
  });

  it('inPlaceRefreshPossible: false for a session never handled here', () => {
    const { rec } = make();
    expect(rec.inPlaceRefreshPossible('never', 'acct')).toBe(false);
  });
});
