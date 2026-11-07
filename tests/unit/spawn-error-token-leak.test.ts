/**
 * #2184 — when `tmux new-session` fails, SessionManager.spawnSession must not
 * put the GitHub token it passed as `-e GH_TOKEN=…` into the error it throws
 * (POST /sessions/spawn returns that error to the caller) or into its logs.
 *
 * Mocking mirrors headless-spawn-reroute.test.ts: node:child_process is stubbed
 * with an argv-capturing tmux handle, and new-session fails the way Node's
 * execFileSync does — `Command failed: <full argv>\n<stderr>`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FAKE_GH_TOKEN = `github_pat_11${'Q7r6S5t4'.repeat(8)}`;
const newSessionArgvs: string[][] = [];

vi.mock('node:child_process', () => {
  const handle = (cmd: string, args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'new-session') {
      newSessionArgvs.push([...args]);
      throw Object.assign(
        new Error(`Command failed: ${cmd} ${args.join(' ')}\nduplicate session: proj-job-leak`),
        // execFileSync errors carry the child's stderr alongside the message.
        { status: 1, signal: null, stderr: 'duplicate session: proj-job-leak\n' },
      );
    }
    if (args[0] === 'has-session') throw new Error('no session');
    return '';
  };
  return {
    execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => handle(cmd, args)),
    execFile: vi.fn().mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        try { const out = handle(cmd, args); if (cb) cb(null, { stdout: String(out) }); }
        catch (e) { if (cb) cb(e as Error, { stdout: '' }); }
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('spawn failure does not leak the GitHub token (#2184)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-spawn-leak-'));
    newSessionArgvs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/spawn-error-token-leak.test.ts' });
  });

  it('throws a scrubbed error and logs no token when tmux new-session fails', async () => {
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectName: 'proj',
      projectDir: tmpDir,
      maxSessions: 10,
      protectedSessions: [],
      completionPatterns: [],
    };
    const manager = new SessionManager(config, new StateManager(stateDir));
    // Stand in for a vault-held token (resolveGhTokenFromVault) without a vault.
    (manager as unknown as { ghTokenEnvFlags: () => string[] })
      .ghTokenEnvFlags = () => ['-e', `GH_TOKEN=${FAKE_GH_TOKEN}`];

    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    }

    const err = await manager.spawnSession({ name: 'job-leak', prompt: 'p' }).then(
      () => { throw new Error('expected spawnSession to reject'); },
      (e: unknown) => e as Error,
    );

    // The token really was handed to tmux, so a leak was possible.
    expect(newSessionArgvs).toHaveLength(1);
    expect(newSessionArgvs[0]).toContain(`GH_TOKEN=${FAKE_GH_TOKEN}`);

    expect(err.message).not.toContain(FAKE_GH_TOKEN);
    expect(logged.join('\n')).not.toContain(FAKE_GH_TOKEN);
    // …while still saying why the spawn failed.
    expect(err.message).toContain('Failed to create tmux session');
    expect(err.message).toContain('exit status 1');
    expect(err.message).toContain('duplicate session');
  });
});
