import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS, DEV_GATED_FEATURES, getConfigByPath } from '../../src/core/devGatedFeatures.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

/**
 * Live credential re-pointing was RE-GATED on 2026-06-13 (operator directive, topic 20905:
 * "NONE of this should be dark for development agents") from DARK_GATE_EXCLUSIONS
 * (off+dry-run for everyone) to the developmentAgent gate: it resolves LIVE on a dev agent
 * and DARK on the fleet. The destructive credential WRITE is gated by the SEPARATE `dryRun`
 * flag (default true) — the dry-run canary — so live-on-dev runs the full decision loop +
 * audits what it WOULD do but writes ZERO credentials until a deliberate `dryRun:false`.
 *
 * Builds the config a real agent would run with (explicit developmentAgent flag + the REAL
 * ConfigDefaults applied, exactly as PostUpdateMigrator does).
 */
function buildConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

const CONFIG_PATH = 'subscriptionPool.credentialRepointing.enabled';
const DRYRUN_PATH = 'subscriptionPool.credentialRepointing.dryRun';

describe('credential re-pointing — developmentAgent gate (re-gated 2026-06-13)', () => {
  it('is registered in DEV_GATED_FEATURES (not DARK_GATE_EXCLUSIONS)', () => {
    expect(DEV_GATED_FEATURES.some((e) => e.configPath === CONFIG_PATH), 'must be a DEV_GATED_FEATURES entry').toBe(true);
    expect(DARK_GATE_EXCLUSIONS.some((e) => e.configPath === CONFIG_PATH), 'must NOT remain a DARK_GATE_EXCLUSIONS entry').toBe(false);
  });

  it('OMITS enabled in ConfigDefaults so the gate decides (no baked-in false)', () => {
    const cfg = buildConfig(true);
    expect(getConfigByPath(cfg, CONFIG_PATH)).toBeUndefined();
    // dryRun stays present + true (the write-safety canary), regardless of agent kind.
    expect(getConfigByPath(cfg, DRYRUN_PATH)).toBe(true);
  });

  it('resolves LIVE on a dev agent and DARK on the fleet', () => {
    const dev = buildConfig(true);
    const fleet = buildConfig(false);
    expect(resolveDevAgentGate(getConfigByPath(dev, CONFIG_PATH) as boolean | undefined, dev)).toBe(true);
    expect(resolveDevAgentGate(getConfigByPath(fleet, CONFIG_PATH) as boolean | undefined, fleet)).toBe(false);
    // dryRun true on BOTH ⇒ even live-on-dev performs no credential write (the canary).
    expect(getConfigByPath(dev, DRYRUN_PATH)).toBe(true);
    expect(getConfigByPath(fleet, DRYRUN_PATH)).toBe(true);
  });

  it('honors an explicit operator override of enabled (explicit wins over the gate)', () => {
    const fleetForcedOn: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleetForcedOn, getMigrationDefaults('standalone'));
    // Operator explicitly enables on a fleet (non-dev) agent.
    (((fleetForcedOn.subscriptionPool as Record<string, unknown>).credentialRepointing) as Record<string, unknown>).enabled = true;
    expect(resolveDevAgentGate(getConfigByPath(fleetForcedOn, CONFIG_PATH) as boolean | undefined, fleetForcedOn)).toBe(true);
  });
});
