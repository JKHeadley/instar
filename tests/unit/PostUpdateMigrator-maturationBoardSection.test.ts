/**
 * Migration Parity + Agent Awareness for the maturation board
 * (docs/specs/maturation-board.md): existing agents learn GET /maturation/board
 * and the /dashboard/maturation/ page on update, once, and a fresh template
 * carries the same section so it is never double-patched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, MATURATION_BOARD_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = 'Maturation Board — where is every maturing feature';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Maturation Board CLAUDE.md section', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-mb-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-maturationBoardSection.test.ts:cleanup' });
  });

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    expect(run(projectDir).upgraded).toContain('CLAUDE.md: added Maturation Board section');
    run(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content.split(MARKER).length - 1).toBe(1);
    expect(content).toContain('http://localhost:4042/maturation/board?scope=pool');
    expect(content).toContain('/dashboard/maturation/');
    expect(content).toContain('advisory: true');
  });

  it('the shared section carries the marker the migration sniffs', () => {
    expect(MATURATION_BOARD_CLAUDEMD_SECTION(4040)).toContain(MARKER);
  });
});
