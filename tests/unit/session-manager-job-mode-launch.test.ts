// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * job-mode-instructions (docs/specs/job-mode-instructions.md, Changes 4-5) on the real spawn lanes.
 * Harness copied from session-manager-confined-spawn.test.ts. Original header:
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


describe('job-mode launch on the spawn lanes', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobmode-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-job-mode-launch.test.ts' }); });

  const jm = { text: '# Job mode\nline two\nJOB-MODE-MARKER instar 9.9.9', markerVersion: '9.9.9' };

  function jobModeFlags(launch: string[]): { settings: any; text: string; sessionId: string } | null {
    const at = launch.indexOf('--append-system-prompt');
    if (at < 0) return null;
    return {
      settings: JSON.parse(launch[launch.indexOf('--settings') + 1]),
      text: launch[at + 1],
      sessionId: launch[launch.indexOf('--session-id') + 1],
    };
  }

  it('headless lane: excludes the agent home files, turns memory off, appends the text as one argument, pins the session id', async () => {
    const { manager } = makeManager({}, tmpDir);
    const session = await manager.spawnSession({ name: 'job-x', prompt: 'do the job', framework: 'claude-code', jobSlug: 'x', jobMode: jm });
    const launch = launchArgvFrom(lastNewSessionArgv(), CLAUDE);
    const f = jobModeFlags(launch);
    expect(f).not.toBeNull();
    expect(f!.text).toBe(jm.text);
    expect(f!.settings).toEqual({
      claudeMdExcludes: [path.resolve(tmpDir, 'CLAUDE.md'), path.resolve(tmpDir, 'AGENTS.md'), path.resolve(tmpDir, '.claude', 'CLAUDE.md')],
      autoMemoryEnabled: false,
    });
    expect(launch.indexOf('--append-system-prompt')).toBeLessThan(launch.indexOf('-p'));
    expect(session.jobMode).toMatchObject({ applied: true, lane: 'headless', agentHome: expect.any(String), claudeSessionId: f!.sessionId, markerVersion: '9.9.9', textBytes: Buffer.byteLength(jm.text) });
    expect(JSON.stringify(session.jobMode)).not.toContain('line two');
  });

  it('rerouted interactive lane carries identical job-mode flags', async () => {
    const { manager } = makeManager({ mode: 'force' }, tmpDir);
    const session = await manager.spawnSession({ name: 'job-y', prompt: 'do the job', framework: 'claude-code', jobSlug: 'y', triggeredBy: 'scheduler:cron', jobMode: jm });
    expect(session.launchLane).toBe('rerouted-interactive');
    const f = jobModeFlags(launchArgvFrom(lastNewSessionArgv(), CLAUDE));
    expect(f).not.toBeNull();
    expect(f!.text).toBe(jm.text);
    expect(f!.settings.autoMemoryEnabled).toBe(false);
    expect(session.jobMode?.applied).toBe(true);
    expect(session.jobMode?.lane).toBe('rerouted-interactive');
  });

  it('no jobMode option means no job-mode flags, even with a job slug', async () => {
    const { manager } = makeManager({}, tmpDir);
    const session = await manager.spawnSession({ name: 'spawn-z', prompt: 'p', framework: 'claude-code', jobSlug: 'z' });
    expect(jobModeFlags(launchArgvFrom(lastNewSessionArgv(), CLAUDE))).toBeNull();
    expect(session.jobMode).toBeUndefined();
  });

  it('restricted spawns keep today\'s launch and record why', async () => {
    const { manager } = makeManager({}, tmpDir);
    const s1 = await manager.spawnSession({ name: 'job-c', prompt: 'p', framework: 'claude-code', jobSlug: 'c', confinedTools: ['Read'], jobMode: jm });
    expect(jobModeFlags(launchArgvFrom(lastNewSessionArgv(), CLAUDE))).toBeNull();
    expect(s1.jobMode).toMatchObject({ applied: false, reason: 'confined-tools' });
    const s2 = await manager.spawnSession({ name: 'job-d', prompt: 'p', framework: 'claude-code', jobSlug: 'd', omitAuthEnv: true, jobMode: jm });
    expect(jobModeFlags(launchArgvFrom(lastNewSessionArgv(), CLAUDE))).toBeNull();
    expect(s2.jobMode).toMatchObject({ applied: false, reason: 'no-auth-env' });
  });

  it('a pinned session id skips job mode on the headless path too', async () => {
    const { manager } = makeManager({}, tmpDir);
    const s1 = await manager.spawnSession({ name: 'job-p', prompt: 'p', framework: 'claude-code', jobSlug: 'p', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', jobMode: jm } as never);
    expect(jobModeFlags(launchArgvFrom(lastNewSessionArgv(), CLAUDE))).toBeNull();
    expect((s1 as { jobMode?: unknown }).jobMode).toMatchObject({ applied: false, reason: 'session-id-pinned' });
  });

  it('a non-Claude framework gets nothing and records not-claude-code', async () => {
    const { manager } = makeManager({}, tmpDir);
    const s = await manager.spawnSession({ name: 'job-e', prompt: 'p', framework: 'codex-cli', jobSlug: 'e', jobMode: jm });
    expect(lastNewSessionArgv().join(' ')).not.toContain('--append-system-prompt');
    expect(s.jobMode).toMatchObject({ applied: false, reason: 'not-claude-code' });
  });
});
