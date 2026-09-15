import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyLongLivedServiceProcess, SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog safe-wait pipeline', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  }, 30_000);
  it('does not call the LLM judge or Ctrl+C for a live safe-merge wait', async () => {
    const sm = {
      captureOutput: vi.fn(() => 'safe-merge: waiting for PR #1981 checks to finish (deadline 1200s)...'),
      sendKey: vi.fn(),
      sendInput: vi.fn(),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-safe-wait-integration',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180 } },
    } as any, sm as any, {} as any);
    (wd as any).getClaudePid = vi.fn(async () => 10);
    (wd as any).getChildProcesses = vi.fn(async () => [{
      pid: 11,
      command: 'node scripts/safe-merge.mjs 1981 --squash --admin',
      elapsedMs: 200_000,
    }]);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    const evaluate = vi.fn(async () => 'stuck');
    wd.intelligence = { evaluate } as any;

    await (wd as any).checkSession('echo-stall-sentinel-recovery');
    await (wd as any).checkSession('echo-stall-sentinel-recovery');

    expect(evaluate).not.toHaveBeenCalled();
    expect(sm.sendKey).not.toHaveBeenCalled();
    expect((wd as any).temporaryExclusions.has(11)).toBe(false);
  });

  it('never judges or signals Vitest\'s esbuild service child', async () => {
    const sm = {
      listRunningSessions: vi.fn(() => [{ tmuxSession: 'topic-67366', framework: 'codex-cli' }]),
      captureOutput: vi.fn(() => 'RUN tests/unit/example.test.ts'),
      sendKey: vi.fn(),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-esbuild-service-integration',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 1, hardCeilingSec: 2 } },
    } as any, sm as any, {} as any);
    (wd as any).getClaudePid = vi.fn(async () => 10);
    (wd as any).getChildProcesses = vi.fn(async () => [{
      pid: 11,
      parentPid: 10,
      command: '/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5 --ping',
      elapsedMs: 60_000,
    }]);
    const evaluate = vi.fn(async () => 'stuck');
    const signal = vi.fn(async () => true);
    wd.intelligence = { evaluate } as any;
    (wd as any).signalIfIdentityMatches = signal;

    await (wd as any).checkSession('topic-67366');

    expect(evaluate).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(sm.sendKey).not.toHaveBeenCalled();
  });

  it('recognizes a live esbuild service process from the real process table', async () => {
    const sm = {
      listRunningSessions: vi.fn(() => [{ tmuxSession: 'real-esbuild', framework: 'codex-cli' }]),
      captureOutput: vi.fn(() => 'RUN real test process'),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-real-esbuild-integration',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 0 } },
    } as any, sm as any, {} as any);
    type Row = { pid: number; parentPid: number; command: string; elapsedMs: number };
    const snapshot = (): Promise<Row[]> => (wd as any).getChildProcesses(process.pid);
    // Cleanup uses a strict whole-table read: production enumeration intentionally
    // returns [] on failure and excludes children orphaned by an unexpected exit.
    const cleanupSnapshot = async (): Promise<Row[]> => {
      const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      if (!stdout.trim()) throw new Error('fixture cleanup process table unavailable');
      return stdout.split('\n').flatMap(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3], elapsedMs: 0 }] : [];
      });
    };
    const esbuild = spawn(path.resolve('node_modules/.bin/esbuild'), ['--service=0.21.5', '--ping'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let spawnError: string | null = null;
    esbuild.on('error', error => { spawnError = (error as NodeJS.ErrnoException).code ?? 'spawn-error'; });
    let closed = false;
    const joined = new Promise<void>(resolve => esbuild.once('close', () => { closed = true; resolve(); }));
    const owned = new Map<number, Row>();
    const observeOwned = (rows: Row[]) => {
      // npm may install a native executable or a Node shim with a native child.
      const ids = new Set([esbuild.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) if (ids.has(row.parentPid) && !ids.has(row.pid)) {
          ids.add(row.pid); changed = true;
        }
      }
      for (const row of rows) if (ids.has(row.pid)) owned.set(row.pid, row);
      return rows.filter(row => ids.has(row.pid));
    };
    const liveOwned = (rows: Row[]) => rows.filter(row => {
      const prior = owned.get(row.pid);
      return prior && prior.parentPid === row.parentPid && prior.command === row.command;
    });
    cleanups.push(async () => {
      // EOF lets the service exit and the shim's synchronous child wait unwind.
      esbuild.stdin?.on('error', () => { /* EPIPE means the reader already exited. */ });
      esbuild.stdin?.end();
      const deadline = performance.now() + 3000;
      while (!closed && performance.now() < deadline) await delay(25);
      if (!closed) {
        const rows = await cleanupSnapshot();
        if (esbuild.exitCode === null && esbuild.signalCode === null &&
          rows.some(row => row.pid === esbuild.pid && row.parentPid === process.pid)) observeOwned(rows);
        const candidates = liveOwned(rows);
        // Recheck each identity immediately before signalling. Descendants first.
        candidates.sort((left, right) => Number(left.pid === esbuild.pid) - Number(right.pid === esbuild.pid));
        for (const candidate of candidates) {
          const current = (await cleanupSnapshot()).find(row => row.pid === candidate.pid);
          if (!current || current.parentPid !== candidate.parentPid || current.command !== candidate.command) continue;
          try { process.kill(candidate.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        const killDeadline = performance.now() + 3000;
        while (!closed && performance.now() < killDeadline) await delay(25);
      }
      expect(closed, 'owned esbuild fixture must close after EOF or bounded cleanup').toBe(true);
      await joined;
      expect((await cleanupSnapshot()).filter(row => owned.get(row.pid)?.command === row.command),
        'owned esbuild descendants must be reaped, including unexpectedly orphaned children').toEqual([]);
    });
    let service: Row | undefined;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (spawnError || closed || esbuild.exitCode !== null || esbuild.signalCode !== null) {
        throw new Error(`esbuild fixture exited before readiness: ${spawnError ?? esbuild.exitCode ?? esbuild.signalCode ?? 'closed'}`);
      }
      service = observeOwned(await snapshot()).find(entry => classifyLongLivedServiceProcess(entry.command).protected);
      if (service) break;
      await delay(50);
    }
    expect(service?.command, 'owned esbuild service must appear in the real process table within 5s')
      .toContain('esbuild --service=0.21.5 --ping');
    (wd as any).getClaudePid = vi.fn(async () => process.pid);
    (wd as any).getChildProcesses = vi.fn(async () => [{ ...service, elapsedMs: 60_000 }]);
    const judge = vi.fn(async () => 'stuck');
    const signal = vi.fn(async () => true);
    wd.intelligence = { evaluate: judge } as any;
    (wd as any).signalIfIdentityMatches = signal;

    await (wd as any).checkSession('real-esbuild');

    expect(judge).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(esbuild.exitCode).toBeNull();
    expect(esbuild.signalCode).toBeNull();
    expect(closed).toBe(false);
  }, 15_000);
});
