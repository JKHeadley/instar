/**
 * Evolution Manager — the feedback loop that turns running into evolving.
 *
 * Four subsystems, one principle: every interaction is an opportunity
 * to improve. Not during batch reflection hours later, but at the
 * moment the insight is freshest.
 *
 * Subsystems:
 * 1. Evolution Queue — staged self-improvement proposals
 * 2. Learning Registry — structured, searchable insights
 * 3. Capability Gap Tracker — "what am I missing?"
 * 4. Action Queue — commitment tracking with stale detection
 *
 * Born from Portal's engagement pipeline (Steps 8-11) and proven
 * across 100+ evolution proposals and 10 platform engagement skills.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  EvolutionProposal,
  EvolutionType,
  EvolutionStatus,
  LearningEntry,
  LearningSource,
  CapabilityGap,
  GapCategory,
  ActionItem,
  EvolutionManagerConfig,
} from './types.js';
import type { TrustElevationTracker } from './TrustElevationTracker.js';
import type { AutonomousEvolution, ReviewResult } from './AutonomousEvolution.js';
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { TaskFlowRegistry } from '../tasks/TaskFlowRegistry.js';
import type { TaskFlowRecord, TaskFlowPrincipal } from '../tasks/task-flow-types.js';
import { TaskFlowError } from '../tasks/task-flow-types.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';
import type { MemoryEvidence } from './types.js';

/**
 * WS2.2 (multi-machine-replicated-store-foundation) — the learning-record replication
 * emitter seam. server.ts injects a journal-backed emitter (built from the
 * CoherenceJournal clock + the `learning-record` kind) ONLY when
 * `multiMachine.stateSync.learnings.enabled` is true (default false ⇒ NOT injected ⇒ a
 * strict no-op, byte-identical single-machine behavior). The emitter NEVER throws out of
 * a learning write — a replication failure must never break a local write (the emitter
 * swallows + counts internally), so the manager calls it best-effort.
 *
 * CRITICAL: emitDelete MUST fire for every learning PRUNED over maxLearnings (the
 * saveLearnings prune path) — else a peer re-replicates the locally-pruned learning
 * forever (resurrection). The emitter keys the tombstone on the SAME content-fingerprint
 * recordKey the put used, so the delete reaches the same lesson on every machine even
 * though the local LRN-NNN ids differ.
 */
export interface LearningReplicationEmitter {
  /** Emit a `put` for a persisted learning (called from the save funnel). */
  emitPut(record: LearningEntry): void;
  /** Emit a `delete` tombstone for a removed/pruned learning, keyed on its content
   *  fingerprint (title/category/source). */
  emitDelete(title: string, category: string, source: LearningSource, deletedAt: string): void;
}

/**
 * WS2.5 (multi-machine-replicated-store-foundation) — the evolution-action-record
 * replication emitter seam. server.ts injects a journal-backed emitter (built from the
 * CoherenceJournal clock + the `evolution-action-record` kind) ONLY when
 * `multiMachine.stateSync.evolutionActions.enabled` is true (default false ⇒ NOT injected ⇒
 * a strict no-op, byte-identical single-machine behavior). The emitter NEVER throws out of an
 * action write — a replication failure must never break a local write (the emitter swallows +
 * counts internally), so the manager calls it best-effort.
 *
 * CRITICAL: emitPut MUST re-fire on a STATUS CHANGE (the whole point — a peer must SEE an
 * action was already completed/in_progress elsewhere so it does not redo it). The save funnel
 * re-emits every surviving action on every saveActions, so addAction AND updateAction both
 * re-emit.
 *
 * CRITICAL: emitDelete MUST fire for every action actually REMOVED from the queue (the
 * prune-over-maxActions path) — else a peer re-replicates the locally-removed action forever
 * (resurrection). A `completed`/`cancelled` action is a TERMINAL state, NOT a delete — its
 * record is retained (history); only an actual queue-removal tombstones. The emitter keys the
 * tombstone on the SAME content-fingerprint recordKey the put used, so the delete reaches the
 * same action on every machine even though the local ACT-NNN ids differ.
 */
export interface EvolutionActionReplicationEmitter {
  /** Emit a `put` for a persisted action (called from the save funnel; re-fires on every
   *  status change). */
  emitPut(record: ActionItem): void;
  /** Emit a `delete` tombstone for an action removed from the queue, keyed on its content
   *  fingerprint (title/commitTo/createdAt). */
  emitDelete(title: string, commitTo: string | null | undefined, createdAt: string, deletedAt: string): void;
}

/**
 * TaskFlow controller identity for EvolutionManager (Phase 3a dual-write).
 * Every proposal's flow is owned by this controllerId; the registry uses it
 * for OCC scope checks. Single-instance per server process.
 */
const EVOLUTION_TASKFLOW_CONTROLLER_ID = 'EvolutionManager';

/**
 * Map an `EvolutionStatus` to a TaskFlow-side status. Returned values match
 * the legal TaskFlow state-machine transitions:
 *   proposed     → queued (createFlow)
 *   approved     → running (startStep step='approved')
 *   in_progress  → running (startStep step='in_progress')
 *   implemented  → succeeded (finishFlow)
 *   rejected     → failed (failFlow)
 *   deferred     → cancelled (treated as soft-end; uses requestFlowCancel + cancelFlow)
 */
type ProposalFlowAction =
  | { kind: 'create'; step?: undefined }
  | { kind: 'start'; step: string }
  | { kind: 'finish' }
  | { kind: 'fail'; reason: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'noop' };

function statusToFlowAction(
  prev: EvolutionStatus | null,
  next: EvolutionStatus,
  resolution?: string
): ProposalFlowAction {
  // Initial create-from-proposed is handled in addProposal directly.
  if (prev === null && next === 'proposed') return { kind: 'create' };
  if (prev === next) return { kind: 'noop' };
  switch (next) {
    case 'approved':
      return { kind: 'start', step: 'approved' };
    case 'in_progress':
      return { kind: 'start', step: 'in_progress' };
    case 'implemented':
      return { kind: 'finish' };
    case 'rejected':
      return { kind: 'fail', reason: resolution ?? 'rejected' };
    case 'deferred':
      return { kind: 'cancel', reason: resolution ?? 'deferred' };
    case 'proposed':
      // Re-opening is not a legal transition; treat as no-op for v1.
      return { kind: 'noop' };
    default:
      return { kind: 'noop' };
  }
}

/**
 * Owner-key for a proposal-flow. Deterministic — used as both the TaskFlow
 * `ownerKey` and the basis of the `idempotencyKey`. Phase 3b's cutover
 * gate relies on `evolution:cluster:<id>` being a stable bidirectional join.
 */
function ownerKeyForProposal(proposalId: string): string {
  return `evolution:cluster:${proposalId}`;
}

interface EvolutionState {
  proposals: EvolutionProposal[];
  stats: {
    totalProposals: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    lastUpdated: string;
  };
}

