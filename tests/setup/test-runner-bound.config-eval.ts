/**
 * test-runner-bound.config-eval — the shared CONFIG-EVAL seam of the
 * test-runner concurrency bound (spec §2.2/§2.3/§2.5).
 *
 * Every root vitest config calls `withTestRunnerBound(<name>, config)`. It:
 *  1. wires the globalSetup chokepoint entry (PREPENDED — teardown runs in
 *     reverse, so the slot is held through any later globalSetup like the
 *     integration dist build);
 *  2. injects the re-entrancy env marker into worker env explicitly
 *     (`test.env`, not ambient inheritance — §2.5);
 *  3. applies the config-eval CLAMPS (targeted ≤4, nested ≤4 unconditional,
 *     CLI-proof via pool hard-set + argv neutralization) when the resolved
 *     posture makes clamps REAL (`clampActive`/enforcing); in dry-run it
 *     ledgers `would-clamp` and reshapes NOTHING (§2.11 — zero behavior
 *     change at ship posture).
 *
 * THIN CALLER RULE (spec L12): all destructive-fs work lives in the src/core
 * semaphore modules — this file only calls them.
 *
 * FAIL-OPEN (§1.1): any internal error leaves the config unreshaped (with the
 * globalSetup entry wired when possible) — config-eval must never wedge a run.
 */

import fs from 'node:fs';

import {
  HostTestRunnerSemaphore,
  resolveClampActive,
  resolvePosture,
  resolveTestRunnerPaths,
  readTuningFile,
} from '../../src/core/hostTestRunnerSemaphore.js';
import {
  analyzeVitestArgv,
  checkNestedUnderHolder,
  clampConfigPool,
  classifyTargetedRun,
  isCiEnvironment,
  isKillSwitchOff,
  neutralizePoolShapingArgv,
  resolveIncludedTestFiles,
  resolvedPoolBound,
} from '../../src/core/testRunnerRunClassifier.js';

export type TestRunnerConfigName = 'unit' | 'integration' | 'e2e' | 'contract' | 'push';

export const GLOBAL_SETUP_ENTRY = 'tests/setup/test-runner-semaphore.globalSetup.ts';
/** The nested/targeted worker-pool clamp ceiling (§2.3/§2.5 — pinned). */
export const POOL_CLAMP_MAX = 4;

