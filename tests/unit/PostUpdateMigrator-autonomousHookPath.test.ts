/**
 * Verifies the autonomous stop-hook REGISTRATION PATH fix.
 *
 * Regression (2026-06-03): an autonomous session went idle between turns —
 * the stop hook never re-engaged the loop. Root cause: the autonomous
 * SKILL.md Step 2a registered the stop hook in settings.json at
 * `bash .instar/hooks/instar/autonomous-stop-hook.sh`, but the hook ships
 * ONLY in the skill dir (`.claude/skills/autonomous/hooks/`) — it is never
 * deployed to `.instar/hooks/instar/`. So every Stop event hit a missing
 * file, failed silently, and the autonomous loop never re-injected the task
 * list. The session looked alive but never self-continued.
 *
 * Fix (two prongs, both tested here):
 *  1. ensureAutonomousStopHook() repairs any wrong-path registration in
 *     settings.json → rewrites the command to the deployed skill path. This
 *     is the Migration-Parity path that heals existing agents on update.
 *     (Without it, the `hasAutonomousHook` presence check treats the
 *     wrong-path entry as "already registered" and never corrects it.)
 *  2. migrateAutonomousStopHookTopicKeyed() re-deploys the fixed SKILL.md
 *     (whose Step 2a now registers the correct path + self-heals) to existing
 *     agents, gated on a marker unique to the fixed prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const CORRECT_CMD = 'bash ${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh';
const WRONG_CMD = 'bash .instar/hooks/instar/autonomous-stop-hook.sh';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

type Hooks = Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>>;

function ensure(migrator: PostUpdateMigrator, hooks: Hooks): { patched: boolean; result: MigrationResult } {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const patched = (migrator as unknown as {
    ensureAutonomousStopHook(h: Hooks, r: MigrationResult): boolean;
  }).ensureAutonomousStopHook(hooks, result);
  return { patched, result };
}

function autonomousCommands(hooks: Hooks): string[] {
  return (hooks.Stop ?? [])
    .flatMap(e => e.hooks ?? [])
    .map(h => h.command ?? '')
    .filter(c => c.includes('autonomous-stop-hook'));
}

describe('PostUpdateMigrator — ensureAutonomousStopHook registration path repair', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autohook-path-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-autonomousHookPath.test.ts' });
  });

  it('rewrites a legacy wrong-path registration to the deployed skill path', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: WRONG_CMD, timeout: 10000 }] },
      ],
    };
    const { patched, result } = ensure(newMigrator(projectDir), hooks);

    const cmds = autonomousCommands(hooks);
    expect(cmds).toEqual([CORRECT_CMD]); // exactly one, at the correct path
    expect(cmds).not.toContain(WRONG_CMD);
    expect(patched).toBe(true);
    expect(result.upgraded.some(u => u.includes('repaired autonomous stop-hook path'))).toBe(true);
  });

  it('does NOT add a duplicate when a wrong-path entry is repaired (no double-registration)', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/stop-gate-router.js' }] },
        { matcher: '', hooks: [{ type: 'command', command: WRONG_CMD, timeout: 10000 }] },
      ],
    };
    ensure(newMigrator(projectDir), hooks);
    // Exactly one autonomous-stop-hook command survives, at the correct path.
    expect(autonomousCommands(hooks)).toEqual([CORRECT_CMD]);
  });

  it('leaves sibling Stop hooks untouched while repairing only the autonomous entry', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/stop-gate-router.js' }] },
        { matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/build-stop-hook.sh' }] },
        { matcher: '', hooks: [{ type: 'command', command: WRONG_CMD, timeout: 10000 }] },
      ],
    };
    ensure(newMigrator(projectDir), hooks);
    const allCmds = (hooks.Stop ?? []).flatMap(e => e.hooks ?? []).map(h => h.command);
    expect(allCmds).toContain('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/stop-gate-router.js');
    expect(allCmds).toContain('bash .instar/hooks/instar/build-stop-hook.sh');
    expect(allCmds).toContain(CORRECT_CMD);
    expect(allCmds).not.toContain(WRONG_CMD);
  });

  it('is a no-op (no repair) when the registration is already the correct skill path', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: CORRECT_CMD, timeout: 10000 }] },
      ],
    };
    const { result } = ensure(newMigrator(projectDir), hooks);
    expect(autonomousCommands(hooks)).toEqual([CORRECT_CMD]);
    expect(result.upgraded.some(u => u.includes('repaired autonomous stop-hook path'))).toBe(false);
  });

  it('registers the correct skill path when no autonomous entry exists yet', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/stop-gate-router.js' }] },
      ],
    };
    ensure(newMigrator(projectDir), hooks);
    expect(autonomousCommands(hooks)).toEqual([CORRECT_CMD]);
  });

  it('is idempotent: a second pass over repaired settings makes no further change', () => {
    const hooks: Hooks = {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: WRONG_CMD, timeout: 10000 }] },
      ],
    };
    const migrator = newMigrator(projectDir);
    ensure(migrator, hooks);
    const after1 = JSON.stringify(hooks);
    const { result: result2 } = ensure(migrator, hooks);
    expect(JSON.stringify(hooks)).toBe(after1);
    expect(result2.upgraded.some(u => u.includes('repaired autonomous stop-hook path'))).toBe(false);
  });
});

describe('autonomous SKILL.md — Step 2a registers the deployed skill path', () => {
  it('the bundled SKILL.md registers the skill-dir path, not .instar/hooks/instar', () => {
    const skillMd = path.resolve(__dirname, '../../.claude/skills/autonomous/SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    // The fixed Step 2a registers the deployed skill path and prints a marker.
    expect(content).toContain('.claude/skills/autonomous/hooks/autonomous-stop-hook.sh');
    expect(content).toContain('Stop hook registered (correct skill path)');
    // The legacy wrong path must not be the registered command anymore.
    expect(content).not.toContain("'command': 'bash .instar/hooks/instar/autonomous-stop-hook.sh'");
  });
});

describe('PostUpdateMigrator — migrateAutonomousStopHookTopicKeyed re-deploys fixed SKILL.md', () => {
  let projectDir: string;
  let skillMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autohook-skillmd-'));
    const skillDir = path.join(projectDir, '.claude', 'skills', 'autonomous');
    fs.mkdirSync(skillDir, { recursive: true });
    skillMd = path.join(skillDir, 'SKILL.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-autonomousHookPath.test.ts:skillmd' });
  });

  function runTopicKeyed(migrator: PostUpdateMigrator): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateAutonomousStopHookTopicKeyed(r: MigrationResult): void }).migrateAutonomousStopHookTopicKeyed(result);
    return result;
  }

  it('re-deploys the SKILL.md when the installed copy lacks the fixed-path marker but is stock', () => {
    // Old deployed SKILL.md: has the stock fingerprint, prints the old plain message.
    fs.writeFileSync(skillMd, [
      '# Autonomous Mode',
      'Completion promise: "ALL_TASKS_COMPLETE"',
      "    print('Stop hook registered')",
      "command': 'bash .instar/hooks/instar/autonomous-stop-hook.sh'",
    ].join('\n'));

    const result = runTopicKeyed(newMigrator(projectDir));

    const after = fs.readFileSync(skillMd, 'utf8');
    expect(after).toContain('Stop hook registered (correct skill path)');
    expect(result.upgraded.some(u => u.includes('SKILL.md'))).toBe(true);
  });

  it('leaves a customized SKILL.md (missing the stock fingerprint) untouched', () => {
    const customized = '# My heavily customized autonomous prompt\nno standard markers here\n';
    fs.writeFileSync(skillMd, customized);

    const result = runTopicKeyed(newMigrator(projectDir));

    expect(fs.readFileSync(skillMd, 'utf8')).toBe(customized);
    expect(result.skipped.some(s => s.includes('SKILL.md') && s.includes('customized'))).toBe(true);
  });
});
