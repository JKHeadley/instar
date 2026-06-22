/**
 * tmux Event-Loop Resilience, Increment 1 — Group F (config/dev-gate plumbing).
 *
 * Verifies the `migrateConfigTmuxResilienceDevGate` strip helper (the Migration
 * Parity arm): the three dev-gated tmux-resilience `enabled` flags ship with
 * `enabled` OMITTED from ConfigDefaults so resolveDevAgentGate decides (live on
 * dev, dark on fleet). An EXISTING agent that ran an interim build with a
 * hardcoded `enabled: false` per sub-block carries an explicit `false`, which
 * (being explicit) would keep the gate DARK even on a dev agent (#1001). The
 * strip removes a default-shaped `false` per sub-block so the gate resolves.
 *
 * The three real sub-blocks (verified against src/core/PostUpdateMigrator.ts):
 *   - monitoring.tmuxResilience.asyncHotPath.enabled    (A)
 *   - monitoring.tmuxResilience.inFlightMarker.enabled  (B)
 *   - monitoring.degradedTmuxGuard.enabled              (C)
 *
 * Per-sub-block rules: absent → no-op; `=== false` → STRIP; `=== true` →
 * preserve (an operator's explicit fleet-flip wins). No migration ever WRITES
 * `enabled`. The helper is idempotent.
 */

import { describe, it, expect } from 'vitest';
import { migrateConfigTmuxResilienceDevGate } from '../../src/core/PostUpdateMigrator.js';

/** A config whose three tmux-resilience sub-blocks each carry a default-shaped enabled:false. */
function defaultShapedFalseConfig(): Record<string, any> {
  return {
    monitoring: {
      tmuxResilience: {
        asyncHotPath: { enabled: false, timeoutMs: 9000, maxInFlight: 4 },
        inFlightMarker: { enabled: false, staleTtlFactor: 2 },
      },
      degradedTmuxGuard: { enabled: false, windowSize: 64 },
    },
  };
}

