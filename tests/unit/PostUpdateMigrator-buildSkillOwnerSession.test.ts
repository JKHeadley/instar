/**
 * ACT-155 fast-follow to BUILD-STOP-HOOK-SESSION-SCOPING: the /build skill must
 * pass --owner-session at init so the stop-hook can scope by Claude session UUID
 * (on top of the load-bearing tmux scoping). installBuildSkill is
 * install-if-missing, so deployed agents need this migration to pick up the flag.
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
    projectDir, stateDir: path.join(projectDir, '.instar'),
    port: 4042, hasTelegram: false, projectName: 'test',
  });
}

function runOwnerSessionMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateBuildSkillOwnerSession(r: MigrationResult): void })
    .migrateBuildSkillOwnerSession(result);
  return result;
}

describe('PostUpdateMigrator — build SKILL --owner-session', () => {
  let projectDir: string;
  let skillFile: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-build-owner-sess-'));
    const skillDir = path.join(projectDir, '.claude', 'skills', 'build');
    fs.mkdirSync(skillDir, { recursive: true });
    skillFile = path.join(skillDir, 'SKILL.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'PostUpdateMigrator-buildSkillOwnerSession.test.ts' });
  });

  it('appends --owner-session to the init invocation line', () => {
    fs.writeFileSync(skillFile, [
      '## Step 1: Initialize Build',
      '```bash',
      'python3 playbook-scripts/build-state.py init "TASK DESCRIPTION" --size SMALL|STANDARD|LARGE',
      '```',
    ].join('\n'));

    const result = runOwnerSessionMigration(newMigrator(projectDir));

    const updated = fs.readFileSync(skillFile, 'utf8');
    expect(updated).toContain('--owner-session "$CLAUDE_CODE_SESSION_ID"');
    expect(updated).toMatch(/build-state\.py init .* --owner-session "\$CLAUDE_CODE_SESSION_ID"/);
    expect(result.upgraded.some(u => u.includes('--owner-session'))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('is idempotent — a second run makes no further change', () => {
    fs.writeFileSync(skillFile,
      'python3 playbook-scripts/build-state.py init "T" --size SMALL\n');
    runOwnerSessionMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(skillFile, 'utf8');

    const second = runOwnerSessionMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(skillFile, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    // exactly one occurrence of the flag (no double-append)
    expect((afterSecond.match(/--owner-session/g) || []).length).toBe(1);
    expect(second.upgraded).toEqual([]);
  });

  it('no-op when SKILL.md is absent (fresh install handled by installBuildSkill)', () => {
    const result = runOwnerSessionMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
  });

  it('leaves a SKILL.md with no init invocation untouched', () => {
    const content = '## Some customized build skill\nNo init line here.\n';
    fs.writeFileSync(skillFile, content);
    const result = runOwnerSessionMigration(newMigrator(projectDir));
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(content);
    expect(result.upgraded).toEqual([]);
  });

  it('the bundled build SKILL.md already passes --owner-session (new installs)', () => {
    const bundled = path.resolve(__dirname, '../../.claude/skills/build/SKILL.md');
    const content = fs.readFileSync(bundled, 'utf8');
    expect(content).toMatch(/build-state\.py init .* --owner-session "\$CLAUDE_CODE_SESSION_ID"/);
  });
});
