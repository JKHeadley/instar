/**
 * Verifies PostUpdateMigrator backfills the Slice-2 Preferences dashboard tab
 * awareness line into existing agents on update (Migration Parity Standard).
 *
 * New agents get the line via generateClaudeMd; existing agents (which already
 * have the Slice-1a/1b correction section but NOT the dashboard tab line) only
 * get it through migrateClaudeMd. Proves it at runtime + that it is idempotent.
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

describe('PostUpdateMigrator — Preferences dashboard tab CLAUDE.md backfill (Slice 2)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-prefdashtab-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-preferencesDashboardTab.test.ts:cleanup',
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

  // A CLAUDE.md that already has the Slice-1a/1b section (so the first migrate
  // branch is satisfied) but lacks the Slice-2 dashboard-tab line.
  const SLICE1_CLAUDE_MD =
    '# CLAUDE.md\n\n' +
    '## Preferences I\'ve learned about you (Correction & Preference Learning Sentinel)\n\n' +
    'When you correct me the same way repeatedly the loop turns it into a durable preference.\n' +
    '- See them: curl /corrections (deduped, scrubbed).\n';

  it('adds the dashboard-tab line when the section exists without it', () => {
    fs.writeFileSync(claudeMdPath, SLICE1_CLAUDE_MD);
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Preferences dashboard tab');
    expect(result.upgraded.some((u) => u.includes('Preferences dashboard tab'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the line', () => {
    fs.writeFileSync(claudeMdPath, SLICE1_CLAUDE_MD);
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
    const occurrences = after2.split('Preferences dashboard tab').length - 1;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('Preferences dashboard tab'))).toBe(false);
  });

  it('a fresh CLAUDE.md gets BOTH the Slice-1a section AND the dashboard-tab line', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Correction & Preference Learning Sentinel');
    expect(content).toContain('Preferences dashboard tab');
  });
});
