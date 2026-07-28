/**
 * Increment B, step B3a — the §2.4 balancer ORCHESTRATOR (CredentialRebalancer).
 *
 * Covers the stateful safety contract over fake deps (no keychain): dark = strict no-op
 * (zero executor calls), dry-run actuates the decision but the executor writes nothing,
 * cooldown state advances across passes (anti-churn), and the P19 breaker opens on N
 * consecutive LIVE failures + resets on success.
 */

import { describe, it, expect } from 'vitest';
import { CredentialRebalancer, type CredentialRebalancerDeps, type RebalancerResolvedConfig } from '../../src/core/CredentialRebalancer.js';
import type { SlotState, AccountState } from '../../src/core/CredentialRebalancerPolicy.js';

const RESOLVED: RebalancerResolvedConfig = {
  policy: {
    highWaterPct: 85, criticalPct: 95, drainHorizonHours: 24, drainHeadroomMinPct: 30,
    minScoreDelta: 10, maxForcedSwapsPerPass: 1, perPairCooldownMs: 15 * 60_000,
    perTenantCooldownMs: 30 * 60_000, staleQuotaMs: 30 * 60_000, urgencyClampHours: 4,
  },
  auditCadenceMs: 6 * 3600_000,
  desiredDefaultAccountId: null,
  maxForcedOverridesPerWindow: 5,
  breakerThreshold: 3,
};

function slot(p: Partial<SlotState> & { slot: string; tenantAccountId: string }): SlotState {
  return { isDefault: false, quarantined: false, lastVerifiedAt: 1000, lastAuditDivergent: false, drainInProgress: false, busyness: 1, ...p };
}
function acc(p: Partial<AccountState> & { accountId: string }): AccountState {
  return { status: 'ok', fiveHrPct: 10, weeklyPct: 10, weeklyResetsInHours: 100, measuredAt: 1, ...p };
}

function makeDeps(over: Partial<CredentialRebalancerDeps> & { clock?: { t: number } }): CredentialRebalancerDeps {
  const clock = over.clock ?? { t: 10_000_000 };
  // A walling scenario (A at 90% rescued with B at 5%); quota measuredAt tracks the clock
  // so it is always FRESH (a stale reading would make the target source-only, by design).
  return {
    isEnabled: () => true,
    isDryRun: () => false,
    listSlots: () => [slot({ slot: 's1', tenantAccountId: 'A', lastVerifiedAt: clock.t }), slot({ slot: 's2', tenantAccountId: 'B', lastVerifiedAt: clock.t })],
    listAccounts: () => [acc({ accountId: 'A', fiveHrPct: 90, measuredAt: clock.t }), acc({ accountId: 'B', fiveHrPct: 5, measuredAt: clock.t })],
    resolveConfig: () => RESOLVED,
    swap: async () => ({ ok: true }),
    now: () => clock.t,
    ...over,
  };
}

describe('CredentialRebalancer — dark gate', () => {
  it('is a STRICT no-op when disabled (zero executor calls)', async () => {
    let swaps = 0;
    const r = new CredentialRebalancer(makeDeps({ isEnabled: () => false, swap: async () => { swaps += 1; return { ok: true }; } }));
    const audit = await r.tick();
    expect(audit.enabled).toBe(false);
    expect(audit.decisions).toEqual([]);
    expect(swaps).toBe(0);
    expect(audit.noActuationReason).toBe('feature dark');
  });
});

describe('CredentialRebalancer — actuation', () => {
  it('actuates one swap for a walling scenario when enabled', async () => {
    const calls: Array<[string, string]> = [];
    const r = new CredentialRebalancer(makeDeps({ swap: async (a, b) => { calls.push([a, b]); return { ok: true }; } }));
    const audit = await r.tick();
    expect(audit.decisions).toHaveLength(1);
    expect(audit.actuated).toHaveLength(1);
    expect(audit.actuated[0].result.ok).toBe(true);
    expect(calls).toEqual([['s1', 's2']]); // targetSlot, sourceSlot
  });

  it('dry-run still drives the executor (which no-ops the write) and advances cooldowns', async () => {
    let calls = 0;
    const r = new CredentialRebalancer(makeDeps({ isDryRun: () => true, swap: async () => { calls += 1; return { ok: true }; } }));
    const audit = await r.tick();
    expect(audit.dryRun).toBe(true);
    expect(calls).toBe(1); // the executor IS called (it enforces dryRun internally)
    const st = r.status();
    expect(st.cooldownTenants).toBeGreaterThan(0); // cooldown advanced even in dry-run
  });
});

describe('CredentialRebalancer — cooldown across passes', () => {
  it('does not re-swap the same tenant pair on the very next pass (per-pair cooldown)', async () => {
    const clock = { t: 10_000_000 };
    let calls = 0;
    const r = new CredentialRebalancer(makeDeps({ clock, swap: async () => { calls += 1; return { ok: true }; } }));
    await r.tick();            // pass 1 acts
    expect(calls).toBe(1);
    clock.t += 60_000;         // 1 min later (< 15 min per-pair cooldown)
    await r.tick();            // pass 2 should be held by the cooldown
    expect(calls).toBe(1);     // no second swap
  });
});

describe('CredentialRebalancer — P19 breaker', () => {
  it('opens after N consecutive LIVE failures and resets on a success', async () => {
    const clock = { t: 10_000_000 };
    let mode: 'fail' | 'ok' = 'fail';
    // Fresh quota each pass so the fresh-data gate never blocks (advance measuredAt with the clock).
    const r = new CredentialRebalancer(makeDeps({
      clock,
      listAccounts: () => [acc({ accountId: 'A', fiveHrPct: 90, measuredAt: clock.t }), acc({ accountId: 'B', fiveHrPct: 5, measuredAt: clock.t })],
      swap: async () => (mode === 'fail' ? { ok: false, detail: 'keychain dead' } : { ok: true }),
    }));
    // 3 consecutive failing passes (advance clock past the per-pair cooldown each time so it keeps trying).
    for (let i = 0; i < 3; i++) { await r.tick(); clock.t += 31 * 60_000; }
    expect(r.status().breaker.open).toBe(true);
    expect(r.status().breaker.consecutiveFailures).toBeGreaterThanOrEqual(3);
    // A success resets it.
    mode = 'ok';
    clock.t += 31 * 60_000;
    await r.tick();
    expect(r.status().breaker.open).toBe(false);
    expect(r.status().breaker.consecutiveFailures).toBe(0);
  });

  it('a dry-run swap that returns ok never trips the breaker', async () => {
    const r = new CredentialRebalancer(makeDeps({ isDryRun: () => true, swap: async () => ({ ok: true }) }));
    await r.tick();
    expect(r.status().breaker.open).toBe(false);
  });
});

describe('CredentialRebalancer — status surface', () => {
  it('reports enabled + breaker + last pass', async () => {
    const r = new CredentialRebalancer(makeDeps({}));
    expect(r.status().lastPass).toBeNull();
    await r.tick();
    const st = r.status();
    expect(st.enabled).toBe(true);
    expect(st.lastPass).not.toBeNull();
    expect(st.breaker.threshold).toBe(3);
  });
});
