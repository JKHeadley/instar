import { describe, it, expect } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS, DEV_GATED_FEATURES, getConfigByPath } from '../../src/core/devGatedFeatures.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

/**
 * ExternalHogSentinel config slice (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md).
 *
 * The sentinel is a 4th process-killer whose three siblings (sessionReaper /
 * agentWorktreeReaper / mcpProcessReaper) are DARK_GATE_EXCLUSIONS as destructive. Per
 * the converged+approved spec (§7/§8), it is admissible to the developmentAgent gate
 * ONLY because the `enabled` gate makes SCAN/CLASSIFY/LOG live while the KILL stays
 * doubly-held: the SEPARATE `dryRun` flag (default true — the canary) AND, orthogonally,
 * a PIN-written armed marker. So live-on-dev watches + logs would-kills but kills NOTHING
 * until a deliberate dryRun:false AND a fresh PIN arm.
 *
 * Builds the config a real agent would run with (explicit developmentAgent flag + the
 * REAL ConfigDefaults applied, exactly as PostUpdateMigrator does).
 */
function buildConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

const CONFIG_PATH = 'monitoring.externalHogSentinel.enabled';
const DRYRUN_PATH = 'monitoring.externalHogSentinel.dryRun';

describe('externalHogSentinel — config slice (dev-gate + dryRun canary)', () => {
  it('is registered in DEV_GATED_FEATURES (not DARK_GATE_EXCLUSIONS)', () => {
    expect(
      DEV_GATED_FEATURES.some((e) => e.configPath === CONFIG_PATH),
      'must be a DEV_GATED_FEATURES entry',
    ).toBe(true);
    expect(
      DARK_GATE_EXCLUSIONS.some((e) => e.configPath === CONFIG_PATH),
      'must NOT be a DARK_GATE_EXCLUSIONS entry',
    ).toBe(false);
    // Registered exactly once (no duplicate that would confuse gate resolution).
    expect(
      DEV_GATED_FEATURES.filter((e) => e.configPath === CONFIG_PATH).length,
      'exactly one registry entry',
    ).toBe(1);
  });

  it('carries a substantive justification naming the doubly-held kill (dryRun + PIN marker)', () => {
    const entry = DEV_GATED_FEATURES.find((e) => e.configPath === CONFIG_PATH);
    expect(entry, 'registry entry present').toBeDefined();
    const j = (entry!.justification || '').toLowerCase();
    expect(j).toContain('dryrun');
    expect(j).toContain('pin');
    // The negative-invariant the spec requires: it must NOT be in a strip allowlist
    // (asserted structurally by the migrateDevGateTeethStrip test), and the justification
    // must acknowledge it is a process-killer whose siblings are excluded as destructive.
    expect(j).toContain('kill');
  });

  it('OMITS enabled in ConfigDefaults so the gate decides (no baked-in false)', () => {
    const cfg = buildConfig(true);
    expect(getConfigByPath(cfg, CONFIG_PATH)).toBeUndefined();
    // dryRun stays present + true (the kill-safety canary), regardless of agent kind.
    expect(getConfigByPath(cfg, DRYRUN_PATH)).toBe(true);
    expect(getConfigByPath(buildConfig(false), DRYRUN_PATH)).toBe(true);
  });

  it('resolves LIVE on a dev agent and DARK on the fleet — but dryRun holds on BOTH', () => {
    const dev = buildConfig(true);
    const fleet = buildConfig(false);
    expect(resolveDevAgentGate(getConfigByPath(dev, CONFIG_PATH) as boolean | undefined, dev)).toBe(true);
    expect(resolveDevAgentGate(getConfigByPath(fleet, CONFIG_PATH) as boolean | undefined, fleet)).toBe(false);
    // dryRun true on BOTH ⇒ even live-on-dev kills NOTHING (the canary): watch-only soak.
    expect(getConfigByPath(dev, DRYRUN_PATH)).toBe(true);
  });

  it('ships the spec-mandated kill-gate defaults', () => {
    const cfg = buildConfig(true);
    const g = (k: string) => getConfigByPath(cfg, `monitoring.externalHogSentinel.${k}`);
    expect(g('scanIntervalMs')).toBe(60_000);
    expect(g('cpuCoreThreshold')).toBe(1.5); // above the observed ~2.2, clear of single-core disowned jobs
    expect(g('sustainedSampleCount')).toBe(3);
    expect(g('sampleWindowMs')).toBe(30_000);
    expect(g('singleFlightBudgetMs')).toBe(20_000); // poll budget; NO coupling to N×window (round-8 vestige removed)
    expect(g('killTimeCpuRecheckWindowMs')).toBe(2_500);
    expect(g('sigtermGraceMs')).toBe(12_000);
    expect(g('inFlightKillTtlMs')).toBe(36_000); // ~3×sigtermGraceMs, NOT 2× (mid-write LS guard)
    expect(g('maxKillDeferrals')).toBe(3);
    expect(g('maxClassificationsPerScan')).toBe(4);
    expect(g('classifierCacheTtlMs')).toBe(300_000);
    expect(g('classifierCacheMaxEntries')).toBe(256);
    expect(g('inFlightKillSetMax')).toBe(64);
    expect(g('noticeBudgetPerWindow')).toBe(4);
    expect(g('noticeWindowMs')).toBe(600_000);
  });

  it('holds the classifier-spend invariant: maxClassificationsPerScan (4) < the host spawn cap (8)', () => {
    // §5: a full classification burst can never occupy more than half the host's spawn
    // slots, so the sentinel cannot crowd out the tone gate on the priority-less semaphore.
    const cfg = buildConfig(true);
    const cap = getConfigByPath(cfg, 'monitoring.externalHogSentinel.maxClassificationsPerScan') as number;
    const HOST_SPAWN_CAP_DEFAULT = 8;
    expect(cap).toBeLessThan(HOST_SPAWN_CAP_DEFAULT);
  });
});
