// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SessionManager's confined spawn for the feedback executor (docs/specs/feedback-triage-and-execution.md
 * §4 step 4): `cwd` limited to <projectDir>/.worktrees/, `omitAuthEnv` (no Instar token, no origin/bind/
 * fencing token, no vault GitHub token, every credential-shaped variable blanked), and the claude-code
 * confinement adapter (the policy --settings file loaded with only the `local` source, `dontAsk` instead
 * of `--dangerously-skip-permissions`, file and shell tools only, no MCP servers, CLAUDE_CODE_TMPDIR).
 * tmux is mocked at node:child_process (argv captured), mirroring headless-spawn-reroute.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
/** Every `new-session` argv captured, in call order (for argv-pin assertions). */
const newSessionArgvs: string[][] = [];
/** Every send-keys `-l` literal payload captured (for the sanitizer assertion). */
const sentLiterals: string[] = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'send-keys' && args.includes('-l')) {
      // The payload follows `-l`, and `--` may sit between them: literal sends
      // funnel through buildLiteralSendArgs(), which emits an option terminator
      // so a payload starting with `-` can never be read as a flag. Skip it, or
      // this captures the terminator instead of the text.
      let at = args.indexOf('-l') + 1;
      if (args[at] === '--') at += 1;
      sentLiterals.push(args[at]);
      return '';
    }
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target) mockTmuxSessions.delete(target);
      return '';
    }
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
      if (target && !mockTmuxSessions.has(target)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'display-message') {
      // pane_current_command — report a live claude so isSessionAlive passes.
      return 'claude||claude';
    }
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => handle(args)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

/** Helper: the newest captured new-session argv. */
function lastNewSessionArgv(): string[] {
  return newSessionArgvs[newSessionArgvs.length - 1];
}

/** Helper: the argv AFTER the tmux env block (everything from the binary path on). */
function launchArgvFrom(argv: string[], binary: string): string[] {
  const idx = argv.indexOf(binary);
  return idx >= 0 ? argv.slice(idx) : [];
}

const CLAUDE = '/usr/local/bin/claude';

function makeManager(opts: {
  anthropicApiKey?: string;
  mode?: 'off' | 'auto' | 'force';
  maxRerouted?: number;
  framework?: 'claude-code' | 'codex-cli' | 'gemini-cli';
  credit?: () => Promise<{ remainingUsd: number; totalUsd: number } | null>;
}, tmpDir: string): { manager: SessionManager; state: StateManager; maintenanceTick: () => Promise<void> } {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: CLAUDE,
    frameworkBinaryPaths: { 'claude-code': CLAUDE, 'codex-cli': '/usr/local/bin/codex', 'gemini-cli': '/usr/local/bin/gemini' },
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 10,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    ...(opts.framework ? { framework: opts.framework } : {}),
    ...(opts.anthropicApiKey ? { anthropicApiKey: opts.anthropicApiKey } : {}),
    authToken: 'instar-real-token',
    ...(opts.mode ? { subscriptionPathMode: opts.mode } : {}),
    ...(opts.maxRerouted != null ? { subscriptionMaxRerouted: opts.maxRerouted } : {}),
  };
  let maintenanceTick!: () => Promise<void>;
  const manager = new SessionManager(config, state, {
    bindMaintenanceTickForTesting: (tick) => { maintenanceTick = tick; },
  });
  // Stub the background ready-wait so the detached injectAfterReady completes
  // immediately (otherwise it polls for ~90s). The tmux argv is captured
  // synchronously at new-session, so this never affects the pin assertions.
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> })
    .waitForClaudeReadyWithRetry = async () => true;
  // Deterministic reroute gate regardless of the host machine's live memory
  // state: the gate legitimately refuses force-mode spawns when the REAL host
  // is under pressure, which made this suite fail on loaded dev machines while
  // passing in CI. These tests assert the reroute logic, not host pressure.
  (manager as unknown as { currentMemoryPressure: () => string })
    .currentMemoryPressure = () => 'normal';
  if (opts.credit) {
    manager.setSdkCreditReader(opts.credit as never);
  }
  return { manager, state, maintenanceTick };
}


