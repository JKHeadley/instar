import { createHash, randomUUID } from 'node:crypto';
import type { Cluster } from '../processor/types.js';
import type { FeedbackProcessingService } from '../processing/FeedbackProcessingService.js';
import { DrainConflictError, FeedbackDrainStore, type AuthorityRecord, type ReadinessProjection } from './FeedbackDrainStore.js';
import type { FeedbackInitiativeConsumer } from './FeedbackInitiativeConsumer.js';
import { FEEDBACK_READINESS_MODEL_TIMEOUT_MS, ReadinessContractViolation, type FeedbackReadinessArbiter, type ReadinessCandidate, type ReadinessDecision } from './FeedbackReadinessArbiter.js';
import { scrubForStore } from '../../core/durableSecretScrub.js';

export const FEEDBACK_DRAIN_SERVICE_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'operated-drain',
} as const;

/** Consecutive transient authority invocation failures before the authority is demoted. */
export const READINESS_TRANSIENT_FAILURE_LIMIT = 3;
/**
 * Candidates per readiness model call. Live 2026-10-01 (gpt-6-astra via codex-cli): about 3-4 s
 * per candidate, so 10 finished in ~31 s while 50 hit the 60 s call budget twice in a row.
 */
export const READINESS_CHUNK_SIZE = 10;

export interface FeedbackDrainServiceOptions {
  store: FeedbackDrainStore;
  processing: FeedbackProcessingService;
  consumer: FeedbackInitiativeConsumer;
  arbiter?: FeedbackReadinessArbiter | null;
  authorityId: string;
  ownerHost: string;
  ownerEpoch: () => number;
  isCanonicalOwner: () => boolean;
  isConsumerLive: () => boolean;
  consumerBatchBound?: () => number;
  estimatedReadinessBatchUsd?: number;
  maxReadyScansPerTick?: number;
  maxClaimsPerTick?: number;
  stageBudgetMs?: number;
  /** Budget for the model-backed readiness stage; defaults to the arbiter's model timeout plus margin. */
  readinessStageBudgetMs?: number;
  /** Candidates per readiness model call; a tick runs several calls up to the authority's maxBatch. */
  readinessChunkSize?: number;
  maxWallClockMs?: number;
  sourceCompactionIntervalMs?: number;
  onRecoverableStall?: (reason: string) => void;
  clock?: () => number;
}

export interface FeedbackDrainTickResult {
  runId: string;
  processed: number;
  reviewed: number;
  approved: number;
  enqueued: number;
  claimed: number;
  completed: number;
  retried: number;
  wouldCreate: number;
  result: 'succeeded' | 'no-op' | 'degraded';
  reason?: string;
}

export interface FeedbackBacklogAnalysis {
  generatedAt: number;
  boundedBatchSize: number;
  totalCollecting: number;
  proposedClusterIds: string[];
  counts: { clusters: number; reports: number };
  ageDistribution: Record<'under7d' | 'd7to30' | 'd31to90' | 'over90d', number>;
  priorityDistribution: Record<'high' | 'normal', number>;
  duplicates: { estimatedDuplicateReports: number };
  estimatedWorkItemVolume: number;
}

