import { describe, expect, it, vi } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog safe-wait pipeline', () => {
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
});
