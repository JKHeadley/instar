import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { DEV_GATED_FEATURES, getConfigByPath } from '../../src/core/devGatedFeatures.js';

/**
 * Build the config a real agent would run with: the explicit developmentAgent
 * flag, then the REAL ConfigDefaults applied (add-missing semantics, exactly as
 * PostUpdateMigrator does). This is the point — if a dev-gated feature's default
 * ever hardcodes `enabled: false` (the literal #1001 mechanism), applyDefaults
 * injects that `false` and the LIVE-on-dev assertion below fails.
 */
function buildConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

describe('DEV_GATED_FEATURES — both-sides wiring (live on dev, dark on fleet)', () => {
  it('the registry is non-empty (guards against an accidentally-emptied registry)', () => {
    expect(DEV_GATED_FEATURES.length).toBeGreaterThan(0);
  });

  for (const feature of DEV_GATED_FEATURES) {
    it(`${feature.name} (${feature.configPath}) resolves LIVE on a dev agent`, () => {
      const devCfg = buildConfig(true);
      const resolved = resolveDevAgentGate(
        getConfigByPath(devCfg, feature.configPath) as boolean | undefined,
        devCfg as { developmentAgent?: boolean },
      );
      // If this fails, the feature's default hardcodes `enabled: false` (or the
      // gate path is wrong) — it would ship dark on dev agents (the #1001 bug).
      expect(resolved).toBe(true);
    });

    it(`${feature.name} (${feature.configPath}) resolves DARK on the fleet`, () => {
      const fleetCfg = buildConfig(false);
      const resolved = resolveDevAgentGate(
        getConfigByPath(fleetCfg, feature.configPath) as boolean | undefined,
        fleetCfg as { developmentAgent?: boolean },
      );
      // If this fails, the feature's default hardcodes `enabled: true` — it would
      // ship live on the whole fleet rather than dark-until-flipped.
      expect(resolved).toBe(false);
    });
  }

  it('has teeth — a regressed hardcoded `enabled: false` default would FAIL the live-on-dev assertion (the #1001 mechanism)', () => {
    // Simulate the literal #1001 bug: a dev-gated feature's default hardcodes
    // enabled:false. Inject it at a registered path on a dev-agent config and
    // confirm the gate resolves DARK — i.e., the per-feature LIVE-on-dev test
    // above would have failed loudly, which is the whole point of the registry.
    const feature = DEV_GATED_FEATURES[0];
    const devCfg = buildConfig(true) as Record<string, any>;
    const keys = feature.configPath.split('.');
    let cur: Record<string, any> = devCfg;
    for (const k of keys.slice(0, -1)) {
      cur[k] = cur[k] ?? {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = false; // the regression

    const resolved = resolveDevAgentGate(
      getConfigByPath(devCfg, feature.configPath) as boolean | undefined,
      devCfg as { developmentAgent?: boolean },
    );
    expect(resolved).toBe(false); // caught: dark on a dev agent
  });
});
