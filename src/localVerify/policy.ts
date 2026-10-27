/**
 * The fixed policy local-verify runs under (spec local-verify-merge-authority.md §2).
 *
 * Deadlines are constants reviewed at Acceptance, never derived from a run's own
 * history. `policyHash` covers everything a record's verdict depends on (lanes,
 * inventory rules, harness globs, toolchain list, deadlines): a journal entry
 * written under a different policy is not trusted at boot and is re-verified.
 */

import crypto from 'node:crypto';
import { LANES, INVENTORY_INCLUDE, INVENTORY_EXCLUDE, type LaneName } from './inventory.js';
import { HARNESS_GLOBS, TOOLCHAIN_PACKAGES, TOOLCHAIN_SCOPES } from './harnessClassifier.js';

const MIN = 60_000;

export interface LocalVerifyDeadlines {
  fetchMs: number;
  npmCiMs: number;
  /** Build plus every lint step, shared. */
  buildLintMs: number;
  lanes: Record<LaneName, number>;
  /** Overall active-work deadline, excluding only slot / single-flight waits. */
  totalActiveMs: number;
  /** Small bookkeeping git steps (merge-tree, commit-tree, worktree add, diff, status). */
  gitStepMs: number;
}

export const LOCAL_VERIFY_DEADLINES: Readonly<LocalVerifyDeadlines> = Object.freeze({
  fetchMs: 5 * MIN,
  npmCiMs: 10 * MIN,
  buildLintMs: 15 * MIN,
  lanes: Object.freeze({ unit: 20 * MIN, integration: 30 * MIN, e2e: 45 * MIN }),
  totalActiveMs: 120 * MIN,
  gitStepMs: 2 * MIN,
});

export const LOCAL_VERIFY_LIMITS = Object.freeze({
  /** Wait in place for a foreign full suite before lane 2 or 3, then re-queue. */
  waitInPlaceMs: 30 * MIN,
  /** Poll interval while waiting in place. */
  holderPollMs: 30_000,
  queueCap: 10,
  /**
   * PRs labelled `merge-throughput` may queue past `queueCap` by at most this many: a full
   * queue of ordinary PRs must not keep out the work that speeds the queue up (2026-10-26:
   * two labelled PRs answered queue-full for hours, so their priority never applied).
   */
  throughputOverflow: 5,
  /**
   * Isolation re-run (Throughput budget, evidence-per-run "known-flaky"): a lane whose ONLY
   * problem is 1..N failed files re-runs exactly those files once, one at a time. More than N
   * failed files is a real break (no re-run). N is also the cap across a whole verify.
   */
  isolationRerunMaxFiles: 3,
  /**
   * The e2e lane runs as this many vitest shards at once (spec "Parallel lanes"). Each
   * shard has its own TMPDIR and tmux server. Measured on the Studio 2026-10-22: one
   * e2e process 23-25 min; two shards 11 and 20 min, beside the other two lanes.
   */
  e2eShards: 2,
  /** Unit-lane workers while the lanes run at once (pinned in the lane's env). */
  unitWorkersParallel: 4,
  /** Oldest queued entry waiting longer than this (capacity waits included) raises `local-verify:starved`. */
  starvedAfterMs: 3 * 60 * MIN,
  /** Automatic re-runs of an `error` outcome. */
  errorAutoRetries: 1,
  keepFailedWorktrees: 3,
  /** Records are kept while the PR is open plus this long. */
  retentionAfterCloseMs: 14 * 24 * 60 * MIN,
  journalCap: 500,
  auditRotateBytes: 5 * 1024 * 1024,
  auditKeepFiles: 10,
  /** Grace between SIGTERM and SIGKILL of a cancelled run's process group. */
  cancelGraceMs: 10_000,
});

export const LOCAL_VERIFY_IDENTITY = Object.freeze({ name: 'local-verify', email: 'noreply@local' });

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
}

export function computePolicyHash(): string {
  const policy = {
    lanes: LANES,
    inventoryInclude: INVENTORY_INCLUDE,
    inventoryExclude: INVENTORY_EXCLUDE,
    harnessGlobs: HARNESS_GLOBS,
    toolchain: { packages: TOOLCHAIN_PACKAGES, scopes: TOOLCHAIN_SCOPES },
    deadlines: LOCAL_VERIFY_DEADLINES,
    e2eShards: LOCAL_VERIFY_LIMITS.e2eShards,
    unitWorkersParallel: LOCAL_VERIFY_LIMITS.unitWorkersParallel,
  };
  return crypto.createHash('sha256').update(stable(policy)).digest('hex');
}