interface LearningState {
  learnings: LearningEntry[];
  stats: {
    totalLearnings: number;
    applied: number;
    pending: number;
    byCategory: Record<string, number>;
    lastUpdated: string;
  };
}

interface GapState {
  gaps: CapabilityGap[];
  stats: {
    totalGaps: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    addressed: number;
    lastUpdated: string;
  };
}

interface ActionState {
  actions: ActionItem[];
  stats: {
    totalActions: number;
    pending: number;
    completed: number;
    overdue: number;
    lastUpdated: string;
  };
}

export class EvolutionManager {
  private stateDir: string;
  private config: EvolutionManagerConfig;
  private trustElevationTracker: TrustElevationTracker | null = null;
  private autonomousEvolution: AutonomousEvolution | null = null;
  private autonomyManager: AutonomyProfileManager | null = null;

  // ── TaskFlow Phase 3a dual-write fields ──────────────────────────
  /** Registry handle (set when TaskFlow is enabled). */
  private taskFlowRegistry: TaskFlowRegistry | null = null;
  /** Per-process controller-instance id (server uuid). */
  private taskFlowControllerInstanceId: string | null = null;
  /**
   * Set to true by DivergenceChecker when state-divergence is detected.
   * When true, EvolutionManager continues JSON-only writes and DOES NOT
   * dual-write to TaskFlow. The signal is reset on next divergence pass that
   * reports zero divergence. This is a signal-emitted brake, not a hard gate.
   */
  private taskFlowShadowWritesHalted = false;
  /** Most recent reason for halting; surfaced in /health and tests. */
  private taskFlowShadowWritesHaltReason: string | null = null;
  /**
   * Source of the most recent halt. DivergenceChecker uses this to ensure it
   * only auto-clears halts that DivergenceChecker itself imposed — an operator
   * or sibling system's manual halt stays in place until that source clears it.
   */
  private taskFlowShadowWritesHaltSource: string | null = null;

  // ── WikiClaim Evidence Phase 2 fields ───────────────────────────
  /**
   * SemanticMemory handle. When wired, EvolutionManager creates a `pattern`
   * MemoryEntity for each new proposal (the cluster) and populates evidence
   * rows linking the cluster to its constituent feedback IDs / commit SHAs /
   * session IDs. JSON state remains the source of truth for proposals; the
   * cluster entity is a parallel surface for inverse-traceability queries.
   *
   * See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Producers.
   */
  private semanticMemory: SemanticMemory | null = null;

  /**
   * WS2.2 learning-record replication emitter (injected, dark by default). Absent ⇒
   * strict no-op (single-machine, byte-identical). server.ts late-binds a journal-backed
   * emitter ONLY when `multiMachine.stateSync.learnings.enabled` is true.
   */
  private learningReplication: LearningReplicationEmitter | null = null;

  /**
   * WS2.5 evolution-action-record replication emitter (injected, dark by default). Absent ⇒
   * strict no-op (single-machine, byte-identical). server.ts late-binds a journal-backed
   * emitter ONLY when `multiMachine.stateSync.evolutionActions.enabled` is true.
   */
  private actionReplication: EvolutionActionReplicationEmitter | null = null;

  constructor(config: EvolutionManagerConfig) {
    this.config = config;
    this.stateDir = config.stateDir;
  }

  /**
   * Late-bind the WS2.2 learning-record replication emitter (server.ts constructs the
   * journal/clock AFTER the manager). Idempotent; passing undefined/null detaches (back
   * to single-machine no-op). The emit funnel checks `this.learningReplication` per
   * write, so attaching mid-life takes effect on the next save.
   */
  setLearningReplicationEmitter(emitter: LearningReplicationEmitter | null | undefined): void {
    this.learningReplication = emitter ?? null;
  }

  /**
   * Late-bind the WS2.5 evolution-action-record replication emitter (server.ts constructs the
   * journal/clock AFTER the manager). Idempotent; passing undefined/null detaches (back to
   * single-machine no-op). The emit funnel checks `this.actionReplication` per write, so
   * attaching mid-life takes effect on the next save (add/updateAction).
   */
  setEvolutionActionReplicationEmitter(emitter: EvolutionActionReplicationEmitter | null | undefined): void {
    this.actionReplication = emitter ?? null;
  }

  // ── TaskFlow wiring ─────────────────────────────────────────────

  /**
   * Wire a TaskFlow registry for Phase 3a dual-write. After this call:
   *   - addProposal / updateProposalStatus shadow-write to TaskFlow
   *   - migrateExistingToTaskFlow() backfills any in-flight clusters
   *   - DivergenceChecker can call setShadowWritesHalted() to brake writes
   *
   * Idempotent — safe to call multiple times; subsequent calls overwrite.
   */
  setTaskFlowRegistry(
    registry: TaskFlowRegistry,
    controllerInstanceId: string
  ): void {
    this.taskFlowRegistry = registry;
    this.taskFlowControllerInstanceId = controllerInstanceId;
  }

  getTaskFlowRegistry(): TaskFlowRegistry | null {
    return this.taskFlowRegistry;
  }

  /**
   * Halt or resume TaskFlow shadow-writes. Called by DivergenceChecker on a
   * mismatch. Signal-vs-authority compliance: this is a signal-consumed brake,
   * not a brittle blocker — the divergence checker decides, EvolutionManager
   * obeys. JSON writes continue regardless (read-authoritative TaskFlow is
   * shadow-mode in Phase 3a).
   *
   * The optional `source` parameter tags the halt with its origin so an
   * automatic clearer (DivergenceChecker) only cancels halts it caused.
   * Defaults to `'manual'` when omitted.
   */
  setShadowWritesHalted(halted: boolean, reason?: string, source?: string): void {
    this.taskFlowShadowWritesHalted = halted;
    this.taskFlowShadowWritesHaltReason = halted ? (reason ?? 'divergence-detected') : null;
    this.taskFlowShadowWritesHaltSource = halted ? (source ?? 'manual') : null;
  }

  isShadowWritesHalted(): { halted: boolean; reason: string | null; source: string | null } {
    return {
      halted: this.taskFlowShadowWritesHalted,
      reason: this.taskFlowShadowWritesHaltReason,
      source: this.taskFlowShadowWritesHaltSource,
    };
  }

  // ── WikiClaim Evidence Phase 2 wiring ───────────────────────────

  /**
   * Wire a SemanticMemory handle for cluster evidence emission. After this
   * call, `addProposal()` creates a `pattern` MemoryEntity for the cluster
   * with evidence linking to the proposal source, and `addClusterEvidence()`
   * appends evidence atomically as more inputs join the cluster.
   *
   * Idempotent — safe to call multiple times; subsequent calls overwrite.
   * Producers emit signals (evidence rows); they do NOT gate proposal flow.
   *
   * See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Producers.
   */
  setSemanticMemory(memory: SemanticMemory): void {
    this.semanticMemory = memory;
  }

