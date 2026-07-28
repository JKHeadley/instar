/**
 * immutableGuard.ts — the structural "never re-derive curated state" guard (spec §2.4).
 *
 * Curated cluster state — pre-cutover lifecycle status + the human/LLM governance
 * judgment that lives in the notes fields — is IRREPLACEABLE. The migration imports it
 * AS-IS and the processor must never overwrite it. "Structure > Willpower": rather than
 * trust the processor to only ever run over new, post-cutover traffic, we wrap the store
 * so a mutation of an immutable cluster is PHYSICALLY refused (and recorded), not merely
 * discouraged by a comment. A wrong-date backfill therefore cannot overwrite curated
 * lifecycle/governance state — the write simply does not happen.
 *
 * A cluster is immutable when EITHER:
 *   - it carries non-null governance notes (a human/LLM triage decision lives on it), OR
 *   - it predates the cutover (createdAt < cutoverTimestamp) — migrated curated history.
 *
 * The guard is a decorator over any FeedbackStore: reads and non-curated writes pass
 * through untouched; the three methods that can mutate an existing cluster
 * (mergeIntoCluster, applyReopen, upsertClusterFromItem-when-it-exists) are gated.
 */

import type { Cluster, FeedbackItem } from '../processor/types.js';
import type { ReopenDecision } from '../processor/reopen.js';
import type { DispatchRecord } from '../dispatch/dispatch.js';
import type { FeedbackStore, FeedbackMetrics } from '../store/FeedbackStore.js';

/** Fields that, when non-empty, mark a cluster as carrying curated governance judgment. */
export const GOVERNANCE_FIELDS = [
  'governanceNotes',
  'processingNotes',
  'actionTaken',
  'researchNotes',
] as const;

/** True when the cluster carries any non-empty curated governance note. */
export function hasGovernanceNotes(cluster: Cluster): boolean {
  for (const f of GOVERNANCE_FIELDS) {
    const v = (cluster as Record<string, unknown>)[f];
    if (typeof v === 'string' && v.trim().length > 0) return true;
  }
  return false;
}

/**
 * The structural invariant: is this cluster curated state the processor must not touch?
 *
 * - Governance notes present → immutable regardless of date (a triage decision lives here).
 * - createdAt < cutoverTimestamp → migrated curated history, immutable.
 * - createdAt present but unparseable → fail SAFE (immutable): a cluster that HAS a
 *   timestamp we cannot read is suspicious; never risk overwriting curated state.
 * - No createdAt and no governance notes → a fresh/post-cutover cluster → mutable
 *   (curated rows always carry a timestamp or notes, so this is new processor state).
 */
export function isClusterImmutable(cluster: Cluster, cutoverTimestamp: string): boolean {
  if (hasGovernanceNotes(cluster)) return true;

  const createdAt = cluster.createdAt;
  if (typeof createdAt === 'string' && createdAt.length > 0) {
    const created = Date.parse(createdAt);
    const cutover = Date.parse(cutoverTimestamp);
    if (Number.isNaN(created) || Number.isNaN(cutover)) return true; // fail safe
    return created < cutover;
  }
  return false;
}

/** One refused-mutation record, surfaced for the audit trail. */
export interface GuardViolation {
  clusterId: string;
  operation: 'merge' | 'reopen' | 'upsert';
  reason: 'pre-cutover' | 'governance-notes';
  feedbackId?: string;
  at: string;
}

export interface GuardedStoreOptions {
  /** The one-way-door timestamp: clusters created before this are migrated curated history. */
  cutoverTimestamp: string;
  /** Called for every refused mutation, so the caller can audit it (never throws into the store). */
  onViolation?: (v: GuardViolation) => void;
  /** Injected clock for the violation timestamp (testable; defaults to a fixed-at-construction stamp). */
  now?: () => string;
}

/** Why a cluster was deemed immutable, for the violation record. */
function immutableReason(cluster: Cluster): GuardViolation['reason'] {
  return hasGovernanceNotes(cluster) ? 'governance-notes' : 'pre-cutover';
}

