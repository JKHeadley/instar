/**
 * Verifies HONEST-PROGRESS-MESSAGING D (Config surface + migration parity):
 *   1. PostUpdateMigrator.migrateHonestProgressMessagingDefaults — the
 *      existence-checked, audited, idempotent backfill that surfaces the five
 *      operator-tunable/rollback keys into a DEPLOYED agent's config.json at the
 *      paths the runtime actually reads (`monitoring.activeWorkSilenceSentinel.*`
 *      and TOP-LEVEL `promiseBeacon.*`).
 *   2. ConfigDefaults carries the same keys as the single source of truth (so a
 *      freshly-initialized agent gets them via applyDefaults).
 *   3. migrateClaudeMd appends the honest-progress-messaging awareness section.
 *
 * Covers both sides of every boundary: fresh backfill, operator-override
 * preservation (incl. the `suppressUnchangedHeartbeats:false` rollback), the
 * run-once marker, no-config skip, corrupt-config error with bytes preserved,
 * and CLAUDE.md append + idempotency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getInitDefaults } from '../../src/config/ConfigDefaults.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — honest-progress-messaging defaults (D)', () => {
  let projectDir: string;
  let stateDir: string;

  const configPath = () => path.join(stateDir, 'config.json');
  const writeConfig = (cfg: Record<string, unknown>) => fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  const readConfig = (): Record<string, any> => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

  function runMigration(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
    });
    (migrator as unknown as { migrateHonestProgressMessagingDefaults(r: MigrationResult): void })
      .migrateHonestProgressMessagingDefaults(result);
    return result;
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-mig-'));
    stateDir = projectDir;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-honestProgressMessaging.test.ts' });
  });

  it('ConfigDefaults is the SSOT — carries all five keys at the runtime-read paths', () => {
    const defaults = getInitDefaults('standalone') as any;
    const silence = defaults.monitoring.activeWorkSilenceSentinel;
    expect(silence.silenceThresholdMs).toBe(1_800_000);
    expect(silence.activeWorkMaxFrozenIndicatorMs).toBe(5_400_000);
    const beacon = defaults.promiseBeacon;
    expect(beacon.suppressUnchangedHeartbeats).toBe(true);
    expect(beacon.beaconLivenessIntervalMs).toBe(3_600_000);
    expect(beacon.turnFinishedCloseoutChecks).toBe(3);
  });

  it('fresh agent: backfills all five keys at the correct paths + records upgraded + sets marker', () => {
    writeConfig({ developmentAgent: true });
    const result = runMigration();
    const cfg = readConfig();
    expect(cfg.monitoring.activeWorkSilenceSentinel.silenceThresholdMs).toBe(1_800_000);
    expect(cfg.monitoring.activeWorkSilenceSentinel.activeWorkMaxFrozenIndicatorMs).toBe(5_400_000);
    expect(cfg.promiseBeacon.suppressUnchangedHeartbeats).toBe(true);
    expect(cfg.promiseBeacon.beaconLivenessIntervalMs).toBe(3_600_000);
    expect(cfg.promiseBeacon.turnFinishedCloseoutChecks).toBe(3);
    expect(result.upgraded.some(u => u.includes('honest-progress-messaging-defaults'))).toBe(true);
    expect((cfg._instar_migrations as string[]).some(m => m.startsWith('honest-progress-messaging-defaults'))).toBe(true);
  });

  it('preserves operator overrides — incl. the suppressUnchangedHeartbeats:false rollback', () => {
    writeConfig({
      monitoring: { activeWorkSilenceSentinel: { enabled: true, silenceThresholdMs: 900_000 } },
      promiseBeacon: { suppressUnchangedHeartbeats: false, prefix: '⏳' },
    });
    runMigration();
    const cfg = readConfig();
    // Operator-set values untouched...
    expect(cfg.monitoring.activeWorkSilenceSentinel.silenceThresholdMs).toBe(900_000);
    expect(cfg.promiseBeacon.suppressUnchangedHeartbeats).toBe(false);
    expect(cfg.promiseBeacon.prefix).toBe('⏳');
    // ...missing siblings still backfilled.
    expect(cfg.monitoring.activeWorkSilenceSentinel.activeWorkMaxFrozenIndicatorMs).toBe(5_400_000);
    expect(cfg.promiseBeacon.beaconLivenessIntervalMs).toBe(3_600_000);
    expect(cfg.promiseBeacon.turnFinishedCloseoutChecks).toBe(3);
  });

  it('idempotent: a re-added operator value is NOT overwritten after the marker is set', () => {
    writeConfig({});
    runMigration(); // backfills + sets marker
    const cfg = readConfig();
    cfg.promiseBeacon.suppressUnchangedHeartbeats = false; // operator later opts out
    writeConfig(cfg);
    const result2 = runMigration();
    expect(readConfig().promiseBeacon.suppressUnchangedHeartbeats).toBe(false);
    expect(result2.skipped.some(s => s.includes('already migrated'))).toBe(true);
  });

  it('no config.json: skips cleanly without error', () => {
    const result = runMigration();
    expect(result.errors.length).toBe(0);
    expect(result.skipped.some(s => s.includes('config.json not found'))).toBe(true);
  });

  it('corrupt config.json: reports an error and preserves bytes', () => {
    fs.writeFileSync(configPath(), '{ not valid json');
    const result = runMigration();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe('{ not valid json');
  });

  it('migrateClaudeMd appends the honest-progress-messaging awareness section (idempotent)', () => {
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting content.\n');
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Honest progress messaging (silent-freeze watchdog + promise beacon)');
    expect(after).toContain('suppressUnchangedHeartbeats');
    // Idempotent: running again does not duplicate the section.
    (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    const occurrences = after2.split('Honest progress messaging (silent-freeze watchdog + promise beacon)').length - 1;
    expect(occurrences).toBe(1);
  });
});
