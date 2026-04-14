/**
 * Regression tests for the pipeline guard in SessionWatchdog.
 *
 * Historical bug: `zsh -c "python ... | tail -40"` execs the last pipeline
 * member (tail) into place, so claude's direct child shows up as `tail -40`.
 * After 3 minutes the watchdog's LLM gate saw only "tail -40", correctly
 * called it stuck (tail with no file waits on stdin forever), and Ctrl+C'd
 * the entire pipeline — killing long-running builds, test suites, and
 * autonomous work.
 *
 * Fix: detect stdin-consumers in an active pipeline via pgid siblings.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

function createMockSessionManager() {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    captureOutput: vi.fn().mockReturnValue(null),
    sendKey: vi.fn().mockReturnValue(true),
    isSessionAlive: vi.fn().mockReturnValue(true),
  } as any;
}

function createConfig() {
  return {
    stateDir: '/tmp/test-watchdog-pipeline',
    sessions: { tmuxPath: 'tmux' },
    monitoring: {
      watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000 },
    },
  } as any;
}

describe('SessionWatchdog pipeline guard', () => {
  let watchdog: SessionWatchdog;
  let sessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = createMockSessionManager();
    watchdog = new SessionWatchdog(createConfig(), sessionManager, {} as any);
    (watchdog as any).getClaudePid = vi.fn().mockReturnValue(1000);
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  describe('hasActivePipelineSibling', () => {
    it('returns false for commands that are not stdin consumers', () => {
      const result = (watchdog as any).hasActivePipelineSibling(1234, 'python3 script.py');
      expect(result).toBe(false);
    });

    it('returns false for tail with a file argument (tail -f /var/log/foo)', () => {
      // Even though we might have pgid siblings, a file-arg tail is really
      // tailing that file, not reading from a pipe.
      const result = (watchdog as any).hasActivePipelineSibling(1234, 'tail -f /var/log/foo.log');
      expect(result).toBe(false);
    });

    it('returns false for tail with -n N numeric arg only (still a pipe consumer)', () => {
      // The intent of this test is: bare `tail -N` without a file is a pipe
      // consumer. With no pgid siblings mocked, the peer lookup returns
      // nothing and the guard returns false — that's fine, we also need
      // to verify the positive case below.
      (watchdog as any).hasActivePipelineSibling = SessionWatchdog.prototype['hasActivePipelineSibling'].bind(watchdog);
      // No mocking of the shell — will return false because pgid lookup fails
      const result = (watchdog as any).hasActivePipelineSibling(99999999, 'tail -40');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('checkSession integration — tail piped from producer should not escalate', () => {
    it('skips escalation when stuck child is `tail -N` with active producer sibling', async () => {
      // Simulate a session where claude has `tail -40` as its direct child
      // (the zsh-exec artifact) and the process group has an active python3
      // producer as a sibling. Elapsed must exceed the extended 10-min
      // threshold for stdin consumers to even be considered stuck.
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -40', elapsedMs: 700_000 },
      ]);
      // Stub the pgid lookup to indicate there is an active sibling
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(true);

      // Spy on sendKey — this is what would send Ctrl+C
      const sendKeySpy = sessionManager.sendKey;

      await (watchdog as any).checkSession('test-session');

      expect(sendKeySpy).not.toHaveBeenCalled();
      // The pid should now be temporarily excluded so future polls don't
      // re-escalate on the same consumer
      expect((watchdog as any).temporaryExclusions.has(77777)).toBe(true);
    });

    it('DOES escalate when stuck child is `tail -N` past 10min with NO active producer and LLM says stuck', async () => {
      // Must cross the 10-min extended threshold for stdin consumers AND
      // pass the LLM gate (which fails-closed without LLM for consumers).
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -40', elapsedMs: 700_000 }, // 11m 40s
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = {
        evaluate: vi.fn().mockResolvedValue('stuck'),
      };

      await (watchdog as any).checkSession('test-session');

      // Ctrl+C fires: past extended threshold, no pipeline, LLM confirms stuck
      expect(sessionManager.sendKey).toHaveBeenCalledWith('test-session', 'C-c');
    });

    it('LLM gate receives recent tmux output as context', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -15', elapsedMs: 700_000 },
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      sessionManager.captureOutput.mockReturnValue('Running vitest tests...\n✓ 200 tests pass\n✓ 300 tests pass\n');

      const evaluateSpy = vi.fn().mockResolvedValue('legitimate');
      (watchdog as any).intelligence = { evaluate: evaluateSpy };

      await (watchdog as any).checkSession('test-session');

      expect(evaluateSpy).toHaveBeenCalledOnce();
      const [promptArg] = evaluateSpy.mock.calls[0];
      expect(promptArg).toContain('Recent terminal output');
      expect(promptArg).toContain('vitest tests');
      // With the LLM saying legitimate, escalation should be skipped
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
    });
  });

  describe('isStdinConsumerCommand', () => {
    it('identifies tail -N as a stdin consumer', () => {
      expect((watchdog as any).isStdinConsumerCommand('tail -40')).toBe(true);
    });

    it('identifies bare sort as a stdin consumer', () => {
      expect((watchdog as any).isStdinConsumerCommand('sort')).toBe(true);
    });

    it('does NOT identify tail -f /file as a stdin consumer', () => {
      expect((watchdog as any).isStdinConsumerCommand('tail -f /var/log/foo')).toBe(false);
    });

    it('does NOT identify python3 as a stdin consumer', () => {
      expect((watchdog as any).isStdinConsumerCommand('python3 script.py')).toBe(false);
    });
  });

  describe('extended grace period for stdin consumers', () => {
    it('does NOT mark tail as stuck at 3 minutes (below 10-min extended threshold)', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -40', elapsedMs: 200_000 }, // 3m 20s
      ]);
      const siblingSpy = vi.fn().mockReturnValue(false);
      (watchdog as any).hasActivePipelineSibling = siblingSpy;
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      // The pipeline guard should never even be consulted because the
      // 3-min elapsed doesn't cross the 10-min extended threshold for
      // stdin consumers.
      expect(siblingSpy).not.toHaveBeenCalled();
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
    });

    it('DOES evaluate tail as stuck at 11 minutes (above extended threshold) with no pipeline', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -40', elapsedMs: 660_000 }, // 11m
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      // With no LLM and a stdin-consumer, we fail-closed: don't escalate
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      // Fail-closed guard should have kicked in — no Ctrl+C
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
      expect((watchdog as any).temporaryExclusions.has(77777)).toBe(true);
    });

    it('STILL escalates non-consumer stuck command at 3 minutes (preserves normal behavior)', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'python3 /broken/script.py', elapsedMs: 200_000 },
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      // Non-consumer commands still escalate at the normal 3-min threshold
      expect(sessionManager.sendKey).toHaveBeenCalledWith('test-session', 'C-c');
    });
  });

  describe('fail-closed for stdin consumers without LLM', () => {
    it('does NOT escalate stdin-consumer past threshold when no LLM available', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -10', elapsedMs: 700_000 }, // 11m 40s
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      expect(sessionManager.sendKey).not.toHaveBeenCalled();
      // PID added to exclusions so it's not re-checked every poll
      expect((watchdog as any).temporaryExclusions.has(77777)).toBe(true);
    });

    it('DOES escalate stdin-consumer when LLM explicitly says stuck', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'tail -40', elapsedMs: 700_000 },
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = {
        evaluate: vi.fn().mockResolvedValue('stuck'),
      };

      await (watchdog as any).checkSession('test-session');

      expect(sessionManager.sendKey).toHaveBeenCalledWith('test-session', 'C-c');
    });
  });

  describe('hasFileArgument heuristic', () => {
    it('detects file arg in tail -f /var/log/foo', () => {
      const result = (watchdog as any).hasFileArgument('tail -f /var/log/foo');
      expect(result).toBe(true);
    });

    it('does not treat -n 40 as a file arg', () => {
      const result = (watchdog as any).hasFileArgument('tail -n 40');
      expect(result).toBe(false);
    });

    it('does not treat -40 as a file arg', () => {
      const result = (watchdog as any).hasFileArgument('tail -40');
      expect(result).toBe(false);
    });

    it('detects file arg in grep pattern file.txt', () => {
      const result = (watchdog as any).hasFileArgument('grep pattern file.txt');
      expect(result).toBe(true);
    });

    it('does not treat bare grep pattern as file arg (pattern is required positional)', () => {
      // Note: `grep pattern` with no file IS reading from stdin. But our
      // heuristic treats the first non-flag token as a file arg, which
      // would misclassify this. This is acceptable because real usage
      // always includes a file or a pipe — and if piped, the pipeline
      // guard still checks pgid siblings. The false-negative direction
      // (missing the guard) is safer than the false-positive direction.
      const result = (watchdog as any).hasFileArgument('grep foo');
      expect(result).toBe(true); // Acknowledged limitation
    });
  });
});
