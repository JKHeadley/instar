/**
 * Subprocess failover check — the injectable `runFailoverCheck` for
 * `SessionPoolFailoverRunner` that produces an HONEST green/red verdict by
 * running the REAL two-node sessionPool failover E2E as a bounded subprocess.
 *
 * Why a subprocess (not an in-process re-implementation): the proven failover
 * assertion already lives in `tests/e2e/sessionpool-failover-two-node.test.ts`
 * (the merged #1551 E2E — real two servers, real ownership FSM, real force-claim
 * takeover). Re-implementing it in-process risks a DIFFERENT, weaker check that
 * could green a broken failover (the exact honesty-line risk the runner guards).
 * Running the SAME vitest E2E as a bounded subprocess reuses that trusted
 * assertion verbatim, so the recorded green means what CI's green means.
 *
 * ── Honesty mapping (load-bearing) ──
 * The runner records green on a genuine pass, red on a genuine regression, and
 * NOTHING on a throw. This check honours that three-way contract:
 *   ran to completion, exit 0        → { outcome: 'green' }   (failover proven)
 *   ran to completion, exit non-zero → { outcome: 'red' }     (real regression)
 *   did NOT run to completion         → THROW                 (spawn error / timeout
 *     (or a null exit code)              / harness couldn't run — NOT a failover
 *                                        verdict; the runner records nothing so a
 *                                        transient infra failure never masquerades
 *                                        as a red demotion or a green promotion).
 *   exited, but NO test executed      → THROW                 (INCONCLUSIVE — CMT-1117)
 *     (exit 75, or the run's test report
 *      is missing, or shows zero executed tests and zero failed suites)
 *
 * The last row exists because "the process exited" is not "the failover test
 * ran". The host test-runner bound refuses a run it cannot admit with
 * INSTAR_TEST_CAPACITY_TIMEOUT inside vitest's globalSetup; vitest then exits 1
 * (it overwrites the semaphore's exit 75), the E2E never started, and the old
 * mapping recorded that as a red — 25 of 29 reds on 2026-10-28 were these, and
 * each one demoted the live sessionPool stage. A capacity refusal says the
 * machine was busy, nothing about failover.
 *
 * ── Scope note ──
 * This check requires the instar SOURCE + a vitest runner on the executing
 * machine (a dev / test-as-self context). A deployed agent with no source cannot
 * use it; that agent needs the separate in-process check (a tracked follow-up).
 * The process spawn itself is INJECTED (`runProcess`) so this module is pure and
 * unit-tests with zero real subprocess.
 */

import type { FailoverCheckResult } from './SessionPoolFailoverRunner.js';

/**
 * EX_TEMPFAIL — the host test-runner bound's "could not start" exit code. Mirrors
 * `TEST_RUNNER_CAPACITY_EXIT_CODE` in hostTestRunnerSemaphore.ts (kept local so
 * this module stays pure; a unit test pins the two equal).
 */
export const FAILOVER_CHECK_CAPACITY_EXIT_CODE = 75;

/** The default E2E the check runs — the merged #1551 real two-node failover. */
export const DEFAULT_FAILOVER_E2E_PATH = 'tests/e2e/sessionpool-failover-two-node.test.ts';
export const DEFAULT_FAILOVER_TIMEOUT_MS = 180_000;

/** Result of the injected process runner. `ranToCompletion:false` = could not run. */
export interface SubprocessRunResult {
  /** true iff the runner actually executed the suite to a verdict (exit code known). */
  ranToCompletion: boolean;
  /** The process exit code, or null when it did not run to completion. */
  exitCode: number | null;
  /** A durable, human-traceable pointer to this run (a log path / run id). */
  evidenceRef: string;
  /**
   * What the run's test report says actually executed. `null` = no readable
   * report — inconclusive. (A globalSetup capacity refusal writes an EMPTY
   * report: zero executed tests, zero failed suites — also inconclusive.) Omitted = this runner does not report
   * (legacy/injected runners), and only the exit code is consulted.
   */
  testReport?: FailoverTestReport | null;
}

/** The part of a vitest JSON report that says whether the E2E really ran. */
export interface FailoverTestReport {
  /** Tests that ran to a pass or a fail (skipped / todo / pending excluded). */
  executedTests: number;
  /** Suites that failed outright (a beforeAll throw, an import error in the file). */
  failedSuites: number;
}

/**
 * Parse a vitest `--reporter=json` output file. Returns null for anything that
 * is not a recognisable report (absent, torn, wrong shape) — never a guess.
 */
export function parseVitestJsonReport(text: string | null | undefined): FailoverTestReport | null {
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const passed = num(r.numPassedTests);
  const failed = num(r.numFailedTests);
  const failedSuites = num(r.numFailedTestSuites);
  if (passed === null || failed === null || failedSuites === null) return null;
  return { executedTests: passed + failed, failedSuites };
}

export interface SubprocessFailoverCheckDeps {
  /**
   * Spawn the failover E2E and resolve once it finishes (or times out). MUST
   * resolve — a spawn failure or timeout resolves with `ranToCompletion:false`,
   * NOT a rejection, so the mapping below owns the honesty decision.
   */
  runProcess: (args: { testPath: string; timeoutMs: number }) => Promise<SubprocessRunResult>;
  /** Which E2E to run (defaults to the merged two-node failover E2E). */
  testPath?: string;
  /** Bounded wall-clock budget for the subprocess. */
  timeoutMs?: number;
}

/**
 * Build the injectable `runFailoverCheck` for `SessionPoolFailoverRunner`. It
 * runs the real failover E2E as a bounded subprocess and maps the outcome per the
 * honesty contract above (throws when the check could not run, so the runner
 * records nothing).
 */
export function makeSubprocessFailoverCheck(
  deps: SubprocessFailoverCheckDeps,
): () => Promise<FailoverCheckResult> {
  const testPath = deps.testPath ?? DEFAULT_FAILOVER_E2E_PATH;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FAILOVER_TIMEOUT_MS;
  return async (): Promise<FailoverCheckResult> => {
    const r = await deps.runProcess({ testPath, timeoutMs });
    if (!r.ranToCompletion || r.exitCode === null) {
      // Could not run to a verdict → NOT a failover result. Throw so the runner
      // records nothing (never a fabricated green promotion or red demotion).
      throw new Error(
        `sessionPool failover check did not run to completion (evidence: ${r.evidenceRef})`,
      );
    }
    if (r.exitCode === FAILOVER_CHECK_CAPACITY_EXIT_CODE) {
      // EX_TEMPFAIL from the host test-runner bound: the E2E never started.
      throw new Error(
        `sessionPool failover check inconclusive: the test runner refused to start (exit ${r.exitCode}, capacity) (evidence: ${r.evidenceRef})`,
      );
    }
    if (r.testReport !== undefined) {
      const rep = r.testReport;
      if (rep === null || (rep.executedTests === 0 && rep.failedSuites === 0)) {
        // Exited, but no failover test ran: a globalSetup refusal exits 1 with
        // an empty report (verified against vitest 2.1.9); an all-skipped run
        // exits 0 with nothing proven. Neither is a failover verdict — record
        // nothing. A beforeAll throw or an import error in the E2E reports
        // failed suites, so it stays a real red.
        throw new Error(
          `sessionPool failover check inconclusive: exit ${r.exitCode} but ${rep === null ? 'no test report was written' : 'no test executed'} (evidence: ${r.evidenceRef})`,
        );
      }
    }
    return {
      outcome: r.exitCode === 0 ? 'green' : 'red',
      evidenceRef: r.evidenceRef,
    };
  };
}
