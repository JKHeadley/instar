/**
 * A spawned session's environment never contains the lifeline ingress secret
 * (docs/specs/telegram-internal-route-lifeline-secret.md §The secret).
 *
 * The server spawns sessions and children inherit its environment, so the
 * secret must live only in its file and in process-private memory. This test
 * holds the secret exactly the way the running server does (a live guard that
 * has verified a request), then spawns through the REAL SessionManager and
 * inspects the exact tmux argv production would execute, plus the parent
 * environment the child would inherit.
 *
 * Only node:child_process is stubbed (the argv-capturing tmux handle, the
 * session-spawn-gh-token.test.ts pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const allArgvs: string[][] = [];
const allSpawnEnvs: Array<Record<string, string | undefined>> = [];

vi.mock('node:child_process', () => {
  const handle = (args?: string[], opts?: { env?: Record<string, string | undefined> }) => {
    if (!args) return '';
    allArgvs.push([...args]);
    if (opts && typeof opts === 'object' && opts.env) allSpawnEnvs.push(opts.env);
    if (args[0] === 'new-session') {
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
    if (args[0] === 'display-message') return 'claude||claude';
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[], opts?: any) => handle(args, opts)),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        const opts = typeof _opts === 'function' ? undefined : (_opts as any);
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(args, opts); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { LifelineIngressGuard } from '../../src/server/LifelineIngressGuard.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';

function makeManager(tmpDir: string, opts?: { mode?: 'force' }): SessionManager {
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectName: 'proj',
    projectDir: tmpDir,
    maxSessions: 10,
    protectedSessions: [],
    completionPatterns: ['has been automatically paused'],
    ...(opts?.mode ? { subscriptionPathMode: opts.mode } : {}),
  };
  const manager = new SessionManager(config, new StateManager(stateDir));
  (manager as unknown as { waitForClaudeReadyWithRetry: () => Promise<boolean> })
    .waitForClaudeReadyWithRetry = async () => true;
  (manager as unknown as { currentMemoryPressure: () => string })
    .currentMemoryPressure = () => 'normal';
  return manager;
}

describe('a spawned session never receives the lifeline ingress secret', () => {
  let tmpDir: string;
  let secret: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-no-lifeline-secret-'));
    mockTmuxSessions.clear();
    allArgvs.length = 0;
    allSpawnEnvs.length = 0;
    // Hold the secret the way the running server does: in the file, and in a
    // live guard that has already verified a lifeline request with it.
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    secret = ensureLifelineIngressSecret(stateDir);
    const guard = new LifelineIngressGuard({
      stateDir,
      explicitEnforce: () => true,
      config: { developmentAgent: true },
      writeRestartSignal: () => {},
      log: () => {},
    });
    expect(guard.evaluate({ [LIFELINE_SECRET_HEADER]: secret }, 'telegram-forward').verified).toBe(true);
    expect((guard.health() as { armed: boolean }).armed).toBe(true);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-spawn-no-lifeline-secret.test.ts' });
  });

  const assertAbsent = () => {
    // The canary: this really is a spawn with the usual injected environment.
    const newSession = allArgvs.filter((a) => a[0] === 'new-session');
    expect(newSession.length).toBeGreaterThan(0);
    expect(newSession[newSession.length - 1].some((x) => x.startsWith('INSTAR_AUTH_TOKEN='))).toBe(true);
    // No tmux argv of any kind (new-session -e flags, send-keys, set-environment…).
    for (const argv of allArgvs) for (const arg of argv) expect(arg).not.toContain(secret);
    // No explicit env object handed to a child process.
    for (const env of allSpawnEnvs) for (const v of Object.values(env)) expect(v ?? '').not.toContain(secret);
    // Not in the parent environment the child inherits by default.
    for (const [k, v] of Object.entries(process.env)) {
      expect(v ?? '', `process.env.${k}`).not.toContain(secret);
      expect(k).not.toMatch(/LIFELINE.*SECRET/i);
    }
  };

  it('headless spawn', async () => {
    await makeManager(tmpDir).spawnSession({ name: 'job-a', prompt: 'p' });
    assertAbsent();
  });

  it('interactive (subscription-path) spawn', async () => {
    await makeManager(tmpDir, { mode: 'force' }).spawnSession({ name: 'job-b', prompt: 'p' });
    assertAbsent();
  });
});
