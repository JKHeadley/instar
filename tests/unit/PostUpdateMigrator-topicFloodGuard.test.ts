/**
 * Verifies PostUpdateMigrator backfills the Topic-Flood Guard CLAUDE.md section
 * into existing agents on update (Migration Parity + Agent Awareness Standards).
 *
 * The guard itself ships in code (pure src, default-ON) so every fleet agent is
 * PROTECTED on the dist update with no config. This section is the awareness
 * layer: so an agent can answer "why are my notices grouped / where did topic X
 * go?". New agents get it via the first migrateClaudeMd run; this proves it at
 * runtime and that it is idempotent.
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

describe('PostUpdateMigrator — Topic-Flood Guard CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-floodguard-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts:cleanup',
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

  it('adds the Topic-Flood Guard section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Topic-Flood Guard');
    expect(content).toContain('attention-suppressed.jsonl');
    expect(result.upgraded.some((u) => u.includes('Topic-Flood Guard'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
    const occurrences = after2.split('## Topic-Flood Guard (attention queue circuit breaker)').length - 1;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('Topic-Flood Guard'))).toBe(false);
  });
});
