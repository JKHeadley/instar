/**
 * Increment B, step B1 — the §2.4 balancer DECISION core (CredentialRebalancerPolicy).
 *
 * Exhaustive both-sides-of-the-boundary coverage of the pure pass policy: eligibility,
 * objective-1 wall avoidance + the wall-override caps (fresh-data gate, per-pass cap,
 * per-window budget, recency gate, stale-quota source-only), objective-2 drain (weekly-
 * only, headroom floor, drain-in-progress hold, busiest-slot, min-improvement), the
 * 1-swap-per-pass invariant, and the audited zero-actuation pass.
 */

import { describe, it, expect } from 'vitest';
import {
  decidePass,
  type RebalancePassInput,
  type RebalancerPolicyConfig,
  type AccountState,
  type SlotState,
  type CooldownState,
} from '../../src/core/CredentialRebalancerPolicy.js';

const HOUR = 3600_000;

const CONFIG: RebalancerPolicyConfig = {
  highWaterPct: 85,
  criticalPct: 95,
  drainHorizonHours: 24,
  drainHeadroomMinPct: 30,
  minScoreDelta: 10,
  maxForcedSwapsPerPass: 1,
  perPairCooldownMs: 15 * 60_000,
  perTenantCooldownMs: 30 * 60_000,
  staleQuotaMs: 30 * 60_000,
  urgencyClampHours: 4,
};

const NOW = 1_000_000_000_000;

function acc(p: Partial<AccountState> & { accountId: string }): AccountState {
  return {
    status: 'ok',
    fiveHrPct: 10,
    weeklyPct: 10,
    weeklyResetsInHours: 100,
    measuredAt: NOW, // fresh
    ...p,
  };
}

function slot(p: Partial<SlotState> & { slot: string; tenantAccountId: string }): SlotState {
  return {
    isDefault: false,
    quarantined: false,
    lastVerifiedAt: NOW, // recently verified
    lastAuditDivergent: false,
    drainInProgress: false,
    busyness: 1,
    ...p,
  };
}

const NO_COOLDOWNS: CooldownState = {
  lastActuationByPair: {},
  lastActuationByTenant: {},
  forcedOverridesInWindow: 0,
  maxForcedOverridesPerWindow: 5,
};

function pass(over: Partial<RebalancePassInput>): RebalancePassInput {
  return {
    now: NOW,
    slots: [],
    accounts: [],
    cooldowns: NO_COOLDOWNS,
    config: CONFIG,
    auditCadenceMs: 6 * HOUR,
    ...over,
  };
}

describe('decidePass — eligibility', () => {
  it('excludes a needs-reauth tenant from participating (no swap)', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 99, status: 'needs-reauth' }), acc({ accountId: 'B', fiveHrPct: 10 })],
    }));
    expect(r.decisions).toEqual([]); // A is over the wall but ineligible → nothing to rescue
  });

  it('does not use a quarantined slot as a rescue target', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B', quarantined: true })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 90 }), acc({ accountId: 'B', fiveHrPct: 5 })],
    }));
    expect(r.decisions).toEqual([]);
    expect(r.attention.some((a) => /no eligible.*rescue target/.test(a))).toBe(true);
  });
});

describe('decidePass — objective 1 wall avoidance', () => {
  it('rescues a walling tenant with the highest-headroom eligible account', () => {
    const r = decidePass(pass({
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A' }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
        slot({ slot: 's3', tenantAccountId: 'C' }),
      ],
      accounts: [
        acc({ accountId: 'A', fiveHrPct: 90 }), // walling
        acc({ accountId: 'B', fiveHrPct: 40 }),
        acc({ accountId: 'C', fiveHrPct: 5 }),  // most headroom
      ],
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].objective).toBe('wall');
    expect(r.decisions[0].forced).toBeNull();
    expect(r.decisions[0].targetSlot).toBe('s1');
    expect(r.decisions[0].sourceSlot).toBe('s3'); // C, lowest utilization
  });

  it('does NOT rescue when the only target is also walling', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 90 }), acc({ accountId: 'B', fiveHrPct: 88 })],
    }));
    expect(r.decisions).toEqual([]);
  });

  it('holds a non-forced wall move behind the per-pair cooldown', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 90 }), acc({ accountId: 'B', fiveHrPct: 5 })],
      cooldowns: { ...NO_COOLDOWNS, lastActuationByPair: { 'A|B': NOW - 60_000 } }, // 1 min ago < 15 min
    }));
    expect(r.decisions).toEqual([]);
    expect(r.noActuationReason).toMatch(/cooldown|held/);
  });

  it('triggers on the weekly window too (not just 5h)', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 10, weeklyPct: 92 }), acc({ accountId: 'B', fiveHrPct: 5, weeklyPct: 5 })],
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].targetSlot).toBe('s1');
  });
});

