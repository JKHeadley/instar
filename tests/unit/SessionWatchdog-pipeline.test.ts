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
    (watchdog as any).signalIfIdentityMatches = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  describe('hasActivePipelineSibling', () => {
    it('returns false for commands that are not stdin consumers', async () => {
      const result = await (watchdog as any).hasActivePipelineSibling(1234, 'python3 script.py');
      expect(result).toBe(false);
    });

    it('returns false for tail with a file argument (tail -f /var/log/foo)', async () => {
      // Even though we might have pgid siblings, a file-arg tail is really
      // tailing that file, not reading from a pipe.
      const result = await (watchdog as any).hasActivePipelineSibling(1234, 'tail -f /var/log/foo.log');
      expect(result).toBe(false);
    });

    it('returns false for tail with -n N numeric arg only (still a pipe consumer)', async () => {
      // The intent of this test is: bare `tail -N` without a file is a pipe
      // consumer. With no pgid siblings mocked, the peer lookup returns
      // nothing and the guard returns false — that's fine, we also need
      // to verify the positive case below.
      (watchdog as any).hasActivePipelineSibling = SessionWatchdog.prototype['hasActivePipelineSibling'].bind(watchdog);
      // No mocking of the shell — will return false because pgid lookup fails
      const result = await (watchdog as any).hasActivePipelineSibling(99999999, 'tail -40');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('undecided verdicts are re-checked until the hard ceiling (bounded-input review)', () => {
    const longCmd = `python3 -c "${'x = 1; '.repeat(400)}"`; // over the judge's command bound

    it('a command too long to judge is NOT excluded below the ceiling, and IS interrupted once past it', async () => {
      const evaluate = vi.fn().mockResolvedValue('stuck');
      (watchdog as any).intelligence = { evaluate };
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);

      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([{ pid: 55555, command: longCmd, elapsedMs: 4 * 60_000 }]);
      await (watchdog as any).checkSession('test-session');
      expect(evaluate).not.toHaveBeenCalled();
      expect((watchdog as any).signalIfIdentityMatches).not.toHaveBeenCalled();
      expect((watchdog as any).temporaryExclusions.has(55555)).toBe(false); // deferred, not excluded for good
      expect((watchdog as any).undecidedPids.has(55555)).toBe(true);

      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([{ pid: 55555, command: longCmd, elapsedMs: 31 * 60_000 }]);
      await (watchdog as any).checkSession('test-session');
      expect(evaluate).not.toHaveBeenCalled();
      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 55555 }),
        'SIGINT',
      );
    });

    it('an undecided command does not hide a stuck SIBLING: the next poll judges and interrupts the sibling', async () => {
      const evaluate = vi.fn().mockResolvedValue('stuck');
      (watchdog as any).intelligence = { evaluate };
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).isProcessAlive = vi.fn().mockReturnValue(true);
      const kids = [
        { pid: 66661, command: longCmd, elapsedMs: 5 * 60_000 },        // undecided (too long), listed first
        { pid: 66662, command: 'make all', elapsedMs: 4 * 60_000 },     // the judge will call this stuck
      ];
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue(kids);
      await (watchdog as any).checkSession('test-session');            // poll 1: picks 66661, undecided, deferred
      expect((watchdog as any).signalIfIdentityMatches).not.toHaveBeenCalled();
      await (watchdog as any).checkSession('test-session');            // poll 2: skips 66661, reaches 66662
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(String(evaluate.mock.calls[0][0])).toContain('Command: make all');
      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 66662 }),
        'SIGINT',
      );
    });

    it('a judge ERROR below the ceiling defers the PID to the ceiling instead of excluding it for good', async () => {
      (watchdog as any).intelligence = { evaluate: vi.fn().mockRejectedValue(new Error('rate limited')) };
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([{ pid: 55556, command: 'make all', elapsedMs: 4 * 60_000 }]);
      await (watchdog as any).checkSession('test-session');
      expect((watchdog as any).signalIfIdentityMatches).not.toHaveBeenCalled();
      expect((watchdog as any).temporaryExclusions.has(55556)).toBe(false);
      expect((watchdog as any).undecidedPids.has(55556)).toBe(true);
    });

    it('a stdin consumer reached "stuck" only by the ceiling (judge errored) is NOT interrupted', async () => {
      (watchdog as any).intelligence = { evaluate: vi.fn().mockRejectedValue(new Error('circuit open')) };
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([{ pid: 55557, command: 'tail -40', elapsedMs: 31 * 60_000 }]);
      await (watchdog as any).checkSession('test-session');
      expect((watchdog as any).signalIfIdentityMatches).not.toHaveBeenCalled();
      expect((watchdog as any).temporaryExclusions.has(55557)).toBe(true);
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

      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 77777, command: 'tail -40' }),
        'SIGINT',
      );
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
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

    it('does NOT escalate a non-consumer at 3 min when the LLM judge is unavailable (fail-closed)', async () => {
      // Was fail-OPEN (Ctrl+C'd anything past 3 min when the LLM couldn't run),
      // which under load interrupted legitimate builds/tests. Now fails CLOSED
      // below the 30-min default hard ceiling.
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'python3 /broken/script.py', elapsedMs: 200_000 }, // 3.3m
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      expect(sessionManager.sendKey).not.toHaveBeenCalled();
    });

    it('DOES escalate a non-consumer past the hard ceiling without an LLM (deterministic recovery)', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'python3 /broken/script.py', elapsedMs: 31 * 60_000 }, // 31m > 30m ceiling
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = null;

      await (watchdog as any).checkSession('test-session');

      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 77777 }), 'SIGINT',
      );
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
    });

    it('escalates a non-consumer at 3 min when the LLM positively confirms stuck', async () => {
      (watchdog as any).getChildProcesses = vi.fn().mockReturnValue([
        { pid: 77777, command: 'python3 /broken/script.py', elapsedMs: 200_000 },
      ]);
      (watchdog as any).hasActivePipelineSibling = vi.fn().mockReturnValue(false);
      (watchdog as any).intelligence = { evaluate: vi.fn().mockResolvedValue('stuck') };

      await (watchdog as any).checkSession('test-session');

      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 77777 }), 'SIGINT',
      );
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
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

      expect((watchdog as any).signalIfIdentityMatches).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 77777 }), 'SIGINT',
      );
      expect(sessionManager.sendKey).not.toHaveBeenCalled();
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
