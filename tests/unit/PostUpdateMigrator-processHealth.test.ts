/**
 * Verifies PostUpdateMigrator backfills the Process Health (Dashboard Tab)
 * CLAUDE.md section into existing agents on update (Migration Parity Standard).
 *
 * New agents get the section via generateClaudeMd; existing agents only get it
 * through migrateClaudeMd. This proves it at runtime (the feature-delivery
 * completeness test only checks source-string presence) and that it's idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Process Health dashboard tab CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-processhealth-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-processHealth.test.ts:cleanup',
    });
  });

  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
  }

  it('adds the Process Health section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('**Process Health (Dashboard Tab)**');
    expect(content).toContain('the tab IS the answer surface');
    expect(result.upgraded.some((u) => u.includes('Process Health'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1); // no change on the second pass
    const occurrences = after2.split('**Process Health (Dashboard Tab)**').length - 1;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('Process Health'))).toBe(false);
  });
});