  getSemanticMemory(): SemanticMemory | null {
    return this.semanticMemory;
  }

  /**
   * Append evidence to the cluster MemoryEntity for an existing proposal.
   * Used when more feedback / commits / sessions join an open cluster.
   * No-op when SemanticMemory is not wired or when the proposal has no
   * cluster entity yet (legacy proposals from before Phase 2).
   *
   * Allowed kinds (per spec § Producers): `feedback`, `pattern-entity`,
   * `supersedes-evidence`. Mismatches throw `EvidencePolicyError`.
   */
  addClusterEvidence(proposalId: string, evidence: MemoryEvidence | MemoryEvidence[]): void {
    if (!this.semanticMemory) return;
    const state = this.loadEvolution();
    const proposal = state.proposals.find((p) => p.id === proposalId);
    if (!proposal || !proposal.entityId) return;
    // Throws EvidencePolicyError on producer/kind mismatch — surfaced to caller
    // by design so a buggy emit-site isn't silently dropped.
    this.semanticMemory.addEvidence(proposal.entityId, evidence, 'EvolutionManager');
  }

  /**
   * Build the initial evidence array for a newly-created cluster from the
   * proposal's `source` field. Recognized patterns (mirrors backfill rules
   * in spec § Migration of Existing MemoryEntity Records, restricted to
   * EvolutionManager's allowlist):
   *
   *   - `feedback:<id>` → kind: 'feedback', sourceId: '<id>'
   *
   * Unrecognized sources produce no evidence (cluster is created with
   * `evidence: []`). Subsequent `addClusterEvidence()` calls populate as
   * inputs join. Empty evidence arrays are valid — `rememberWithEvidence`
   * with `evidence: []` is functionally equivalent to `remember()` plus the
   * consolidated JSONL action.
   */
  private buildInitialClusterEvidence(p: EvolutionProposal): MemoryEvidence[] {
    const now = this.now();
    const evidence: MemoryEvidence[] = [];
    const feedbackMatch = p.source.match(/^feedback:(.+)$/);
    if (feedbackMatch) {
      evidence.push({
        kind: 'feedback',
        sourceId: feedbackMatch[1],
        weight: 1.0,
        confidence: 0.8,
        // privacyTier omitted — inherits cluster's privacyScope ('shared-project')
        note: p.title.slice(0, 200),
        updatedAt: now,
      });
    }
    return evidence;
  }

