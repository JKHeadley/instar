/**
 * A failed tmux probe is not a dead server. On 2026-11-06 the supervisor read
 * probe failures as "session GONE" and restarted healthy servers on the Studio.
 * These run the real execFileSync against stand-in tmux scripts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ServerSupervisor, tmuxReportedSessionMissing } from '../../src/lifeline/ServerSupervisor.js';

describe('ServerSupervisor session probe', () => {
  let dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sup: any;

  const tmuxThat = (body: string): string => {
    const file = path.join(dir, 'tmux-stand-in.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-probe-'));
    fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
    sup = new ServerSupervisor({ projectDir: dir, projectName: 'test-agent', port: 0, stateDir: path.join(dir, '.instar') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/supervisor-tmux-probe-unknown.test.ts:cleanup' });
  });

  it('reads a clean answer as alive', () => {
    sup.tmuxPath = tmuxThat('exit 0');
    expect(sup.isServerSessionAlive()).toBe(true);
  });

  it.each([
    ["can't find session: test-agent-server"],
    ['no server running on /private/tmp/tmux-501/default'],
    ['error connecting to /private/tmp/tmux-501/default (No such file or directory)'],
  ])('reads tmux saying "%s" as gone, so a real death still respawns', (message) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    sup.tmuxPath = tmuxThat(`echo "${message}" >&2; exit 1`);
    expect(sup.isServerSessionAlive()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it('does not read tmux failing to reach its server as gone, despite the same exit code', () => {
    sup.tmuxPath = tmuxThat('echo "error connecting to /private/tmp/tmux-501/default (Resource temporarily unavailable)" >&2; exit 1');
    expect(sup.isServerSessionAlive()).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not treating the server as gone'));
  });

  it('does not read a probe that could not start as gone', () => {
    sup.tmuxPath = path.join(dir, 'no-such-tmux');
    expect(sup.isServerSessionAlive()).toBe(true);
  });

  it('does not read a probe that timed out as gone', () => {
    sup.tmuxPath = tmuxThat('exec sleep 30');
    expect(sup.isServerSessionAlive()).toBe(true);
  }, 15_000);

  it('a health tick with an unanswered probe does not restart the server', async () => {
    sup.tmuxPath = tmuxThat('echo "error connecting to /tmp/x (Resource temporarily unavailable)" >&2; exit 1');
    sup.isRunning = true;
    sup.spawnedAt = Date.now();
    const handleUnhealthy = vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
    await sup.runHealthTick();
    expect(handleUnhealthy).not.toHaveBeenCalled();
  });

  it('a health tick with a real missing session still restarts it', async () => {
    sup.tmuxPath = tmuxThat(`echo "can't find session: x" >&2; exit 1`);
    sup.isRunning = true;
    sup.spawnedAt = Date.now();
    const handleUnhealthy = vi.spyOn(sup, 'handleUnhealthy').mockImplementation(() => {});
    await sup.runHealthTick();
    expect(handleUnhealthy).toHaveBeenCalledOnce();
  });
});

describe('tmuxReportedSessionMissing', () => {
  it('needs both an exit status and the message', () => {
    expect(tmuxReportedSessionMissing({ status: 1, stderr: Buffer.from("can't find session: x") })).toBe(true);
    expect(tmuxReportedSessionMissing({ status: null, stderr: "can't find session: x" })).toBe(false);
    expect(tmuxReportedSessionMissing({ status: 1, stderr: 'server exited unexpectedly' })).toBe(false);
    expect(tmuxReportedSessionMissing(new Error('spawnSync /opt/homebrew/bin/tmux EAGAIN'))).toBe(false);
    expect(tmuxReportedSessionMissing(null)).toBe(false);
  });
});
