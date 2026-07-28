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

  // ── tmux Event-Loop Resilience, Increment 1 — the three new dev-gated flags.
  //    The per-feature loop above ALREADY exercises both sides (live-on-dev /
  //    dark-on-fleet) for every registry entry; this block pins the three by
  //    name so a future delete of an entry fails loudly here, not just by a drop
  //    in the loop count. ──
  describe('tmux-resilience flags are registered and resolve both-sides', () => {
    const TMUX_CONFIG_PATHS = [
      'monitoring.tmuxResilience.asyncHotPath.enabled', // (A)
      'monitoring.tmuxResilience.inFlightMarker.enabled', // (B)
      'monitoring.degradedTmuxGuard.enabled', // (C) — guard-manifest-keyed
    ] as const;

    for (const configPath of TMUX_CONFIG_PATHS) {
      it(`${configPath} is present in DEV_GATED_FEATURES exactly once`, () => {
        const matches = DEV_GATED_FEATURES.filter(f => f.configPath === configPath);
        expect(matches.length, `${configPath} entry count`).toBe(1);
      });

      it(`${configPath} resolves LIVE on dev and DARK on fleet`, () => {
        const devCfg = buildConfig(true);
        const fleetCfg = buildConfig(false);
        expect(
          resolveDevAgentGate(
            getConfigByPath(devCfg, configPath) as boolean | undefined,
            devCfg as { developmentAgent?: boolean },
          ),
        ).toBe(true);
        expect(
          resolveDevAgentGate(
            getConfigByPath(fleetCfg, configPath) as boolean | undefined,
            fleetCfg as { developmentAgent?: boolean },
          ),
        ).toBe(false);
      });
    }

    it('the three flags map to the named features (tmuxResilienceAsyncHotPath / InFlightMarker / LatencyGuard)', () => {
      const byPath = new Map(DEV_GATED_FEATURES.map(f => [f.configPath, f.name]));
      expect(byPath.get('monitoring.tmuxResilience.asyncHotPath.enabled')).toBe('tmuxResilienceAsyncHotPath');
      expect(byPath.get('monitoring.tmuxResilience.inFlightMarker.enabled')).toBe('tmuxResilienceInFlightMarker');
      // (C) uses the standalone degradedTmuxGuard path but the LatencyGuard feature name.
      expect(byPath.get('monitoring.degradedTmuxGuard.enabled')).toBe('tmuxResilienceLatencyGuard');
    });
  });

  // ── LLM-Decision Quality Meter uniform provenance seam (llm-decision-quality-
  //    meter §5.7). The per-feature loop above already exercises both sides; this
  //    block pins the entry by name (so a future delete fails loudly) AND pins the
  //    spec-mandated justification sentence (the CODEOWNERS-reviewable safety
  //    rationale is part of the spec's deliverable, not free prose). ──
  describe('provenance.uniformSeam.enabled is registered with the spec §5.7 justification', () => {
    const CONFIG_PATH = 'provenance.uniformSeam.enabled';

    it(`${CONFIG_PATH} is present in DEV_GATED_FEATURES exactly once, as provenanceUniformSeam`, () => {
      const matches = DEV_GATED_FEATURES.filter(f => f.configPath === CONFIG_PATH);
      expect(matches.length, `${CONFIG_PATH} entry count`).toBe(1);
      expect(matches[0].name).toBe('provenanceUniformSeam');
    });

    it('carries the spec §5.7 justification sentence verbatim', () => {
      const entry = DEV_GATED_FEATURES.find(f => f.configPath === CONFIG_PATH)!;
      expect(entry.justification).toBe(
        'observe-only side write at the router-settlement seam; never gates/blocks/delays the decision call; no egress, no spend, no destructive action; failure is catch-logged.',
      );
    });

    it('the key stays UNSEEDED by ConfigDefaults/migration defaults (omit-required — a seeded false would pin the dev gate off)', () => {
      // migrateConfig is a deliberate NO-OP for this key (spec §5.7/§6): the
      // migration defaults an updated agent receives must not carry it.
      const devCfg = buildConfig(true);
      expect(getConfigByPath(devCfg, CONFIG_PATH)).toBeUndefined();
      // And the provenance.quality.* tuning keys are also unseeded (inline
      // defaults at read sites, spec §6).
      expect(getConfigByPath(devCfg, 'provenance.quality')).toBeUndefined();
    });
  });

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