  /**
   * Best-effort cluster-entity creation for a new proposal. Never throws to
   * the caller — JSON state remains the source of truth for proposals.
   * `EvidencePolicyError` (e.g., cap exceeded, kind mismatch) is logged and
   * swallowed; subsequent `addClusterEvidence()` calls can recover.
   *
   * Returns the entity id when created, or null when memory is not wired or
   * the cluster entity cannot be created.
   */
  private createClusterEntity(p: EvolutionProposal): string | null {
    if (!this.semanticMemory) return null;
    try {
      const evidence = this.buildInitialClusterEvidence(p);
      const id = this.semanticMemory.rememberWithEvidence(
        {
          type: 'pattern',
          name: p.title.slice(0, 200),
          content: p.description,
          confidence: p.impact === 'high' ? 0.85 : p.impact === 'low' ? 0.6 : 0.75,
          lastVerified: p.proposedAt,
          source: `evolution:${p.id}`,
          tags: ['cluster', 'evolution', p.type, ...(p.tags ?? [])],
          privacyScope: 'shared-project',
        },
        evidence,
        'EvolutionManager',
      );
      return id;
    } catch (err) {
      console.warn(
        `[EvolutionManager] cluster-entity create failed for ${p.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private taskFlowPrincipal(): TaskFlowPrincipal | null {
    if (!this.taskFlowRegistry || !this.taskFlowControllerInstanceId) return null;
    return {
      scope: 'controller',
      controllerId: EVOLUTION_TASKFLOW_CONTROLLER_ID,
      controllerInstanceId: this.taskFlowControllerInstanceId,
    };
  }

  /**
   * Best-effort dual-write to TaskFlow. NEVER throws to the caller — JSON
   * remains the local durability path; TaskFlow is shadow until Phase 3b
   * cutover. All TaskFlow errors land in console and the divergence checker
   * picks up via state comparison.
   */
  private async dualWriteCreate(p: EvolutionProposal): Promise<void> {
    if (!this.taskFlowRegistry || this.taskFlowShadowWritesHalted) return;
    const principal = this.taskFlowPrincipal();
    if (!principal || principal.scope !== 'controller') return;
    try {
      await this.taskFlowRegistry.createFlow({
        controllerId: EVOLUTION_TASKFLOW_CONTROLLER_ID,
        controllerInstanceId: principal.controllerInstanceId,
        ownerKey: ownerKeyForProposal(p.id),
        idempotencyKey: `evolution-cluster-create-${p.id}`,
        goal: p.title.slice(0, 1024),
        currentStep: 'proposed',
        stateJson: { proposalId: p.id, type: p.type, source: p.source },
      });
    } catch (err) {
      // Swallow — JSON is the source of truth in Phase 3a.
      this.logTaskFlowError('createFlow', p.id, err);
    }
  }

  private async dualWriteTransition(
    proposalId: string,
    action: ProposalFlowAction
  ): Promise<void> {
    if (!this.taskFlowRegistry || this.taskFlowShadowWritesHalted) return;
    if (action.kind === 'noop' || action.kind === 'create') return;
    const principal = this.taskFlowPrincipal();
    if (!principal) return;
    const registry = this.taskFlowRegistry;
    try {
      // Look up current flow by owner key + deterministic idempotency key.
      const existing = registry.findByIdempotency(
        EVOLUTION_TASKFLOW_CONTROLLER_ID,
        ownerKeyForProposal(proposalId),
        `evolution-cluster-create-${proposalId}`
      );
      if (!existing) {
        // No backfill yet — proposal exists in JSON but not TaskFlow. Skip
        // the transition silently; the next migrate-existing pass will pick
        // it up at its terminal state.
        return;
      }
      const flow = registry.getFlow(existing.flowId, { bypassCache: true });
      if (!flow) return;
      const expectedRevision = flow.revision;
      switch (action.kind) {
        case 'start': {
          if (flow.status !== 'queued' && flow.status !== 'running') return;
          await registry.startStep({
            flowId: flow.flowId,
            expectedRevision,
            principal,
            currentStep: action.step,
          });
          break;
        }
        case 'finish': {
          // Need flow in `running` state for finishFlow. If currently queued,
          // promote first.
          let rev = expectedRevision;
          let cur = flow;
          if (cur.status === 'queued') {
            const r = await registry.startStep({
              flowId: flow.flowId,
              expectedRevision: rev,
              principal,
              currentStep: 'implementing',
            });
            cur = r.flow;
            rev = r.flow.revision;
          }
          if (cur.status !== 'running') return;
          await registry.finishFlow({
            flowId: flow.flowId,
            expectedRevision: rev,
            principal,
          });
          break;
        }
        case 'fail': {
          let rev = expectedRevision;
          let cur = flow;
          // failFlow requires running|waiting. Promote queued → running.
          if (cur.status === 'queued') {
            const r = await registry.startStep({
              flowId: flow.flowId,
              expectedRevision: rev,
              principal,
              currentStep: 'reject-transition',
            });
            cur = r.flow;
            rev = r.flow.revision;
          }
          if (cur.status !== 'running' && cur.status !== 'waiting') return;
          await registry.failFlow({
            flowId: flow.flowId,
            expectedRevision: rev,
            principal,
            failureReason: action.reason,
          });
          break;
        }
        case 'cancel': {
          if (flow.status === 'succeeded' || flow.status === 'failed' ||
              flow.status === 'cancelled' || flow.status === 'lost') return;
          // Two-phase: request, then cancel.
          const r = await registry.requestFlowCancel({
            flowId: flow.flowId,
            expectedRevision,
            requesterOrigin: { kind: 'system', id: 'EvolutionManager' },
          });
          await registry.cancelFlow({
            flowId: flow.flowId,
            expectedRevision: r.flow.revision,
            principal,
          });
          break;
        }
      }
    } catch (err) {
      this.logTaskFlowError(`transition:${action.kind}`, proposalId, err);
    }
  }

  private logTaskFlowError(op: string, proposalId: string, err: unknown): void {
    if (err instanceof TaskFlowError) {
      // OCC conflicts and invalid-transition errors are expected during
      // races and concurrent updates — log at debug level only.
      console.warn(
        `[EvolutionManager] taskflow ${op} for ${proposalId} skipped: ${err.code} (${err.message})`
      );
    } else {
      console.warn(
        `[EvolutionManager] taskflow ${op} for ${proposalId} unexpected error:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Backfill all in-flight proposals (status !== 'implemented' && !== 'rejected')
   * into TaskFlow. Idempotent via `findIdempotent` on
   * `evolution:cluster:<proposalId>` ownerKey. Safe to call multiple times.
   *
   * Returns counts: created, alreadyExisted, advanced (transitioned beyond
   * 'queued' to match the proposal's current status).
   */
  async migrateExistingToTaskFlow(): Promise<{
    created: number;
    alreadyExisted: number;
    advanced: number;
    skipped: number;
  }> {
    if (!this.taskFlowRegistry) {
      return { created: 0, alreadyExisted: 0, advanced: 0, skipped: 0 };
    }
    const principal = this.taskFlowPrincipal();
    if (!principal || principal.scope !== 'controller') {
      return { created: 0, alreadyExisted: 0, advanced: 0, skipped: 0 };
    }
    const registry = this.taskFlowRegistry;
    const state = this.loadEvolution();
    let created = 0;
    let alreadyExisted = 0;
    let advanced = 0;
    let skipped = 0;
    for (const p of state.proposals) {
      try {
        const existing = registry.findByIdempotency(
          EVOLUTION_TASKFLOW_CONTROLLER_ID,
          ownerKeyForProposal(p.id),
          `evolution-cluster-create-${p.id}`
        );
        let flow: TaskFlowRecord;
        if (existing) {
          alreadyExisted++;
          flow = existing;
        } else {
          const r = await registry.createFlow({
            controllerId: EVOLUTION_TASKFLOW_CONTROLLER_ID,
            controllerInstanceId: principal.controllerInstanceId,
            ownerKey: ownerKeyForProposal(p.id),
            idempotencyKey: `evolution-cluster-create-${p.id}`,
            goal: p.title.slice(0, 1024),
            currentStep: 'proposed',
            stateJson: { proposalId: p.id, type: p.type, source: p.source },
          });
          if (r.created) created++;
          else alreadyExisted++;
          flow = r.flow;
        }
        // Catch the flow up to the proposal's current status.
        const advancedThis = await this.catchUpFlowToStatus(flow, p, principal);
        if (advancedThis) advanced++;
      } catch (err) {
        skipped++;
        this.logTaskFlowError('migrate', p.id, err);
      }
    }
    return { created, alreadyExisted, advanced, skipped };
  }

  /** Catch a flow record up to the proposal's current status. */
  private async catchUpFlowToStatus(
    flow: TaskFlowRecord,
    p: EvolutionProposal,
    principal: TaskFlowPrincipal
  ): Promise<boolean> {
    if (!this.taskFlowRegistry) return false;
    const registry = this.taskFlowRegistry;
    let cur = registry.getFlow(flow.flowId, { bypassCache: true }) ?? flow;
    let mutated = false;
    const target = p.status;
    // Already terminal — leave alone.
    if (cur.status === 'succeeded' || cur.status === 'failed' ||
        cur.status === 'cancelled' || cur.status === 'lost') {
      return false;
    }
    // Promote queued → running if target is running/terminal-success/failed.
    if (cur.status === 'queued' && (target === 'approved' || target === 'in_progress' ||
        target === 'implemented' || target === 'rejected' || target === 'deferred')) {
      const step = target === 'in_progress' ? 'in_progress'
        : target === 'approved' ? 'approved' : 'catch-up';
      const r = await registry.startStep({
        flowId: cur.flowId,
        expectedRevision: cur.revision,
        principal,
        currentStep: step,
      });
      cur = r.flow;
      mutated = true;
    }
    // Finalize.
    if (target === 'implemented' && cur.status === 'running') {
      await registry.finishFlow({
        flowId: cur.flowId,
        expectedRevision: cur.revision,
        principal,
      });
      mutated = true;
    } else if (target === 'rejected' &&
               (cur.status === 'running' || cur.status === 'waiting')) {
      await registry.failFlow({
        flowId: cur.flowId,
        expectedRevision: cur.revision,
        principal,
        failureReason: p.resolution ?? 'rejected',
      });
      mutated = true;
    } else if (target === 'deferred' &&
               (cur.status === 'running' || cur.status === 'waiting' || cur.status === 'queued')) {
      const r = await registry.requestFlowCancel({
        flowId: cur.flowId,
        expectedRevision: cur.revision,
        requesterOrigin: { kind: 'system', id: 'EvolutionManager' },
      });
      await registry.cancelFlow({
        flowId: cur.flowId,
        expectedRevision: r.flow.revision,
        principal,
      });
      mutated = true;
    }
    return mutated;
  }

  /**
   * Wire adaptive autonomy modules for runtime integration.
   * - TrustElevationTracker: receives proposal approval/rejection events
   * - AutonomousEvolution: handles auto-implementation when in autonomous mode
   * - AutonomyProfileManager: provides current autonomy profile state
   */
  setAdaptiveAutonomyModules(modules: {
    trustElevationTracker?: TrustElevationTracker | null;
    autonomousEvolution?: AutonomousEvolution | null;
    autonomyManager?: AutonomyProfileManager | null;
  }): void {
    this.trustElevationTracker = modules.trustElevationTracker ?? null;
    this.autonomousEvolution = modules.autonomousEvolution ?? null;
    this.autonomyManager = modules.autonomyManager ?? null;
  }

  /**
   * Get the wired TrustElevationTracker (for external access, e.g. routes).
   */
  getTrustElevationTracker(): TrustElevationTracker | null {
    return this.trustElevationTracker;
  }

  /**
   * Get the wired AutonomousEvolution module (for external access, e.g. routes).
   */
  getAutonomousEvolution(): AutonomousEvolution | null {
    return this.autonomousEvolution;
  }

  // ── File I/O ────────────────────────────────────────────────────

  private filePath(name: string): string {
    return path.join(this.stateDir, 'state', 'evolution', `${name}.json`);
  }

  private readFile<T>(name: string, defaultValue: T): T {
    const fp = this.filePath(name);
    if (!fs.existsSync(fp)) return defaultValue;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      console.warn(`[EvolutionManager] Corrupted file: ${fp}`);
      return defaultValue;
    }
  }

  private writeFile<T>(name: string, data: T): void {
    const fp = this.filePath(name);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = fp + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, fp);
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/EvolutionManager.ts:147' }); } catch { /* ignore */ }
      throw err;
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ── Evolution Queue ─────────────────────────────────────────────

  private loadEvolution(): EvolutionState {
    return this.readFile<EvolutionState>('evolution-queue', {
      proposals: [],
      stats: { totalProposals: 0, byStatus: {}, byType: {}, lastUpdated: this.now() },
    });
  }

  private saveEvolution(state: EvolutionState): void {
    // Recompute stats
    const statusCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const p of state.proposals) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
    }
    state.stats = {
      totalProposals: state.proposals.length,
      byStatus: statusCounts,
      byType: typeCounts,
      lastUpdated: this.now(),
    };

    // Archive old implemented/rejected proposals if over limit
    const max = this.config.maxProposals || 200;
    if (state.proposals.length > max) {
      const active = state.proposals.filter(p => !['implemented', 'rejected'].includes(p.status));
      const archived = state.proposals.filter(p => ['implemented', 'rejected'].includes(p.status));
      // Keep most recent archived
      const keep = archived.slice(-Math.max(0, max - active.length));
      state.proposals = [...active, ...keep];
    }

    this.writeFile('evolution-queue', state);
  }

  private nextProposalId(state: EvolutionState): string {
    const existing = new Set(state.proposals.map(p => p.id));
    let num = 1;
    while (existing.has(`EVO-${String(num).padStart(3, '0')}`)) num++;
    return `EVO-${String(num).padStart(3, '0')}`;
  }

  addProposal(opts: {
    title: string;
    source: string;
    description: string;
    type: EvolutionType;
    impact?: 'high' | 'medium' | 'low';
    effort?: 'high' | 'medium' | 'low';
    proposedBy?: string;
    tags?: string[];
  }): EvolutionProposal {
    const state = this.loadEvolution();
    const id = this.nextProposalId(state);
    const proposal: EvolutionProposal = {
      id,
      title: opts.title,
      source: opts.source,
      description: opts.description,
      type: opts.type,
      impact: opts.impact || 'medium',
      effort: opts.effort || 'medium',
      status: 'proposed',
      proposedBy: opts.proposedBy || 'agent',
      proposedAt: this.now(),
      tags: opts.tags,
    };
    // WikiClaim Phase 2: create cluster MemoryEntity and capture entityId BEFORE
    // saving JSON, so the persisted proposal carries its cluster reference.
    // Failure to create the cluster entity is logged and swallowed inside
    // createClusterEntity — the proposal still ships with `entityId: undefined`.
    const entityId = this.createClusterEntity(proposal);
    if (entityId) proposal.entityId = entityId;

    state.proposals.push(proposal);
    this.saveEvolution(state);

    // TaskFlow Phase 3a shadow-write — best-effort, JSON remains source of truth.
    void this.dualWriteCreate(proposal);

    return proposal;
  }

  updateProposalStatus(id: string, status: EvolutionStatus, resolution?: string): boolean {
    const state = this.loadEvolution();
    const proposal = state.proposals.find(p => p.id === id);
    if (!proposal) return false;
    const prevStatus = proposal.status;
    proposal.status = status;
    if (resolution) proposal.resolution = resolution;
    if (status === 'implemented') proposal.implementedAt = this.now();
    this.saveEvolution(state);

    // Feed decision to TrustElevationTracker for acceptance rate tracking
    if (this.trustElevationTracker && (status === 'approved' || status === 'rejected')) {
      const decision = status === 'approved' ? 'approved' : 'rejected';
      this.trustElevationTracker.recordProposalDecision(proposal, decision, false);
    }

    // TaskFlow Phase 3a shadow-write — best-effort, JSON remains source of truth.
    const action = statusToFlowAction(prevStatus, status, resolution);
    void this.dualWriteTransition(id, action);

    return true;
  }

  /**
   * Process a proposal through the autonomous evolution pipeline.
   * If in autonomous mode and the review approves with safe scope,
   * the proposal is auto-implemented via sidecar pattern.
   *
   * Returns the action taken, or null if autonomous modules aren't wired.
   */
  processProposalAutonomously(
    proposalId: string,
    review: ReviewResult,
  ): { action: string; reason: string } | null {
    if (!this.autonomousEvolution || !this.autonomyManager) return null;

    const resolved = this.autonomyManager.getResolvedState();
    const isAutonomous = resolved.evolutionApprovalMode === 'autonomous';

    const evaluation = this.autonomousEvolution.evaluateForAutoImplementation(review, isAutonomous);

    const state = this.loadEvolution();
    const proposal = state.proposals.find(p => p.id === proposalId);
    if (!proposal) return null;

    switch (evaluation.action) {
      case 'auto-implement':
        // Auto-approve and create notification
        this.updateProposalStatus(proposalId, 'approved', evaluation.reason);
        this.autonomousEvolution.createNotification(proposal, 'auto-implemented', review, evaluation.reason);
        break;
      case 'reject':
        this.updateProposalStatus(proposalId, 'rejected', evaluation.reason);
        this.autonomousEvolution.createNotification(proposal, 'rejected', review, evaluation.reason);
        break;
      case 'needs-review':
        this.autonomousEvolution.createNotification(proposal, 'needs-review', review, evaluation.reason);
        break;
      case 'queue-for-approval':
        // Stays as proposed — human will approve via API
        break;
    }

    return { action: evaluation.action, reason: evaluation.reason };
  }

  listProposals(filter?: { status?: EvolutionStatus; type?: EvolutionType }): EvolutionProposal[] {
    const state = this.loadEvolution();
    let proposals = state.proposals;
    if (filter?.status) proposals = proposals.filter(p => p.status === filter.status);
    if (filter?.type) proposals = proposals.filter(p => p.type === filter.type);
    return proposals;
  }

  getEvolutionStats(): EvolutionState['stats'] {
    return this.loadEvolution().stats;
  }

  // ── Learning Registry ───────────────────────────────────────────

  private loadLearnings(): LearningState {
    return this.readFile<LearningState>('learning-registry', {
      learnings: [],
      stats: { totalLearnings: 0, applied: 0, pending: 0, byCategory: {}, lastUpdated: this.now() },
    });
  }

  private saveLearnings(state: LearningState): void {
    const categoryCounts: Record<string, number> = {};
    let applied = 0;
    for (const l of state.learnings) {
      categoryCounts[l.category] = (categoryCounts[l.category] || 0) + 1;
      if (l.applied) applied++;
    }
    state.stats = {
      totalLearnings: state.learnings.length,
      applied,
      pending: state.learnings.length - applied,
      byCategory: categoryCounts,
      lastUpdated: this.now(),
    };

    const max = this.config.maxLearnings || 500;
    const beforePrune = state.learnings;
    if (state.learnings.length > max) {
      const unapplied = state.learnings.filter(l => !l.applied);
      const appliedEntries = state.learnings.filter(l => l.applied);
      const keep = appliedEntries.slice(-Math.max(0, max - unapplied.length));
      state.learnings = [...unapplied, ...keep];
    }

    this.writeFile('learning-registry', state);

    // WS2.2 — best-effort replication emission (dark by default; the emitter is only
    // injected when multiMachine.stateSync.learnings.enabled is true). The emitter
    // swallows its own errors, but we wrap defensively so a replication fault can NEVER
    // break a local learning write. CRITICAL (tombstone resurrection guard): a learning
    // that was PRUNED over maxLearnings emits an op:delete tombstone, else a peer
    // re-replicates the locally-pruned learning forever.
    const emitter = this.learningReplication;
    if (emitter) {
      const survivors = new Set(state.learnings.map(l => l.id));
      const deletedAt = this.now();
      for (const pruned of beforePrune) {
        if (survivors.has(pruned.id)) continue;
        try {
          emitter.emitDelete(pruned.title, pruned.category, pruned.source, deletedAt);
        } catch {
          // @silent-fallback-ok: a replication emit fault must never break or roll back
          // a local learning write — the durable on-disk state is already persisted
          // above. The emitter counts its own failures internally; this guard only
          // ensures a throw from the seam cannot propagate into the local write path.
        }
      }
      for (const l of state.learnings) {
        try {
          emitter.emitPut(l);
        } catch {
          // @silent-fallback-ok: see the emitDelete guard above — replication is
          // best-effort and must never break the local write.
        }
      }
    }
  }

  private nextLearningId(state: LearningState): string {
    const existing = new Set(state.learnings.map(l => l.id));
    let num = 1;
    while (existing.has(`LRN-${String(num).padStart(3, '0')}`)) num++;
    return `LRN-${String(num).padStart(3, '0')}`;
  }

  addLearning(opts: {
    title: string;
    category: string;
    description: string;
    source: LearningSource;
    tags?: string[];
    evolutionRelevance?: string;
  }): LearningEntry {
    const state = this.loadLearnings();
    const id = this.nextLearningId(state);
    const learning: LearningEntry = {
      id,
      title: opts.title,
      category: opts.category,
      description: opts.description,
      source: opts.source,
      tags: opts.tags || [],
      applied: false,
      evolutionRelevance: opts.evolutionRelevance,
    };
    state.learnings.push(learning);
    this.saveLearnings(state);
    return learning;
  }

  markLearningApplied(id: string, appliedTo: string): boolean {
    const state = this.loadLearnings();
    const learning = state.learnings.find(l => l.id === id);
    if (!learning) return false;
    learning.applied = true;
    learning.appliedTo = appliedTo;
    this.saveLearnings(state);
    return true;
  }

  listLearnings(filter?: { category?: string; applied?: boolean }): LearningEntry[] {
    const state = this.loadLearnings();
    let learnings = state.learnings;
    if (filter?.category) learnings = learnings.filter(l => l.category === filter.category);
    if (filter?.applied !== undefined) learnings = learnings.filter(l => l.applied === filter.applied);
    return learnings;
  }

  getLearningStats(): LearningState['stats'] {
    return this.loadLearnings().stats;
  }

  // ── Capability Gap Tracker ──────────────────────────────────────

  private loadGaps(): GapState {
    return this.readFile<GapState>('capability-gaps', {
      gaps: [],
      stats: { totalGaps: 0, bySeverity: {}, byCategory: {}, addressed: 0, lastUpdated: this.now() },
    });
  }

  private saveGaps(state: GapState): void {
    const severityCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    let addressed = 0;
    for (const g of state.gaps) {
      severityCounts[g.severity] = (severityCounts[g.severity] || 0) + 1;
      categoryCounts[g.category] = (categoryCounts[g.category] || 0) + 1;
      if (g.status === 'addressed') addressed++;
    }
    state.stats = {
      totalGaps: state.gaps.length,
      bySeverity: severityCounts,
      byCategory: categoryCounts,
      addressed,
      lastUpdated: this.now(),
    };

    const max = this.config.maxGaps || 200;
    if (state.gaps.length > max) {
      const open = state.gaps.filter(g => g.status === 'identified');
      const closed = state.gaps.filter(g => g.status !== 'identified');
      const keep = closed.slice(-Math.max(0, max - open.length));
      state.gaps = [...open, ...keep];
    }

    this.writeFile('capability-gaps', state);
  }

  private nextGapId(state: GapState): string {
    const existing = new Set(state.gaps.map(g => g.id));
    let num = 1;
    while (existing.has(`GAP-${String(num).padStart(3, '0')}`)) num++;
    return `GAP-${String(num).padStart(3, '0')}`;
  }

  addGap(opts: {
    title: string;
    category: GapCategory;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    context: string;
    platform?: string;
    session?: string;
    currentState?: string;
    proposedSolution?: string;
  }): CapabilityGap {
    const state = this.loadGaps();
    const id = this.nextGapId(state);
    const gap: CapabilityGap = {
      id,
      title: opts.title,
      category: opts.category,
      severity: opts.severity,
      description: opts.description,
      discoveredFrom: {
        context: opts.context,
        platform: opts.platform,
        discoveredAt: this.now(),
        session: opts.session,
      },
      currentState: opts.currentState || 'Not implemented',
      proposedSolution: opts.proposedSolution,
      status: 'identified',
    };
    state.gaps.push(gap);
    this.saveGaps(state);
    return gap;
  }

  addressGap(id: string, resolution: string): boolean {
    const state = this.loadGaps();
    const gap = state.gaps.find(g => g.id === id);
    if (!gap) return false;
    gap.status = 'addressed';
    gap.resolution = resolution;
    gap.addressedAt = this.now();
    this.saveGaps(state);
    return true;
  }

  listGaps(filter?: { severity?: string; category?: GapCategory; status?: string }): CapabilityGap[] {
    const state = this.loadGaps();
    let gaps = state.gaps;
    if (filter?.severity) gaps = gaps.filter(g => g.severity === filter.severity);
    if (filter?.category) gaps = gaps.filter(g => g.category === filter.category);
    if (filter?.status) gaps = gaps.filter(g => g.status === filter.status);
    return gaps;
  }

  getGapStats(): GapState['stats'] {
    return this.loadGaps().stats;
  }

  // ── Action Queue ────────────────────────────────────────────────

  private loadActions(): ActionState {
    return this.readFile<ActionState>('action-queue', {
      actions: [],
      stats: { totalActions: 0, pending: 0, completed: 0, overdue: 0, lastUpdated: this.now() },
    });
  }

  private saveActions(state: ActionState): void {
    let pending = 0, completed = 0, overdue = 0;
    const now = new Date();
    for (const a of state.actions) {
      if (a.status === 'completed') completed++;
      else if (a.status === 'pending' || a.status === 'in_progress') {
        pending++;
        if (a.dueBy && new Date(a.dueBy) < now) overdue++;
      }
    }
    state.stats = {
      totalActions: state.actions.length,
      pending,
      completed,
      overdue,
      lastUpdated: this.now(),
    };

    const max = this.config.maxActions || 300;
    const beforePrune = state.actions;
    if (state.actions.length > max) {
      const active = state.actions.filter(a => !['completed', 'cancelled'].includes(a.status));
      const done = state.actions.filter(a => ['completed', 'cancelled'].includes(a.status));
      const keep = done.slice(-Math.max(0, max - active.length));
      state.actions = [...active, ...keep];
    }

    this.writeFile('action-queue', state);

    // WS2.5 — best-effort replication emission (dark by default; the emitter is only
    // injected when multiMachine.stateSync.evolutionActions.enabled is true). The emitter
    // swallows its own errors, but we wrap defensively so a replication fault can NEVER
    // break a local action write. CRITICAL (fork #2): a STATUS CHANGE must re-emit — both
    // addAction and updateAction route through saveActions, so re-emitting every survivor on
    // every save makes a peer SEE an action's latest status (completed/in_progress) so it does
    // not redo it. CRITICAL (resurrection guard): an action that was actually REMOVED from the
    // queue (prune-over-maxActions) emits an op:delete tombstone — a terminal completed/
    // cancelled action that is RETAINED is NOT tombstoned, only an actual queue-removal is.
    const emitter = this.actionReplication;
    if (emitter) {
      const survivors = new Set(state.actions.map(a => a.id));
      const deletedAt = this.now();
      for (const pruned of beforePrune) {
        if (survivors.has(pruned.id)) continue;
        try {
          emitter.emitDelete(pruned.title, pruned.commitTo, pruned.createdAt, deletedAt);
        } catch {
          // @silent-fallback-ok: a replication emit fault must never break or roll back a
          // local action write — the durable on-disk state is already persisted above. The
          // emitter counts its own failures internally; this guard only ensures a throw from
          // the seam cannot propagate into the local write path.
        }
      }
      for (const a of state.actions) {
        try {
          emitter.emitPut(a);
        } catch {
          // @silent-fallback-ok: see the emitDelete guard above — replication is best-effort
          // and must never break the local write.
        }
      }
    }
  }

  private nextActionId(state: ActionState): string {
    const existing = new Set(state.actions.map(a => a.id));
    let num = 1;
    while (existing.has(`ACT-${String(num).padStart(3, '0')}`)) num++;
    return `ACT-${String(num).padStart(3, '0')}`;
  }

  addAction(opts: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    commitTo?: string;
    dueBy?: string;
    source?: ActionItem['source'];
    tags?: string[];
  }): ActionItem {
    const state = this.loadActions();
    const id = this.nextActionId(state);
    const action: ActionItem = {
      id,
      title: opts.title,
      description: opts.description,
      priority: opts.priority || 'medium',
      status: 'pending',
      commitTo: opts.commitTo,
      createdAt: this.now(),
      dueBy: opts.dueBy,
      source: opts.source,
      tags: opts.tags,
    };
    state.actions.push(action);
    this.saveActions(state);
    return action;
  }

