/**
 * Verifies PostUpdateMigrator backfills the "Applying config & hook changes to
 * running sessions" CLAUDE.md section into existing agents on update
 * (Migration Parity Standard).
 *
 * New agents get the section via generateClaudeMd; existing agents only get it
 * through migrateClaudeMd. This proves it at runtime and that it's idempotent.
 * The section is the awareness surface for POST /sessions/restart-all (and the
 * existing /sessions/refresh) — without it, an agent doesn't know that a config
 * or hook change requires restarting running sessions to take effect.
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

const MARKER = 'Applying config & hook changes to running sessions';

describe('PostUpdateMigrator — apply-config-to-running-sessions CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-applyconfig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-applyConfigToRunningSessions.test.ts:cleanup',
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

  it('adds the section (with restart-all + refresh endpoints) when CLAUDE.md lacks it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain(`**${MARKER}**`);
    expect(content).toContain('/sessions/restart-all');
    expect(content).toContain('/sessions/refresh');
    // Uses the configured port (4042), not a hardcoded 4040.
    expect(content).toContain('http://localhost:4042/sessions/restart-all');
    expect(result.upgraded.some((u) => u.includes('applying config & hook changes'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
    const occurrences = after2.split(`**${MARKER}**`).length - 1;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('applying config & hook changes'))).toBe(false);
  });
});
