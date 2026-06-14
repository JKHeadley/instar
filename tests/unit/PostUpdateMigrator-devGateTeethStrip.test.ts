/**
 * Verifies PostUpdateMigrator.migrateDevGateTeethStrip — the one-shot, dev-agent-only
 * migration that strips a DEFAULT-SHAPED `enabled: false` from an EXISTING dev agent's
 * config for the 4 features moved out of the retired `deliberate-fleet-default` bucket
 * into DEV_GATED_FEATURES (CMT-1438, DEV-AGENT-DARK-GATE-TEETH §D5). Without it,
 * applyDefaults's add-missing-only semantics leave a stale persisted `false` in place
 * and the feature stays DARK on the very dev agent meant to dogfood it (the cartographer
 * trap; Migration Parity).
 *
 * Covers both sides of every boundary: dev-agent strip (resolver then yields live),
 * fleet-agent no-op (the dark default is correct), an operator `true` preserved, the 3
 * D4-held exclusion paths NEVER touched, idempotency via the _instar_migrations
 * run-once marker (a re-added operator `false` is never re-stripped), the stripped set
 * reported in result.upgraded, no-config skip, and corrupt-config error with bytes
 * preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { getConfigByPath } from '../../src/core/devGatedFeatures.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const GATED_PATHS = [
  'monitoring.parallelWorkSentinel.enabled',
  'monitoring.failureLearning.enabled',
  'monitoring.releaseReadiness.enabled',
  'monitoring.bootHealthBeacon.enabled',
];

describe('PostUpdateMigrator — dev-gate teeth strip (CMT-1438 §D5)', () => {
  let projectDir: string;
  let stateDir: string;

  function configPath(): string {
    return path.join(stateDir, 'config.json');
  }
  function writeConfig(cfg: Record<string, unknown>): void {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  }
  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  }
  function runMigration(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
    });
    (migrator as unknown as { migrateDevGateTeethStrip(r: MigrationResult): void })
      .migrateDevGateTeethStrip(result);
    return result;
  }
  /** A monitoring block with all 4 gated paths + the 3 D4-held paths persisted false. */
  function fullStaleMonitoring(): Record<string, unknown> {
    return {
      parallelWorkSentinel: { enabled: false },
      failureLearning: { enabled: false, minSupport: 4 },
      releaseReadiness: { enabled: false, tickIntervalMs: 1 },
      bootHealthBeacon: { enabled: false },
      // The 3 D4-held exclusions — must be left UNTOUCHED.
      correctionLearning: { enabled: false },
      apprenticeshipCycleSla: { enabled: false },
      geminiCapacityEscalation: { enabled: false },
    };
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devgate-teeth-mig-'));
    stateDir = projectDir;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-devGateTeethStrip.test.ts' });
  });

  it('dev agent: strips the 4 default-shaped `false`s so the resolver yields LIVE, and leaves the 3 D4-held exclusions DARK', () => {
    writeConfig({ developmentAgent: true, monitoring: fullStaleMonitoring() });
    const result = runMigration();
    const cfg = readConfig();

    // The 4 dev-gated paths: `enabled` deleted → resolveDevAgentGate yields LIVE on dev.
    for (const p of GATED_PATHS) {
      expect(getConfigByPath(cfg, p), `${p} should be stripped`).toBeUndefined();
      expect(
        resolveDevAgentGate(getConfigByPath(cfg, p) as boolean | undefined, cfg as { developmentAgent?: boolean }),
        `${p} should now resolve live on the dev agent`,
      ).toBe(true);
    }

    // The 3 D4-held exclusions: NEVER touched → still persisted false → still DARK.
    for (const p of [
      'monitoring.correctionLearning.enabled',
      'monitoring.apprenticeshipCycleSla.enabled',
      'monitoring.geminiCapacityEscalation.enabled',
    ]) {
      expect(getConfigByPath(cfg, p), `${p} must be left untouched`).toBe(false);
    }

    // The stripped set is reported (round-3 visibility finding), naming all 4 paths.
    const line = result.upgraded.find((u) => u.includes('dev-gate-teeth'));
    expect(line).toBeTruthy();
    for (const p of GATED_PATHS) expect(line!).toContain(p);
  });

  it('fleet agent: no-op (the dark default is correct for the fleet); marker NOT set so a later promotion can still run once', () => {
    writeConfig({ monitoring: fullStaleMonitoring() }); // developmentAgent absent
    const result = runMigration();
    const cfg = readConfig();
    for (const p of GATED_PATHS) {
      expect(getConfigByPath(cfg, p), `${p} must stay false on the fleet`).toBe(false);
    }
    expect(result.upgraded.length).toBe(0);
    expect(result.skipped.some((s) => s.includes('not a development agent'))).toBe(true);
    expect((cfg._instar_migrations as string[] | undefined) ?? []).not.toContainEqual(
      expect.stringContaining('dev-gate-teeth-strip'),
    );
  });

  it('dev agent: NEVER strips an EXPLICIT operator `true` (only literal `false` is stripped)', () => {
    writeConfig({
      developmentAgent: true,
      monitoring: {
        parallelWorkSentinel: { enabled: true },
        failureLearning: { enabled: true },
        releaseReadiness: { enabled: false }, // a stale false — this one IS stripped
        bootHealthBeacon: { enabled: true },
      },
    });
    runMigration();
    const cfg = readConfig();
    expect(getConfigByPath(cfg, 'monitoring.parallelWorkSentinel.enabled')).toBe(true);
    expect(getConfigByPath(cfg, 'monitoring.failureLearning.enabled')).toBe(true);
    expect(getConfigByPath(cfg, 'monitoring.bootHealthBeacon.enabled')).toBe(true);
    expect(getConfigByPath(cfg, 'monitoring.releaseReadiness.enabled')).toBeUndefined();
  });

  it('idempotent: a re-added operator `false` is NOT re-stripped after the marker is set', () => {
    writeConfig({ developmentAgent: true, monitoring: { parallelWorkSentinel: { enabled: false } } });
    runMigration(); // strips + sets marker
    expect(getConfigByPath(readConfig(), 'monitoring.parallelWorkSentinel.enabled')).toBeUndefined();
    // Operator deliberately re-adds false later.
    const cfg = readConfig();
    (cfg.monitoring as Record<string, any>).parallelWorkSentinel.enabled = false;
    writeConfig(cfg);
    const result2 = runMigration();
    expect(getConfigByPath(readConfig(), 'monitoring.parallelWorkSentinel.enabled')).toBe(false);
    expect(result2.skipped.some((s) => s.includes('already migrated'))).toBe(true);
  });

  it('dev agent with absent/partial monitoring block: safe no-op (no throw)', () => {
    writeConfig({ developmentAgent: true }); // no monitoring block at all
    const result = runMigration();
    expect(result.errors.length).toBe(0);
    // Marker still set (runs once); nothing to strip.
    expect(result.skipped.some((s) => s.includes('no default-shaped false to strip'))).toBe(true);
  });

  it('no config.json: skips cleanly without error', () => {
    const result = runMigration();
    expect(result.errors.length).toBe(0);
    expect(result.skipped.some((s) => s.includes('config.json not found'))).toBe(true);
  });

  it('corrupt config.json: reports an error and preserves bytes', () => {
    fs.writeFileSync(configPath(), '{ not valid json');
    const result = runMigration();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe('{ not valid json');
  });
});
