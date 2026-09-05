import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyLongLivedServiceProcess, SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog safe-wait pipeline', () => {
  const children: Array<ReturnType<typeof spawn>> = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });
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
    const esbuild = spawn(path.resolve('node_modules/.bin/esbuild'), ['--service=0.21.5', '--ping'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    children.push(esbuild);
    await new Promise<void>((resolve, reject) => {
      esbuild.once('spawn', () => setTimeout(resolve, 100));
      esbuild.once('error', reject);
    });

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
    const observed = await (wd as any).getChildProcesses(process.pid);
    const service = observed.find((entry: any) => classifyLongLivedServiceProcess(entry.command).protected);
    expect(service?.command).toContain('esbuild --service=0.21.5 --ping');
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
  });
});
