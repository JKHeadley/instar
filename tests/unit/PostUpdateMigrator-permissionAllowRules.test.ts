/**
 * Verifies the subagent permissions.allow migration: migrateSettings() adds
 * `permissions.allow` rules for the built-in tools that Task/Agent-spawned
 * subagents use, so an unattended autonomous run is never modal-blocked on a
 * tool-approval prompt.
 *
 * Background (2026-06-24, the "session paused" bug): the parent session launches
 * with `--dangerously-skip-permissions`, but a subagent spawned via the
 * Task/Agent tool does NOT inherit the parent's permission MODE — it only
 * inherits the permission RULES from .claude/settings.json. With no allow-rules,
 * the first Bash call a subagent makes hits the interactive approval dialog, and
 * with no human at the keyboard the session sits frozen forever. The fix is an
 * inherited allow-rule (the PermissionRequest auto-approve hook is unreliable for
 * subagent calls). Real safety is unaffected — the PreToolUse guards still run on
 * every call; allow-rules only skip the duplicative human-in-the-loop PROMPT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const EXPECTED_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Task', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
];

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runMigrateSettings(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
  return result;
}

describe('PostUpdateMigrator — subagent permissions.allow rules', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-perm-allow-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-permissionAllowRules.test.ts' });
  });

  function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  function allowList(): string[] {
    const p = readSettings().permissions as Record<string, unknown> | undefined;
    return (p?.allow as string[]) ?? [];
  }

  it('adds permissions.allow rules for all subagent tools when the block is absent', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }, null, 2));

    const result = runMigrateSettings(newMigrator(projectDir));

    const allow = allowList();
    for (const tool of EXPECTED_TOOLS) {
      expect(allow).toContain(tool);
    }
    expect(result.upgraded.some(u => u.includes('permissions.allow'))).toBe(true);
  });

  it('includes Bash — the load-bearing rule that unblocks a wedged subagent', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    runMigrateSettings(newMigrator(projectDir));
    expect(allowList()).toContain('Bash');
  });

  it('does NOT blanket-allow MCP tools (those stay gated by the external-operation-gate)', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    runMigrateSettings(newMigrator(projectDir));
    expect(allowList().some(r => r.startsWith('mcp__'))).toBe(false);
  });

  it('preserves operator-configured allow entries and only adds the missing built-ins', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm run build:*)', 'CustomOperatorTool', 'Bash'] },
      hooks: {},
    }, null, 2));

    runMigrateSettings(newMigrator(projectDir));

    const allow = allowList();
    // operator entries kept
    expect(allow).toContain('Bash(npm run build:*)');
    expect(allow).toContain('CustomOperatorTool');
    // pre-existing 'Bash' not duplicated
    expect(allow.filter(r => r === 'Bash')).toHaveLength(1);
    // the rest added
    expect(allow).toContain('Read');
    expect(allow).toContain('WebSearch');
  });

  it('never touches deny / ask lists the operator configured', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { deny: ['Bash(rm -rf /:*)'], ask: ['WebFetch'] },
      hooks: {},
    }, null, 2));

    runMigrateSettings(newMigrator(projectDir));

    const perms = readSettings().permissions as Record<string, unknown>;
    expect(perms.deny).toEqual(['Bash(rm -rf /:*)']);
    expect(perms.ask).toEqual(['WebFetch']);
    // allow still got populated alongside the untouched deny/ask
    expect((perms.allow as string[])).toContain('Bash');
  });

  it('is idempotent: a second pass makes no further change and does not re-report', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    const migrator = newMigrator(projectDir);

    runMigrateSettings(migrator);
    const after1 = fs.readFileSync(settingsPath, 'utf8');
    const result2 = runMigrateSettings(migrator);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(after1);
    expect(result2.upgraded.some(u => u.includes('permissions.allow'))).toBe(false);
  });
});