describe('confined spawn (feedback executor)', () => {
  let tmpDir: string;
  let ws: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-confined-'));
    ws = path.join(tmpDir, '.worktrees', 'feedback-x-12345678-a1');
    fs.mkdirSync(ws, { recursive: true });
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-confined-spawn.test.ts' }); });

  const confined = () => ({ framework: 'claude-code' as const, settingsPath: '/trusted/settings.json', tmpDir: `${ws}-tmp` });

  it('launches with the confinement adapter instead of bypass permissions, in the workspace, without the agent\'s authority', async () => {
    process.env.FEEDBACK_TEST_SECRET_TOKEN = 'should-be-blanked';
    try {
      const { manager } = makeManager({}, tmpDir);
      await manager.spawnSession({ name: 'feedback-x-a1', prompt: 'fix it', cwd: ws, omitAuthEnv: true, framework: 'claude-code', confinement: confined() });
      const argv = lastNewSessionArgv();
      const launch = launchArgvFrom(argv, CLAUDE);
      expect(launch).not.toContain('--dangerously-skip-permissions');
      expect(launch).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', '--settings', '/trusted/settings.json', '--setting-sources', 'local', '--strict-mcp-config']));
      expect(launch.indexOf('--permission-mode')).toBeLessThan(launch.indexOf('-p'));
      expect(argv[argv.indexOf('-c') + 1]).toBe(ws);
      const env = argv.filter((_a, i) => argv[i - 1] === '-e');
      expect(env).toContain('INSTAR_AUTH_TOKEN=');
      expect(env).not.toContain('INSTAR_AUTH_TOKEN=instar-real-token');
      expect(env).toContain('INSTAR_ORIGIN_TOKEN=');
      expect(env).toContain('GH_TOKEN=');
      expect(env).toContain('FEEDBACK_TEST_SECRET_TOKEN=');
      expect(env).toContain(`CLAUDE_CODE_TMPDIR=${ws}-tmp`);
      expect(env).toContain(`TMPDIR=${ws}-tmp`);
      // The CLI itself starts from an empty environment plus an allowlist.
      const envAt = argv.indexOf('/usr/bin/env');
      expect(envAt).toBeGreaterThan(-1);
      expect(argv[envAt + 1]).toBe('-i');
      const allowed = argv.slice(envAt + 2, argv.indexOf(CLAUDE));
      expect(allowed.every((kv) => /^[A-Z_]+=/.test(kv))).toBe(true);
      expect(allowed.some((kv) => kv.startsWith('FEEDBACK_TEST_SECRET_TOKEN'))).toBe(false);
      expect(allowed.some((kv) => kv.startsWith('INSTAR_AUTH_TOKEN'))).toBe(false);
      expect(allowed).toContain(`CLAUDE_CODE_TMPDIR=${ws}-tmp`);
    } finally { delete process.env.FEEDBACK_TEST_SECRET_TOKEN; }
  });

  it('a confined spawn with a session id records its Claude config home and launches with that --session-id (the canary reads its transcript)', async () => {
    const { manager } = makeManager({}, tmpDir);
    const uuid = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
    const session = await manager.spawnSession({ name: 'feedback-canary-x-a1', prompt: 'canary', cwd: ws, omitAuthEnv: true, framework: 'claude-code', sessionId: uuid, confinement: confined() });
    expect(session.confinedConfigHome).toBeTruthy();
    const launch = launchArgvFrom(lastNewSessionArgv(), CLAUDE);
    expect(launch[launch.indexOf('--session-id') + 1]).toBe(uuid);
    expect(manager.plannedTmuxSessionName('feedback-canary-x-a1')).toBe(session.tmuxSession);
    const ordinary = await manager.spawnSession({ name: 'ordinary-x', prompt: 'p' });
    expect(ordinary.confinedConfigHome).toBeUndefined();
  });

  it('an ordinary spawn is unchanged (bypass permissions, project dir, the agent token)', async () => {
    const { manager } = makeManager({}, tmpDir);
    await manager.spawnSession({ name: 'job', prompt: 'p' });
    const argv = lastNewSessionArgv();
    expect(launchArgvFrom(argv, CLAUDE)).toContain('--dangerously-skip-permissions');
    expect(argv).toContain('INSTAR_AUTH_TOKEN=instar-real-token');
  });

  it('refuses a cwd outside <projectDir>/.worktrees/, or a missing one, or combined with topicId', async () => {
    const { manager } = makeManager({}, tmpDir);
    await expect(manager.spawnSession({ name: 'a', prompt: 'p', cwd: tmpDir, omitAuthEnv: true })).rejects.toThrow(/spawn-cwd-refused/);
    await expect(manager.spawnSession({ name: 'b', prompt: 'p', cwd: path.join(tmpDir, '.worktrees', 'missing') })).rejects.toThrow(/does not exist/);
    await expect(manager.spawnSession({ name: 'c', prompt: 'p', cwd: ws, topicId: 5 })).rejects.toThrow(/spawn-cwd-refused/);
    expect(newSessionArgvs).toHaveLength(0);
  });

  it('confinement requires omitAuthEnv; omitAuthEnv refuses an env-token Claude credential', async () => {
    const { manager } = makeManager({}, tmpDir);
    await expect(manager.spawnSession({ name: 'a', prompt: 'p', cwd: ws, confinement: confined() })).rejects.toThrow(/confinement-requires-omit-auth-env/);
    const withToken = makeManager({ anthropicApiKey: 'sk-ant-oat-xyz' }, tmpDir).manager;
    await expect(withToken.spawnSession({ name: 'b', prompt: 'p', cwd: ws, omitAuthEnv: true, confinement: confined() })).rejects.toThrow(/omit-auth-env-unsupported/);
    expect(newSessionArgvs).toHaveLength(0);
  });

  it('refuses a framework without a confinement adapter, and a launch the subscription reroute would make interactive', async () => {
    const codex = makeManager({ framework: 'codex-cli' }, tmpDir).manager;
    await expect(codex.spawnSession({ name: 'a', prompt: 'p', cwd: ws, omitAuthEnv: true, framework: 'codex-cli', confinement: confined() as never })).rejects.toThrow(/confinement-unsupported-framework/);
    const forced = makeManager({ mode: 'force' }, tmpDir).manager;
    await expect(forced.spawnSession({ name: 'b', prompt: 'p', cwd: ws, omitAuthEnv: true, framework: 'claude-code', confinement: confined() })).rejects.toThrow(/confinement-reroute-unsupported/);
    expect(newSessionArgvs).toHaveLength(0);
  });
});