describe('decidePass — wall-override (critical mark)', () => {
  const wallingCritical = {
    slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
    accounts: [acc({ accountId: 'A', fiveHrPct: 97 }), acc({ accountId: 'B', fiveHrPct: 5 })],
  };

  it('bypasses a cooldown that would block a non-forced move', () => {
    const r = decidePass(pass({
      ...wallingCritical,
      cooldowns: { ...NO_COOLDOWNS, lastActuationByPair: { 'A|B': NOW - 60_000 }, lastActuationByTenant: { A: NOW - 60_000, B: NOW - 60_000 } },
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].forced).toBe('wall-override');
  });

  it('respects the fresh-data gate — does NOT re-fire on the same sensor snapshot', () => {
    // The tenant's quota measuredAt is NOT newer than its last actuation → no override.
    const r = decidePass(pass({
      ...wallingCritical,
      cooldowns: { ...NO_COOLDOWNS, lastActuationByTenant: { A: NOW } }, // == measuredAt, not newer
    }));
    expect(r.decisions).toEqual([]);
  });

  it('stops + surfaces when the per-window override budget is exhausted', () => {
    const r = decidePass(pass({
      ...wallingCritical,
      cooldowns: { ...NO_COOLDOWNS, forcedOverridesInWindow: 5, maxForcedOverridesPerWindow: 5 },
    }));
    expect(r.decisions).toEqual([]);
    expect(r.degraded.some((d) => /budget exhausted/.test(d))).toBe(true);
    expect(r.attention.some((a) => /budget exhausted/.test(a))).toBe(true);
  });

  it('emits at most maxForcedSwapsPerPass forced swaps when multiple slots are critical', () => {
    const r = decidePass(pass({
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A' }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
        slot({ slot: 's3', tenantAccountId: 'C' }),
        slot({ slot: 's4', tenantAccountId: 'D' }),
      ],
      accounts: [
        acc({ accountId: 'A', fiveHrPct: 98 }), // critical
        acc({ accountId: 'B', fiveHrPct: 97 }), // critical
        acc({ accountId: 'C', fiveHrPct: 5 }),
        acc({ accountId: 'D', fiveHrPct: 6 }),
      ],
      config: { ...CONFIG, maxForcedSwapsPerPass: 1 },
    }));
    expect(r.decisions).toHaveLength(1); // worst (A) rescued this pass; B waits for next
    expect(r.decisions[0].targetSlot).toBe('s1');
  });

  it('is NOT eligible to rescue with a target whose identity verify is stale (recency gate)', () => {
    const r = decidePass(pass({
      ...wallingCritical,
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A' }),
        slot({ slot: 's2', tenantAccountId: 'B', lastVerifiedAt: NOW - 100 * HOUR }), // stale verify
      ],
    }));
    expect(r.decisions).toEqual([]);
    expect(r.attention.some((a) => /no eligible non-walling rescue target/.test(a))).toBe(true);
  });
});

describe('decidePass — stale quota is SOURCE-only', () => {
  it('does not deal a stale-quota account into a walling slot (could mask a wall)', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [
        acc({ accountId: 'A', fiveHrPct: 90 }),
        acc({ accountId: 'B', fiveHrPct: 5, measuredAt: NOW - 2 * HOUR }), // stale
      ],
    }));
    expect(r.decisions).toEqual([]); // B is fresh-headroom-looking but stale → not a target
  });
});

describe('decidePass — objective 2 drain', () => {
  it('drains a soon-resetting weekly window with headroom to the busiest slot', () => {
    const r = decidePass(pass({
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A', busyness: 1 }),
        slot({ slot: 's2', tenantAccountId: 'B', busyness: 9 }), // busiest
      ],
      accounts: [
        acc({ accountId: 'A', weeklyPct: 20, weeklyResetsInHours: 10 }), // drainable: 80% unused, resets in 10h
        acc({ accountId: 'B', weeklyPct: 50, weeklyResetsInHours: 100 }),
      ],
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].objective).toBe('drain');
    expect(r.decisions[0].targetSlot).toBe('s2'); // busiest destination
    expect(r.decisions[0].sourceSlot).toBe('s1'); // holds the drainable account
  });

  it('does NOT drain a 5h window (weekly only)', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B', busyness: 9 })],
      accounts: [
        acc({ accountId: 'A', fiveHrPct: 20, weeklyResetsInHours: null }), // no weekly window info
        acc({ accountId: 'B', weeklyResetsInHours: 100 }),
      ],
    }));
    expect(r.decisions).toEqual([]);
  });

  it('does NOT drain when headroom is below the floor', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B', busyness: 9 })],
      accounts: [
        acc({ accountId: 'A', weeklyPct: 80, weeklyResetsInHours: 10 }), // only 20% unused < 30%
        acc({ accountId: 'B', weeklyResetsInHours: 100 }),
      ],
    }));
    expect(r.decisions).toEqual([]);
  });

  it('excludes a drain-in-progress slot as a drain destination', () => {
    const r = decidePass(pass({
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A' }),
        slot({ slot: 's2', tenantAccountId: 'B', busyness: 9, drainInProgress: true }), // held
      ],
      accounts: [
        acc({ accountId: 'A', weeklyPct: 20, weeklyResetsInHours: 10 }),
        acc({ accountId: 'B', weeklyResetsInHours: 100 }),
      ],
    }));
    expect(r.decisions).toEqual([]); // only candidate destination is held
  });
});

