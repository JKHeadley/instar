import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog non-operator interruption lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('attributes its Ctrl+C without creating an independent continuation writer', async () => {
    vi.useFakeTimers();
    const sm = {
      captureOutput: vi.fn(() => 'hung without progress'),
      sendKey: vi.fn(() => true),
      sendInput: vi.fn(() => true),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-continuation-e2e',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180 } },
    } as any, sm as any, {} as any);
    (wd as any).getClaudePid = vi.fn(async () => 20);
    (wd as any).getChildProcesses = vi.fn(async () => [{ pid: 21, command: 'node hung.mjs', elapsedMs: 200_000 }]);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    wd.intelligence = { evaluate: vi.fn(async () => 'stuck') } as any;
    const interventions: any[] = [];
    wd.on('intervention', event => interventions.push(event));

    await (wd as any).checkSession('topic-59199');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(sm.sendKey).toHaveBeenCalledOnce();
    expect(sm.sendInput).not.toHaveBeenCalled();
    expect(interventions).toEqual([expect.objectContaining({
      principal: 'session-watchdog',
      reason: 'stuck-command-judge',
      operatorInitiated: false,
    })]);
  });

  it('does not record an intervention or inject input when Ctrl+C delivery fails', async () => {
    vi.useFakeTimers();
    const sm = {
      captureOutput: vi.fn(() => 'hung without progress'),
      sendKey: vi.fn(() => false),
      sendInput: vi.fn(() => true),
      isSessionAlive: vi.fn(() => true),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-continuation-failed-e2e',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180 } },
    } as any, sm as any, {} as any);
    (wd as any).getClaudePid = vi.fn(async () => 20);
    (wd as any).getChildProcesses = vi.fn(async () => [{ pid: 21, command: 'node hung.mjs', elapsedMs: 200_000 }]);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    wd.intelligence = { evaluate: vi.fn(async () => 'stuck') } as any;
    const interventions: any[] = [];
    wd.on('intervention', event => interventions.push(event));

    await (wd as any).checkSession('topic-59199');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(interventions).toEqual([]);
    expect(sm.sendInput).not.toHaveBeenCalled();
  });
});
