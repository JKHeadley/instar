/**
 * Unit tests for Threadline A2A continuity flags in
 * SessionManager.spawnSession() (the HEADLESS `claude -p` path).
 *
 * Path-1 continuity: a fresh A2A reply spawn sets a deterministic conversation
 * id via `--session-id <uuid>` so the transcript is created at that id; a
 * follow-up resumes the exact conversation via `--resume <uuid>`. Both flags
 * are spliced before the `-p` positional, mirroring the existing
 * claudeHeadlessExtraFlags splice. They are claude-code-only, mutually
 * exclusive (sessionId wins), and absent for every existing spawn.
 *
 * Uses the same child_process capture mock pattern as session-resume.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Track mock tmux sessions and capture spawned args at module scope
const mockTmuxSessions = new Set<string>();
const capturedExecFileSyncCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => {
      if (!args) return '';
      capturedExecFileSyncCalls.push({ cmd, args: [...args] });

      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '');
        if (!mockTmuxSessions.has(target)) {
          throw new Error(`session not found: ${target}`);
        }
        return '';
      }
      if (args[0] === 'new-session') {
        const sIdx = args.indexOf('-s');
        if (sIdx >= 0 && args[sIdx + 1]) {
          mockTmuxSessions.add(args[sIdx + 1]);
        }
        return '';
      }
      if (args[0] === 'kill-session') {
        const target = args[2]?.replace(/^=/, '');
        mockTmuxSessions.delete(target);
        return '';
      }
      if (args[0] === 'display-message') return 'claude||claude';
      return '';
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
        if (typeof _opts === 'function') {
          cb = _opts as (err: Error | null, result: { stdout: string }) => void;
        }
        if (args[0] === 'has-session') {
          const target = args[2]?.replace(/^=/, '');
          if (!mockTmuxSessions.has(target)) {
            if (cb) cb(new Error(`session not found: ${target}`), { stdout: '' });
          } else {
            if (cb) cb(null, { stdout: '' });
          }
        } else {
          if (cb) cb(null, { stdout: '' });
        }
      }
    ),
  };
});

// Import after mock
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

function findLastNewSessionCall(): string[] | undefined {
  const calls = capturedExecFileSyncCalls.filter(c => c.args[0] === 'new-session');
  return calls[calls.length - 1]?.args;
}

describe('SessionManager.spawnSession — Threadline A2A continuity flags (headless)', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let config: SessionManagerConfig;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-continuity-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    state = new StateManager(stateDir);
    config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
    };
    manager = new SessionManager(config, state);

    mockTmuxSessions.clear();
    capturedExecFileSyncCalls.length = 0;
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-headless-continuity.test.ts:cleanup' });
  });

  it('puts --session-id <uuid> before -p when sessionId is provided', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await manager.spawnSession({ name: 'a2a-new', prompt: 'reply prompt', sessionId: uuid });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    const flagIdx = args!.indexOf('--session-id');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args![flagIdx + 1]).toBe(uuid);

    // Spliced BEFORE the -p positional (so the prompt stays the last positional).
    const dashPIdx = args!.indexOf('-p');
    expect(dashPIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(dashPIdx);

    // Mutually exclusive: --resume is NOT present when sessionId is set.
    expect(args!.includes('--resume')).toBe(false);
  });

  it('puts --resume <uuid> before -p when resumeSessionId is provided', async () => {
    const uuid = 'abcdef00-1111-2222-3333-444444444444';
    await manager.spawnSession({ name: 'a2a-resume', prompt: 'follow-up prompt', resumeSessionId: uuid });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    const flagIdx = args!.indexOf('--resume');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args![flagIdx + 1]).toBe(uuid);

    const dashPIdx = args!.indexOf('-p');
    expect(dashPIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(dashPIdx);

    // --session-id is NOT present on the resume path.
    expect(args!.includes('--session-id')).toBe(false);
  });

  it('sessionId wins when BOTH sessionId and resumeSessionId are provided (mutually exclusive)', async () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    const rid = '99999999-8888-7777-6666-555555555555';
    await manager.spawnSession({
      name: 'a2a-both',
      prompt: 'p',
      sessionId: sid,
      resumeSessionId: rid,
    });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();

    const sidIdx = args!.indexOf('--session-id');
    expect(sidIdx).toBeGreaterThan(-1);
    expect(args![sidIdx + 1]).toBe(sid);
    // --resume must NOT appear — sessionId takes precedence.
    expect(args!.includes('--resume')).toBe(false);
  });

  it('emits NEITHER flag when neither option is provided (existing spawns unaffected)', async () => {
    await manager.spawnSession({ name: 'plain-job', prompt: 'job prompt' });

    const args = findLastNewSessionCall();
    expect(args).toBeDefined();
    expect(args!.includes('--session-id')).toBe(false);
    expect(args!.includes('--resume')).toBe(false);

    // The -p positional is still present and the prompt is the final argument.
    const dashPIdx = args!.indexOf('-p');
    expect(dashPIdx).toBeGreaterThan(-1);
    expect(args![args!.length - 1]).toBe('job prompt');
  });

  it('passes the uuid through verbatim (no normalization)', async () => {
    const uuid = 'ABCDEF12-3456-7890-abcd-ef1234567890';
    await manager.spawnSession({ name: 'verbatim', prompt: 'p', sessionId: uuid });

    const args = findLastNewSessionCall();
    const flagIdx = args!.indexOf('--session-id');
    expect(args![flagIdx + 1]).toBe(uuid);
  });
});
