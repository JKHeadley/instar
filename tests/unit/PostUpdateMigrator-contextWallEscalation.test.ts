/**
 * Verifies PostUpdateMigrator adds the Context-wall recovery escalation note
 * (the /compact-before-respawn rung) to CLAUDE.md — fresh installs get it inside
 * the Honest-standby section; agents that already have that section get it
 * appended (Migration Parity).
 *
 * 2026-06-06: recovery now presses /compact for a session stuck at the context
 * wall before the destructive fresh respawn, preserving the conversation.
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

describe('PostUpdateMigrator — Context-wall recovery escalation note', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ctxwall-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-contextWallEscalation.test.ts:cleanup',
    });
  });

  it('fresh install: the note ships inside the Honest-standby section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Honest standby (turn-receipts)');
    expect(after).toContain('Context-wall recovery escalation');
    expect(after).toContain('/compact');
  });

  it('patches an agent that already has the Honest-standby section but not the escalation note', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Honest standby (turn-receipts)\n\nThe standby (🔭) system reports on the session ...\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Context-wall recovery escalation'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Context-wall recovery escalation');
    expect(after.match(/Honest standby \(turn-receipts\)/g)!.length).toBe(1); // not duplicated
  });

  it('is idempotent — a second run skips, content unchanged', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('Context-wall recovery escalation'))).toBe(false);
  });
});
