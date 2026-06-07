/**
 * Verifies the transcript-retention migration: migrateSettings() sets
 * `cleanupPeriodDays` on existing agents' .claude/settings.json so the whole
 * fleet caps Claude Code's transcript pile-up on update.
 *
 * Background (2026-06-07): Claude Code retains chat transcripts under
 * ~/.claude/projects for `cleanupPeriodDays` (default 30 when unset). On a
 * multi-agent fleet every background `claude -p` one-shot (sentinels/gates)
 * writes a transcript, so 30 days accumulates hundreds of thousands of files
 * (observed: ~322k files / 18 GB on one box). instar did not manage this
 * setting at all. The migration sets it to 14 — but ONLY when unset, so an
 * operator's hand-tuned value is never clobbered (Migration-Parity idempotency).
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

function runMigrateSettings(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
  return result;
}

describe('PostUpdateMigrator — cleanupPeriodDays transcript retention', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cleanup-period-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-cleanupPeriodDays.test.ts' });
  });

  function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  it('sets cleanupPeriodDays=14 when the key is absent', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }, null, 2));

    const result = runMigrateSettings(newMigrator(projectDir));

    expect(readSettings().cleanupPeriodDays).toBe(14);
    expect(result.upgraded.some(u => u.includes('cleanupPeriodDays'))).toBe(true);
  });

  it('does NOT override an operator-set value (respects a hand-tuned retention)', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ cleanupPeriodDays: 7, hooks: {} }, null, 2));

    const result = runMigrateSettings(newMigrator(projectDir));

    expect(readSettings().cleanupPeriodDays).toBe(7); // unchanged
    expect(result.upgraded.some(u => u.includes('cleanupPeriodDays'))).toBe(false);
  });

  it('treats an explicit 0 as set (does not overwrite — 0 is a real Claude value meaning "no retention cleanup")', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ cleanupPeriodDays: 0, hooks: {} }, null, 2));

    runMigrateSettings(newMigrator(projectDir));

    expect(readSettings().cleanupPeriodDays).toBe(0); // nullish guard — 0 stays 0
  });

  it('is idempotent: a second pass makes no further change and does not re-report', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    const migrator = newMigrator(projectDir);

    runMigrateSettings(migrator);
    const after1 = fs.readFileSync(settingsPath, 'utf8');
    const result2 = runMigrateSettings(migrator);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(after1);
    expect(result2.upgraded.some(u => u.includes('cleanupPeriodDays'))).toBe(false);
  });
});
