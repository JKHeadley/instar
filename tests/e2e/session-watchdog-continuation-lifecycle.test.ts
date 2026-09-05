import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog targeted interruption lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('attributes its targeted SIGINT without creating an independent continuation writer', async () => {
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
    (wd as any).getChildProcesses = vi.fn(async () => [{ pid: 21, parentPid: 20, command: 'node hung.mjs', elapsedMs: 200_000 }]);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    const targetedSignal = vi.fn(async () => true);
    (wd as any).signalIfIdentityMatches = targetedSignal;
    wd.intelligence = { evaluate: vi.fn(async () => 'stuck') } as any;
    const interventions: any[] = [];
    wd.on('intervention', event => interventions.push(event));

    await (wd as any).checkSession('topic-59199');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(targetedSignal).toHaveBeenCalledWith(expect.objectContaining({ pid: 21 }), 'SIGINT');
    expect(sm.sendKey).not.toHaveBeenCalled();
    expect(sm.sendInput).not.toHaveBeenCalled();
    expect(interventions).toEqual([expect.objectContaining({
      principal: 'session-watchdog',
      reason: 'stuck-command-judge',
      operatorInitiated: false,
      stuckParentPid: 20,
      processRole: 'user-command',
      effectScope: 'target-process',
    })]);
  });

  it('does not record an intervention or inject input when the target identity fence fails', async () => {
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
    (wd as any).getChildProcesses = vi.fn(async () => [{ pid: 21, parentPid: 20, command: 'node hung.mjs', elapsedMs: 200_000 }]);
    (wd as any).hasActivePipelineSibling = vi.fn(async () => false);
    (wd as any).signalIfIdentityMatches = vi.fn(async () => false);
    wd.intelligence = { evaluate: vi.fn(async () => 'stuck') } as any;
    const interventions: any[] = [];
    wd.on('intervention', event => interventions.push(event));

    await (wd as any).checkSession('topic-59199');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(interventions).toEqual([]);
    expect(sm.sendInput).not.toHaveBeenCalled();
  });

  it('discards escalation inherited by a replacement session with the same tmux name', async () => {
    const sm = {
      listRunningSessions: vi.fn(() => [{
        id: 'replacement', tmuxSession: 'topic-59199', startedAt: '2026-09-04T20:00:00.000Z',
      }]),
      captureOutput: vi.fn(() => ''),
    };
    const wd = new SessionWatchdog({
      stateDir: '/tmp/watchdog-incarnation-e2e',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180 } },
    } as any, sm as any, {} as any);
    (wd as any).escalationState.set('topic-59199', {
      level: 1,
      levelEnteredAt: Date.now() - 60_000,
      stuckChildPid: 21,
      stuckChildParentPid: 20,
      stuckCommand: 'node hung.mjs',
      sessionId: 'original',
      sessionStartedAt: '2026-09-04T19:00:00.000Z',
      retryCount: 0,
    });
    const handle = vi.spyOn(wd as any, 'handleEscalation');

    await (wd as any).checkSession('topic-59199');

    expect(handle).not.toHaveBeenCalled();
    expect((wd as any).escalationState.has('topic-59199')).toBe(false);
  });
});