interface MinimalVitestConfig {
  test?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Read a holders snapshot without the lock (classification input only). */
function readHoldersSnapshot(): unknown[] {
  try {
    const sem = new HostTestRunnerSemaphore();
    // Plain read via the status projection would virtual-prune; classification
    // wants raw rows — read the file directly through the module's paths.
    const raw = fs.readFileSync(sem.paths.holders, 'utf-8');
    const obj = JSON.parse(raw);
    return Array.isArray(obj?.holders) ? obj.holders : [];
  } catch {
    // @silent-fallback-ok: no/corrupt holders file → no nested shelter — the
    // child simply acquires normally (safe direction).
    return [];
  }
}

/**
 * Wire the test-runner bound into a vitest config. Returns the same config
 * object (mutated) for ergonomic `export default defineConfig(withTestRunnerBound(...))`.
 */
export function withTestRunnerBound<T extends MinimalVitestConfig>(
  name: TestRunnerConfigName,
  config: T,
): T {
  const test: Record<string, unknown> = (config.test as Record<string, unknown>) ?? {};
  config.test = test;
  try {
    // ── 1. globalSetup wiring (both per-config seams — §2.2) ──────────────
    const existing = test.globalSetup;
    const gs: string[] = Array.isArray(existing)
      ? [...(existing as string[])]
      : typeof existing === 'string'
        ? [existing]
        : [];
    if (!gs.includes(GLOBAL_SETUP_ENTRY)) gs.unshift(GLOBAL_SETUP_ENTRY);
    test.globalSetup = gs;

    // ── 2. Worker env marker (explicit injection — §2.5) ──────────────────
    test.env = {
      ...((test.env as Record<string, string>) ?? {}),
      INSTAR_TEST_SEMAPHORE_HELD: `${process.pid}:cfg`,
    };

    // Stash the config name for the globalSetup (same process).
    process.env['__INSTAR_TRB_CONFIG'] = name;

    // ── 3. Classification + clamps ────────────────────────────────────────
    if (isKillSwitchOff() || isCiEnvironment()) return config; // skips handled in globalSetup
    const analysis = analyzeVitestArgv(process.argv);
    if (analysis.isList || analysis.explicitWatch) return config;

    const paths = resolveTestRunnerPaths();
    const tuning = readTuningFile(paths);
    const posture = resolvePosture(process.env, tuning.file);
    if (posture.posture === 'off') return config;
    const clampActive = resolveClampActive(posture.posture, tuning.file);
    const sem = new HostTestRunnerSemaphore();

    const rootDir = process.cwd();
    const naturalBound = resolvedPoolBound(test as Parameters<typeof resolvedPoolBound>[0]);

    // Nested detection: ANY-lane ancestor holder ⇒ the unconditional ≤4 clamp
    // (§2.5 round 8 — no reservation, no count; the SKIP stays lane-scoped and
    // is decided in the globalSetup).
    const holders = readHoldersSnapshot();
    const nested = checkNestedUnderHolder(holders, name === 'unit' ? 'targeted' : 'suite', {
      envMarker: process.env['INSTAR_TEST_SEMAPHORE_HELD'],
    });
    if (nested.anyLaneAncestorHolder) {
      if (clampActive) {
        // CLI-proof (§2.5 round 9): neutralize recognized pool-shaping argv
        // (belt) AND hard-set the pool bounds to Math.min(resolved, 4) — a
        // clamp, never a floor.
        const neutralized = neutralizePoolShapingArgv(process.argv);
        if (neutralized.removed.length > 0) {
          process.argv.length = 0;
          process.argv.push(...neutralized.argv);
        }
        clampConfigPool(test, POOL_CLAMP_MAX);
        process.env['__INSTAR_TRB_CLAMPED'] = 'nested';
      } else {
        // Dry-run honesty (§2.11): ledger the would-clamp, reshape NOTHING.
        sem.ledger('would-clamp', {
          variant: 'nested',
          naturalPoolBound: naturalBound,
          shelteringPid: nested.shelteringPid,
        });
        process.env['__INSTAR_TRB_CLAMPED'] = 'dry-run';
      }
      return config;
    }

    // Targeted classification — vitest.config.ts (unit) runs only (§2.3).
    if (name === 'unit') {
      const include = Array.isArray(test.include) ? (test.include as string[]) : [];
      const included = resolveIncludedTestFiles(include, rootDir);
      const cls = classifyTargetedRun(analysis, included, rootDir);
      process.env['__INSTAR_TRB_TARGETED'] = JSON.stringify({
        targeted: cls.targeted,
        matchedCount: cls.matchedCount,
        reason: cls.reason,
      });
      if (cls.targeted) {
        if (clampActive) {
          clampConfigPool(test, POOL_CLAMP_MAX);
          process.env['__INSTAR_TRB_CLAMPED'] = 'targeted';
        } else {
          sem.ledger('would-clamp', {
            variant: 'targeted',
            naturalPoolBound: naturalBound,
            matchedCount: cls.matchedCount,
          });
          process.env['__INSTAR_TRB_CLAMPED'] = 'dry-run';
        }
      }
    }
    return config;
  } catch (err) {
    // FAIL-OPEN (§1.1): a config-eval error must never wedge a test run.
    try {
      process.stderr.write(
        `[test-runner-bound] WARN: config-eval error (${(err as Error)?.message ?? err}) — proceeding unclamped (fail-open)\n`,
      );
    } catch {
      /* @silent-fallback-ok: stderr write failure is unrecoverable noise */
    }
    return config;
  }
}
