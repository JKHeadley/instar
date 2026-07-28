/**
 * Tier-1 unit tests for seamlessness config resolution + invariant validation.
 * Spec §9 (Tunability). Both sides of every invariant boundary are covered.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSeamlessnessConfig,
  validateSeamlessnessInvariants,
  assertSeamlessnessInvariants,
  SeamlessnessConfigError,
  SEAMLESSNESS_PROTOCOL_VERSION,
} from '../../src/core/seamlessnessConfig.js';
import type { MultiMachineConfig } from '../../src/core/types.js';

const baseMM = (over?: Partial<MultiMachineConfig>): MultiMachineConfig => ({
  enabled: true,
  autoFailover: true,
  failoverTimeoutMinutes: 15,
  autoFailoverConfirm: false,
  ...over,
});

describe('resolveSeamlessnessConfig', () => {
  it('applies sane defaults', () => {
    const c = resolveSeamlessnessConfig(baseMM());
    expect(c.ingressHeartbeatMs).toBe(30_000);
    expect(c.leaseTtlMs).toBe(60_000); // 2 × ingressHeartbeatMs
    expect(c.registrySyncDebounceMs).toBe(10_000);
    expect(c.liveTailTransport).toBe('tunnel');
    expect(c.liveTailMaxStalenessMs).toBe(5_000);
    expect(c.liveTailPushRateMs).toBe(5_000); // = staleness
    expect(c.handoffBar).toBe('near-instant');
    expect(c.protocolVersion).toBe(SEAMLESSNESS_PROTOCOL_VERSION);
  });

  it('auto-derives standbyPullIntervalMs under BOTH bounds (min of fo/4 and leaseTtl/2)', () => {
    const c = resolveSeamlessnessConfig(baseMM());
    expect(c.failoverThresholdMs).toBe(15 * 60_000);
    // At default ratios leaseTtl/2 (30s) is the binding bound, not failover/4 (225s).
    expect(c.standbyPullIntervalMs).toBe(Math.min((15 * 60_000) / 4, c.leaseTtlMs / 2));
    expect(c.standbyPullIntervalMs).toBe(30_000);
    // And it actually satisfies the validated invariants:
    expect(c.standbyPullIntervalMs).toBeLessThan(c.leaseTtlMs);
    expect(c.standbyPullIntervalMs).toBeLessThan(c.failoverThresholdMs / 3);
  });

  it('leaseTtlMs follows a widened ingressHeartbeatMs', () => {
    const c = resolveSeamlessnessConfig(baseMM({ ingressHeartbeatMs: 45_000 }));
    expect(c.leaseTtlMs).toBe(90_000);
  });

  it('leasePullIntervalMs defaults to 5s and honors an explicit override', () => {
    expect(resolveSeamlessnessConfig(baseMM()).leasePullIntervalMs).toBe(5_000);
    expect(resolveSeamlessnessConfig(baseMM({ leasePullIntervalMs: 2_000 })).leasePullIntervalMs).toBe(2_000);
  });

  it('explicit overrides win over defaults', () => {
    const c = resolveSeamlessnessConfig(baseMM({ liveTailTransport: 'git', liveTailMaxBytesPerTopic: 1024 }));
    expect(c.liveTailTransport).toBe('git');
    expect(c.liveTailMaxBytesPerTopic).toBe(1024);
  });
});

describe('validateSeamlessnessInvariants', () => {
  it('default config is valid', () => {
    expect(validateSeamlessnessInvariants(resolveSeamlessnessConfig(baseMM()))).toEqual([]);
  });

  it('rejects standbyPullIntervalMs >= failoverThresholdMs/3', () => {
    // failoverThresholdMs = 900_000; /3 = 300_000. Set pull to 300_000 (boundary, must fail).
    const c = resolveSeamlessnessConfig(baseMM({ standbyPullIntervalMs: 300_000 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('failoverThresholdMs/3'))).toBe(true);
  });

  it('rejects standbyPullIntervalMs >= leaseTtlMs', () => {
    // Make leaseTtlMs small (via ingressHeartbeatMs) but keep pull large within the /3 bound.
    // ingressHeartbeatMs=20_000 → leaseTtl=40_000. pull must be < 40_000 AND < 300_000.
    const c = resolveSeamlessnessConfig(baseMM({ ingressHeartbeatMs: 20_000, standbyPullIntervalMs: 50_000 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('leaseTtlMs'))).toBe(true);
  });

  it('rejects liveTailPushRateMs > liveTailMaxStalenessMs', () => {
    const c = resolveSeamlessnessConfig(baseMM({ liveTailPushRateMs: 10_000, liveTailMaxStalenessMs: 5_000 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('liveTailPushRateMs'))).toBe(true);
  });

  it('rejects non-positive cadences', () => {
    const c = resolveSeamlessnessConfig(baseMM({ ingressHeartbeatMs: 0 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('ingressHeartbeatMs'))).toBe(true);
  });

  it('rejects leasePullIntervalMs >= leaseTtlMs (anti-blinding bound)', () => {
    // leaseTtl default 60_000. A pull cadence at/over the TTL means a standby could
    // go a whole lease lifetime without actively pulling — defeats the purpose.
    const c = resolveSeamlessnessConfig(baseMM({ leasePullIntervalMs: 60_000 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('leasePullIntervalMs'))).toBe(true);
  });

  it('accepts a leasePullIntervalMs just under leaseTtlMs', () => {
    const c = resolveSeamlessnessConfig(baseMM({ leasePullIntervalMs: 59_999 }));
    expect(validateSeamlessnessInvariants(c)).toEqual([]);
  });

  it('rejects a non-positive leasePullIntervalMs', () => {
    const c = resolveSeamlessnessConfig(baseMM({ leasePullIntervalMs: 0 }));
    const errs = validateSeamlessnessInvariants(c);
    expect(errs.some((e) => e.includes('leasePullIntervalMs'))).toBe(true);
  });
});

describe('assertSeamlessnessInvariants', () => {
  it('returns the resolved config when valid', () => {
    const c = assertSeamlessnessInvariants(baseMM());
    expect(c.ingressHeartbeatMs).toBe(30_000);
  });

  it('throws SeamlessnessConfigError on a violating config', () => {
    expect(() => assertSeamlessnessInvariants(baseMM({ liveTailPushRateMs: 10_000, liveTailMaxStalenessMs: 5_000 }))).toThrow(
      SeamlessnessConfigError,
    );
  });
});

// ── exactlyOnceIngress ↔ session-pool stage coupling (2026-06-05) ────────
// Running a LIVE multi-machine pool without the ingress dedupe ledger is the
// incoherent configuration that let one "move to laptop" execute 4×. The
// default now follows the pool stage; an explicit value always wins.
describe('exactlyOnceIngress default coupling', () => {
  it('defaults OFF with no multiMachine config at all', () => {
    expect(resolveSeamlessnessConfig(undefined).exactlyOnceIngress).toBe(false);
  });

  it('defaults OFF while the pool ships dark/shadow', () => {
    expect(resolveSeamlessnessConfig({ sessionPool: { stage: 'dark' } } as never).exactlyOnceIngress).toBe(false);
    expect(resolveSeamlessnessConfig({ sessionPool: { stage: 'shadow' } } as never).exactlyOnceIngress).toBe(false);
  });

  it('defaults ON once the pool routes real traffic (live-transfer / rebalance)', () => {
    expect(resolveSeamlessnessConfig({ sessionPool: { stage: 'live-transfer' } } as never).exactlyOnceIngress).toBe(true);
    expect(resolveSeamlessnessConfig({ sessionPool: { stage: 'rebalance' } } as never).exactlyOnceIngress).toBe(true);
  });

  it('an explicit value always wins over the stage-derived default', () => {
    expect(resolveSeamlessnessConfig({ exactlyOnceIngress: false, sessionPool: { stage: 'live-transfer' } } as never).exactlyOnceIngress).toBe(false);
    expect(resolveSeamlessnessConfig({ exactlyOnceIngress: true, sessionPool: { stage: 'dark' } } as never).exactlyOnceIngress).toBe(true);
  });
});
