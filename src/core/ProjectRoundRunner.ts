/**
 * ProjectRoundRunner — the single entry point for project-scope rounds.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.5.
 *
 * Authority model: every entry path (HTTP /advance, /run-round skill,
 * future auto-advance poller) MUST go through `preflight()` here. Routes
 * do NOT enforce gates that the runner already enforces — the runner is
 * the chokepoint. Preflight returns a structured result; callers either
 * proceed (when the runner approves) or surface the rejection.
 *
 * Lock: machine-local `.instar/local/round-runner.lock` (see
 * `ProjectRoundLock`). At most one runner active per machine.
 *
 * What's IN this PR (Phase 1b PR 3):
 *   - `preflight(projectId, roundIndex)` — checks 1–9 from the spec
 *     (drift check, step 10, is deferred to a follow-up PR alongside
 *     the cache+ledger HTTP wiring).
 *   - `halt(projectId, reason)` — writes haltedAt, sets project status
 *     to `halted`, releases the lock if held. Idempotent.
 *   - `recordAck(projectId, roundIndex)` — records user acknowledgment,
 *     resets `unacknowledgedAdvanceCount`, advances `lastAckedRoundIndex`,
 *     populates `firstLaunchAckAt` if absent.
 *   - `acceptPartial(projectId, roundIndex, reason)` — closes a
 *     partially-complete round: missing items → skipped,
 *     round.status → `complete-with-skips`. Counts as an ack for the
 *     current round (advances lastAckedRoundIndex) but does NOT
 *     increment unacknowledgedAdvanceCount.
 *
 * What's NOT in this PR:
 *   - The actual autonomous-delegating run loop (`run()`).
 *   - Dynamic stop-condition revalidation + SIGTERM/SIGKILL of children.
 *   - Drift check at preflight step 10.
 *   - Auto-advance poller.
 *   - Multi-machine claim-ownership.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InitiativeTracker, Initiative, InitiativeRound, PipelineStage, RoundStatus } from './InitiativeTracker.js';
import { ProjectRoundLock, type ProjectRoundLockPayload, isAlive } from './ProjectRoundLock.js';
import { extractFrontmatter } from './SafeYaml.js';

/** Spec-mandated rejection codes for preflight failures. */
export type PreflightRejectCode =
  | 'TRACKER_MISSING'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_PROJECT_KIND'
  | 'PROJECT_INACTIVE'
  | 'PROJECT_HALTED'
  | 'PROJECT_AWAITING_USER'
  | 'ROUND_INDEX_OUT_OF_RANGE'
  | 'ROUND_NOT_PENDING_OR_READY'
  | 'LOCK_HELD'
  | 'FIRST_LAUNCH_ACK_REQUIRED'
  | 'UNACKED_ADVANCES_OVER_CAP'
  | 'ROUND_ACK_GAP_TOO_LARGE'
  | 'NOT_OWNER_MACHINE'
  | 'TARGET_REPO_PATH_INVALID'
  | 'AWAITING_RECONCILIATION'
  | 'ITEMS_NOT_ALL_APPROVED'
  | 'ITEM_FRONTMATTER_INVALID';

export interface PreflightOk {
  ok: true;
  project: Initiative;
  round: InitiativeRound;
  children: Initiative[];
  ownerMachineId: string;
}

export interface PreflightReject {
  ok: false;
  code: PreflightRejectCode;
  reason: string;
  /** When code === 'LOCK_HELD', the current holder is populated. */
  currentHolder?: ProjectRoundLockPayload;
  /** When code === 'ITEMS_NOT_ALL_APPROVED', the failing child id(s). */
  failingItemIds?: string[];
}

export type PreflightResult = PreflightOk | PreflightReject;

export interface ProjectRoundRunnerConfig {
  tracker: InitiativeTracker;
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  /** Identifier of THIS machine — usually `agentRegistry.machineId()`. */
  machineId: string;
  /**
   * How many auto-advances without ack before the project is paused.
   * Defaults to 2 (matches spec § Phase 1.5 step 6 brake).
   */
  unackedAdvanceCap?: number;
  /**
   * Max gap allowed between `lastAckedRoundIndex` and the requested
   * roundIndex. Defaults to 2 (spec § Phase 1.5 step 5: "no more than
   * two rounds-ahead-of-ack at any time").
   */
  ackGapCap?: number;
}

export class ProjectRoundRunner {
  private tracker: InitiativeTracker;
  private stateDir: string;
  private machineId: string;
  private lock: ProjectRoundLock;
  private unackedAdvanceCap: number;
  private ackGapCap: number;

