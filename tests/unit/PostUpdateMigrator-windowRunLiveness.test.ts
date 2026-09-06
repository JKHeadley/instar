import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function migrate(projectDir: string): Result {
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'echo' });
  (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
  return result;
}

describe('Window run liveness agent awareness migration', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-windowRunLiveness.test.ts' }); });

  it('keeps new and existing agents in idempotent awareness parity', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-awareness-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    const first = migrate(projectDir);
    const migrated = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(first.upgraded).toContain('CLAUDE.md: added Authoritative Window Run Liveness section');
    expect(migrated).toContain('/window-run-liveness/work-advance');
    expect(migrated).toContain('callers never submit task refs, predicate booleans');
    expect(migrated).toContain('W32 cadence executor:');
    expect(migrated).toContain('/window-run-liveness/cadence/tick');
    const beforeSecond = migrated;
    expect(migrate(projectDir).upgraded).not.toContain('CLAUDE.md: added Authoritative Window Run Liveness section');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(beforeSecond);

    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh).toContain('Authoritative Window Run Liveness');
    expect(fresh).toContain('http://localhost:4042/window-run-liveness');
    expect(fresh).toContain('W32 cadence executor:');
  });

  it('backfills dark exact-cadence defaults without overwriting an operator override', () => {
    const freshTarget = {} as Record<string, unknown>;
    applyDefaults(freshTarget, getMigrationDefaults('managed-project'));
    expect((freshTarget as any).monitoring.windowRunLiveness.cadenceExecutor).toEqual({
      enabled: false, dryRun: true, receiptIntervalMs: 1_800_000, reportIntervalMs: 10_800_000,
      checkpointLeadMs: 300_000, receiptGraceMs: 300_000, reportRetryMaxAttempts: 3, reportRetryBackoffMs: 60_000,
    });

    const target = { monitoring: { windowRunLiveness: { cadenceExecutor: { enabled: true, dryRun: false, receiptGraceMs: 60_000 } } } } as Record<string, unknown>;
    applyDefaults(target, getMigrationDefaults('managed-project'));
    expect((target as any).monitoring.windowRunLiveness.cadenceExecutor).toEqual({
      enabled: true, dryRun: false, receiptGraceMs: 60_000,
      receiptIntervalMs: 1_800_000, reportIntervalMs: 10_800_000, checkpointLeadMs: 300_000,
      reportRetryMaxAttempts: 3, reportRetryBackoffMs: 60_000,
    });
    const before = JSON.stringify(target);
    applyDefaults(target, getMigrationDefaults('managed-project'));
    expect(JSON.stringify(target)).toBe(before);
  });

  it('ships a preparation-aware autonomous setup script gated on live enforcement', () => {
    const script = fs.readFileSync(path.resolve('.claude/skills/autonomous/scripts/setup-autonomous.sh'), 'utf8');
    expect(script).toContain('W32_PREPARING_LIVENESS');
    expect(script).toContain('REG_INITIAL_STATUS');
    expect(script).toContain("raw.get('dryRun',True) is False");
    expect(script).toContain('RUN_ACTIVE="true"');
    expect(script).toContain('RUN_ACTIVE="false"');
    expect(script).toContain('active: $RUN_ACTIVE');
    expect(script).toContain('status: $RUN_STATUS');
  });
});
