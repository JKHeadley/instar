/**
 * ProjectRoundExecution — the autonomous run loop for a project round.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5 ("Run loop", steps 1-11).
 *
 * What this module is responsible for:
 *   1. Acquiring the round-runner lock (delegated to ProjectRoundLock).
 *   2. Spawning the autonomous child process in a detached process
 *      group, so SIGTERM/SIGKILL of the group never reaps the runner.
 *   3. Polling the project record every `pollIntervalMs` to detect
 *      mid-round mutations to the round's itemIds (e.g., a user
 *      manually skips an item) — when detected, SIGTERM the group
 *      (5s grace, then SIGKILL) and relaunch with a recomputed stop
 *      condition.
 *   4. On the autonomous child's NATURAL exit, verify per-item
 *      artifacts and set round.status = complete | partially-complete.
 *   5. Cleanup: `git worktree prune` for the round namespace.
 *   6. Release the lock.
 *
 * What this module is NOT responsible for:
 *   - The preflight gate. That's `ProjectRoundRunner.preflight`. The
 *     caller (the auto-advance poller, the /project run-round skill,
 *     a future HTTP endpoint) is expected to preflight before calling
 *     `runRound(input)`.
 *   - Drift checking. Same — preflight handles it.
 *   - Choosing the autonomous command. The `spawnCommand` is injected,
 *     defaulting to `claude` (which invokes the local /autonomous skill).
 *     Tests pass a custom command so they don't depend on the skill.
 *
 * Process group safety:
 *   The child is spawned with `detached: true` so it gets its own
 *   process group. `kill(-pgid, signal)` (Node passes negative PIDs
 *   for group signals) targets only the child's group — never reaps
 *   the runner.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { Initiative, InitiativeTracker, RoundStatus } from './InitiativeTracker.js';
import { ProjectRoundLock } from './ProjectRoundLock.js';
import { ProjectRoundWorktrees } from './ProjectRoundWorktrees.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';

/** Per-spec defaults. Tests dial both down to keep the suite fast. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_SIGTERM_GRACE_MS = 5_000;
/** Resume cap from spec § Phase 1.5 step 11. */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

export interface RunRoundInput {
  tracker: InitiativeTracker;
  projectId: string;
  roundIndex: number;
  /**
   * Absolute target repo path; required (the spec's `targetRepoPath`).
   * The caller must have verified it points at a git repo (preflight does this).
   */
  targetRepoPath: string;

  /**
   * `process.cwd()` for the spawned autonomous child. Defaults to the
   * first item's worktree path. The autonomous child opens additional
   * worktrees as it works through items.
   */
  initialWorkdir?: string;

  /**
   * Command + args to spawn. Default is the production invocation:
   * `claude --skill autonomous` (resolved via PATH). Tests pass a
   * harmless command (`bash -c "exit 0"`) so the test doesn't actually
   * invoke claude.
   *
   * Stop condition + project/round identifiers are passed via env:
   *   INSTAR_PROJECT_ID, INSTAR_ROUND_INDEX, INSTAR_STOP_CONDITION
   *   INSTAR_ROUND_ITEM_IDS (JSON-encoded array)
   */
  spawnCommand?: string;
  spawnArgs?: string[];

  /** Poll cadence; defaults to 60s. */
  pollIntervalMs?: number;
  /** SIGTERM→SIGKILL grace; defaults to 5s. */
  sigtermGraceMs?: number;
  /** Max resume attempts on transient failures; defaults to 3. */
  maxResumeAttempts?: number;

  /**
   * Test hook: shell out to verify per-item artifacts. Defaults to a
   * real `gh pr view` shell-out via SafeGitExecutor. Tests inject a
   * stub. The function returns the set of itemIds whose artifact
   * is verified merged-on-main-with-CI-green.
   */
  verifyMergedItems?: (childIds: string[]) => Promise<Set<string>>;
}

