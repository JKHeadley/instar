/**
 * Verifies PostUpdateMigrator adds the Cold-Start Lifeline Fallback CLAUDE.md
 * section to existing agents on update (Migration Parity + Agent Awareness).
 *
 * Without it, an agent asked "why did I get a message telling me to go to the
 * lifeline?" / "why couldn't this topic start?" has no grounded answer.
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

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Cold-Start Lifeline Fallback CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-coldstart-fallback-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-coldStartFallbackSection.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Cold-Start Lifeline Fallback'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Cold-Start Lifeline Fallback');
    expect(after).toContain('The Agent Is Always Reachable');
    expect(after).toContain('copy-paste');
  });

  it('is idempotent — a second run skips, content unchanged', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('Cold-Start Lifeline Fallback'))).toBe(false);
    expect(second.skipped.some(s => s.includes('Cold-Start Lifeline Fallback'))).toBe(true);
  });
});
