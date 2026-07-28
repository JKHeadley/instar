// safe-git-allow: test framework — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Real-World-State Fixture Framework — post-mortem lever B.
 *
 * Tests in `tests/real-world-state/` exercise instar against fixtures that
 * model REAL-world agent state, not the small fresh-fixture state the rest
 * of the suite uses. The classes this catches:
 *
 *  - Real data sizes (multi-100MB token-ledger.db, multi-MB JSONL transcript
 *    directories, semantic-memory at scale).
 *  - Realistic config shapes (externalized secrets / { "secret": true }
 *    placeholders, partially-migrated state, older on-disk formats).
 *  - Environment shapes (specific Node + ABI binary, missing toolchain,
 *    load >> cores).
 *  - Concurrency at scale (N concurrent jobs, restart-during-tick,
 *    exhausted lease).
 *
 * Why a separate directory
 * ------------------------
 * `tests/unit/` is for module-in-isolation with real dependencies.
 * `tests/integration/` is for the HTTP route surface.
 * `tests/e2e/` is for production-init lifecycle.
 * `tests/real-world-state/` (this one) is for "boot the same code against
 * state that LOOKS LIKE a real production agent — does the boot path
 * still work?" — the bug surface that pre-PR-#545 testing missed
 * because everything was mocked at module boundary.
 *
 * Tier system
 * -----------
 * Fixtures fall into two tiers:
 *
 *  - **'pr' tier** — small fixtures (< ~5 MB, < ~30 s setup). Run on
 *    every PR / every CI shard. Default on.
 *  - **'nightly' tier** — large fixtures (multi-100MB DBs, generated
 *    JSONL volumes, environment-specific shapes). Default off. Opt in
 *    via `INSTAR_REAL_WORLD_BIG=1` env. Intended for nightly cron +
 *    dev-machine on-demand.
 *
 * Use `describeAtTier(tier, name, fn)` to declare a tier-scoped
 * describe block. Vitest's `describe.skip` is used under the hood when
 * the tier is gated off — the block still appears in the output as
 * "skipped" so the gap is visible.
 *
 * Future extension
 * ----------------
 * Big fixtures will need to be generated and cached. The generator
 * `scripts/build-real-world-fixtures.mjs` (deferred to a follow-up PR
 * with the first nightly-tier scenario) will populate
 * `tests/fixtures/real-world-state/` (git-ignored), and helpers below
 * will gain `loadGeneratedFixture(name)` that returns paths or skips
 * cleanly when the cache is empty.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe } from 'vitest';

export type Tier = 'pr' | 'nightly';

const NIGHTLY_ENV = 'INSTAR_REAL_WORLD_BIG';

export function shouldSkipForTier(tier: Tier): boolean {
  if (tier === 'nightly') return process.env[NIGHTLY_ENV] !== '1';
  return false;
}

/**
 * Conditional describe — skips the whole block when the tier is gated off.
 * Shows up in the vitest output as "skipped" so the coverage gap is
 * visible (not silently absent).
 */
export function describeAtTier(tier: Tier, name: string, fn: () => void): void {
  if (shouldSkipForTier(tier)) {
    describe.skip(
      `[real-world-state:${tier}] ${name} — skipped (set ${NIGHTLY_ENV}=1 to run)`,
      fn,
    );
  } else {
    describe(`[real-world-state:${tier}] ${name}`, fn);
  }
}

/**
 * Per-test scratch dir that simulates an agent home: project dir + .instar
 * state dir. Returns a cleanup helper for `afterEach`.
 */
export interface AgentFixtureCtx {
  /** Simulated project / agent-home root (tmpdir). */
  projectDir: string;
  /** `.instar/` subdir inside projectDir. */
  stateDir: string;
  /** Cleanup the entire tmpdir. Idempotent. */
  cleanup: () => void;
}

export function makeAgentFixture(): AgentFixtureCtx {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rws-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    projectDir,
    stateDir,
    cleanup: () => {
      // @silent-fallback-ok — best-effort tmpdir cleanup; missing-after-test is fine.
      try {
        fs.rmSync(projectDir, { recursive: true, force: true }); // safe-fs-allow: per-test tmpdir cleanup
      } catch { /* @silent-fallback-ok */ }
    },
  };
}
