/**
 * Verifies the PostUpdateMigrator seeds a parity-sentinel trust profile
 * entry on update so existing agents preserve mirror-trust remediation
 * once FrameworkParitySentinel.shouldRemediate is wired to AdaptiveTrust.
 *
 * AdaptiveTrust's DEFAULT_TRUST for 'modify' is 'approve-always' which
 * would silently turn every mirror-trust rule into flag-only for deployed
 * agents on the v1.0.10 upgrade. Seeding the entry at level=log preserves
 * the v0.1 remediate-by-default behavior with the new auto-elevatable
 * audit trail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runParityMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateParitySentinelTrust(r: MigrationResult): void }).migrateParitySentinelTrust(result);
  return result;
}

describe('PostUpdateMigrator — parity-sentinel trust profile seed', () => {
  let projectDir: string;
  let configPath: string;
  let trustProfilePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-parity-trust-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
    trustProfilePath = path.join(projectDir, '.instar', 'state', 'trust-profile.json');
    fs.writeFileSync(configPath, JSON.stringify({}));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-paritySentinelTrust.test.ts:50' });
  });

  it('seeds parity-sentinel entry when trust-profile.json is missing', () => {
    expect(fs.existsSync(trustProfilePath)).toBe(false);

    const result = runParityMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(trustProfilePath)).toBe(true);

    const profile = JSON.parse(fs.readFileSync(trustProfilePath, 'utf-8'));
    expect(profile.services['parity-sentinel']).toBeDefined();
    expect(profile.services['parity-sentinel'].operations.modify.level).toBe('log');
    expect(profile.services['parity-sentinel'].operations.modify.source).toBe('default');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect((config._instar_migrations as string[]).some(m => m.startsWith('parity-sentinel-trust-seed'))).toBe(true);
  });

  it('preserves existing parity-sentinel entry (never overwrites operator config)', () => {
    fs.mkdirSync(path.dirname(trustProfilePath), { recursive: true });
    const existing = {
      services: {
        'parity-sentinel': {
          service: 'parity-sentinel',
          operations: {
            modify: { level: 'autonomous', source: 'user-explicit', changedAt: '2026-01-01T00:00:00Z' },
          },
          history: { successCount: 42, incidentCount: 0, streakSinceIncident: 42 },
        },
      },
      global: { maturity: 0.5, lastEvent: '', lastEventAt: '2026-01-01T00:00:00Z', floor: 'collaborative' },
    };
    fs.writeFileSync(trustProfilePath, JSON.stringify(existing));

    const result = runParityMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const profile = JSON.parse(fs.readFileSync(trustProfilePath, 'utf-8'));
    // Existing autonomous level preserved.
    expect(profile.services['parity-sentinel'].operations.modify.level).toBe('autonomous');
    expect(profile.services['parity-sentinel'].operations.modify.source).toBe('user-explicit');
    expect(profile.services['parity-sentinel'].history.successCount).toBe(42);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect((config._instar_migrations as string[]).some(m => m.includes('existing-entry-preserved'))).toBe(true);
  });

  it('is idempotent — second run is a no-op via the migration marker', () => {
    runParityMigration(newMigrator(projectDir));
    const result2 = runParityMigration(newMigrator(projectDir));

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded).toEqual([]);
    expect(result2.skipped.some(s => s.includes('already migrated'))).toBe(true);

    // Trust profile entry stays put.
    const profile = JSON.parse(fs.readFileSync(trustProfilePath, 'utf-8'));
    expect(profile.services['parity-sentinel'].operations.modify.level).toBe('log');
  });

  it('preserves existing services in trust-profile.json (additive, not destructive)', () => {
    fs.mkdirSync(path.dirname(trustProfilePath), { recursive: true });
    const existing = {
      services: {
        'gmail': {
          service: 'gmail',
          operations: {
            modify: { level: 'approve-always', source: 'default', changedAt: '2026-01-01T00:00:00Z' },
          },
          history: { successCount: 0, incidentCount: 0, streakSinceIncident: 0 },
        },
      },
      global: { maturity: 0, lastEvent: '', lastEventAt: '2026-01-01T00:00:00Z', floor: 'collaborative' },
    };
    fs.writeFileSync(trustProfilePath, JSON.stringify(existing));

    runParityMigration(newMigrator(projectDir));

    const profile = JSON.parse(fs.readFileSync(trustProfilePath, 'utf-8'));
    expect(profile.services['gmail']).toBeDefined(); // not destroyed
    expect(profile.services['gmail'].operations.modify.level).toBe('approve-always');
    expect(profile.services['parity-sentinel']).toBeDefined(); // newly added
  });

  it('records migration marker in config._instar_migrations', () => {
    runParityMigration(newMigrator(projectDir));

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const migrations = config._instar_migrations as string[];
    expect(migrations).toBeDefined();
    expect(migrations.some(m => m.startsWith('parity-sentinel-trust-seed'))).toBe(true);
  });

  it('skips gracefully when config.json is missing', () => {
    SafeFsExecutor.safeRmSync(configPath, { operation: 'tests/unit/PostUpdateMigrator-paritySentinelTrust.test.ts:149' });

    const result = runParityMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('config.json not found'))).toBe(true);
    expect(fs.existsSync(trustProfilePath)).toBe(false);
  });
});
