/**
 * Wiring for the poll-loop protection (2026-11-27): the watchdog itself must record a timed sleep it
 * sees below a long-lived shell and use that evidence on a later poll, when the loop is mid-check and
 * no sleep is visible. The pure classifier rule is covered in session-watchdog-timed-sleep-and-notice.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SessionWatchdog, POLL_LOOP_SLEEP_RECENT_MS } from '../../src/monitoring/SessionWatchdog.js';

const config = () => ({
  stateDir: '/tmp/test-watchdog-poll-loop',
  sessions: { tmuxPath: 'tmux' },
  monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000 } },
}) as any;

const sessionManager = () => ({
  listRunningSessions: vi.fn().mockReturnValue([]),
  captureOutput: vi.fn().mockReturnValue(''),
  sendKey: vi.fn().mockReturnValue(true),
  isSessionAlive: vi.fn().mockReturnValue(true),
}) as any;

const SHELL = { pid: 5001, parentPid: 12345, command: '/bin/zsh /private/tmp/scratchpad/watch-07a05cb5.sh' };

afterEach(() => { vi.useRealTimers(); });

describe('SessionWatchdog poll-loop wiring', () => {
  it('a quiet watch loop is left alone while sleeping and mid-check, and judged once it stops sleeping', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T08:00:00Z'));
    const wd = new SessionWatchdog(config(), sessionManager(), {} as any) as any;
    wd.getClaudePid = vi.fn().mockReturnValue(12345);
    wd.isProcessAlive = vi.fn().mockReturnValue(true);
    const judge = vi.fn().mockResolvedValue({ verdict: 'undecided', by: 'none' });
    wd.judgeCommand = judge;

    // Poll 1: the loop is 400 s old and its 15 s sleep is running below it.
    wd.getChildProcesses = vi.fn().mockResolvedValue([
      { ...SHELL, elapsedMs: 400_000 },
      { pid: 5002, parentPid: 5001, command: 'sleep 15', elapsedMs: 3_000 },
    ]);
    await wd.checkSession('echo-subscription-management');
    expect(judge).not.toHaveBeenCalled();

    // Poll 2, 30 s later: caught mid-check (curl, no sleep visible). The recent sleep still protects it.
    vi.setSystemTime(new Date('2026-11-27T08:00:30Z'));
    wd.getChildProcesses = vi.fn().mockResolvedValue([
      { ...SHELL, elapsedMs: 430_000 },
      { pid: 5003, parentPid: 5001, command: 'curl -s -m 30 http://localhost:4042/x', elapsedMs: 1_000 },
    ]);
    await wd.checkSession('echo-subscription-management');
    expect(judge).not.toHaveBeenCalled();

    // Poll 3: no sleep seen for longer than the window (the loop hung inside its check): judged as before.
    vi.setSystemTime(new Date(Date.parse('2026-11-27T08:00:00Z') + POLL_LOOP_SLEEP_RECENT_MS + 1_000));
    wd.getChildProcesses = vi.fn().mockResolvedValue([
      { ...SHELL, elapsedMs: 400_000 + POLL_LOOP_SLEEP_RECENT_MS + 1_000 },
      { pid: 5003, parentPid: 5001, command: 'curl -s -m 30 http://localhost:4042/x', elapsedMs: 290_000 },
    ]);
    await wd.checkSession('echo-subscription-management');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toBe(SHELL.command);
    wd.stop?.();
  });

  it('forgets a loop once its process exits', async () => {
    const wd = new SessionWatchdog(config(), sessionManager(), {} as any) as any;
    wd.getClaudePid = vi.fn().mockReturnValue(12345);
    wd.judgeCommand = vi.fn().mockResolvedValue({ verdict: 'undecided', by: 'none' });
    wd.getChildProcesses = vi.fn().mockResolvedValue([
      { ...SHELL, elapsedMs: 400_000 },
      { pid: 5002, parentPid: 5001, command: 'sleep 15', elapsedMs: 3_000 },
    ]);
    wd.isProcessAlive = vi.fn().mockReturnValue(true);
    await wd.checkSession('s');
    expect(wd.timedSleepSeenAt.has(SHELL.pid)).toBe(true);
    wd.isProcessAlive = vi.fn().mockReturnValue(false);
    wd.getChildProcesses = vi.fn().mockResolvedValue([]);
    await wd.checkSession('s');
    expect(wd.timedSleepSeenAt.has(SHELL.pid)).toBe(false);
    wd.stop?.();
  });
});
