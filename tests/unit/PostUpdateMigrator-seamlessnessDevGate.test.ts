/**
 * Migration parity for the multiMachine.seamlessness coherence flags (WS3 / WS4.1 /
 * WS4.3) re-gated to the developmentAgent gate on 2026-06-13 (operator directive
 * topic 13481: "NOTHING should ship dark on development agents").
 *
 * Existing agents carry the OLD ConfigDefaults-backfilled signature — an explicit
 * `false` per flag (and for ws43, the pair `{ ws43JournalLease:false,
 * ws43JournalLeaseDryRun:true }`). The explicit `false` would keep resolveDevAgentGate
 * DARK even on a dev agent. migrateConfigSeamlessnessDevGate strips a default-shaped
 * `false` per flag so the gate resolves (live-on-dev / dark-fleet) — and strips the paired
 * ws43JournalLeaseDryRun:true so the consumer's coherent dryRun default applies. An
 * operator-set explicit `true` (or any non-default value) is left entirely alone (reach is
 * not authority). Mirrors the ws44PoolLinks / stateSync strips.
 *
 * U4.1 (docs/specs/u4-1-pin-persistence.md §5, R-r2-4): ws13Reconcile was REMOVED
 * from the strip list by the pin-persistence graduation PR — an explicit
 * `ws13Reconcile: false` is now the operator's DURABLE rollback lever ("re-darken
 * the ws13 flags") and must SURVIVE every migrator run. The old strip could not
 * distinguish the operator's darken from a default-shaped false, so it silently
 * undid the rollback on the next update. This suite locks BOTH directions.
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigSeamlessnessDevGate } from '../../src/core/PostUpdateMigrator.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

const FLAGS = [
  'ws3OneVoice',
  'ws41DurableAck',
  'ws43RoleGuard',
  'ws43JournalLease',
] as const;

function oldDefaultConfig(): Record<string, any> {
  return {
    multiMachine: {
      seamlessness: {
        ...Object.fromEntries(FLAGS.map((f) => [f, false])),
        ws43JournalLeaseDryRun: true,
      },
    },
  };
}

describe('migrateConfigSeamlessnessDevGate', () => {
  it('strips the default-shaped false from the 4 gated coherence flags + paired ws43JournalLeaseDryRun', () => {
    const cfg = oldDefaultConfig();
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true);
    // All 4 flags + dryRun stripped → seamlessness block was emptied & removed.
    expect(cfg.multiMachine.seamlessness).toBeUndefined();
  });

  it('U4.1 R-r2-4: an explicit ws13Reconcile:false (the operator rollback lever) SURVIVES migration', () => {
    const cfg: Record<string, any> = {
      multiMachine: {
        seamlessness: {
          ...Object.fromEntries(FLAGS.map((f) => [f, false])),
          ws13Reconcile: false, // the operator's re-darken — must NOT be stripped
          ws43JournalLeaseDryRun: true,
        },
      },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true); // the 4 gated flags still strip
    expect(cfg.multiMachine.seamlessness.ws13Reconcile).toBe(false); // the lever survives
    // And it stays dark even on a dev agent — the operator darken WINS the gate.
    const dev: Record<string, any> = { developmentAgent: true, ...cfg };
    expect(resolveDevAgentGate(dev.multiMachine.seamlessness.ws13Reconcile, dev)).toBe(false);
    // Idempotent: a second run has nothing more to strip and still leaves the lever.
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws13Reconcile).toBe(false);
  });

  it('keeps non-default tunables when stripping only the flags (block not emptied)', () => {
    const cfg: Record<string, any> = {
      multiMachine: {
        seamlessness: {
          ...Object.fromEntries(FLAGS.map((f) => [f, false])),
          ws43JournalLeaseDryRun: true,
          ws3DwellMs: 60000, // a tunable, not a gate — left alone
        },
      },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true);
    for (const f of FLAGS) {
      expect(Object.prototype.hasOwnProperty.call(cfg.multiMachine.seamlessness, f), `${f} stripped`).toBe(false);
    }
    expect(Object.prototype.hasOwnProperty.call(cfg.multiMachine.seamlessness, 'ws43JournalLeaseDryRun')).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws3DwellMs).toBe(60000);
  });

  it('after strip + applyDefaults, the flags resolve LIVE on a dev agent and DARK on the fleet', () => {
    const dev: Record<string, any> = { developmentAgent: true, ...oldDefaultConfig() };
    migrateConfigSeamlessnessDevGate(dev);
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const devSeam = dev.multiMachine?.seamlessness ?? {};
    for (const f of FLAGS) {
      expect(resolveDevAgentGate(devSeam[f], dev), `${f} live on dev`).toBe(true);
    }
    // ws43JournalLeaseDryRun resolves COHERENTLY false on dev (genuinely live cutover).
    expect(devSeam.ws43JournalLeaseDryRun ?? !resolveDevAgentGate(undefined, dev), 'ws43 dryRun false on dev').toBe(false);

    const fleet: Record<string, any> = { developmentAgent: false, ...oldDefaultConfig() };
    migrateConfigSeamlessnessDevGate(fleet);
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    const fleetSeam = fleet.multiMachine?.seamlessness ?? {};
    for (const f of FLAGS) {
      expect(resolveDevAgentGate(fleetSeam[f], fleet), `${f} dark on fleet`).toBe(false);
    }
    // Fleet stays in the safe dry-run posture.
    expect(fleetSeam.ws43JournalLeaseDryRun ?? !resolveDevAgentGate(undefined, fleet), 'ws43 dryRun true on fleet').toBe(true);
  });

  it('is idempotent (a second run finds nothing default-shaped to strip)', () => {
    const cfg = oldDefaultConfig();
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true);
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(false);
  });

  it('leaves an operator-set explicit true entirely alone (reach is not authority)', () => {
    const cfg: Record<string, any> = {
      multiMachine: { seamlessness: { ws3OneVoice: true, ws43JournalLease: true } },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws3OneVoice).toBe(true);
    expect(cfg.multiMachine.seamlessness.ws43JournalLease).toBe(true);
  });

  it('leaves an operator-set ws43JournalLeaseDryRun untouched when not paired with a default-shaped false', () => {
    // ws43JournalLease operator-on (true) → not stripped; the paired dryRun strip never fires.
    const cfg: Record<string, any> = {
      multiMachine: { seamlessness: { ws43JournalLease: true, ws43JournalLeaseDryRun: true } },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws43JournalLeaseDryRun).toBe(true);
  });

  it('does NOT strip ws43JournalLeaseDryRun:false even alongside a default-shaped ws43JournalLease:false (operator-touched dryRun)', () => {
    const cfg: Record<string, any> = {
      multiMachine: { seamlessness: { ws43JournalLease: false, ws43JournalLeaseDryRun: false } },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true);
    // ws43JournalLease (default-shaped false) stripped; the operator dryRun:false preserved.
    expect(Object.prototype.hasOwnProperty.call(cfg.multiMachine.seamlessness, 'ws43JournalLease')).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws43JournalLeaseDryRun).toBe(false);
  });

  it('migrates only the flags present (a partial config strips just what is default-shaped)', () => {
    const cfg: Record<string, any> = {
      multiMachine: {
        seamlessness: {
          ws3OneVoice: false, // strip
          ws43RoleGuard: true, // operator-on, leave
        },
      },
    };
    expect(migrateConfigSeamlessnessDevGate(cfg)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cfg.multiMachine.seamlessness, 'ws3OneVoice')).toBe(false);
    expect(cfg.multiMachine.seamlessness.ws43RoleGuard).toBe(true);
  });

  it('returns false (no-op) on a config with no seamlessness block (single-machine / fresh)', () => {
    expect(migrateConfigSeamlessnessDevGate({})).toBe(false);
    expect(migrateConfigSeamlessnessDevGate({ multiMachine: {} })).toBe(false);
    expect(migrateConfigSeamlessnessDevGate({ multiMachine: { seamlessness: {} } })).toBe(false);
  });
});