/**
 * A FeedbackStore decorator that enforces the never-re-derive invariant structurally.
 * Mutations targeting an immutable cluster are refused (recorded as a GuardViolation),
 * never delegated to the inner store — so curated state physically cannot be overwritten.
 */
export class GuardedFeedbackStore implements FeedbackStore {
  private readonly inner: FeedbackStore;
  private readonly cutoverTimestamp: string;
  private readonly onViolation?: (v: GuardViolation) => void;
  private readonly now: () => string;
  private readonly _violations: GuardViolation[] = [];

  constructor(inner: FeedbackStore, opts: GuardedStoreOptions) {
    this.inner = inner;
    this.cutoverTimestamp = opts.cutoverTimestamp;
    this.onViolation = opts.onViolation;
    // Default clock is fixed at construction so a guarded store has no hidden Date.now() call
    // per mutation; callers that need per-event time pass opts.now.
    const stamp = opts.now;
    this.now = stamp ?? (() => this.cutoverTimestamp);
  }

  /** All refused mutations observed by this guard (in order). */
  get violations(): readonly GuardViolation[] {
    return this._violations;
  }

  private refuse(clusterId: string, operation: GuardViolation['operation'], cluster: Cluster, feedbackId?: string): void {
    const v: GuardViolation = {
      clusterId,
      operation,
      reason: immutableReason(cluster),
      feedbackId,
      at: this.now(),
    };
    this._violations.push(v);
    if (this.onViolation) {
      try {
        this.onViolation(v);
      } catch {
        // An audit-sink failure must never break the store or surface as a mutation.
        // @silent-fallback-ok — guard integrity is independent of the audit sink's health.
      }
    }
  }

  // ── Gated mutations (curated-cluster protection) ──────────────────────────

  upsertClusterFromItem(clusterId: string, item: FeedbackItem): void {
    const existing = this.inner.getCluster(clusterId);
    if (existing && isClusterImmutable(existing, this.cutoverTimestamp)) {
      this.refuse(clusterId, 'upsert', existing, item.feedbackId);
      return;
    }
    this.inner.upsertClusterFromItem(clusterId, item);
  }

  mergeIntoCluster(clusterId: string, item: FeedbackItem): void {
    const existing = this.inner.getCluster(clusterId);
    if (existing && isClusterImmutable(existing, this.cutoverTimestamp)) {
      this.refuse(clusterId, 'merge', existing, item.feedbackId);
      return;
    }
    this.inner.mergeIntoCluster(clusterId, item);
  }

  applyReopen(clusterId: string, decision: ReopenDecision): void {
    const existing = this.inner.getCluster(clusterId);
    if (existing && isClusterImmutable(existing, this.cutoverTimestamp)) {
      this.refuse(clusterId, 'reopen', existing);
      return;
    }
    this.inner.applyReopen(clusterId, decision);
  }

  // ── Pass-through (reads + non-curated writes) ─────────────────────────────

  getUnprocessedFeedback(): FeedbackItem[] {
    return this.inner.getUnprocessedFeedback();
  }
  getActiveClusters(): Cluster[] {
    return this.inner.getActiveClusters();
  }
  getCluster(clusterId: string): Cluster | undefined {
    return this.inner.getCluster(clusterId);
  }
  markProcessed(feedbackId: string, clusterId: string): void {
    this.inner.markProcessed(feedbackId, clusterId);
  }
  hasFeedback(feedbackId: string): boolean {
    return this.inner.hasFeedback(feedbackId);
  }
  addFeedback(item: FeedbackItem): void {
    this.inner.addFeedback(item);
  }
  listDispatches(filter?: { since?: string; type?: string }): DispatchRecord[] {
    return this.inner.listDispatches(filter);
  }
  findDispatchByTitle(title: string): DispatchRecord | undefined {
    return this.inner.findDispatchByTitle(title);
  }
  createDispatch(record: DispatchRecord): void {
    this.inner.createDispatch(record);
  }
  metrics(): FeedbackMetrics {
    return this.inner.metrics();
  }
}
