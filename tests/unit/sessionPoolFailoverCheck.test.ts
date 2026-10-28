import { describe, it, expect } from 'vitest';
import {
  makeSubprocessFailoverCheck,
  DEFAULT_FAILOVER_E2E_PATH,
  DEFAULT_FAILOVER_TIMEOUT_MS,
  FAILOVER_CHECK_CAPACITY_EXIT_CODE,
  parseVitestJsonReport,
  type SubprocessRunResult,
} from '../../src/core/sessionPoolFailoverCheck.js';

import { TEST_RUNNER_CAPACITY_EXIT_CODE } from '../../src/core/hostTestRunnerSemaphore.js';

function runProcessReturning(result: SubprocessRunResult, capture?: (a: { testPath: string; timeoutMs: number }) => void) {
  return async (args: { testPath: string; timeoutMs: number }) => {
    capture?.(args);
    return result;
  };
}

describe('makeSubprocessFailoverCheck — honest verdict mapping', () => {
  it('exit 0 (ran to completion) → green', async () => {
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: true, exitCode: 0, evidenceRef: 'run-1' }),
    });
    await expect(check()).resolves.toEqual({ outcome: 'green', evidenceRef: 'run-1' });
  });

  it('exit non-zero (ran to completion) → red', async () => {
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: true, exitCode: 1, evidenceRef: 'run-2' }),
    });
    await expect(check()).resolves.toEqual({ outcome: 'red', evidenceRef: 'run-2' });
  });

  it('did NOT run to completion → THROWS (so the runner records nothing)', async () => {
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: false, exitCode: null, evidenceRef: 'spawn-failed' }),
    });
    await expect(check()).rejects.toThrow(/did not run to completion/);
  });

  it('null exit code even if flagged complete → THROWS (no fabricated verdict)', async () => {
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: true, exitCode: null, evidenceRef: 'no-code' }),
    });
    await expect(check()).rejects.toThrow(/did not run to completion/);
  });

  it('uses the merged two-node failover E2E + a bounded timeout by default', async () => {
    let seen: { testPath: string; timeoutMs: number } | undefined;
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: true, exitCode: 0, evidenceRef: 'r' }, (a) => { seen = a; }),
    });
    await check();
    expect(seen?.testPath).toBe(DEFAULT_FAILOVER_E2E_PATH);
    expect(seen?.timeoutMs).toBe(DEFAULT_FAILOVER_TIMEOUT_MS);
  });

  it('honours an explicit testPath + timeout override', async () => {
    let seen: { testPath: string; timeoutMs: number } | undefined;
    const check = makeSubprocessFailoverCheck({
      runProcess: runProcessReturning({ ranToCompletion: true, exitCode: 0, evidenceRef: 'r' }, (a) => { seen = a; }),
      testPath: 'tests/e2e/custom.test.ts',
      timeoutMs: 5000,
    });
    await check();
    expect(seen).toEqual({ testPath: 'tests/e2e/custom.test.ts', timeoutMs: 5000 });
  });
});

describe('makeSubprocessFailoverCheck — a run where no failover test executed is INCONCLUSIVE (CMT-1117)', () => {
  const check = (r: SubprocessRunResult) => makeSubprocessFailoverCheck({ runProcess: runProcessReturning(r) })();

  it('the local capacity exit code mirrors the semaphore constant', () => {
    expect(FAILOVER_CHECK_CAPACITY_EXIT_CODE).toBe(TEST_RUNNER_CAPACITY_EXIT_CODE);
  });

  it('exit 75 (test runner refused to start) → THROWS, never red', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 75, evidenceRef: 'cap' })).rejects.toThrow(/inconclusive/);
  });

  it('exit 1 with NO readable report → THROWS, never red', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 1, evidenceRef: 'cap', testReport: null })).rejects.toThrow(/no test report/);
  });

  it('exit 1 with an EMPTY report (globalSetup capacity refusal: vitest overwrites 75 with 1 and writes 0/0) → THROWS, never red', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 1, evidenceRef: 'cap', testReport: { executedTests: 0, failedSuites: 0 } })).rejects.toThrow(/no test executed/);
  });

  it('exit 0 with zero executed tests (all skipped) → THROWS, never green', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 0, evidenceRef: 'skip', testReport: { executedTests: 0, failedSuites: 0 } })).rejects.toThrow(/no test executed/);
  });

  it('exit 1 with an executed failing test → red (a real regression still demotes)', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 1, evidenceRef: 'r', testReport: { executedTests: 3, failedSuites: 0 } })).resolves.toEqual({ outcome: 'red', evidenceRef: 'r' });
  });

  it('exit 1 with a failed suite but no executed test (beforeAll threw in the E2E) → red', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 1, evidenceRef: 'r', testReport: { executedTests: 0, failedSuites: 1 } })).resolves.toEqual({ outcome: 'red', evidenceRef: 'r' });
  });

  it('exit 0 with executed tests → green', async () => {
    await expect(check({ ranToCompletion: true, exitCode: 0, evidenceRef: 'g', testReport: { executedTests: 3, failedSuites: 0 } })).resolves.toEqual({ outcome: 'green', evidenceRef: 'g' });
  });
});

describe('parseVitestJsonReport', () => {
  it('reads executed tests (passed + failed) and failed suites', () => {
    expect(parseVitestJsonReport(JSON.stringify({ numPassedTests: 2, numFailedTests: 1, numPendingTests: 4, numTodoTests: 0, numFailedTestSuites: 0 })))
      .toEqual({ executedTests: 3, failedSuites: 0 });
  });
  it('returns null for absent, torn, or wrong-shape input (never a guess)', () => {
    expect(parseVitestJsonReport(null)).toBeNull();
    expect(parseVitestJsonReport('')).toBeNull();
    expect(parseVitestJsonReport('{"numPassedTests":')).toBeNull();
    expect(parseVitestJsonReport('{"numPassedTests":1}')).toBeNull();
    expect(parseVitestJsonReport('[]')).toBeNull();
  });
});
