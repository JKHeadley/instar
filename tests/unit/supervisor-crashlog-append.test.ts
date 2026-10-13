/**
 * Regression tests for the server crash-log capture (2026-10-12, `inspec`).
 *
 * The supervisor tees the spawned server's stderr to `logs/server-stderr.log`.
 * That tee TRUNCATED on every spawn, so in a crash loop each attempt erased the
 * evidence of the one before it. `inspec` refused 42 consecutive spawns — each
 * printing its reason to stderr — and the surviving file held three unrelated
 * lines from an earlier boot, which is why the cause stayed invisible for hours
 * while the agent was dark.
 *
 * The capture now APPENDS, bounded by a size cap so a tight loop cannot fill
 * the disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const execFileSyncMock = vi.hoisted(() => vi.fn(() => '' as unknown as Buffer));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});

const CAP_BYTES = 4 * 1024 * 1024;

function makeSupervisor(stateDir: string): any {
  const s: any = new ServerSupervisor({
    projectDir: stateDir,
    projectName: 'crashlog-test',
    port: 59998,
  });
  s.tmuxPath = 'tmux';
  s.stateDir = stateDir;
  s.startHealthChecks = vi.fn();
  s.preflightSelfHeal = vi.fn();
  s.isServerSessionAlive = vi.fn().mockReturnValue(false);
  return s;
}

/** The `bash -c` command string the supervisor handed to `tmux new-session`. */
function capturedTmuxCommand(calls: unknown[][]): string {
  const newSession = calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
  if (!newSession) throw new Error('tmux new-session was never invoked');
  const args = newSession[1] as string[];
  return args[args.length - 1] as string;
}

describe('ServerSupervisor — server stderr crash log', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crashlog-'));
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/supervisor-crashlog-append.test.ts:afterEach',
      });
    } catch { /* ignore */ }
  });

  it('appends rather than truncates, so a crash loop keeps every attempt’s reason', () => {
    const s = makeSupervisor(dir);
    expect(s.spawnServer()).toBe(true);

    const cmd = capturedTmuxCommand(execFileSyncMock.mock.calls as unknown[][]);
    expect(cmd).toContain('tee -a ');
    // The exact shape that erased the evidence must not come back.
    expect(cmd).not.toMatch(/tee '[^']*server-stderr\.log'/);
  });

  it('leaves an existing crash log in place across a respawn', () => {
    const logPath = path.join(dir, 'logs', 'server-stderr.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'refusal from the previous spawn\n');

    const s = makeSupervisor(dir);
    s.spawnServer();

    expect(fs.readFileSync(logPath, 'utf-8')).toContain('refusal from the previous spawn');
  });

  it('trims to the newest slice once the log passes the cap — never to zero', () => {
    const logPath = path.join(dir, 'logs', 'server-stderr.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Old bulk, then the most recent (most valuable) evidence at the end.
    fs.writeFileSync(logPath, 'x'.repeat(CAP_BYTES + 1024) + '\nLATEST REFUSAL REASON\n');

    const s = makeSupervisor(dir);
    s.spawnServer();

    const size = fs.statSync(logPath).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(512 * 1024);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('LATEST REFUSAL REASON');
  });

  it('spawns normally when no crash log exists yet', () => {
    const s = makeSupervisor(dir);
    expect(s.spawnServer()).toBe(true);
    expect(capturedTmuxCommand(execFileSyncMock.mock.calls as unknown[][])).toContain('tee -a ');
  });
});
