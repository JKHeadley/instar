/**
 * Step 10 — the §5 livetest battery orchestration (CredentialRepointingLivetest).
 *
 * Verifies the harness's safety contract + verdict logic against FAKE deps (no real
 * keychain, no real oracle): the armed guard (zero swaps unless armed), the
 * identity-verified round trip (exchange-then-restore via the oracle, NOT auth status),
 * always-restore-on-failure, fail-closed on an unresolvable oracle, and that the
 * inherently-manual items (c)/(d) are surfaced — never auto-passed.
 */

import { describe, it, expect } from 'vitest';
import { CredentialRepointingLivetest } from '../../src/core/CredentialRepointingLivetest.js';

/**
 * A fake keychain world: a map of slot → accountId. `swap` exchanges the two slots'
 * accounts; `resolveIdentity` reads the current owner. Mirrors the real executor's
 * observable effect (identity follows the credential) without any IO.
 */
function fakeWorld(initial: Record<string, string | null>) {
  const slots: Record<string, string | null> = { ...initial };
  const calls: Array<[string, string]> = [];
  return {
    slots,
    calls,
    deps: {
      swap: async (a: string, b: string) => {
        calls.push([a, b]);
        const tmp = slots[a];
        slots[a] = slots[b];
        slots[b] = tmp;
        return { ok: true };
      },
      resolveIdentity: async (slot: string) => ({ accountId: slots[slot] ?? null }),
    },
  };
}

const ENROLLED = { slotA: '~/.config/a', slotB: '~/.config/b' };
const DEFAULT_PAIR = { defaultSlot: '~/.claude', enrolledSlot: '~/.config/a' };

describe('CredentialRepointingLivetest — armed guard', () => {
  it('REFUSES and performs ZERO swaps when not armed', async () => {
    const world = fakeWorld({ '~/.config/a': 'acct-A', '~/.config/b': 'acct-B', '~/.claude': 'acct-D' });
    const lt = new CredentialRepointingLivetest(world.deps); // armed defaults to false

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);

    expect(report.armed).toBe(false);
    expect(report.promotable).toBe(false);
    expect(report.refusedReason).toMatch(/PROMOTION gate/);
    expect(report.steps).toEqual([]);
    expect(world.calls).toEqual([]); // not a single real swap was attempted
    // Manual items are still surfaced even on a refusal.
    expect(report.manualSteps.length).toBe(CredentialRepointingLivetest.MANUAL_STEPS.length);
  });
});

describe('CredentialRepointingLivetest — armed round trips', () => {
  it('passes both automated steps when identities exchange and restore cleanly', async () => {
    const world = fakeWorld({ '~/.config/a': 'acct-A', '~/.config/b': 'acct-B', '~/.claude': 'acct-D' });
    const lt = new CredentialRepointingLivetest(world.deps, { armed: true });

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);

    expect(report.armed).toBe(true);
    expect(report.steps).toHaveLength(2);
    expect(report.steps.every((s) => s.passed)).toBe(true);
    // Each round trip is a forward + a restoring swap = 2 swaps per step, 4 total.
    expect(world.calls).toHaveLength(4);
    // World is left exactly as found.
    expect(world.slots).toEqual({ '~/.config/a': 'acct-A', '~/.config/b': 'acct-B', '~/.claude': 'acct-D' });
  });

  it('is NOT promotable while manual items (c)/(d) remain outstanding', async () => {
    const world = fakeWorld({ '~/.config/a': 'acct-A', '~/.config/b': 'acct-B', '~/.claude': 'acct-D' });
    const lt = new CredentialRepointingLivetest(world.deps, { armed: true });

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);

    expect(report.steps.every((s) => s.passed)).toBe(true);
    expect(report.manualSteps.length).toBeGreaterThan(0);
    // Automated all-green is necessary but NOT sufficient — the operator must still
    // complete (c)/(d) before promotion.
    expect(report.promotable).toBe(false);
  });

  it('fails the step (fail-closed) when the oracle cannot resolve a slot identity', async () => {
    const world = fakeWorld({ '~/.config/a': null, '~/.config/b': 'acct-B', '~/.claude': 'acct-D' });
    const lt = new CredentialRepointingLivetest(world.deps, { armed: true });

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);

    expect(report.steps[0].passed).toBe(false);
    expect(report.steps[0].detail).toMatch(/oracle could not resolve/);
    // No swap attempted when the pre-state is unverifiable.
    expect(world.calls).toHaveLength(0);
  });

  it('fails when the two slots already report the same account (cannot prove an exchange)', async () => {
    const world = fakeWorld({ '~/.config/a': 'same', '~/.config/b': 'same', '~/.claude': 'acct-D' });
    const lt = new CredentialRepointingLivetest(world.deps, { armed: true });

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);
    expect(report.steps[0].passed).toBe(false);
    expect(report.steps[0].detail).toMatch(/same account/);
  });

  it('fails AND still restores when the forward swap does not actuate (identities do not exchange)', async () => {
    // A swap that records the call but does NOT change identities (a no-op executor).
    const slots: Record<string, string | null> = { '~/.config/a': 'acct-A', '~/.config/b': 'acct-B', '~/.claude': 'acct-D' };
    const calls: Array<[string, string]> = [];
    const lt = new CredentialRepointingLivetest(
      {
        swap: async (a, b) => { calls.push([a, b]); return { ok: true }; }, // no state change
        resolveIdentity: async (slot) => ({ accountId: slots[slot] ?? null }),
      },
      { armed: true },
    );

    const report = await lt.run(ENROLLED, DEFAULT_PAIR);
    expect(report.steps[0].passed).toBe(false);
    expect(report.steps[0].detail).toMatch(/did NOT exchange/);
    // Restore was still attempted (forward + restore) even though verify failed.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a residual state when the restoring swap fails', async () => {
    let n = 0;
    const slots: Record<string, string | null> = { '~/.config/a': 'acct-A', '~/.config/b': 'acct-B' };
    const lt = new CredentialRepointingLivetest(
      {
        swap: async (a, b) => {
          n += 1;
          if (n === 1) { const t = slots[a]; slots[a] = slots[b]; slots[b] = t; return { ok: true }; } // forward ok
          return { ok: false, detail: 'restore failed' }; // restoring swap fails
        },
        resolveIdentity: async (slot) => ({ accountId: slots[slot] ?? null }),
      },
      { armed: true },
    );

    const report = await lt.run({ slotA: '~/.config/a', slotB: '~/.config/b' }, DEFAULT_PAIR);
    expect(report.steps[0].passed).toBe(false);
    expect(report.steps[0].detail).toMatch(/NOT cleanly restored|residual/);
  });
});

describe('CredentialRepointingLivetest — manual battery items', () => {
  it('surfaces the §2.8 manual items (c) refresher, (d) §0.c residual, and E4 liveness', () => {
    const joined = CredentialRepointingLivetest.MANUAL_STEPS.join('\n');
    expect(joined).toMatch(/\(c\)/);
    expect(joined).toMatch(/refresher/i);
    expect(joined).toMatch(/\(d\)/);
    expect(joined).toMatch(/disposable/i);
    expect(joined).toMatch(/E4|liveness/i);
  });
});
