import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  installCodexHooks,
  buildInstarCodexHookGroups,
  INSTAR_HOOK_PATH_MARKER,
} from '../../src/core/installCodexHooks.js';

describe('installCodexHooks', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/installCodexHooks.test.ts:cleanup',
    });
  });

  const read = () =>
    JSON.parse(fs.readFileSync(path.join(projectDir, '.codex', 'hooks.json'), 'utf-8'));

  it('writes per-project <projectDir>/.codex/hooks.json, never the global ~/.codex', () => {
    const written = installCodexHooks(projectDir);
    expect(written).toBe(path.join(projectDir, '.codex', 'hooks.json'));
    expect(fs.existsSync(written)).toBe(true);
    // Must not be the operator's global Codex root.
    expect(written.startsWith(path.join(os.homedir(), '.codex'))).toBe(false);
  });

  it('registers all five gate events with the verified Codex schema', () => {
    installCodexHooks(projectDir);
    const cfg = read();
    for (const event of ['PreToolUse', 'PermissionRequest', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      expect(cfg.hooks[event], `missing event ${event}`).toBeDefined();
      const group = cfg.hooks[event][0];
      expect(group).toHaveProperty('matcher');
      expect(Array.isArray(group.hooks)).toBe(true);
      expect(group.hooks[0]).toMatchObject({ type: 'command' });
      expect(typeof group.hooks[0].command).toBe('string');
    }
  });

  it('uses absolute script paths under .instar/hooks/instar/ (cwd-independent)', () => {
    installCodexHooks(projectDir);
    const cfg = read();
    const allCommands = Object.values(cfg.hooks)
      .flat()
      .flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(allCommands.length).toBeGreaterThan(0);
    for (const cmd of allCommands) {
      expect(cmd).toContain(path.join(projectDir, INSTAR_HOOK_PATH_MARKER));
    }
    // The external-operation gate is wired into both PreToolUse and PermissionRequest.
    expect(cfg.hooks.PreToolUse[0].hooks.some((h: any) => h.command.includes('external-operation-gate.js'))).toBe(true);
    expect(cfg.hooks.PermissionRequest[0].hooks.some((h: any) => h.command.includes('external-operation-gate.js'))).toBe(true);
    // The shell-safety gate MUST be in PreToolUse — Codex's native shell/exec/apply_patch
    // are the main destructive surface and external-operation-gate only covers mcp__*.
    expect(cfg.hooks.PreToolUse[0].hooks.some((h: any) => h.command.includes('dangerous-command-guard.sh'))).toBe(true);
  });

  it("uses '.*' as the tool-call matcher, NOT '*' (regression: a bare '*' is an invalid regex that matches nothing, so the gate silently never fires)", () => {
    installCodexHooks(projectDir);
    const cfg = read();
    // Verified live 2026-05-24: with matcher '.*' the dangerous-command-guard fires
    // on Codex's exec_command tool and blocks `rm -rf /`; with '*' or '' it did not
    // fire at all. Codex treats matcher as a regex against the tool name.
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(cfg.hooks.PermissionRequest[0].matcher).toBe('.*');
  });

  it('is idempotent — running twice yields identical config (no duplicate instar groups)', () => {
    installCodexHooks(projectDir);
    const first = fs.readFileSync(path.join(projectDir, '.codex', 'hooks.json'), 'utf-8');
    installCodexHooks(projectDir);
    const second = fs.readFileSync(path.join(projectDir, '.codex', 'hooks.json'), 'utf-8');
    expect(second).toBe(first);
    const cfg = read();
    // exactly one instar group per event, not stacked
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
  });

  it('preserves user-added Codex hooks and replaces only instar-owned entries', () => {
    const codexDir = path.join(projectDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const userHook = {
      hooks: {
        PreToolUse: [
          { matcher: '^git$', hooks: [{ type: 'command', command: 'node /home/user/my-own-hook.js' }] },
        ],
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo user-postool' }] },
        ],
      },
    };
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify(userHook));

    installCodexHooks(projectDir);
    const cfg = read();

    // User's PreToolUse group survives alongside the instar group.
    const preCommands = cfg.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(preCommands).toContain('node /home/user/my-own-hook.js');
    expect(preCommands.some((c: string) => c.includes('external-operation-gate.js'))).toBe(true);
    // User's untouched event is preserved verbatim.
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe('echo user-postool');

    // Re-running still only keeps ONE instar PreToolUse group (no accumulation).
    installCodexHooks(projectDir);
    const cfg2 = read();
    const instarGroups = cfg2.hooks.PreToolUse.filter((g: any) =>
      g.hooks.some((h: any) => h.command.includes(INSTAR_HOOK_PATH_MARKER)),
    );
    expect(instarGroups).toHaveLength(1);
    // and the user hook is STILL there.
    expect(cfg2.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command)))
      .toContain('node /home/user/my-own-hook.js');
  });

  it('buildInstarCodexHookGroups is a pure function of projectDir', () => {
    const a = buildInstarCodexHookGroups('/tmp/agentA');
    const b = buildInstarCodexHookGroups('/tmp/agentB');
    expect(a.PreToolUse[0].hooks[0].command).toContain('/tmp/agentA/');
    expect(b.PreToolUse[0].hooks[0].command).toContain('/tmp/agentB/');
  });
});
