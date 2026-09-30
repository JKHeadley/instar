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
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { INSTAR_BASH_PRETOOLUSE_HOOKS, INSTAR_WILDCARD_PRETOOLUSE_HOOKS } from '../../src/core/instarSettingsHooks.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
type Settings = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };

const BARE = /^(node|bash|sh)\s+(\.\/)?\.instar\//;
// Anchored but unquoted: a home path with a space splits into two words.
const UNQUOTED = /^(node|bash|sh)\s+\$\{CLAUDE_PROJECT_DIR\}/;
const QUOTED_PREFIX = /^(node|bash|sh) "\$\{CLAUDE_PROJECT_DIR\}\/[^"\s]+"/;

/**
 * Run each command the way Claude Code does (a shell, cwd = the session's
 * directory, CLAUDE_PROJECT_DIR = the agent home) against stub scripts, from a
 * subdirectory of a home whose path contains a space.
 */
function runFromSpacedHomeSubdir(cmds: string[]): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-anchor-run-'));
  const home = path.join(root, 'Agent Home');
  const sub = path.join(home, '.instar', 'lanes', 'pipeline');
  fs.mkdirSync(sub, { recursive: true });
  const failures: string[] = [];
  try {
    for (const cmd of cmds) {
      const rel = cmd.match(/\$\{CLAUDE_PROJECT_DIR\}\/([^"\s]+)/)?.[1];
      if (!rel) { failures.push(`no project-dir path: ${cmd}`); continue; }
      const script = path.join(home, rel);
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, script.endsWith('.sh') ? 'echo hook-ran\n' : "console.log('hook-ran');\n");
      try {
        const out = execFileSync('/bin/sh', ['-c', cmd], {
          cwd: sub, env: { ...process.env, CLAUDE_PROJECT_DIR: home }, input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!out.includes('hook-ran')) failures.push(`no output: ${cmd}`);
      } catch (err) {
        failures.push(`${cmd}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  } finally {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/hook-command-project-dir-anchor.test.ts' });
  }
  return failures;
}

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
    expect(cmds.every(c => c.startsWith('node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/'))).toBe(true);
    expect(runFromSpacedHomeSubdir(cmds)).toEqual([]);
  });

  it('settings-template.json carries no bare relative command', () => {
    const tpl = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/settings-template.json'), 'utf8'));
    const cmds = allCommands(tpl);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.filter(c => BARE.test(c) || UNQUOTED.test(c))).toEqual([]);
    expect(runFromSpacedHomeSubdir(cmds)).toEqual([]);
  });

  it('the shared PreToolUse hook entries are quoted and run from a spaced home subdirectory', () => {
    const cmds = [...INSTAR_BASH_PRETOOLUSE_HOOKS, ...INSTAR_WILDCARD_PRETOOLUSE_HOOKS].map(h => h.command);
    expect(cmds.every(c => QUOTED_PREFIX.test(c))).toBe(true);
    expect(runFromSpacedHomeSubdir(cmds)).toEqual([]);
  });

  it('the unquoted anchored form really does break in a spaced home (the run check is live)', () => {
    expect(runFromSpacedHomeSubdir(['node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/x.js'])).toHaveLength(1);
    expect(runFromSpacedHomeSubdir(['node .instar/hooks/instar/x.js'])).toHaveLength(1);
    expect(runFromSpacedHomeSubdir(['node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/x.js"'])).toEqual([]);
  });

  it('the detector does flag the bare form (the check is live)', () => {
    expect(BARE.test('node .instar/hooks/instar/hook-event-reporter.js')).toBe(true);
    expect(BARE.test('bash .instar/hooks/instar/session-start.sh')).toBe(true);
    expect(BARE.test('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js')).toBe(false);
    expect(UNQUOTED.test('node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js')).toBe(true);
    expect(UNQUOTED.test('node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"')).toBe(false);
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
    expect(cmds.filter(c => BARE.test(c) || UNQUOTED.test(c))).toEqual([]);
    expect(runFromSpacedHomeSubdir(cmds.filter(c => c.includes('${CLAUDE_PROJECT_DIR}')))).toEqual([]);
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
    expect(cmds).toContain('node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/external-operation-gate.js"');
    expect(cmds).toContain('bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/build-stop-hook.sh"');
    expect(cmds).toContain('node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/auto-approve-permissions.js"');
    expect(cmds).toContain(custom);
    expect(cmds.filter(c => UNQUOTED.test(c))).toEqual([]);

    const second = migrateSettings();
    expect(second.upgraded.some(u => u.includes('anchored'))).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });

  it('quotes the round-1 unquoted anchored form, keeps arguments, never double-prefixes, leaves custom hooks alone', () => {
    const customAnchored = 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/custom/my-guard.js';
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [
            { type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/dangerous-command-guard.sh "$TOOL_INPUT"', blocking: true },
            { type: 'command', command: 'bash .instar/hooks/instar/grounding-before-messaging.sh "$TOOL_INPUT"' },
            { type: 'command', command: customAnchored },
          ] },
        ],
        Stop: [{ matcher: '', hooks: [
          { type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh', timeout: 10000 },
        ] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 }] }],
      },
      cleanupPeriodDays: 14,
    }, null, 2));

    const first = migrateSettings();
    expect(first.errors).toEqual([]);
    const afterFirst = fs.readFileSync(settingsPath, 'utf8');
    const cmds = allCommands(JSON.parse(afterFirst));
    expect(cmds).toContain('bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/dangerous-command-guard.sh" "$TOOL_INPUT"');
    expect(cmds).toContain('bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/grounding-before-messaging.sh" "$TOOL_INPUT"');
    expect(cmds).toContain('bash "${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh"');
    expect(cmds).toContain('node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"');
    expect(cmds).toContain(customAnchored);
    expect(cmds.filter(c => (c.match(/CLAUDE_PROJECT_DIR/g) ?? []).length > 1)).toEqual([]);
    expect(cmds.filter(c => UNQUOTED.test(c) && !c.includes('/custom/'))).toEqual([]);

    const second = migrateSettings();
    expect(second.upgraded.some(u => u.includes('anchored'))).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(afterFirst);
  });

  it('validateHookReferences checks quoted anchored commands against disk', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/missing-quoted.sh"' }] }] },
    }));
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    migrator.validateHookReferences(path.join(projectDir, '.instar', 'hooks'), result);
    expect(result.errors.some(e => e.includes('missing-quoted.sh') && !e.includes('"'))).toBe(true);
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

describe('slack-channel-context.sh reads config from any agent home path', () => {
  it("reads port, token and agent id when the home path has an apostrophe and a space, from a subdirectory", async () => {
    const http = await import('node:http');
    const { execFile } = await import('node:child_process');
    const seen: Array<{ url?: string; auth?: string; agent?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, agent: req.headers['x-instar-agentid'] as string | undefined });
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/health' ? '{"status":"ok"}' : '{"messages":[{"user":"u","text":"hi","ts":"1"}]}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ctx-'));
    const home = path.join(root, "Justin's Agent Home");
    const sub = path.join(home, '.instar', 'lanes', 'pipeline');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ port, authToken: 'tok-from-config', projectName: 'agent-from-config' }));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: home };
      delete env.INSTAR_PORT; delete env.INSTAR_AUTH_TOKEN; delete env.INSTAR_AGENT_ID;
      const hook = path.resolve(__dirname, '../../src/templates/hooks/slack-channel-context.sh');
      await new Promise<void>((resolve, reject) => {
        const child = execFile('bash', [hook], { cwd: sub, env }, err => (err ? reject(err) : resolve()));
        child.stdin?.end(JSON.stringify({ userMessage: '[slack:C123] hello' }));
      });
      const fetch = seen.find(s => s.url?.startsWith('/slack/channels/C123/messages'));
      expect(fetch).toBeDefined();
      expect(fetch?.auth).toBe('Bearer tok-from-config');
      expect(fetch?.agent).toBe('agent-from-config');
    } finally {
      server.close();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/hook-command-project-dir-anchor.test.ts' });
    }
  });
});
