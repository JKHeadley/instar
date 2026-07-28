/**
 * Verifies PostUpdateMigrator adds the Cross-Agent Communication Discipline
 * (anti-confabulation) section to existing agents' CLAUDE.md on update.
 *
 * codex-instar audit Item 11. Discovered when codey fabricated an "echo ->
 * instar-codey (ACK)" section in the shared coordination file echo_chat.md
 * AND a "registered ACT-148 in Echo's commitments" claim with no
 * corresponding record on Echo's side. Root cause: no structural guidance
 * preventing the "narrate intentions as completed actions" pattern.
 *
 * This migration adds explicit anti-confabulation guidance to deployed
 * agents' CLAUDE.md so the rule is visible in every session-start context.
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

describe('PostUpdateMigrator — anti-confabulation CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-anticonfab-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-antiConfabulation.test.ts:cleanup',
    });
  });

  it('adds the anti-confabulation section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(
      result.upgraded.some(u => u.includes('Cross-Agent Communication Discipline (anti-confabulation)')),
    ).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Cross-Agent Communication Discipline (anti-confabulation)');
    expect(after).toContain('Never narrate cross-agent work as if it happened');
    expect(after).toContain('Describing a tool call instead of making one');
    expect(after).toContain('Authoring messages in the other agent\'s voice');
    expect(after).toContain('Registering state inside another agent\'s system without an ACK');
    expect(after).toContain('codex-instar audit Item 11');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    // Second run finds the section already present and does NOT add it again.
    expect(
      result2.upgraded.some(u => u.includes('Cross-Agent Communication Discipline (anti-confabulation)')),
    ).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    // Exactly one occurrence of the heading.
    const headingMatches = afterSecond.match(/### Cross-Agent Communication Discipline \(anti-confabulation\)/g);
    expect(headingMatches?.length).toBe(1);
  });

  it('preserves existing CLAUDE.md content above the new section', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nDo not delete this.\n\n## Another Section\n\nAlso important.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
    expect(after.length).toBeGreaterThan(original.length);
  });

  it('does not run when CLAUDE.md is missing (graceful skip)', () => {
    expect(fs.existsSync(claudeMdPath)).toBe(false);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md'))).toBe(true);
  });
});

describe('generateClaudeMd template includes anti-confabulation section', () => {
  it('the source template emits the section so fresh installs get it too', async () => {
    // Source-grep — easier than spinning up generateClaudeMd which needs
    // many config inputs. The migration adds the section to existing
    // CLAUDE.md files; this test verifies the same section is present in
    // the template that produces new CLAUDE.md files.
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain('Cross-Agent Communication Discipline (anti-confabulation)');
    expect(templateSource).toContain('Describing a tool call instead of making one');
    expect(templateSource).toContain('codex-instar audit Item 11');
  });
});
