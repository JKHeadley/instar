import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS, getConfigByPath } from '../../src/core/devGatedFeatures.js';

/**
 * Increment A foundation: live credential re-pointing ships DARK + dry-run for
 * EVERYONE — including dev agents. It is a DARK_GATE_EXCLUSIONS entry (category
 * 'destructive', it WRITES OAuth credentials), NOT a DEV_GATED_FEATURES entry: a
 * dev-gated omit-enabled would resolve LIVE-with-writes on Echo (the rev-2
 * blocking bug this build deliberately avoids). Going live requires a deliberate
 * `enabled:true` AND `dryRun:false` flip — neither happens by default.
 *
 * Builds the config a real agent would run with (explicit developmentAgent flag +
 * the REAL ConfigDefaults applied, exactly as PostUpdateMigrator does).
 */
function buildConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

const CONFIG_PATH = 'subscriptionPool.credentialRepointing.enabled';
const DRYRUN_PATH = 'subscriptionPool.credentialRepointing.dryRun';

describe('credential re-pointing — dark-gate foundation (Increment A)', () => {
  it('is registered in DARK_GATE_EXCLUSIONS as a destructive exclusion (not dev-gated)', () => {
    const entry = DARK_GATE_EXCLUSIONS.find((e) => e.configPath === CONFIG_PATH);
    expect(entry, 'credentialRepointing must be a DARK_GATE_EXCLUSIONS entry').toBeDefined();
    expect(entry!.category).toBe('destructive');
    // The lint enforces ≥12-char reasons; assert it carries a real one.
    expect(entry!.reason.replace(/\s+/g, '').length).toBeGreaterThanOrEqual(12);
  });

  for (const isDev of [true, false]) {
    it(`ships enabled:false + dryRun:true on a ${isDev ? 'DEV' : 'fleet'} agent (no live-with-writes by default)`, () => {
      const cfg = buildConfig(isDev);
      // Both flags must be present (explicit, not omitted) AND off — the two-flag
      // gate. If either regressed to live, this fails loudly.
      expect(getConfigByPath(cfg, CONFIG_PATH)).toBe(false);
      expect(getConfigByPath(cfg, DRYRUN_PATH)).toBe(true);
    });
  }

  it('the explicit enabled:false default is paired with its registry entry (lint assertion C invariant)', () => {
    // ConfigDefaults ships a literal enabled:false for this path; the lint refuses
    // such a literal unless it is a declared choice in a registry. Assert the pair
    // exists so a future ConfigDefaults edit can't orphan the literal.
    const cfg = buildConfig(true);
    expect(getConfigByPath(cfg, CONFIG_PATH)).toBe(false);
    expect(DARK_GATE_EXCLUSIONS.some((e) => e.configPath === CONFIG_PATH)).toBe(true);
  });
});
