/**
 * Built-in hook commands must be anchored on ${CLAUDE_PROJECT_DIR}.
 *
 * Bug (2026-09-29, Mac Studio, echo): a session whose working directory was a
 * subdirectory of the agent home (`.instar/lanes/pipeline`) hit MODULE_NOT_FOUND
 * / "No such file" on every tool call and stop. Claude Code runs a hook command
 * from the session's cwd, so `node .instar/hooks/instar/hook-event-reporter.js`
 * resolved against the subdirectory. The hook-event reporter, topic context,
 * external-operation gate and permission auto-approve silently never ran.
 *
 * Covers: fresh-install templates (both sides), the init-generated settings,
 * and the migrateSettings() rewrite for deployed agents (runs once, then no-op;
 * custom hooks untouched).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpHookSettings } from '../../src/data/http-hook-templates.js';
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
type Settings = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

const BARE = /^(node|bash|sh)\s+(\.\/)?\.instar\//;

function allCommands(settings: Settings): string[] {
  const out: string[] = [];
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) if (typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

describe('hook commands are anchored on ${CLAUDE_PROJECT_DIR} — templates', () => {
  it('the hook-event reporter templates carry no bare relative command', () => {
    const cmds = allCommands({ hooks: buildHttpHookSettings('http://localhost:4040') as Settings['hooks'] });
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.filter(c => BARE.test(c))).toEqual([]);
    expect(cmds.every(c => c.startsWith('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/'))).toBe(true);
  });

  it('settings-template.json carries no bare relative command', () => {
    const tpl = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/settings-template.json'), 'utf8'));
    const cmds = allCommands(tpl);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.filter(c => BARE.test(c))).toEqual([]);
  });

  it('the detector does flag the bare form (the check is live)', () => {
    expect(BARE.test('node .instar/hooks/instar/hook-event-reporter.js')).toBe(true);
    expect(BARE.test('bash .instar/hooks/instar/session-start.sh')).toBe(true);
    expect(BARE.test('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js')).toBe(false);
  });
});

describe('hook commands are anchored on ${CLAUDE_PROJECT_DIR} — generated + migrated settings', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-anchor-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 4042 }));
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/hook-command-project-dir-anchor.test.ts' });
  });

  function migrateSettings(): MigrationResult {
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
    return result;
  }

  it('init-generated settings contain no built-in hook command starting with node .instar/ or bash .instar/', () => {
    refreshHooksAndSettings(projectDir, path.join(projectDir, '.instar'));
    const cmds = allCommands(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    expect(cmds.some(c => c.includes('hook-event-reporter.js'))).toBe(true);
    expect(cmds.filter(c => BARE.test(c))).toEqual([]);
  });

  it('rewrites the old bare form once; a second run changes nothing; custom hooks untouched', () => {
    const custom = 'node .instar/hooks/custom/my-guard.js';
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'mcp__.*', hooks: [{ type: 'command', command: 'node .instar/hooks/instar/external-operation-gate.js', timeout: 5000 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: custom }] },
        ],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/session-start.sh', timeout: 5 }] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/telegram-topic-context.sh' }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash .instar/hooks/instar/build-stop-hook.sh', timeout: 10000 }] }],
        PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: 'node .instar/hooks/instar/auto-approve-permissions.js', timeout: 5000 }] }],
      },
      cleanupPeriodDays: 14,
    }, null, 2));

    const first = migrateSettings();
    expect(first.errors).toEqual([]);
    expect(first.upgraded.some(u => u.includes('anchored'))).toBe(true);
    const afterFirst = fs.readFileSync(settingsPath, 'utf8');
    const cmds = allCommands(JSON.parse(afterFirst));
    expect(cmds.filter(c => BARE.test(c) && !c.includes('/custom/'))).toEqual([]);
    expect(cmds).toContain('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/external-operation-gate.js');
    expect(cmds).toContain('bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/build-stop-hook.sh');
    expect(cmds).toContain('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/auto-approve-permissions.js');
    expect(cmds).toContain(custom);

    const second = migrateSettings();
    expect(second.upgraded.some(u => u.includes('anchored'))).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });

  it('validateHookReferences still checks anchored commands against disk', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/missing-hook.sh' }] }] },
    }));
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    migrator.validateHookReferences(path.join(projectDir, '.instar', 'hooks'), result);
    expect(result.errors.some(e => e.includes('missing-hook.sh'))).toBe(true);
  });
});
