import { describe, it, expect } from 'vitest';
import {
  makeSubprocessFailoverCheck,
  DEFAULT_FAILOVER_E2E_PATH,
  DEFAULT_FAILOVER_TIMEOUT_MS,
  type SubprocessRunResult,
} from '../../src/core/sessionPoolFailoverCheck.js';

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