  updateAction(id: string, updates: {
    status?: ActionItem['status'];
    resolution?: string;
  }): boolean {
    const state = this.loadActions();
    const action = state.actions.find(a => a.id === id);
    if (!action) return false;
    if (updates.status) {
      action.status = updates.status;
      if (updates.status === 'completed') action.completedAt = this.now();
    }
    if (updates.resolution) action.resolution = updates.resolution;
    this.saveActions(state);
    return true;
  }

  listActions(filter?: { status?: ActionItem['status']; priority?: string }): ActionItem[] {
    const state = this.loadActions();
    let actions = state.actions;
    if (filter?.status) actions = actions.filter(a => a.status === filter.status);
    if (filter?.priority) actions = actions.filter(a => a.priority === filter.priority);
    return actions;
  }

  getOverdueActions(): ActionItem[] {
    const state = this.loadActions();
    const now = new Date();
    return state.actions.filter(a =>
      (a.status === 'pending' || a.status === 'in_progress') &&
      a.dueBy && new Date(a.dueBy) < now
    );
  }

  getActionStats(): ActionState['stats'] {
    return this.loadActions().stats;
  }

  // ── Cross-System Queries ────────────────────────────────────────

  /**
   * Get a full dashboard of evolution health.
   * Useful for session-start orientation and status reporting.
   */
  getDashboard(): {
    evolution: EvolutionState['stats'];
    learnings: LearningState['stats'];
    gaps: GapState['stats'];
    actions: ActionState['stats'];
    highlights: string[];
  } {
    const evolution = this.getEvolutionStats();
    const learnings = this.getLearningStats();
    const gaps = this.getGapStats();
    const actions = this.getActionStats();
    const overdue = this.getOverdueActions();

    const highlights: string[] = [];
    const proposed = evolution.byStatus['proposed'] || 0;
    if (proposed > 0) highlights.push(`${proposed} evolution proposal(s) awaiting review`);
    if (learnings.pending > 0) highlights.push(`${learnings.pending} learning(s) not yet applied`);
    const criticalGaps = gaps.bySeverity['critical'] || 0;
    if (criticalGaps > 0) highlights.push(`${criticalGaps} critical capability gap(s)`);
    if (overdue.length > 0) highlights.push(`${overdue.length} overdue action item(s)`);
    if (highlights.length === 0) highlights.push('All systems healthy — no pending evolution items');

    return { evolution, learnings, gaps, actions, highlights };
  }