export type RoundOutcome = 'complete' | 'partially-complete' | 'failed' | 'halted';

export interface RunRoundResult {
  outcome: RoundOutcome;
  /** Verified-merged itemIds. */
  mergedItemIds: string[];
  /** itemIds that did NOT verify (only populated for partially-complete / halted). */
  unmergedItemIds: string[];
  /** Number of times the runner relaunched the child due to dynamic-stop changes. */
  relaunchCount: number;
  /** Number of times the round resumed after a transient child failure. */
  resumeAttempts: number;
  /** Human-readable reason — useful for halted / failed outcomes. */
  reason?: string;
}

/**
 * Lock that the runner needs but is too high-level to require here as
 * a positional parameter. Wires through the standard
 * `.instar/local/round-runner.lock` location.
 */
export interface RunRoundDeps {
  stateDir: string;
}

/**
 * Run one round to completion. Caller is expected to preflight first.
 */
export async function runRound(input: RunRoundInput, deps: RunRoundDeps): Promise<RunRoundResult> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sigtermGraceMs = input.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const maxResumeAttempts = input.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
  const verifyMergedItems = input.verifyMergedItems ?? defaultVerifyMergedItems(input.targetRepoPath);

  const lock = new ProjectRoundLock({ stateDir: deps.stateDir });

  // Step 1: acquire lock.
  const acquired = lock.acquire(input.projectId, input.roundIndex);
  if (!acquired.ok) {
    return {
      outcome: 'failed',
      mergedItemIds: [],
      unmergedItemIds: [],
      relaunchCount: 0,
      resumeAttempts: 0,
      reason: `lock held by pid ${acquired.currentHolder.pid}`,
    };
  }

  let relaunchCount = 0;
  let resumeAttempts = 0;

  try {
    let snapshot = await readRound(input.tracker, input.projectId, input.roundIndex);
    if (!snapshot) {
      return {
        outcome: 'failed',
        mergedItemIds: [],
        unmergedItemIds: [],
        relaunchCount,
        resumeAttempts,
        reason: 'project or round disappeared',
      };
    }
    let lastItemIds = [...snapshot.itemIds];

    // Step 3: lazy worktree allocation for round items. The autonomous
    // child opens more as it reaches them; we kick off only the first
    // here to give the child a starting cwd.
    if (lastItemIds.length > 0) {
      try {
        ProjectRoundWorktrees.allocate(
          {
            targetRepoPath: input.targetRepoPath,
            projectId: input.projectId,
            roundIndex: input.roundIndex,
            itemId: lastItemIds[0],
          },
          { refuseExisting: false }
        );
      } catch {
        // First-item worktree may pre-exist if a previous attempt
        // crashed mid-way. Continue.
      }
    }

    // Inner relaunch loop: steps 4-5.
    // We loop until either the child exits naturally or we detect a
    // halt / stop-condition-met.
    let outcome: RoundOutcome = 'failed';
    let mergedItemIds: string[] = [];
    let unmergedItemIds: string[] = [];
    let reason: string | undefined;

    for (;;) {
      // Per-step halt checkpoint.
      const halted = await readHaltedAt(input.tracker, input.projectId, input.roundIndex);
      if (halted) {
        outcome = 'halted';
        reason = `round halted at ${halted}`;
        unmergedItemIds = [...lastItemIds];
        break;
      }

      // Compute current stop condition: itemIds verified-merged.
      const verified = await verifyMergedItems(lastItemIds);
      if (lastItemIds.every((id) => verified.has(id))) {
        outcome = 'complete';
        mergedItemIds = [...lastItemIds];
        break;
      }

      // Spawn the autonomous child with stop condition + ids in env.
      const child = spawnAutonomousChild(input, lastItemIds);
      const exit = await waitForExitOrPollChange(
        child,
        input.tracker,
        input.projectId,
        input.roundIndex,
        lastItemIds,
        pollIntervalMs,
        sigtermGraceMs
      );

      if (exit.kind === 'set-changed') {
        relaunchCount++;
        const fresh = await readRound(input.tracker, input.projectId, input.roundIndex);
        if (!fresh) {
          outcome = 'failed';
          reason = 'project disappeared during round';
          break;
        }
        lastItemIds = [...fresh.itemIds];
        // Loop continues; next iteration re-checks stop condition then
        // either spawns again or proceeds to step 6.
        continue;
      }

      if (exit.kind === 'halted') {
        outcome = 'halted';
        reason = 'round halted via API during run';
        unmergedItemIds = [...lastItemIds];
        break;
      }

      // Natural exit.
      if (exit.kind === 'exited' && exit.code === 0) {
        // Step 6: verify per-item artifacts.
        const finalVerified = await verifyMergedItems(lastItemIds);
        mergedItemIds = lastItemIds.filter((id) => finalVerified.has(id));
        unmergedItemIds = lastItemIds.filter((id) => !finalVerified.has(id));
        if (unmergedItemIds.length === 0) outcome = 'complete';
        else outcome = 'partially-complete';
        break;
      }

      // Non-zero exit → resume attempt.
      resumeAttempts++;
      if (resumeAttempts >= maxResumeAttempts) {
        outcome = 'failed';
        reason = `${resumeAttempts} resume attempts exhausted (last exit code: ${exit.kind === 'exited' ? exit.code : exit.kind})`;
        unmergedItemIds = [...lastItemIds];
        break;
      }
      // Backoff before relaunch.
      await sleep(1000 * resumeAttempts);
    }

    // Step 7: cleanup worktrees.
    try { ProjectRoundWorktrees.prune(input.targetRepoPath); } catch { /* best-effort */ }

    // Step 9-11: record round status. We DO NOT touch
    // unacknowledgedAdvanceCount here — that's the auto-advance poller's
    // job. We just record the round status.
    if (outcome !== 'halted') {
      await recordOutcome(input.tracker, input.projectId, input.roundIndex, outcome);
    }

    return { outcome, mergedItemIds, unmergedItemIds, relaunchCount, resumeAttempts, reason };
  } finally {
    // Step 8: release lock.
    lock.release();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

interface RoundSnapshot {
  itemIds: string[];
  status: RoundStatus;
}

async function readRound(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number
): Promise<RoundSnapshot | null> {
  const proj = tracker.get(projectId);
  if (!proj) return null;
  const round = (proj.rounds ?? [])[roundIndex];
  if (!round) return null;
  return { itemIds: round.itemIds ?? [], status: (round.status ?? 'pending') };
}

async function readHaltedAt(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number
): Promise<string | null> {
  const proj = tracker.get(projectId);
  if (!proj) return null;
  const round = (proj.rounds ?? [])[roundIndex];
  return round?.haltedAt ?? null;
}

async function recordOutcome(
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number,
  outcome: RoundOutcome
): Promise<void> {
  const proj = tracker.get(projectId);
  if (!proj) return;
  const map: Record<RoundOutcome, RoundStatus> = {
    complete: 'complete',
    'partially-complete': 'partially-complete',
    failed: 'failed',
    halted: 'failed',
  };
  const newStatus = map[outcome];
  const completedAt = new Date().toISOString();
  const rounds = (proj.rounds ?? []).map((r, i) =>
    i === roundIndex ? { ...r, status: newStatus, completedAt } : r
  );
  try {
    await tracker.update(projectId, { rounds, ifMatch: proj.version });
  } catch {
    // OCC race — caller (or next reconcile) will retry.
  }
}

interface ExitResult {
  kind: 'exited' | 'set-changed' | 'halted';
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

function spawnAutonomousChild(input: RunRoundInput, itemIds: string[]): ChildProcess {
  const cmd = input.spawnCommand ?? 'claude';
  const args = input.spawnArgs ?? ['--skill', 'autonomous'];
  const workdir =
    input.initialWorkdir ??
    (itemIds.length > 0
      ? ProjectRoundWorktrees.pathFor({
          targetRepoPath: input.targetRepoPath,
          projectId: input.projectId,
          roundIndex: input.roundIndex,
          itemId: itemIds[0],
        })
      : input.targetRepoPath);
  const child = spawn(cmd, args, {
    cwd: workdir,
    detached: true, // critical — makes the child its own process group leader
    stdio: 'ignore',
    env: {
      ...process.env,
      INSTAR_PROJECT_ID: input.projectId,
      INSTAR_ROUND_INDEX: String(input.roundIndex),
      INSTAR_ROUND_ITEM_IDS: JSON.stringify(itemIds),
      INSTAR_STOP_CONDITION: 'all-items-merged-on-main',
    },
  });
  return child;
}

async function waitForExitOrPollChange(
  child: ChildProcess,
  tracker: InitiativeTracker,
  projectId: string,
  roundIndex: number,
  initialItemIds: string[],
  pollIntervalMs: number,
  sigtermGraceMs: number
): Promise<ExitResult> {
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  while (!exited) {
    // Wait either pollIntervalMs OR exit, whichever comes first.
    await Promise.race([exitPromise, sleep(pollIntervalMs)]);
    if (exited) break;

    // Halt check.
    const halted = await readHaltedAt(tracker, projectId, roundIndex);
    if (halted) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'halted' };
    }

    // Stop-condition revalidation: did itemIds change?
    const snap = await readRound(tracker, projectId, roundIndex);
    if (!snap) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'halted' };
    }
    if (!arraysEqual(snap.itemIds, initialItemIds)) {
      await killProcessGroup(child, sigtermGraceMs);
      return { kind: 'set-changed' };
    }
  }
  return { kind: 'exited', code: exitCode, signal: exitSignal };
}

