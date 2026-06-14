/**
 * Migration parity for the 7 multiMachine.stateSync.* memory stores re-gated to the
 * developmentAgent gate on 2026-06-13 (operator directive topic 13481: "NOTHING should
 * ship dark on development agents").
 *
 * Existing agents carry the OLD ConfigDefaults-backfilled signature per store —
 * `{ enabled:false, dryRun:true }`. The explicit `enabled:false` would keep
 * resolveDevAgentGate DARK even on a dev agent, and `applyDefaults` (add-missing-only)
 * would not overwrite the stale `dryRun:true`. migrateConfigStateSyncStoresDevGate strips
 * that exact signature (BOTH keys) so the gate resolves (live-on-dev / dark-fleet) and the
 * new `dryRun:false` default backfills — UNLESS the block is operator-touched (any
 * divergence), in which case it is left entirely alone (reach is not authority).
 */
import { describe, it, expect } from 'vitest';
import { migrateConfigStateSyncStoresDevGate } from '../../src/core/PostUpdateMigrator.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

const STORES = [
  'preferences',
  'relationships',
  'learnings',
  'knowledge',
  'evolutionActions',
  'userRegistry',
  'topicOperator',
] as const;

function oldDefaultConfig(): Record<string, any> {
  return {
    multiMachine: {
      stateSync: Object.fromEntries(STORES.map((s) => [s, { enabled: false, dryRun: true }])),
    },
  };
}

describe('migrateConfigStateSyncStoresDevGate', () => {
  it('strips the exact old-default signature {enabled:false,dryRun:true} from all 7 stores', () => {
    const cfg = oldDefaultConfig();
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(true);
    for (const store of STORES) {
      const block = cfg.multiMachine.stateSync[store];
      expect(Object.prototype.hasOwnProperty.call(block, 'enabled'), `${store}.enabled stripped`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(block, 'dryRun'), `${store}.dryRun stripped`).toBe(false);
    }
  });

  it('after the strip + applyDefaults, the stores resolve LIVE on a dev agent and DARK on the fleet, dryRun:false', () => {
    // Dev agent: strip, then apply the (new) defaults exactly as the migrator runner does.
    const dev: Record<string, any> = { developmentAgent: true, ...oldDefaultConfig() };
    migrateConfigStateSyncStoresDevGate(dev);
    applyDefaults(dev, getMigrationDefaults('standalone'));
    for (const store of STORES) {
      const block = dev.multiMachine.stateSync[store];
      expect(resolveDevAgentGate(block.enabled, dev), `${store} live on dev`).toBe(true);
      expect(block.dryRun, `${store} dryRun:false on dev`).toBe(false);
    }
    // Fleet agent: same migration, dark resolution.
    const fleet: Record<string, any> = { developmentAgent: false, ...oldDefaultConfig() };
    migrateConfigStateSyncStoresDevGate(fleet);
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    for (const store of STORES) {
      const block = fleet.multiMachine.stateSync[store];
      expect(resolveDevAgentGate(block.enabled, fleet), `${store} dark on fleet`).toBe(false);
    }
  });

  it('is idempotent (a second run finds nothing default-shaped to strip)', () => {
    const cfg = oldDefaultConfig();
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(true);
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(false);
  });

  it('leaves an operator-set explicit enabled:true entirely alone (reach is not authority)', () => {
    const cfg: Record<string, any> = {
      multiMachine: { stateSync: { preferences: { enabled: true, dryRun: true } } },
    };
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(false);
    expect(cfg.multiMachine.stateSync.preferences.enabled).toBe(true);
    expect(cfg.multiMachine.stateSync.preferences.dryRun).toBe(true);
  });

  it('leaves a divergent block (extra keys, or a non-default dryRun) untouched', () => {
    const cfg: Record<string, any> = {
      multiMachine: {
        stateSync: {
          // enabled:false but dryRun:false → not the old signature, operator-touched
          preferences: { enabled: false, dryRun: false },
          // old signature + an extra key → not exactly 2 keys, operator-touched
          relationships: { enabled: false, dryRun: true, somethingElse: 1 },
        },
      },
    };
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(false);
    expect(cfg.multiMachine.stateSync.preferences).toEqual({ enabled: false, dryRun: false });
    expect(cfg.multiMachine.stateSync.relationships).toEqual({ enabled: false, dryRun: true, somethingElse: 1 });
  });

  it('only migrates the stores present (a partial config strips just what is default-shaped)', () => {
    const cfg: Record<string, any> = {
      multiMachine: {
        stateSync: {
          preferences: { enabled: false, dryRun: true }, // strip
          learnings: { enabled: true }, // operator-on, leave
        },
      },
    };
    expect(migrateConfigStateSyncStoresDevGate(cfg)).toBe(true);
    expect(cfg.multiMachine.stateSync.preferences).toEqual({});
    expect(cfg.multiMachine.stateSync.learnings).toEqual({ enabled: true });
  });

  it('returns false (no-op) on a config with no stateSync block (single-machine / fresh)', () => {
    expect(migrateConfigStateSyncStoresDevGate({})).toBe(false);
    expect(migrateConfigStateSyncStoresDevGate({ multiMachine: {} })).toBe(false);
    expect(migrateConfigStateSyncStoresDevGate({ multiMachine: { stateSync: {} } })).toBe(false);
  });
});