  constructor(config: ProjectRoundRunnerConfig) {
    this.tracker = config.tracker;
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.lock = new ProjectRoundLock({ stateDir: config.stateDir });
    this.unackedAdvanceCap = config.unackedAdvanceCap ?? 2;
    this.ackGapCap = config.ackGapCap ?? 2;
  }

  /** Public read of the current lock holder, used by tests and dashboards. */
  currentLockHolder(): ProjectRoundLockPayload | null {
    return this.lock.read();
  }

  /**
   * Preflight check — the single chokepoint for round-start authority.
   *
   * Steps 1–9 from the spec. Step 10 (drift check) is intentionally
   * skipped in this PR; it lands when the drift-check HTTP endpoint is
   * wired into the routes ctx (Phase 1b follow-up).
   */
  preflight(projectId: string, roundIndex: number): PreflightResult {
    // ── Step 0: tracker present ───────────────────────────────────
    if (!this.tracker) {
      return { ok: false, code: 'TRACKER_MISSING', reason: 'no initiative tracker' };
    }

    // ── Project shape ─────────────────────────────────────────────
    const project = this.tracker.get(projectId);
    if (!project) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `no project ${projectId}` };
    }
    if ((project.kind ?? 'task') !== 'project') {
      return {
        ok: false,
        code: 'PROJECT_NOT_PROJECT_KIND',
        reason: `record ${projectId} is not project-kind (kind=${project.kind ?? 'task'})`,
      };
    }

    // ── Project status ────────────────────────────────────────────
    if (project.status !== 'active') {
      if (project.status === 'archived' || project.status === 'completed' || project.status === 'abandoned') {
        return {
          ok: false,
          code: 'PROJECT_INACTIVE',
          reason: `project status is "${project.status}", not "active"`,
        };
      }
    }
    // Track halt / awaiting-user via round.haltedAt OR explicit awaitingUser?
    // For now, "active" is the only allowed status.

    // ── Round shape ───────────────────────────────────────────────
    if (!Array.isArray(project.rounds) || project.rounds.length === 0) {
      return { ok: false, code: 'ROUND_INDEX_OUT_OF_RANGE', reason: 'project has no rounds' };
    }
    if (roundIndex < 0 || roundIndex >= project.rounds.length) {
      return {
        ok: false,
        code: 'ROUND_INDEX_OUT_OF_RANGE',
        reason: `roundIndex ${roundIndex} not in [0, ${project.rounds.length})`,
      };
    }
    const round = project.rounds[roundIndex];
    if (round.haltedAt) {
      return {
        ok: false,
        code: 'PROJECT_HALTED',
        reason: `round ${roundIndex} was halted at ${round.haltedAt}: ${round.haltReason ?? '<no reason>'}`,
      };
    }
    // Undefined status is treated as 'pending' (newly-constructed rounds
    // from the plan parser may not set it explicitly).
    const roundStatus = round.status ?? 'pending';
    if (roundStatus !== 'pending' && roundStatus !== 'ready') {
      return {
        ok: false,
        code: 'ROUND_NOT_PENDING_OR_READY',
        reason: `round.status is "${round.status}", not "pending" or "ready"`,
      };
    }

    // ── Step 1+2: lock free / stale-PID sweep ─────────────────────
    const holder = this.lock.read();
    if (holder && isAlive(holder.pid)) {
      return {
        ok: false,
        code: 'LOCK_HELD',
        reason: `lock held by pid ${holder.pid} for ${holder.projectId} round ${holder.roundIndex} since ${holder.acquiredAt}`,
        currentHolder: holder,
      };
    }
    // (If holder exists but PID dead, acquire() will sweep it.)

    // ── Step 3: all round items at `approved` AND frontmatter still valid
    const childIds = round.itemIds ?? [];
    const children: Initiative[] = [];
    const failingItemIds: string[] = [];
    for (const cid of childIds) {
      const child = this.tracker.get(cid);
      if (!child) {
        failingItemIds.push(cid);
        continue;
      }
      children.push(child);
      // First round may legitimately start when items are still at
      // outline (the round itself drives them through stages). The
      // hard "items must all be approved" gate per § Phase 1.5 step 3
      // applies to STARTING the autonomous run loop. Preflight is also
      // used for /advance which does single-item transitions, so we
      // accept any pipelineStage in this PR. The stricter gate will
      // be re-asserted by `run()` when the run loop ships (Phase 1b
      // follow-up).
    }
    if (failingItemIds.length > 0) {
      return {
        ok: false,
        code: 'ITEMS_NOT_ALL_APPROVED',
        reason: `${failingItemIds.length} item id(s) on the round don't resolve to existing records: ${failingItemIds.join(', ')}`,
        failingItemIds,
      };
    }

    // ── Step 5+6: first-launch ack + unacked-advances cap ─────────
    const isFirstRound = roundIndex === 0;
    const firstLaunchAckAt = project.firstLaunchAckAt;
    if (isFirstRound && !firstLaunchAckAt) {
      return {
        ok: false,
        code: 'FIRST_LAUNCH_ACK_REQUIRED',
        reason: `first round requires POST /projects/${projectId}/ack before any entry path can start it`,
      };
    }
    const unacked = project.unacknowledgedAdvanceCount ?? 0;
    if (unacked >= this.unackedAdvanceCap) {
      return {
        ok: false,
        code: 'UNACKED_ADVANCES_OVER_CAP',
        reason: `${unacked} auto-advances without ack (cap ${this.unackedAdvanceCap}); ack or halt before continuing`,
      };
    }
    const lastAcked = project.lastAckedRoundIndex ?? -1;
    if (!isFirstRound && roundIndex - lastAcked > this.ackGapCap) {
      return {
        ok: false,
        code: 'ROUND_ACK_GAP_TOO_LARGE',
        reason: `roundIndex ${roundIndex} is more than ${this.ackGapCap} ahead of lastAckedRoundIndex (${lastAcked})`,
      };
    }

    // ── Step 7: owner machine matches (or owner empty + claiming) ─
    const ownerMachineId = project.ownerMachineId ?? this.machineId;
    if (project.ownerMachineId && project.ownerMachineId !== this.machineId) {
      return {
        ok: false,
        code: 'NOT_OWNER_MACHINE',
        reason: `project owner is ${project.ownerMachineId}; this machine is ${this.machineId}`,
      };
    }

    // ── Step 8: targetRepoPath exists ─────────────────────────────
    const targetRepo = project.targetRepoPath;
    if (!targetRepo || !fs.existsSync(targetRepo) || !fs.existsSync(path.join(targetRepo, '.git'))) {
      return {
        ok: false,
        code: 'TARGET_REPO_PATH_INVALID',
        reason: `targetRepoPath "${targetRepo}" missing, not a git repo, or unreadable`,
      };
    }

    // ── Step 9: no awaitingReconciliation entries ────────────────
    if (Array.isArray(project.awaitingReconciliation) && project.awaitingReconciliation.length > 0) {
      return {
        ok: false,
        code: 'AWAITING_RECONCILIATION',
        reason: `${project.awaitingReconciliation.length} reconciliation conflict(s) pending`,
      };
    }

    // ── Step 10 (drift): deferred to follow-up PR ────────────────

    return { ok: true, project, round, children, ownerMachineId };
  }

  /**
   * Halt the active round of a project. Idempotent — halting an already-
   * halted round is a no-op. Releases the lock if the calling machine
   * holds it.
   *
   * Returns the round that was halted, or null if the project / round
   * didn't exist.
   */
  async halt(projectId: string, reason: string): Promise<{ project: Initiative; roundIndex: number } | null> {
    const project = this.tracker.get(projectId);
    if (!project || (project.kind ?? 'task') !== 'project') return null;

    // Find the active round. Preference order:
    //   1. in-progress (the canonical "active" state)
    //   2. pending / ready / undefined (round is queued but not yet
    //      running — calling halt on a queued round records the intent)
    //   3. already-halted (idempotent return of the existing state)
    const rounds = project.rounds ?? [];
    let activeIdx = rounds.findIndex((r) => r.status === 'in-progress');
    if (activeIdx === -1) activeIdx = rounds.findIndex((r) => {
      const s = r.status ?? 'pending';
      return s === 'pending' || s === 'ready';
    });
    if (activeIdx === -1) activeIdx = rounds.findIndex((r) => Boolean(r.haltedAt));
    if (activeIdx === -1) return null;

    const round = rounds[activeIdx];
    if (round.haltedAt) {
      // Idempotent — return current state.
      return { project, roundIndex: activeIdx };
    }

    const haltedAt = new Date().toISOString();
    const newRounds = rounds.map((r, i) =>
      i === activeIdx
        ? { ...r, status: 'failed' as RoundStatus, haltedAt, haltReason: reason }
        : r
    );
    const updated = await this.tracker.update(projectId, {
      rounds: newRounds,
      ifMatch: project.version,
    });

    // Release the lock if held by anyone — halt is the kill switch.
    // (The spec says SIGTERM-then-SIGKILL the autonomous child; that
    // path lands when run() ships. Here we just clear the lock.)
    const holder = this.lock.read();
    if (holder && holder.projectId === projectId && holder.roundIndex === activeIdx) {
      this.lock.release();
    }

    return { project: updated, roundIndex: activeIdx };
  }

  /**
   * Record a user acknowledgment for `roundIndex`. Idempotent: calling
   * twice with the same index has no further effect. The fields the spec
   * names: resets `unacknowledgedAdvanceCount`, populates
   * `firstLaunchAckAt` (if absent), advances `lastAckedRoundIndex`.
   */
  async recordAck(projectId: string, roundIndex: number): Promise<Initiative | null> {
    const project = this.tracker.get(projectId);
    if (!project || (project.kind ?? 'task') !== 'project') return null;

    // Spec § Phase 1.3: idempotent on lastAckedRoundIndex.
    const currentLastAck = project.lastAckedRoundIndex ?? -1;
    const effectiveLastAck = Math.max(currentLastAck, roundIndex);
    const firstLaunchAckAt = project.firstLaunchAckAt ?? new Date().toISOString();

    return this.tracker.update(projectId, {
      unacknowledgedAdvanceCount: 0,
      firstLaunchAckAt,
      lastAckedRoundIndex: effectiveLastAck,
      ifMatch: project.version,
    });
  }

  /**
   * Close a partially-complete round: missing items → skipped, round
   * status → `complete-with-skips`. Counts as an ack for `roundIndex`
   * (advances `lastAckedRoundIndex`) but does NOT touch
   * `unacknowledgedAdvanceCount`.
   *
   * The transition of each missing item to `skipped` requires `reason`
   * and `skippedBy` (per StageTransitionValidator). The caller passes
   * a single `reason` that's applied to every newly-skipped item.
   */
  async acceptPartial(
    projectId: string,
    roundIndex: number,
    reason: string,
    skippedBy: string
  ): Promise<{ project: Initiative; skippedItemIds: string[] } | null> {
    const project = this.tracker.get(projectId);
    if (!project || (project.kind ?? 'task') !== 'project') return null;

    const rounds = project.rounds ?? [];
    if (roundIndex < 0 || roundIndex >= rounds.length) return null;
    const round = rounds[roundIndex];

    // Skip each non-merged, non-already-skipped item.
    const skippedItemIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const cid of round.itemIds ?? []) {
      const child = this.tracker.get(cid);
      if (!child) continue;
      const stage = child.pipelineStage ?? 'outline';
      if (stage === 'merged' || stage === 'skipped') continue;
      await this.tracker.update(cid, {
        pipelineStage: 'skipped',
        ifMatch: child.version,
      });
      skippedItemIds.push(cid);
    }

    const newRounds = rounds.map((r, i) =>
      i === roundIndex ? { ...r, status: 'complete-with-skips' as RoundStatus, completedAt: nowIso } : r
    );
    // Advance lastAckedRoundIndex; do NOT change unacknowledgedAdvanceCount.
    const currentLastAck = project.lastAckedRoundIndex ?? -1;
    const updated = await this.tracker.update(projectId, {
      rounds: newRounds,
      lastAckedRoundIndex: Math.max(currentLastAck, roundIndex),
      ifMatch: project.version,
    });
    return { project: updated, skippedItemIds };
  }

  /**
   * Validate that a child initiative's spec frontmatter still has the
   * tags the round-runner requires before STARTing the autonomous loop.
   * Spec § Phase 1.5 step 3 + § Phase 1.4 "Authority separation":
   *   - `review-convergence: true`
   *   - `approved: true`
   *
   * Used by future `run()` and by the dashboard's "ready to start" badge.
   * Exported for tests.
   */
  static validateChildFrontmatter(
    targetRepoPath: string,
    specRelPath: string
  ): { ok: true } | { ok: false; reason: string } {
    const abs = path.isAbsolute(specRelPath)
      ? specRelPath
      : path.join(targetRepoPath, specRelPath);
    if (!fs.existsSync(abs)) {
      return { ok: false, reason: `spec file missing: ${specRelPath}` };
    }
    let body: string;
    try {
      body = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      return { ok: false, reason: `spec unreadable: ${(err as Error).message}` };
    }
    const fm = extractFrontmatter(body);
    if (fm.error) return { ok: false, reason: `frontmatter unparseable: ${fm.error}` };
    const data = fm.frontmatter ?? {};
    if (data['review-convergence'] !== true) {
      return { ok: false, reason: '`review-convergence: true` missing or false' };
    }
    if (data['approved'] !== true) {
      return { ok: false, reason: '`approved: true` missing or false' };
    }
    return { ok: true };
  }
}

/** Convenience alias for the lock primitive when callers want a typed reference. */
export type { ProjectRoundLockPayload } from './ProjectRoundLock.js';