  // ── Implicit Evolution Detection ──────────────────────────────
  //
  // Inspired by Dawn's REC-52-2 pattern: scan open gaps and proposals
  // to detect when a capability need is already satisfied by existing
  // infrastructure (implemented proposals, applied learnings, addressed gaps).
  // This prevents duplicate proposals and accelerates the feedback loop.

  /**
   * Detect gaps or proposals that may already be resolved by existing infrastructure.
   *
   * Scans open gaps and proposed items against:
   *   - Implemented proposals (already built)
   *   - Applied learnings (already absorbed)
   *   - Addressed gaps (already resolved)
   *
   * Returns items that appear to have implicit resolutions, with evidence.
   */
  detectImplicitEvolution(): Array<{
    type: 'gap' | 'proposal';
    id: string;
    title: string;
    matchedBy: { type: string; id: string; title: string; similarity: string };
  }> {
    const evolutionState = this.loadEvolution();
    const gapState = this.loadGaps();
    const learningState = this.loadLearnings();

    const resolved: Array<{
      type: 'gap' | 'proposal';
      id: string;
      title: string;
      matchedBy: { type: string; id: string; title: string; similarity: string };
    }> = [];

    // Build keyword index from implemented/resolved items
    const implementedProposals = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'implemented',
    );
    const appliedLearnings = learningState.learnings.filter(
      (l: LearningEntry) => l.applied,
    );
    const addressedGaps = gapState.gaps.filter((g: CapabilityGap) => g.status === 'addressed');