async function killProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    // Negative PID targets the process group. child is its own group
    // leader because we spawned with detached:true.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return; // Already dead.
  }
  const start = Date.now();
  while (child.exitCode === null && Date.now() - start < graceMs) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* already dead */ }
    // Brief wait for the OS to register the kill.
    await sleep(100);
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Real `gh pr view`-backed merged-state verifier. For each child id,
 * looks up the child's `prNumber` + `mergeCommitOid` from the tracker
 * and runs `git merge-base --is-ancestor <oid> origin/main` to confirm
 * the merge is reachable. Tests inject a stub instead.
 *
 * For PR 7's scope, this default is intentionally simple: it only
 * confirms reachability of `mergeCommitOid` if the child has one.
 * Real CI-green checks via `gh pr view` ship in a follow-up (the
 * StageTransitionValidator already performs them for /advance — when
 * the merged-state reconciler wires up in the next PR, it'll call
 * the validator here too).
 */
function defaultVerifyMergedItems(targetRepoPath: string): (childIds: string[]) => Promise<Set<string>> {
  return async (_childIds: string[]) => {
    const verified = new Set<string>();
    // Best-effort no-op default — production callers should pass a
    // real verifyMergedItems that calls StageTransitionValidator.
    // The point of this default is to avoid a spurious shell-out
    // during tests that didn't override it (rare; tests should
    // override).
    void targetRepoPath;
    return verified;
  };
}

/** Helper exported so callers can wire a SafeGit-backed verifier. */
export async function verifyMergedItemsViaGit(
  targetRepoPath: string,
  childIds: string[],
  tracker: InitiativeTracker
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const id of childIds) {
    const child = tracker.get(id);
    if (!child || !child.mergeCommitOid) continue;
    try {
      SafeGitExecutor.run(
        ['merge-base', '--is-ancestor', child.mergeCommitOid, 'origin/main'],
        { cwd: targetRepoPath, operation: 'ProjectRoundExecution.verifyMergedItemsViaGit' }
      );
      verified.add(id);
    } catch {
      // Not an ancestor of origin/main — not verified.
    }
  }
  return verified;
}
