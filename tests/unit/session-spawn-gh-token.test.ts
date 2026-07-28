/**
 * Spawn-time GH_TOKEN injection (Phase-3 increment P3b, option C — per-agent
 * credential isolation).
 *
 * Verifies SessionManager injects the agent's OWN vault GitHub token into the
 * spawned-session env — and, just as load-bearing, that an install WITHOUT a
 * vault token spawns byte-for-byte as before (no GH_TOKEN flag at all; the
 * machine-global gh seat keeps working untouched).
 *
 * REAL modules throughout (StateManager, SecretStore vault on disk, the real
 * resolver) — only node:child_process is stubbed with the argv-capturing tmux
 * handle (the headless-spawn-reroute.test.ts pattern), so the assertion is on
 * the exact tmux argv production would execute.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
/** Every `new-session` argv captured, in call order. */
const newSessionArgvs: string[][] = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[]) => {
    if (!args) return '';
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
import { SecretStore } from '../../src/core/SecretStore.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const CLAUDE = '/usr/local/bin/claude';

function lastNewSessionArgv(): string[] {
  return newSessionArgvs[newSessionArgvs.length - 1];
}

/** All `-e KEY=...` env assignments in a captured tmux argv. */
function envAssignments(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-e') out.push(argv[i + 1]);
  }
  return out;
}

function makeManager(tmpDir: string, opts?: { mode?: 'force' }): SessionManager {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = new StateManager(stateDir);
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: CLAUDE,
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 10,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    ...(opts?.mode ? { subscriptionPathMode: opts.mode } : {}),
  };
  const manager = new SessionManager(config, state);
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> })
    .waitForClaudeReadyWithRetry = async () => true;
  // Deterministic reroute gate regardless of the host machine's live memory
  // state (the gate legitimately refuses force-mode spawns under pressure).
  (manager as unknown as { currentMemoryPressure: () => string })
    .currentMemoryPressure = () => 'normal';
  return manager;
}

/** Seed the vault SessionManager resolves from: StateManager.baseDir (the
 *  `<tmpDir>/state` dir) is the vault state root by construction. */
function seedVault(tmpDir: string, token: string): void {
  new SecretStore({ stateDir: path.join(tmpDir, 'state'), forceFileKey: true })
    .set('github_token', token);
}

describe('spawn-time GH_TOKEN injection (P3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ghtok-spawn-'));
    mockTmuxSessions.clear();
    newSessionArgvs.length = 0;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-spawn-gh-token.test.ts' });
  });

  it('vault token → headless spawn env carries GH_TOKEN (and the existing INSTAR env is intact)', async () => {
    seedVault(tmpDir, 'ghp_spawn_test_token');
    const manager = makeManager(tmpDir);
    await manager.spawnSession({ name: 'job-tok', prompt: 'p' });

    const env = envAssignments(lastNewSessionArgv());
    expect(env).toContain('GH_TOKEN=ghp_spawn_test_token');
    // Canary: the pre-existing credential-injection art is untouched.
    expect(env.some((e) => e.startsWith('INSTAR_AUTH_TOKEN='))).toBe(true);
    expect(env.some((e) => e.startsWith('INSTAR_AGENT_ID='))).toBe(true);
  });

  it('no vault → spawn env has NO GH_TOKEN flag (machine-global behavior preserved byte-for-byte)', async () => {
    const manager = makeManager(tmpDir);
    await manager.spawnSession({ name: 'job-none', prompt: 'p' });

    const env = envAssignments(lastNewSessionArgv());
    expect(env.some((e) => e.startsWith('GH_TOKEN='))).toBe(false);
  });

  it('corrupt vault → spawn still succeeds with no GH_TOKEN flag (fail-soft end to end)', async () => {
    seedVault(tmpDir, 'ghp_to_be_corrupted');
    fs.writeFileSync(path.join(tmpDir, 'state', 'secrets', 'config.secrets.enc'), Buffer.from('garbage'));

    const manager = makeManager(tmpDir);
    const s = await manager.spawnSession({ name: 'job-corrupt', prompt: 'p' });
    expect(s).toBeTruthy();
    const env = envAssignments(lastNewSessionArgv());
    expect(env.some((e) => e.startsWith('GH_TOKEN='))).toBe(false);
  });

  it('whitespace-only vault token → treated as absent (no GH_TOKEN flag)', async () => {
    seedVault(tmpDir, '   ');
    const manager = makeManager(tmpDir);
    await manager.spawnSession({ name: 'job-blank', prompt: 'p' });

    const env = envAssignments(lastNewSessionArgv());
    expect(env.some((e) => e.startsWith('GH_TOKEN='))).toBe(false);
  });

  it('rerouted interactive spawn (subscriptionPathMode force) also carries the vault GH_TOKEN', async () => {
    seedVault(tmpDir, 'ghp_interactive_token');
    const manager = makeManager(tmpDir, { mode: 'force' });
    await manager.spawnSession({ name: 'job-int', prompt: 'p' });

    const argv = lastNewSessionArgv();
    // Interactive lane confirmed by the wide-pane geometry the reroute pins.
    expect(argv).toContain('200');
    const env = envAssignments(argv);
    expect(env).toContain('GH_TOKEN=ghp_interactive_token');
  });
});