    // Check open proposals against implemented ones
    const openProposals = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'proposed',
    );
    for (const open of openProposals) {
      const match = this.findKeywordMatch(
        open.title + ' ' + open.description,
        [
          ...implementedProposals.map((p: EvolutionProposal) => ({
            type: 'implemented-proposal',
            id: p.id,
            title: p.title,
            text: p.title + ' ' + p.description,
          })),
          ...appliedLearnings.map((l: LearningEntry) => ({
            type: 'applied-learning',
            id: l.id,
            title: l.title,
            text: l.title + ' ' + l.description,
          })),
        ],
      );
      if (match) {
        resolved.push({
          type: 'proposal',
          id: open.id,
          title: open.title,
          matchedBy: match,
        });
      }
    }

    // Check open gaps against resolved infrastructure
    const openGaps = gapState.gaps.filter((g: CapabilityGap) => g.status === 'identified');
    for (const gap of openGaps) {
      const match = this.findKeywordMatch(
        gap.title + ' ' + gap.description,
        [
          ...implementedProposals.map((p: EvolutionProposal) => ({
            type: 'implemented-proposal',
            id: p.id,
            title: p.title,
            text: p.title + ' ' + p.description,
          })),
          ...addressedGaps.map((g2: CapabilityGap) => ({
            type: 'addressed-gap',
            id: g2.id,
            title: g2.title,
            text: g2.title + ' ' + g2.description + ' ' + (g2.resolution || ''),
          })),
        ],
      );
      if (match) {
        resolved.push({
          type: 'gap',
          id: gap.id,
          title: gap.title,
          matchedBy: match,
        });
      }
    }

    return resolved;
  }

  /**
   * Verify that implemented proposals left actual file traces in the workspace.
   *
   * Inspired by Dawn's lesson-behavior-gap analyzer: proposals marked
   * "implemented" should have corresponding infrastructure (hooks, scripts,
   * config entries, code files). Proposals with no detectable traces may be
   * "phantom implementations" — marked done without actual changes.
   *
   * Returns proposals that lack verifiable infrastructure traces.
   */
  verifyImplementationTraces(): Array<{
    id: string;
    title: string;
    implementedAt: string;
    tracesFound: string[];
    verdict: 'verified' | 'unverified' | 'weak';
  }> {
    const evolutionState = this.loadEvolution();
    const implemented = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'implemented',
    );

    const results: Array<{
      id: string;
      title: string;
      implementedAt: string;
      tracesFound: string[];
      verdict: 'verified' | 'unverified' | 'weak';
    }> = [];

    // Build search paths
    const projectDir = this.config.stateDir.replace(/\/.instar\/state$/, '');
    const searchDirs = [
      path.join(projectDir, '.instar', 'hooks'),
      path.join(projectDir, '.instar', 'scripts'),
      path.join(projectDir, '.claude', 'hooks'),
      path.join(projectDir, '.claude', 'skills'),
      path.join(projectDir, '.claude', 'scripts'),
    ].filter(d => fs.existsSync(d));

    for (const proposal of implemented) {
      const keywords = this.extractKeywords(proposal.title + ' ' + proposal.description);
      const traces: string[] = [];

      // Check if any file in infrastructure dirs mentions keywords from the proposal
      for (const dir of searchDirs) {
        try {
          const files = fs.readdirSync(dir, { recursive: true }) as string[];
          for (const file of files) {
            const filePath = path.join(dir, String(file));
            try {
              const stat = fs.statSync(filePath);
              if (!stat.isFile()) continue;
              // Check filename match
              const fileName = path.basename(String(file)).toLowerCase();
              const nameKeywords = new Set(fileName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2));
              const nameOverlap = [...keywords].filter(k => nameKeywords.has(k));
              if (nameOverlap.length >= 2) {
                traces.push(`filename:${path.relative(projectDir, filePath)}`);
              }
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }
      }

      // Check git log for mentions (fast: just search commit messages)
      // Skip this for performance — file traces are sufficient

      const verdict = traces.length >= 2 ? 'verified'
        : traces.length === 1 ? 'weak'
        : 'unverified';

      results.push({
        id: proposal.id,
        title: proposal.title,
        implementedAt: proposal.implementedAt || proposal.proposedAt || '',
        tracesFound: traces,
        verdict,
      });
    }

    return results;
  }

  /**
   * Simple keyword overlap matching. Returns the best match if overlap
   * exceeds a threshold, or null if no match is strong enough.
   */
  private findKeywordMatch(
    query: string,
    candidates: Array<{ type: string; id: string; title: string; text: string }>,
  ): { type: string; id: string; title: string; similarity: string } | null {
    const queryWords = this.extractKeywords(query);
    if (queryWords.size < 2) return null;

    let bestMatch: { type: string; id: string; title: string; similarity: string } | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const candidateWords = this.extractKeywords(candidate.text);
      const intersection = new Set([...queryWords].filter(w => candidateWords.has(w)));
      // Jaccard-like overlap score
      const union = new Set([...queryWords, ...candidateWords]);
      const score = intersection.size / union.size;

      // Require at least 30% overlap and 3+ shared keywords
      if (score > bestScore && score >= 0.3 && intersection.size >= 3) {
        bestScore = score;
        bestMatch = {
          type: candidate.type,
          id: candidate.id,
          title: candidate.title,
          similarity: `${Math.round(score * 100)}% keyword overlap`,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Extract meaningful keywords from text, filtering stop words.
   */
  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
      'during', 'before', 'after', 'above', 'below', 'between', 'and',
      'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
      'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
      'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
      'just', 'because', 'as', 'until', 'while', 'if', 'then', 'that',
      'this', 'these', 'those', 'it', 'its', 'when', 'where', 'which',
      'what', 'who', 'how', 'why', 'also', 'add', 'use', 'using', 'used',
    ]);

    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w)),
    );
  }
}