describe('decidePass — objective 0: dead/quarantined-default eviction', () => {
  it('deals a healthy verified tenant into ~/.claude when the default tenant is needs-reauth', () => {
    const r = decidePass(pass({
      desiredDefaultAccountId: 'D',
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
      ],
      accounts: [acc({ accountId: 'D', status: 'needs-reauth' }), acc({ accountId: 'B', fiveHrPct: 10 })],
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].objective).toBe('default-eviction');
    expect(r.decisions[0].targetSlot).toBe('~/.claude');
    expect(r.decisions[0].sourceSlot).toBe('s2');
    expect(r.attention.some((a) => /parked|needs re-auth/.test(a))).toBe(true);
  });

  it('rescues a QUARANTINED default slot too (not just needs-reauth)', () => {
    const r = decidePass(pass({
      desiredDefaultAccountId: 'D',
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true, quarantined: true }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
      ],
      accounts: [acc({ accountId: 'D' }), acc({ accountId: 'B' })],
    }));
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].objective).toBe('default-eviction');
  });

  it('correlated-outage floor: NO slot verifiable → preserve last-known-good, do NOT evict', () => {
    const r = decidePass(pass({
      desiredDefaultAccountId: 'D',
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true, quarantined: true, lastKnownGoodAccountId: 'D' }),
        slot({ slot: 's2', tenantAccountId: 'B', lastVerifiedAt: NOW - 100 * HOUR }), // stale → not verifiable
      ],
      accounts: [acc({ accountId: 'D' }), acc({ accountId: 'B' })],
    }));
    expect(r.decisions).toEqual([]);
    expect(r.degraded.some((d) => /correlated-outage floor/.test(d))).toBe(true);
    expect(r.attention.some((a) => /last-known-good|NOT certified live/.test(a))).toBe(true);
  });

  it('dead default but no healthy tenant available → surface, no action', () => {
    const r = decidePass(pass({
      desiredDefaultAccountId: 'D',
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true }),
        slot({ slot: 's2', tenantAccountId: 'B' }), // verified but B is needs-reauth below
      ],
      accounts: [acc({ accountId: 'D', status: 'disabled' }), acc({ accountId: 'B', status: 'needs-reauth' })],
    }));
    expect(r.decisions).toEqual([]);
    expect(r.attention.some((a) => /no healthy verified tenant/.test(a))).toBe(true);
  });

  it('does nothing special when the default slot is healthy (normal objectives run)', () => {
    const r = decidePass(pass({
      desiredDefaultAccountId: 'D',
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
      ],
      accounts: [acc({ accountId: 'D', fiveHrPct: 20 }), acc({ accountId: 'B', fiveHrPct: 10 })],
    }));
    expect(r.decisions).toEqual([]); // healthy + balanced → no eviction, no wall, no drain
    expect(r.noActuationReason).toMatch(/balanced|zero actuation/);
  });

  it('is inert when no default account is configured', () => {
    const r = decidePass(pass({
      // desiredDefaultAccountId omitted
      slots: [
        slot({ slot: '~/.claude', tenantAccountId: 'D', isDefault: true, quarantined: true }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
      ],
      accounts: [acc({ accountId: 'D' }), acc({ accountId: 'B' })],
    }));
    // No default-eviction objective fires; the quarantined default slot is just excluded from
    // participating, and nothing else acts.
    expect(r.decisions.every((d) => d.objective !== 'default-eviction')).toBe(true);
  });
});

describe('decidePass — zero actuation', () => {
  it('returns no decisions + a reason when nothing walls and nothing drains', () => {
    const r = decidePass(pass({
      slots: [slot({ slot: 's1', tenantAccountId: 'A' }), slot({ slot: 's2', tenantAccountId: 'B' })],
      accounts: [acc({ accountId: 'A', fiveHrPct: 20 }), acc({ accountId: 'B', fiveHrPct: 10 })],
    }));
    expect(r.decisions).toEqual([]);
    expect(r.noActuationReason).toMatch(/balanced|zero actuation/);
  });

  it('never emits more than one non-forced swap per pass', () => {
    const r = decidePass(pass({
      slots: [
        slot({ slot: 's1', tenantAccountId: 'A' }),
        slot({ slot: 's2', tenantAccountId: 'B' }),
        slot({ slot: 's3', tenantAccountId: 'C' }),
        slot({ slot: 's4', tenantAccountId: 'D' }),
      ],
      accounts: [
        acc({ accountId: 'A', fiveHrPct: 90 }), // walling
        acc({ accountId: 'B', fiveHrPct: 88 }), // walling
        acc({ accountId: 'C', fiveHrPct: 5 }),
        acc({ accountId: 'D', fiveHrPct: 6 }),
      ],
    }));
    expect(r.decisions).toHaveLength(1); // only the worst is acted on
  });
});
