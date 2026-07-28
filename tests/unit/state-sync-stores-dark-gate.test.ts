import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS, DEV_GATED_FEATURES, getConfigByPath } from '../../src/core/devGatedFeatures.js';
import { resolveDevAgentGate, resolveStateSyncStores } from '../../src/core/devAgentGate.js';

/**
 * The 7 multiMachine.stateSync.* memory stores were RE-GATED on 2026-06-13
 * (operator directive, topic 13481: "NOTHING should ship dark on development
 * agents — every multi-machine feature must be live on dev agents so it actually
 * gets tested, not rot") from DARK_GATE_EXCLUSIONS (off for everyone) to the
 * developmentAgent gate: they resolve LIVE on a dev agent and DARK on the fleet.
 *
 * UNLIKE credentialRepointing (whose keychain WRITE is destructive, so it keeps
 * dryRun:true as the write-safety canary), these stores replicate between the
 * operator's OWN machines with NO external egress and NO destructive/irreversible
 * write — fully reversible via the foundation's rollback-unmerge. A dry-run would
 * defeat "actually gets tested", so on a dev agent they run ENABLED + dryRun:false
 * (genuinely live).
 *
 * Builds the config a real agent would run with (explicit developmentAgent flag +
 * the REAL ConfigDefaults applied, exactly as PostUpdateMigrator does).
 */
function buildConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

const STORES = [
  'preferences',
  'relationships',
  'learnings',
  'knowledge',
  'evolutionActions',
  'userRegistry',
  'topicOperator',
] as const;

const ENABLED_PATH = (store: string) => `multiMachine.stateSync.${store}.enabled`;
const DRYRUN_PATH = (store: string) => `multiMachine.stateSync.${store}.dryRun`;

describe('stateSync memory stores — developmentAgent gate (re-gated 2026-06-13, topic 13481)', () => {
  for (const store of STORES) {
    const ep = ENABLED_PATH(store);

    it(`${store} is registered in DEV_GATED_FEATURES (not DARK_GATE_EXCLUSIONS)`, () => {
      expect(
        DEV_GATED_FEATURES.some((e) => e.configPath === ep),
        `${ep} must be a DEV_GATED_FEATURES entry`,
      ).toBe(true);
      expect(
        DARK_GATE_EXCLUSIONS.some((e) => e.configPath === ep),
        `${ep} must NOT remain a DARK_GATE_EXCLUSIONS entry`,
      ).toBe(false);
    });

    it(`${store} OMITS enabled in ConfigDefaults so the gate decides (no baked-in false)`, () => {
      const cfg = buildConfig(true);
      expect(getConfigByPath(cfg, ep)).toBeUndefined();
      // dryRun is present + FALSE (genuinely live — no destructive write warrants dry-run).
      expect(getConfigByPath(cfg, DRYRUN_PATH(store))).toBe(false);
    });

    it(`${store} resolves LIVE on a dev agent and DARK on the fleet`, () => {
      const dev = buildConfig(true);
      const fleet = buildConfig(false);
      expect(resolveDevAgentGate(getConfigByPath(dev, ep) as boolean | undefined, dev)).toBe(true);
      expect(resolveDevAgentGate(getConfigByPath(fleet, ep) as boolean | undefined, fleet)).toBe(false);
    });

    it(`${store} resolves NOT-dry-run on BOTH dev and fleet (genuinely live, the operator's key decision)`, () => {
      // dryRun:false regardless of agent kind — it is the gate (enabled) that darks
      // the fleet, not dryRun. The point is that when LIVE (dev), it is NOT dry-run.
      expect(getConfigByPath(buildConfig(true), DRYRUN_PATH(store))).toBe(false);
      expect(getConfigByPath(buildConfig(false), DRYRUN_PATH(store))).toBe(false);
    });

    it(`${store} honors an explicit operator override of enabled (explicit wins over the gate)`, () => {
      const fleetForcedOn: Record<string, unknown> = { developmentAgent: false };
      applyDefaults(fleetForcedOn, getMigrationDefaults('standalone'));
      (((((fleetForcedOn.multiMachine as Record<string, unknown>).stateSync) as Record<string, unknown>)[store]) as Record<string, unknown>).enabled = true;
      expect(resolveDevAgentGate(getConfigByPath(fleetForcedOn, ep) as boolean | undefined, fleetForcedOn)).toBe(true);
    });
  }

  it('resolveStateSyncStores flips all 7 stores LIVE on a dev agent (the construction-boundary funnel)', () => {
    const dev = buildConfig(true) as { developmentAgent?: boolean; multiMachine?: { stateSync?: Record<string, { enabled?: boolean; dryRun?: boolean }> } };
    const resolved = resolveStateSyncStores(dev);
    expect(resolved).toBeDefined();
    for (const store of STORES) {
      expect(resolved![store]?.enabled, `${store} should be live on dev`).toBe(true);
      // dryRun preserved (false) — the funnel only resolves enabled, never touches dryRun.
      expect(resolved![store]?.dryRun, `${store} dryRun preserved`).toBe(false);
    }
  });

  it('resolveStateSyncStores keeps all 7 stores DARK on the fleet', () => {
    const fleet = buildConfig(false) as { developmentAgent?: boolean; multiMachine?: { stateSync?: Record<string, { enabled?: boolean }> } };
    const resolved = resolveStateSyncStores(fleet);
    expect(resolved).toBeDefined();
    for (const store of STORES) {
      expect(resolved![store]?.enabled, `${store} should be dark on fleet`).toBe(false);
    }
  });

  it('resolveStateSyncStores preserves the foundation-level numeric knobs untouched', () => {
    const dev = buildConfig(true) as { developmentAgent?: boolean; multiMachine?: { stateSync?: Record<string, unknown> } };
    const resolved = resolveStateSyncStores(dev) as Record<string, unknown>;
    // maxDriftMs / maxCachedSnapshots / etc are numbers, not per-store objects — they
    // must pass through unchanged (the funnel never coerces a knob into a store).
    expect(resolved['maxDriftMs']).toBe((dev.multiMachine!.stateSync as Record<string, unknown>)['maxDriftMs']);
    expect(resolved['maxCachedSnapshots']).toBe((dev.multiMachine!.stateSync as Record<string, unknown>)['maxCachedSnapshots']);
    expect(typeof resolved['maxDriftMs']).toBe('number');
  });

  it('resolveStateSyncStores honors an explicit operator force-dark on a dev agent (explicit false wins)', () => {
    const dev = buildConfig(true) as { developmentAgent?: boolean; multiMachine?: { stateSync?: Record<string, { enabled?: boolean }> } };
    dev.multiMachine!.stateSync!.preferences.enabled = false; // operator force-dark
    const resolved = resolveStateSyncStores(dev);
    expect(resolved!.preferences?.enabled).toBe(false);
    // the other stores stay live (only the explicitly-overridden one darks)
    expect(resolved!.relationships?.enabled).toBe(true);
  });

  it('resolveStateSyncStores returns undefined when there is no stateSync block (single-machine no-op)', () => {
    expect(resolveStateSyncStores({ developmentAgent: true })).toBeUndefined();
    expect(resolveStateSyncStores(undefined)).toBeUndefined();
  });
});