describe('migrateConfigTmuxResilienceDevGate — strips a default-shaped enabled:false per sub-block', () => {
  it('strips enabled:false on ALL THREE sub-blocks (asyncHotPath, inFlightMarker, degradedTmuxGuard)', () => {
    const cfg = defaultShapedFalseConfig();
    const patched = migrateConfigTmuxResilienceDevGate(cfg);

    expect(patched).toBe(true);
    // (A) asyncHotPath: enabled stripped, tuning knobs preserved.
    expect(cfg.monitoring.tmuxResilience.asyncHotPath).not.toHaveProperty('enabled');
    expect(cfg.monitoring.tmuxResilience.asyncHotPath.timeoutMs).toBe(9000);
    expect(cfg.monitoring.tmuxResilience.asyncHotPath.maxInFlight).toBe(4);
    // (B) inFlightMarker: enabled stripped, tuning knob preserved.
    expect(cfg.monitoring.tmuxResilience.inFlightMarker).not.toHaveProperty('enabled');
    expect(cfg.monitoring.tmuxResilience.inFlightMarker.staleTtlFactor).toBe(2);
    // (C) degradedTmuxGuard: enabled stripped, tuning knob preserved.
    expect(cfg.monitoring.degradedTmuxGuard).not.toHaveProperty('enabled');
    expect(cfg.monitoring.degradedTmuxGuard.windowSize).toBe(64);
  });

  it('strips ONLY the (A) sub-block when only it carries a default-shaped false (independent per-block)', () => {
    const cfg: Record<string, any> = {
      monitoring: {
        tmuxResilience: {
          asyncHotPath: { enabled: false },
          inFlightMarker: { staleTtlFactor: 2 }, // no enabled at all
        },
        degradedTmuxGuard: { windowSize: 64 }, // no enabled at all
      },
    };
    const patched = migrateConfigTmuxResilienceDevGate(cfg);

    expect(patched).toBe(true);
    expect(cfg.monitoring.tmuxResilience.asyncHotPath).not.toHaveProperty('enabled');
    // The other two blocks are untouched (no enabled to strip — must not be created).
    expect(cfg.monitoring.tmuxResilience.inFlightMarker).not.toHaveProperty('enabled');
    expect(cfg.monitoring.degradedTmuxGuard).not.toHaveProperty('enabled');
  });

  it('PRESERVES an explicit enabled:true on each sub-block (operator fleet-flip wins)', () => {
    const cfg: Record<string, any> = {
      monitoring: {
        tmuxResilience: {
          asyncHotPath: { enabled: true, timeoutMs: 9000 },
          inFlightMarker: { enabled: true },
        },
        degradedTmuxGuard: { enabled: true },
      },
    };
    const patched = migrateConfigTmuxResilienceDevGate(cfg);

    // Nothing default-shaped to strip → no patch, all explicit-true values preserved.
    expect(patched).toBe(false);
    expect(cfg.monitoring.tmuxResilience.asyncHotPath.enabled).toBe(true);
    expect(cfg.monitoring.tmuxResilience.inFlightMarker.enabled).toBe(true);
    expect(cfg.monitoring.degradedTmuxGuard.enabled).toBe(true);
  });

  it('preserves a mixed config — strips the false block, leaves the true block alone', () => {
    const cfg: Record<string, any> = {
      monitoring: {
        tmuxResilience: {
          asyncHotPath: { enabled: false }, // stripped
          inFlightMarker: { enabled: true }, // preserved
        },
        degradedTmuxGuard: { enabled: false }, // stripped
      },
    };
    const patched = migrateConfigTmuxResilienceDevGate(cfg);

    expect(patched).toBe(true);
    expect(cfg.monitoring.tmuxResilience.asyncHotPath).not.toHaveProperty('enabled');
    expect(cfg.monitoring.tmuxResilience.inFlightMarker.enabled).toBe(true);
    expect(cfg.monitoring.degradedTmuxGuard).not.toHaveProperty('enabled');
  });

  it('is a NO-OP when the tmux-resilience blocks are entirely absent', () => {
    const cfg: Record<string, any> = { monitoring: { somethingElse: { enabled: false } } };
    const patched = migrateConfigTmuxResilienceDevGate(cfg);

    expect(patched).toBe(false);
    expect(cfg.monitoring.somethingElse.enabled).toBe(false); // unrelated block untouched
  });

  it('is a NO-OP when monitoring is missing entirely', () => {
    const cfg: Record<string, any> = { somethingElse: true };
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(false);
    expect(cfg).toEqual({ somethingElse: true });
  });

  it('is a NO-OP when tmuxResilience exists but the leaf sub-blocks are missing', () => {
    const cfg: Record<string, any> = { monitoring: { tmuxResilience: {} } };
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(false);
    expect(cfg.monitoring.tmuxResilience).toEqual({});
  });

  it('is IDEMPOTENT — a second run finds nothing default-shaped to strip', () => {
    const cfg = defaultShapedFalseConfig();

    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(true);
    const afterFirst = structuredClone(cfg);

    // Second run: no default-shaped false left → no patch, config unchanged.
    expect(migrateConfigTmuxResilienceDevGate(cfg)).toBe(false);
    expect(cfg).toEqual(afterFirst);
  });

  it('never WRITES enabled — a stripped sub-block does not regain an enabled key', () => {
    const cfg = defaultShapedFalseConfig();
    migrateConfigTmuxResilienceDevGate(cfg);
    migrateConfigTmuxResilienceDevGate(cfg);
    expect(cfg.monitoring.tmuxResilience.asyncHotPath).not.toHaveProperty('enabled');
    expect(cfg.monitoring.tmuxResilience.inFlightMarker).not.toHaveProperty('enabled');
    expect(cfg.monitoring.degradedTmuxGuard).not.toHaveProperty('enabled');
  });
});
