/**
 * tmux Event-Loop Resilience, Increment 1 — Group F (config defaults shape).
 *
 * Asserts the LIVE ConfigDefaults posture for the three dev-gated tmux flags,
 * applied through the REAL applyDefaults path a migrating agent runs:
 *   1. The three `.enabled` keys are OMITTED (the #1001-avoidance — a baked-in
 *      `enabled: false` would dark dev agents too). resolveDevAgentGate decides.
 *   2. The tuning knobs (timeoutMs:9000, maxInFlight:4, staleTtlFactor:2,
 *      windowSize:64, …) backfill via applyDefaults (add-missing-only).
 *   3. The migrate-strip helper is idempotent and never re-introduces `enabled`.
 *
 * (Socket-isolation / resolveTmuxSocketLabel cases are OUT OF SCOPE — Increment 2.)
 */

import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { getConfigByPath } from '../../src/core/devGatedFeatures.js';
import { migrateConfigTmuxResilienceDevGate } from '../../src/core/PostUpdateMigrator.js';

/** A pre-feature config with the REAL ConfigDefaults applied (add-missing semantics). */
function buildDefaultedConfig(developmentAgent = true): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

describe('tmux-resilience ConfigDefaults — the three .enabled keys are OMITTED (dev-gate-resolved)', () => {
  it('OMITS monitoring.tmuxResilience.asyncHotPath.enabled (A)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath')).toBeDefined();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.enabled')).toBeUndefined();
  });

  it('OMITS monitoring.tmuxResilience.inFlightMarker.enabled (B)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker')).toBeDefined();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker.enabled')).toBeUndefined();
  });

  it('OMITS monitoring.degradedTmuxGuard.enabled (C)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard')).toBeDefined();
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.enabled')).toBeUndefined();
  });

  it('OMITS all three regardless of the developmentAgent flag (the omission is structural, not gate-derived)', () => {
    for (const dev of [true, false]) {
      const cfg = buildDefaultedConfig(dev);
      expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.enabled')).toBeUndefined();
      expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker.enabled')).toBeUndefined();
      expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.enabled')).toBeUndefined();
    }
  });
});

describe('tmux-resilience ConfigDefaults — the tuning knobs backfill via applyDefaults', () => {
  it('backfills the (A) asyncHotPath knobs (timeoutMs:9000, maxInFlight:4)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.timeoutMs')).toBe(9000);
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.maxInFlight')).toBe(4);
  });

  it('backfills the (B) inFlightMarker knob (staleTtlFactor:2)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker.staleTtlFactor')).toBe(2);
  });

  it('backfills the (C) degradedTmuxGuard knobs (windowSize:64 + the full tuning set)', () => {
    const cfg = buildDefaultedConfig();
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.windowSize')).toBe(64);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.ewmaAlpha')).toBe(0.3);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.slowCallThresholdMs')).toBe(9000);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.episodeCorroborationCycles')).toBe(3);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.loadGateMaxLoadPerCore')).toBe(1.5);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.episodeEscalateIntervalMs')).toBe(1_800_000);
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.settleWindowMs')).toBe(60_000);
  });

  it('add-missing-only: an operator who pre-set a knob keeps their value (applyDefaults never overwrites)', () => {
    const cfg: Record<string, unknown> = {
      developmentAgent: true,
      monitoring: { tmuxResilience: { asyncHotPath: { timeoutMs: 12000 } } },
    };
    applyDefaults(cfg, getMigrationDefaults('standalone'));
    // The operator's explicit timeoutMs survives; the sibling default fills in.
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.timeoutMs')).toBe(12000);
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.maxInFlight')).toBe(4);
    // Still no enabled — applyDefaults never adds it.
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.enabled')).toBeUndefined();
  });
});

describe('tmux-resilience ConfigDefaults — migrate-strip idempotency over a defaulted config', () => {
  it('a fresh defaulted config has no enabled to strip (the strip is a no-op on a clean install)', () => {
    const cfg = buildDefaultedConfig();
    // No default-shaped enabled:false present → nothing to strip.
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(false);
  });

  it('a stale persisted enabled:false is stripped once, then applyDefaults leaves it absent (the cartographer trap is closed)', () => {
    // Simulate an agent that ran an interim build: a hardcoded enabled:false persisted.
    const cfg: Record<string, any> = {
      developmentAgent: true,
      monitoring: {
        tmuxResilience: {
          asyncHotPath: { enabled: false, timeoutMs: 9000, maxInFlight: 4 },
          inFlightMarker: { enabled: false, staleTtlFactor: 2 },
        },
        degradedTmuxGuard: { enabled: false, windowSize: 64 },
      },
    };

    // First strip removes the stale false on all three.
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(true);
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.enabled')).toBeUndefined();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker.enabled')).toBeUndefined();
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.enabled')).toBeUndefined();

    // applyDefaults (add-missing) must NOT re-introduce enabled (the trap: a stale
    // false would never be overwritten, but applyDefaults also never re-adds it).
    applyDefaults(cfg, getMigrationDefaults('standalone'));
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.asyncHotPath.enabled')).toBeUndefined();
    expect(getConfigByPath(cfg, 'monitoring.tmuxResilience.inFlightMarker.enabled')).toBeUndefined();
    expect(getConfigByPath(cfg, 'monitoring.degradedTmuxGuard.enabled')).toBeUndefined();

    // Idempotent: a second strip after applyDefaults finds nothing.
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(false);
  });
});
