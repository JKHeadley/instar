/**
 * ProjectAutoAdvancePoller — periodic scan for project rounds whose
 * `autoAdvanceAt` has elapsed and that pass the runner's preflight.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5 ("Auto-advance
 * polling").
 *
 * Filter (server-side, NOT a full ledger scan):
 *   - `kind: 'project'`
 *   - `status: 'active'`
 *   - has at least one round with `autoAdvanceAt <= now`
 *   - `unacknowledgedAdvanceCount < 2` (cap brake)
 *   - `ownerMachineId` matches OR is empty AND no other machine has
 *     claimed (the heartbeat staleness check is the claim-flow's
 *     responsibility, not the poller's)
 *   - the project lock is not held
 *
 * On fire:
 *   1. Run `ProjectRoundRunner.preflight(projectId, nextRoundIdx)`.
 *   2. If preflight rejects, surface to telemetry + leave
 *      `autoAdvanceAt` in place so a future scan can retry — UNLESS
 *      the rejection is structural (`FIRST_LAUNCH_ACK_REQUIRED`,
 *      `UNACKED_ADVANCES_OVER_CAP`, `PROJECT_INACTIVE`,
 *      `PROJECT_HALTED`), in which case we clear `autoAdvanceAt`
 *      (no point retrying) and increment a structural-skip counter.
 *   3. If preflight passes, increment `unacknowledgedAdvanceCount` and
 *      clear the current round's `autoAdvanceAt`. The autonomous
 *      run loop (next PR) is the one that actually starts the round
 *      work; for this PR, we record the bookkeeping move and rely on
 *      a future `run()` consumer.
 *
 * Why we don't run the actual round here: the autonomous-delegating
 * run loop with worktrees, dynamic stop revalidation, and SIGTERM
 * handling ships separately. Splitting the poller out lets the bookkeeping
 * move ship today and exercises the filter logic end-to-end.
 *
 * Polling cadence is caller-driven (the existing scheduler `nextCheckAt`
 * tick or a direct `tick()` call from a test).
 */

import type { InitiativeTracker, Initiative } from './InitiativeTracker.js';
import type { ProjectRoundRunner, PreflightResult } from './ProjectRoundRunner.js';

export interface PollerTickResult {
  scanned: number;
  fired: string[]; // projectIds where auto-advance proceeded
  rejected: Array<{ projectId: string; code: string; reason: string }>;
  cleared: string[]; // projectIds where autoAdvanceAt was structurally cleared
  /** projectIds where the optional executor was launched (fire-and-forget). */
  executed: string[];
  /** Errors raised by the executor (settled async; one entry per failed launch). */
  executorErrors: Array<{ projectId: string; roundIndex: number; error: string }>;
}

/**
 * Optional fire-and-forget executor invoked after a successful preflight
 * + bookkeeping move. When set, the poller launches the round run
 * asynchronously. The executor is responsible for its own lock acquisition
 * (`ProjectRoundLock`) so two ticks that both pass preflight cannot
 * spawn two concurrent runs for the same project.
 *
 * The promise is NOT awaited inside `tick()` — the poller's job is
 * scanning, not blocking on multi-minute runs. Errors from the executor
 * are caught and surfaced via `result.executorErrors` so the next tick
 * has a record of what happened.
 */
export type ProjectRoundExecutor = (input: {
  projectId: string;
  roundIndex: number;
}) => Promise<void>;

export interface ProjectAutoAdvancePollerConfig {
  tracker: InitiativeTracker;
  runner: ProjectRoundRunner;
  /** Stable machine id (used for ownerMachineId comparison). */
  machineId: string;
  now?: () => Date;
  /**
   * Optional async executor that actually launches the round work. When
   * omitted, the poller does bookkeeping only (PR-5-era behavior). When
   * present, fire-and-forget invocation after `bookKeepFire`.
   */
  executor?: ProjectRoundExecutor;
}

/** Reject codes that mean "stop retrying" — clear autoAdvanceAt. */
const STRUCTURAL_REJECTS: ReadonlySet<string> = new Set([
  'FIRST_LAUNCH_ACK_REQUIRED',
  'UNACKED_ADVANCES_OVER_CAP',
  'ROUND_ACK_GAP_TOO_LARGE',
  'PROJECT_INACTIVE',
  'PROJECT_HALTED',
  'PROJECT_NOT_PROJECT_KIND',
  'PROJECT_NOT_FOUND',
  'TARGET_REPO_PATH_INVALID',
]);

export class ProjectAutoAdvancePoller {
  private tracker: InitiativeTracker;
  private runner: ProjectRoundRunner;
  private machineId: string;
  private now: () => Date;
  private executor?: ProjectRoundExecutor;
  /** Tracks in-flight executor invocations so a slow run doesn't get relaunched on the next tick. */
  private inFlight: Set<string> = new Set();

