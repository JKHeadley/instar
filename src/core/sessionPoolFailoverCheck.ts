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
 *
 * ── Scope note ──
 * This check requires the instar SOURCE + a vitest runner on the executing
 * machine (a dev / test-as-self context). A deployed agent with no source cannot
 * use it; that agent needs the separate in-process check (a tracked follow-up).
 * The process spawn itself is INJECTED (`runProcess`) so this module is pure and
 * unit-tests with zero real subprocess.
 */

import type { FailoverCheckResult } from './SessionPoolFailoverRunner.js';

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
    return {
      outcome: r.exitCode === 0 ? 'green' : 'red',
      evidenceRef: r.evidenceRef,
    };
  };
}
