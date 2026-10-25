import { describe, expect, it } from 'vitest';
import { InteractiveLoginExpiredRecovery, type InteractiveLoginExpiredSignal } from '../../src/core/InteractiveLoginExpiredRecovery.js';

const SIG: InteractiveLoginExpiredSignal = {
  session: 'sagemind-topic-42', sessionName: 'topic 42', configHome: '/home/x/.claude-sagemind-justin',
  accountId: 'sagemind-justin', matchedLine: 'Not logged in · Run /login', protected: false,
};

function make(over: Partial<ConstructorParameters<typeof InteractiveLoginExpiredRecovery>[0]> = {}) {
  const calls: string[] = [];
  let clock = 1_000_000;
  const failures: unknown[] = [];
  const r = new InteractiveLoginExpiredRecovery({
    observe: async () => { calls.push('observe'); return { accountId: 'sagemind-justin', marked: true, accountStatus: 'needs-reauth' }; },
    swap: async (a) => { calls.push(`swap:${a.sessionName}:${a.exhaustedAccountId}`); return { swapped: true, toAccountId: 'gearfinity', reason: 'swapped-and-resumed' }; },
    now: () => clock,
    onSwapFailed: (f) => failures.push(f),
    ...over,
  });
  return { r, calls, failures, tick: (ms: number) => { clock += ms; } };
}

describe('InteractiveLoginExpiredRecovery', () => {
  it('marks the pool BEFORE swapping, then swaps through the reactive funnel', async () => {
    const { r, calls } = make();
    const out = await r.handle(SIG);
    expect(calls).toEqual(['observe', 'swap:sagemind-topic-42:sagemind-justin']);
    expect(out).toEqual({ outcome: 'swapped', accountId: 'sagemind-justin', marked: true, toAccountId: 'gearfinity' });
  });

  it('an untagged session takes the account the poller resolved from its home', async () => {
    const { r, calls } = make();
    await r.handle({ ...SIG, accountId: null });
    expect(calls).toContain('swap:sagemind-topic-42:sagemind-justin');
  });

  it('a protected session is never moved (the pool is still marked)', async () => {
    const { r, calls } = make();
    const out = await r.handle({ ...SIG, protected: true });
    expect(out.outcome).toBe('protected');
    expect(calls).toEqual(['observe']);
  });

  it('kill switch off → marks but does not swap', async () => {
    const { r, calls } = make({ swapEnabled: () => false });
    expect((await r.handle(SIG)).outcome).toBe('swap-disabled');
    expect(calls).toEqual(['observe']);
  });

  it('no owning account → no swap', async () => {
    const { r, calls } = make({ observe: async () => ({ accountId: null, marked: false }) });
    expect((await r.handle({ ...SIG, accountId: null })).outcome).toBe('no-account');
    expect(calls).toEqual([]);
  });

  it('the pool did not confirm the login dead (credential unreadable, still active) → no swap yet', async () => {
    const { r, calls } = make({ observe: async () => { calls.push('observe'); return { accountId: 'sagemind-justin', marked: false, accountStatus: 'active' }; } });
    expect((await r.handle(SIG)).outcome).toBe('not-confirmed');
    expect(calls).toEqual(['observe']);
  });

  it('per-session cooldown: after a refused swap a second offer inside it does not swap again; after it, it does', async () => {
    const { r, calls, tick } = make({ swap: async (a) => { calls.push(`swap:${a.sessionName}:${a.exhaustedAccountId}`); return { swapped: false, toAccountId: null, reason: 'refresh-failed' }; } });
    await r.handle(SIG);
    expect((await r.handle(SIG)).outcome).toBe('cooldown');
    tick(10 * 60_000);
    await r.handle(SIG);
    expect(calls.filter((c) => c.startsWith('swap')).length).toBe(2);
  });

  it('a refused or throwing swap is reported, never thrown', async () => {
    const refused = make({ swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }) });
    expect(await refused.r.handle(SIG)).toMatchObject({ outcome: 'swap-refused', reason: 'no-eligible-alternate' });
    expect(refused.failures).toHaveLength(1);
    const thrown = make({ swap: async () => { throw new Error('refresh exploded'); } });
    expect(await thrown.r.handle(SIG)).toMatchObject({ outcome: 'swap-error', reason: 'refresh exploded' });
    expect(thrown.failures).toHaveLength(1);
  });

  it('a failing pool marking does not stop the swap', async () => {
    const { r, calls } = make({ observe: async () => { throw new Error('pool down'); } });
    expect((await r.handle(SIG)).outcome).toBe('swapped');
    expect(calls).toEqual(['swap:sagemind-topic-42:sagemind-justin']);
  });
});

describe('InteractiveLoginExpiredRecovery attempt cap', () => {
  it('a session the swap cannot move is tried at most 3 times, then left alone', async () => {
    let clock = 0;
    let swaps = 0;
    const r = new InteractiveLoginExpiredRecovery({
      observe: async () => ({ accountId: 'sagemind-justin', marked: false, accountStatus: 'needs-reauth' }),
      swap: async () => { swaps++; return { swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }; },
      now: () => clock,
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) { outcomes.push((await r.handle(SIG)).outcome); clock += 10 * 60_000; }
    expect(swaps).toBe(3);
    expect(outcomes.slice(3)).toEqual(Array(7).fill('gave-up'));
  });
});