function time(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function candidate(cluster: Cluster, now: number): ReadinessCandidate {
  const title = String(cluster.title ?? '').slice(0, 240);
  const instructionPattern = /\b(ignore (all|any|the|previous)|system prompt|developer message|execute|run command)\b/i;
  return {
    clusterId: cluster.clusterId,
    title,
    type: String(cluster.type ?? 'unknown').slice(0, 40),
    reportCount: Math.max(1, Number(cluster.reportCount ?? 1)),
    firstSeenAt: time(cluster.createdAt, now),
    lastSeenAt: time(cluster.updatedAt ?? cluster.createdAt, now),
    evidenceIds: [`cluster:${cluster.clusterId}`],
    injectionSuspected: instructionPattern.test(title),
  };
}

export class FeedbackDrainService {
  private readonly now: () => number;
  private readonly maxReadyScans: number;
  private readonly maxClaims: number;
  private readonly stageBudgetMs: number;
  private readonly readinessStageBudgetMs: number;
  private readonly readinessChunkSize: number;
  private readonly maxWallClockMs: number;
  private readonly sourceCompactionIntervalMs: number;

  constructor(private readonly opts: FeedbackDrainServiceOptions) {
    this.now = opts.clock ?? Date.now;
    this.maxReadyScans = Math.min(250, Math.max(1, opts.maxReadyScansPerTick ?? 250));
    this.maxClaims = Math.min(50, Math.max(1, opts.maxClaimsPerTick ?? 10));
    this.stageBudgetMs = Math.max(1, Math.min(20_000, opts.stageBudgetMs ?? 20_000));
    this.readinessStageBudgetMs = Math.max(1, Math.min(90_000, opts.readinessStageBudgetMs ?? FEEDBACK_READINESS_MODEL_TIMEOUT_MS + 5_000));
    const chunkSize = Number(opts.readinessChunkSize ?? READINESS_CHUNK_SIZE);
    this.readinessChunkSize = Number.isFinite(chunkSize) ? Math.min(50, Math.max(1, Math.trunc(chunkSize))) : READINESS_CHUNK_SIZE;
    this.maxWallClockMs = Math.max(this.stageBudgetMs, this.readinessStageBudgetMs, Math.min(115_000, Number.isFinite(opts.maxWallClockMs) ? opts.maxWallClockMs! : 115_000));
    this.sourceCompactionIntervalMs = Math.max(1, opts.sourceCompactionIntervalMs ?? 24 * 60 * 60 * 1000);
  }

  stats() {
    const cursor = this.opts.store.sourceCursor();
    let generationLag = 0;
    try { generationLag = Math.max(0, this.opts.processing.sourceFeedbackGenerationPlan(cursor?.generationId).length - 1); } catch { generationLag = -1; }
    return { processing: this.opts.processing.stats(), drain: { ...this.opts.store.metrics(), sourceGenerationLag: generationLag }, lastRun: this.opts.store.lastRun(), consumerLive: this.opts.isConsumerLive() };
  }

  sourceClusterPresent(clusterId: string): boolean { return this.opts.processing.hasActiveCluster(clusterId); }

  canAgentMutateReadiness(agentId: string): boolean {
    const authority = this.opts.store.getAuthority(this.opts.authorityId);
    return Boolean(authority && !authority.revoked && authority.agentId === agentId &&
      this.opts.store.authorityOwnerCurrent(authority, this.opts.ownerHost, this.opts.ownerEpoch()) &&
      this.opts.isCanonicalOwner() && this.opts.store.authorityPosture(authority.authorityId, authority.generation).mode === 'active');
  }

  /** Metadata-only, bounded packet for registered-authority historical review. */
  analyzeHistoricalBacklog(requestedLimit = 50): FeedbackBacklogAnalysis {
    const authority = this.opts.store.getAuthority(this.opts.authorityId);
    const bound = Math.min(100, Math.max(1, Math.trunc(requestedLimit)), authority?.maxBatch ?? 1);
    const now = this.now();
    const collecting = this.opts.processing.activeClusters()
      .filter((cluster) => this.opts.store.getReadiness(cluster.clusterId)?.state === 'collecting')
      .sort((a, b) => time(a.createdAt, now) - time(b.createdAt, now) || a.clusterId.localeCompare(b.clusterId));
    const proposed = collecting.slice(0, bound);
    const ageDistribution = { under7d: 0, d7to30: 0, d31to90: 0, over90d: 0 };
    const priorityDistribution = { high: 0, normal: 0 };
    let reports = 0;
    for (const cluster of proposed) {
      const count = Math.max(1, Number(cluster.reportCount ?? 1));
      reports += count;
      priorityDistribution[count >= 5 ? 'high' : 'normal']++;
      const age = Math.max(0, now - time(cluster.createdAt, now));
      if (age < 7 * 86_400_000) ageDistribution.under7d++;
      else if (age < 30 * 86_400_000) ageDistribution.d7to30++;
      else if (age < 90 * 86_400_000) ageDistribution.d31to90++;
      else ageDistribution.over90d++;
    }
    return {
      generatedAt: now, boundedBatchSize: bound, totalCollecting: collecting.length,
      proposedClusterIds: proposed.map((cluster) => cluster.clusterId),
      counts: { clusters: proposed.length, reports }, ageDistribution, priorityDistribution,
      duplicates: { estimatedDuplicateReports: Math.max(0, reports - proposed.length) },
      estimatedWorkItemVolume: proposed.length,
    };
  }

  /** Persist a cancellation request under the currently-held owner fence. */
  requestRunCancellation(runId: string): boolean {
    if (!this.opts.isCanonicalOwner()) throw new Error('feedback drain cancellation requires the canonical owner');
    const ownerEpoch = this.opts.ownerEpoch();
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new Error('feedback drain cancellation requires a valid owner epoch');
    return this.opts.store.requestRunCancellation(runId, { ownerHost: this.opts.ownerHost, ownerEpoch });
  }

  async tick(): Promise<FeedbackDrainTickResult> {
    const admitted = this.admitTick();
    return 'result' in admitted ? admitted.result : this.runAccepted(admitted.run, admitted.ownerEpoch);
  }

  /** Durably admit a run and defer bounded execution so HTTP can return 202/runId. */
  acceptTick(): { runId: string; accepted: boolean; result?: FeedbackDrainTickResult } {
    const admitted = this.admitTick();
    if ('result' in admitted) return { runId: admitted.result.runId, accepted: false, result: admitted.result };
    setImmediate(() => {
      void this.runAccepted(admitted.run, admitted.ownerEpoch).catch(() => { /* durable run row carries the bounded failure */ });
    });
    return { runId: admitted.run.runId, accepted: true };
  }

  private admitTick(): { run: { runId: string; state: 'accepted'; acquired: true }; ownerEpoch: number } | { result: FeedbackDrainTickResult } {
    if (!this.opts.isCanonicalOwner()) {
      return { result: { runId: '', processed: 0, reviewed: 0, approved: 0, enqueued: 0, claimed: 0, completed: 0, retried: 0, wouldCreate: 0, result: 'degraded', reason: 'not-canonical-owner' } };
    }
    const ownerEpoch = this.opts.ownerEpoch();
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
      return { result: { runId: '', processed: 0, reviewed: 0, approved: 0, enqueued: 0, claimed: 0, completed: 0, retried: 0, wouldCreate: 0, result: 'degraded', reason: 'invalid-owner-epoch' } };
    }
    this.opts.store.abandonExpiredRuns(this.now(), 10);
    const run = this.opts.store.startRun({ ownerHost: this.opts.ownerHost, ownerEpoch, leaseMs: 120_000 });
    if (!run.acquired) {
      return { result: { runId: run.runId, processed: 0, reviewed: 0, approved: 0, enqueued: 0, claimed: 0, completed: 0, retried: 0, wouldCreate: 0, result: 'no-op', reason: 'run-active' } };
    }
    return { run: run as { runId: string; state: 'accepted'; acquired: true }, ownerEpoch };
  }

  private async runAccepted(run: { runId: string }, ownerEpoch: number): Promise<FeedbackDrainTickResult> {
    const fence = { ownerHost: this.opts.ownerHost, ownerEpoch };
    const runStartedAt = this.now();
    const assertOwner = () => {
      if (this.now() - runStartedAt > this.maxWallClockMs) throw new Error('feedback drain wall-clock budget exceeded');
      if (!this.opts.isCanonicalOwner() || this.opts.ownerEpoch() !== ownerEpoch) throw new Error('canonical ownership changed during drain run');
      this.opts.store.heartbeatRun(run.runId, fence.ownerHost, fence.ownerEpoch, 120_000);
    };
    this.opts.store.transitionRun(run.runId, 'accepted', 'running', '', fence);
    const out: FeedbackDrainTickResult = { runId: run.runId, processed: 0, reviewed: 0, approved: 0, enqueued: 0, claimed: 0, completed: 0, retried: 0, wouldCreate: 0, result: 'no-op' };
    const stopIfCancelled = () => {
      assertOwner();
      if (!this.opts.store.stopCancelledRunAtBoundary(run.runId, fence)) return;
      throw new FeedbackDrainCancellation();
    };
    try {
      stopIfCancelled();
      let projectionBudget = 500;
      const projectionStartedAt = this.now();
      const sourcePlan = this.opts.processing.sourceFeedbackGenerationPlan(this.opts.store.sourceCursor()?.generationId);
      for (const source of sourcePlan) {
        if (projectionBudget <= 0) break;
        const projection = this.opts.store.projectSourceGeneration({
          filePath: source.filePath, generationId: source.generationId, limit: projectionBudget,
        });
        projectionBudget -= projection.projected + projection.replayed + projection.superseded + projection.quarantined;
        if (source.handoffToNext) {
          if (projection.lagBytes > 0) break;
          this.opts.store.acceptSourceHandoff({
            fromGenerationId: source.handoffToNext.fromGenerationId,
            finalOffset: source.handoffToNext.finalOffset,
            toGenerationId: source.handoffToNext.toGenerationId,
            startOffset: source.handoffToNext.startOffset,
          });
        }
      }
      this.assertStageBudget(projectionStartedAt, 'source-projection');
      stopIfCancelled();
      const clusteringStartedAt = this.now();
      const projectedFeedback = this.opts.store.pendingProjectedFeedback(500);
      const processed = this.opts.processing.processProjected(projectedFeedback.map((row) => row.record));
      if (projectedFeedback.length > 0) this.opts.store.acknowledgeProcessedProjection(projectedFeedback.at(-1)!.ingestSequence);
      this.assertStageBudget(clusteringStartedAt, 'clustering');
      this.opts.store.markClusteringSucceeded(this.now());
      stopIfCancelled();
      out.processed = processed.result.results.length;
      const now = this.now();
      const clusters = this.opts.processing.activeClusters();
      const byId = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));
      for (const cluster of clusters) this.opts.store.ensureReadiness(cluster.clusterId, now);

      const due = this.opts.store.dueReadiness(50, now);
      const authority = this.opts.store.getAuthority(this.opts.authorityId);
      if (due.length > 0 && authority && !authority.revoked && this.opts.arbiter &&
        this.opts.store.authorityOwnerCurrent(authority, this.opts.ownerHost, ownerEpoch) &&
        this.opts.store.authorityPosture(authority.authorityId, authority.generation).mode === 'active') {
        const liveDue = due.filter((row) => byId.has(row.clusterId)).slice(0, authority.maxBatch);
        for (const stale of due.filter((row) => !byId.has(row.clusterId))) this.opts.store.holdReadiness(stale.clusterId, 'source-cluster-missing');
        if (liveDue.length === 0) {
          out.reason = 'readiness-source-missing';
        } else {
          await this.reviewReadinessInChunks(authority, liveDue, byId, now, runStartedAt, stopIfCancelled, out);
        }
      } else if (due.length > 0) {
        for (const row of due) this.opts.store.recordCollectingEvaluation(row.clusterId, { reason: 'readiness-authority-unavailable', nextReviewAt: now + 15 * 60 * 1000 });
        out.reason = 'readiness-authority-unavailable';
      }

      stopIfCancelled();
      for (const ready of this.opts.store.readyReadiness(this.maxReadyScans)) {
        assertOwner();
        const cluster = byId.get(ready.clusterId);
        if (!cluster) continue;
        const title = scrubForStore(String(cluster.title ?? 'Feedback cluster').slice(0, 240), { maxBytes: 4_096 });
        const summary = scrubForStore(`Owned review of feedback cluster ${ready.clusterId} with ${Number(cluster.reportCount ?? 1)} linked reports.`, { maxBytes: 8_192 });
        if (title.error || title.truncated || summary.error || summary.truncated) {
          this.opts.store.holdReadiness(ready.clusterId, 'durable-output-scrub-failed');
          continue;
        }
        this.opts.store.enqueue({
          clusterId: ready.clusterId,
          title: title.text,
          summary: summary.text,
          priority: Number(cluster.reportCount ?? 1) >= 5 ? 'high' : 'normal',
          reportCount: Number(cluster.reportCount ?? 1),
          firstSeenAt: time(cluster.createdAt, now),
          lastSeenAt: time(cluster.updatedAt ?? cluster.createdAt, now),
          authorityRef: `${this.opts.authorityId}:${authority?.generation ?? 0}`,
          evidenceRef: `cluster:${ready.clusterId}`,
        });
        out.enqueued++;
      }

      stopIfCancelled();
      if (!this.opts.isConsumerLive()) {
        out.wouldCreate = this.opts.store.simulateClaims({ limit: this.maxClaims, ownerAuthorityEpoch: ownerEpoch, now });
      } else {
        const promotionBound = Math.min(50, Math.max(0, Math.trunc(this.opts.consumerBatchBound?.() ?? this.maxClaims)));
        for (let i = 0; i < Math.min(this.maxClaims, promotionBound); i++) {
          stopIfCancelled();
          const claim = this.opts.store.claimNext({ consumerId: 'initiative-tracker', ownerAuthorityEpoch: ownerEpoch, leaseMs: 30_000, now });
          if (!claim) break;
          out.claimed++;
          try {
            const artifact = await this.withStageBudget('initiative-consumer', () => this.opts.consumer.consume({
              workId: claim.workId,
              feedbackWorkKey: claim.idempotencyKey,
              clusterId: claim.clusterId,
              title: claim.title,
              summary: claim.summary,
              priority: claim.priority,
            }));
            assertOwner();
            this.opts.store.markArtifactReadable({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: ownerEpoch, artifactId: artifact.initiativeId, artifactKind: 'initiative' });
            this.opts.store.complete({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: ownerEpoch });
            out.completed++;
          } catch (error) {
            if (this.opts.isCanonicalOwner() && this.opts.ownerEpoch() === ownerEpoch) {
              this.opts.store.retry({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: ownerEpoch, retryAt: now + 60_000, maxAttempts: 5, reason: error instanceof Error ? error.message : 'consumer-failed' });
              out.retried++;
            } else {
              throw error;
            }
          }
        }
      }
      stopIfCancelled();
      this.opts.store.reconcileExpiredLeases({ now, limit: 100, retryDelayMs: 60_000, maxAttempts: 5 });
      let reconcileBudget = 500;
      for (const source of this.opts.processing.sourceFeedbackGenerationPlan()) {
        if (reconcileBudget <= 0) break;
        const reconciled = this.opts.store.reconcileSourceProjection({ filePath: source.filePath, generationId: source.generationId, limit: reconcileBudget });
        reconcileBudget -= reconciled.checked;
      }
      stopIfCancelled();
      if (this.opts.store.sourceCompactionDue(this.sourceCompactionIntervalMs, this.now())) {
        const compactionStartedAt = this.now();
        const handoff = this.opts.processing.compactFeedbackSource(this.now());
        this.assertStageBudget(compactionStartedAt, 'source-compaction');
        // No handoff means the source was already compact; the interval restarts either way.
        this.opts.store.recordSourceCompaction(handoff?.publishedAt ?? this.now());
      }
      // A quarantined source line never stops the run, but every run reports it until repaired.
      if (this.opts.store.quarantinedSourceRecords() > 0) out.reason ??= 'source-record-quarantined';
      const progressed = out.processed + out.reviewed + out.enqueued + out.completed;
      out.result = out.reason ? 'degraded' : progressed > 0 ? 'succeeded' : 'no-op';
      stopIfCancelled();
      this.opts.store.transitionRun(run.runId, 'running', out.result, out.reason ?? '', fence);
      if (out.result !== 'degraded') {
        this.opts.store.pruneOperationalHistory({ ownerHost: fence.ownerHost, ownerAuthorityEpoch: fence.ownerEpoch, now: this.now(), limit: 500 });
      }
      if (out.result === 'degraded') this.opts.onRecoverableStall?.(out.reason ?? 'degraded-no-progress');
      return out;
    } catch (error) {
      if (error instanceof FeedbackDrainCancellation) {
        out.result = 'degraded'; out.reason = 'cancelled-at-stage-boundary';
        return out;
      }
      const reason = error instanceof Error ? error.message : 'drain-failed';
      if (this.opts.isCanonicalOwner() && this.opts.ownerEpoch() === ownerEpoch) {
        this.opts.store.transitionRun(run.runId, 'running', 'failed', reason, fence);
      }
      this.opts.onRecoverableStall?.(reason);
      throw error;
    }
  }

  /**
   * Reviews the due candidates in sequential model calls of at most readinessChunkSize, applying
   * each call's decisions as it returns. Stops before a call that would not fit the tick's
   * wall clock (leaving the rest due for the next tick) and after any failed call. The
   * transient-failure counter resets when any call in the tick succeeded and counts one
   * failure only when none did; a contract violation still demotes at once.
   */
  private async reviewReadinessInChunks(authority: AuthorityRecord, liveDue: ReadinessProjection[], byId: Map<string, Cluster>, now: number,
    runStartedAt: number, stopIfCancelled: () => void, out: FeedbackDrainTickResult): Promise<void> {
    // The stages after readiness (enqueue, claims, reconcile, compaction) keep one stage budget.
    const deadline = runStartedAt + this.maxWallClockMs - this.stageBudgetMs;
    let pending = liveDue;
    let succeededCalls = 0;
    let reviewedMs = 0;
    let reviewedCandidates = 0;
    let transientFailure = false;
    let contractViolation = false;
    while (pending.length > 0) {
      const remaining = deadline - this.now();
      // Before the first call a full chunk is assumed to fit its call budget; after it, the
      // chunk is sized from this tick's observed pace with a 25% margin.
      const fits = reviewedCandidates > 0 ? Math.floor(remaining / (1.25 * reviewedMs / reviewedCandidates)) : this.readinessChunkSize;
      const chunk = pending.slice(0, Math.min(this.readinessChunkSize, fits));
      if (remaining <= 0 || chunk.length === 0) {
        if (succeededCalls === 0 && !transientFailure) out.reason ??= 'readiness-wall-clock-exhausted';
        break;
      }
      if (!this.opts.store.reserveAuthoritySpend(authority, this.opts.estimatedReadinessBatchUsd ?? 0.01, chunk.length, now)) {
        for (const row of pending) this.opts.store.recordCollectingEvaluation(row.clusterId, { reason: 'readiness-spend-brake', nextReviewAt: now + 24 * 60 * 60 * 1000 });
        this.opts.store.demoteAuthority(authority.authorityId, authority.generation, 'readiness-spend-brake');
        out.reason = 'readiness-spend-brake';
        break;
      }
      pending = pending.slice(chunk.length);
      const startedAt = this.now();
      // Contract violations (and a refused promotion) demote at once. A timeout or provider
      // error is retried on the next review; only a run of failed ticks in a row demotes.
      const failed = (error: unknown): void => {
        // Rows this call already approved before a store error keep their decision.
        for (const row of chunk) if (this.opts.store.getReadiness(row.clusterId)?.state === 'collecting') this.opts.store.recordCollectingEvaluation(row.clusterId, {
          reason: 'readiness-authority-failed', nextReviewAt: now + 15 * 60 * 1000,
        });
        out.reason = 'readiness-authority-failed';
        if (error instanceof ReadinessContractViolation || error instanceof DrainConflictError) {
          this.opts.store.demoteAuthority(authority.authorityId, authority.generation, 'readiness-schema-provenance-or-routing-failure');
          contractViolation = true;
        } else {
          transientFailure = true;
        }
      };
      let decisions: ReadinessDecision[];
      try {
        decisions = await this.withStageBudget('readiness-authority', () => this.opts.arbiter!.decideBatch(authority, chunk.map((row) => candidate(byId.get(row.clusterId)!, now))),
          Math.min(this.readinessStageBudgetMs, remaining));
      } catch (error) {
        failed(error);
        break;
      }
      // Cancellation, ownership loss or the wall clock end the run like any later stage would.
      stopIfCancelled();
      const decisionNonce = `decision:${randomUUID()}`;
      const proposalSetHash = createHash('sha256').update(JSON.stringify(chunk.map((row) => ({ clusterId: row.clusterId, epoch: row.epoch })).sort((a, b) => a.clusterId.localeCompare(b.clusterId)))).digest('hex');
      try {
        for (const decision of decisions) {
          if (decision.outcome === 'ready') {
            const approvalKey = createHash('sha256').update(`${authority.authorityId}:${authority.generation}:${decision.clusterId}:${decision.evidenceHash}:${decisionNonce}:${proposalSetHash}`).digest('hex');
            this.opts.store.approveReady({ clusterId: decision.clusterId, approvalKey, authorityId: authority.authorityId, authorityGeneration: authority.generation, evidenceHash: decision.evidenceHash, decisionNonce, proposalSetHash });
            out.approved++;
          } else {
            this.opts.store.recordCollectingEvaluation(decision.clusterId, {
              reason: decision.outcome === 'escalate-human' ? 'readiness-escalation' : decision.reasonCodes[0] ?? 'collecting',
              nextReviewAt: now + 24 * 60 * 60 * 1000,
            });
          }
          out.reviewed++;
        }
      } catch (error) {
        failed(error);
        break;
      }
      succeededCalls++;
      reviewedMs += this.now() - startedAt;
      reviewedCandidates += chunk.length;
    }
    if (contractViolation) return;
    if (succeededCalls > 0) {
      this.opts.store.clearAuthorityTransientFailures(authority.authorityId, authority.generation);
    } else if (transientFailure && this.opts.store.recordAuthorityTransientFailure(authority.authorityId, authority.generation) >= READINESS_TRANSIENT_FAILURE_LIMIT) {
      this.opts.store.demoteAuthority(authority.authorityId, authority.generation, 'readiness-authority-repeated-invocation-failure');
    }
  }

  private assertStageBudget(startedAt: number, stage: string): void {
    if (this.now() - startedAt > this.stageBudgetMs) throw new Error(`${stage} stage budget exceeded`);
  }

  private async withStageBudget<T>(stage: string, operation: () => Promise<T>, budgetMs = this.stageBudgetMs): Promise<T> {
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} stage budget exceeded`)), budgetMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const result = await Promise.race([operation(), timeout]);
      if (this.now() - startedAt > budgetMs) throw new Error(`${stage} stage budget exceeded`);
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }
}

class FeedbackDrainCancellation extends Error {}