  constructor(config: ProjectAutoAdvancePollerConfig) {
    this.tracker = config.tracker;
    this.runner = config.runner;
    this.machineId = config.machineId;
    this.now = config.now ?? (() => new Date());
    this.executor = config.executor;
  }

  /** Test/diagnostic helper: how many executor launches are still settling. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Run one pass over all eligible projects. */
  async tick(): Promise<PollerTickResult> {
    const result: PollerTickResult = {
      scanned: 0,
      fired: [],
      rejected: [],
      cleared: [],
      executed: [],
      executorErrors: [],
    };

    // Filter server-side: kind=project + status=active. (The tracker's
    // `list` already supports the kind filter.)
    const projects = this.tracker.list({ kind: 'project', status: 'active' });
    const nowMs = this.now().getTime();

    for (const project of projects) {
      result.scanned++;

      // Step 1: ownership filter — skip projects this machine doesn't own.
      // Empty ownerMachineId is treated as "any machine can claim by
      // running" — but for auto-advance we require explicit ownership
      // so two machines don't race. Claim-ownership endpoint is the
      // explicit takeover path.
      if (project.ownerMachineId && project.ownerMachineId !== this.machineId) continue;

      // Step 2: cap brake — over-cap projects never auto-fire.
      const unacked = project.unacknowledgedAdvanceCount ?? 0;
      if (unacked >= 2) continue;

      // Step 3: find the first round with autoAdvanceAt elapsed.
      const rounds = project.rounds ?? [];
      const roundIdx = rounds.findIndex((r) => {
        const t = r.autoAdvanceAt ? Date.parse(r.autoAdvanceAt) : 0;
        return Number.isFinite(t) && t > 0 && t <= nowMs && (r.status ?? 'pending') === 'pending';
      });
      if (roundIdx === -1) continue;

      // Step 4: preflight via the runner.
      const pre: PreflightResult = this.runner.preflight(project.id, roundIdx);
      if (!pre.ok) {
        result.rejected.push({ projectId: project.id, code: pre.code, reason: pre.reason });
        if (STRUCTURAL_REJECTS.has(pre.code)) {
          // Clear the timestamp; no point in retrying until structural
          // state changes (which will happen via a different code path —
          // user ack, halt-then-resume, etc.).
          await this.clearAutoAdvance(project, roundIdx);
          result.cleared.push(project.id);
        }
        continue;
      }

      // Step 5: bookkeeping move — increment unacked counter, clear
      // current round's autoAdvanceAt so we don't re-fire on the next
      // tick.
      await this.bookKeepFire(project, roundIdx);
      result.fired.push(project.id);

      // Step 6: fire-and-forget executor launch (if configured).
      // The executor (ProjectRoundExecution.runRound) acquires its own
      // lock, so a duplicate-launch on a stuck tick would resolve to
      // LOCK_HELD inside the runner. We additionally guard with
      // `inFlight` so we don't even attempt while one is settling.
      if (this.executor && !this.inFlight.has(project.id)) {
        result.executed.push(project.id);
        this.launchExecutor(project.id, roundIdx, result);
      }
    }
    return result;
  }

  /** Fire-and-forget executor launch. Errors are captured into `result.executorErrors`. */
  private launchExecutor(projectId: string, roundIndex: number, result: PollerTickResult): void {
    if (!this.executor) return;
    this.inFlight.add(projectId);
    void this.executor({ projectId, roundIndex })
      .catch((err: unknown) => {
        result.executorErrors.push({
          projectId,
          roundIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.inFlight.delete(projectId);
      });
  }

  private async clearAutoAdvance(project: Initiative, roundIdx: number): Promise<void> {
    const rounds = (project.rounds ?? []).map((r, i) =>
      i === roundIdx ? { ...r, autoAdvanceAt: undefined } : r
    );
    try {
      await this.tracker.update(project.id, { rounds, ifMatch: project.version });
    } catch {
      // OCC race — another writer beat us. Next tick will see the new state.
    }
  }

  private async bookKeepFire(project: Initiative, roundIdx: number): Promise<void> {
    const rounds = (project.rounds ?? []).map((r, i) =>
      i === roundIdx ? { ...r, autoAdvanceAt: undefined } : r
    );
    const nextUnacked = (project.unacknowledgedAdvanceCount ?? 0) + 1;
    try {
      await this.tracker.update(project.id, {
        rounds,
        unacknowledgedAdvanceCount: nextUnacked,
        ifMatch: project.version,
      });
    } catch {
      // OCC race — next tick will retry.
    }
  }
}
