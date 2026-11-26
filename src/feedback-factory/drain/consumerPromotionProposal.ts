import { createHash } from 'node:crypto';

/**
 * The exact batch an operator approves when promoting the feedback consumer
 * (docs/specs/feedback-factory-operating-drain.md, Security: "Batch promotion is
 * proposal-set bound"). The server derives it; the PIN-bound promote call must
 * present the same hash, re-derived immediately before the write, so a stale or
 * replayed approval cannot promote a set the operator never saw.
 */

export const CONSUMER_PROMOTION_HASH_DOMAIN = 'instar-feedback-consumer-promotion-v1';
/** Hard ceiling from the design doc: a promotion batch names at most 50 work ids. */
export const CONSUMER_PROMOTION_MAX_ITEMS = 50;

export interface PromotionProposalItem {
  workId: string;
  title: string;
  priority: string;
  reportCount: number;
}

export type PromotionProposalState =
  | 'pending'
  | 'configured-simulation'
  | 'already-live'
  | 'no-work'
  | 'non-owner'
  | 'restore'
  | 'unavailable';

/** What the UI needs to explain an existing record (never its evidence hash or decision id). */
export interface PromotionRecordSummary {
  present: boolean;
  revoked: boolean;
  approvedBatchBound: number | null;
  /** True for a present, unrevoked record that is not bound to an approved set (written by the old route): it never makes the consumer live. */
  requiresReapproval: boolean;
}

interface ProposalCommon {
  /** True only when THIS server is the canonical drain owner and the state is pending: Promote may be offered here. */
  localAction: boolean;
  promotionRecord: PromotionRecordSummary;
}

export type PromotionProposal =
  | (ProposalCommon & { state: 'pending'; items: PromotionProposalItem[]; proposalSetHash: string; approvedBatchBound: number; claimsPerRun: number })
  | (ProposalCommon & { state: Exclude<PromotionProposalState, 'pending'>; reason: string });

export interface PromotionProposalInput {
  /** Drain built and initialised on this agent. */
  available: boolean;
  restorePending: boolean;
  isCanonicalOwner: boolean;
  /** `feedbackFactory.consumer.enabled` resolved through the dev-agent gate. */
  consumerEnabled: boolean;
  /** `feedbackFactory.consumer.dryRun` exactly as configured. */
  configuredDryRun: boolean | undefined;
  /** The promotion record as stored (null when none or unreadable). */
  promotionRecord: { approvedBatchBound: number; revokedAt?: string; proposalBound: boolean } | null;
  /** promotionRecordMarker() of the stored record, bound into the hash. */
  priorRecordMarker: string;
  /** The effective per-run claim cap the drain service uses. */
  claimsPerRun: number;
  /** Claimable work in claim order (the same order the consumer claims it). */
  claimable: PromotionProposalItem[];
}

/**
 * Canonical hash: sha256 over UTF-8 of
 *   `${CONSUMER_PROMOTION_HASH_DOMAIN}\nprior:${priorRecordMarker}\n` + workIds sorted by
 *   code-unit order and joined with '\n'. `priorRecordMarker` is 'none' or the existing
 *   record's `recordNonce|approvedAt|revokedAt`.
 * Lowercase hex. Order-independent; any added, removed or substituted id changes it.
 */
export function consumerPromotionSetHash(workIds: readonly string[], priorRecordMarker = 'none'): string {
  const sorted = [...workIds].sort();
  return createHash('sha256').update(`${CONSUMER_PROMOTION_HASH_DOMAIN}\nprior:${priorRecordMarker}\n${sorted.join('\n')}`, 'utf8').digest('hex');
}

/**
 * Identifies the promotion record a proposal was made against ('none' when there is none),
 * so an approval made before a revoke can never be replayed after it, even for the same set.
 */
export function promotionRecordMarker(record: { approvedAt: string; revokedAt?: string; recordNonce?: string } | null): string {
  return record ? `${record.recordNonce ?? 'legacy'}|${record.approvedAt}|${record.revokedAt ?? ''}` : 'none';
}

/** The configured per-run cap, clamped the same way FeedbackDrainService clamps it. */
export function effectiveClaimsPerRun(maxClaimsPerTick: number | undefined): number {
  return Math.min(CONSUMER_PROMOTION_MAX_ITEMS, Math.max(1, Math.trunc(maxClaimsPerTick ?? 10)));
}

export function summarizePromotionRecord(record: PromotionProposalInput['promotionRecord']): PromotionRecordSummary {
  if (!record) return { present: false, revoked: false, approvedBatchBound: null, requiresReapproval: false };
  const revoked = record.revokedAt !== undefined;
  return { present: true, revoked, approvedBatchBound: record.approvedBatchBound, requiresReapproval: !revoked && !record.proposalBound };
}

/**
 * Evaluation order (agreed with the console): unavailable → restore → non-owner →
 * configured-simulation → already-live → no-work → pending. Config dry-run wins over
 * an existing record, because a record alone never makes the consumer live.
 */
export function deriveConsumerPromotionProposal(input: PromotionProposalInput): PromotionProposal {
  const promotionRecord = summarizePromotionRecord(input.promotionRecord);
  const none = (state: Exclude<PromotionProposalState, 'pending'>, reason: string): PromotionProposal => ({ state, reason, localAction: false, promotionRecord });
  if (!input.available) return none('unavailable', 'the feedback drain is dark or failed to initialise on this agent');
  if (input.restorePending) return none('restore', 'a restored drain checkpoint is waiting for failover finalisation');
  if (!input.isCanonicalOwner) return none('non-owner', 'this machine is not the canonical drain owner');
  if (!input.consumerEnabled || input.configuredDryRun !== false) {
    return none('configured-simulation', promotionRecord.present && !promotionRecord.revoked && !promotionRecord.requiresReapproval
      ? 'feedbackFactory.consumer is configured for simulation (dryRun not false); the existing promotion record has no effect until that changes'
      : 'feedbackFactory.consumer is configured for simulation (consumer.enabled off or consumer.dryRun not false); a promotion would not take effect');
  }
  if (promotionRecord.present && !promotionRecord.revoked && !promotionRecord.requiresReapproval) return none('already-live', 'a valid consumer promotion is already recorded and the consumer is configured live');
  const cap = Math.min(CONSUMER_PROMOTION_MAX_ITEMS, Math.max(1, Math.trunc(input.claimsPerRun)));
  const items = input.claimable.slice(0, cap).map((item) => ({
    workId: item.workId, title: item.title, priority: item.priority, reportCount: item.reportCount,
  }));
  if (items.length === 0) return none('no-work', 'no queued feedback work is ready to claim');
  return {
    state: 'pending',
    items,
    proposalSetHash: consumerPromotionSetHash(items.map((item) => item.workId), input.priorRecordMarker),
    approvedBatchBound: items.length,
    claimsPerRun: cap,
    localAction: true,
    promotionRecord,
  };
}

/** Why a promote request does not match the freshly re-derived proposal, or null when it does. */
export function promotionMismatchReason(fresh: PromotionProposal, request: { evidenceHash: string; approvedBatchBound: number }): string | null {
  if (fresh.state !== 'pending') return `promotion-not-pending:${fresh.state}`;
  if (request.evidenceHash !== fresh.proposalSetHash) return 'promotion-proposal-changed';
  if (request.approvedBatchBound !== fresh.approvedBatchBound) return 'promotion-batch-bound-mismatch';
  return null;
}

/** The response when the drain itself is not built on this agent. */
export function unavailableConsumerPromotionProposal(): PromotionProposal {
  return { state: 'unavailable', reason: 'the feedback drain is dark or failed to initialise on this agent', localAction: false, promotionRecord: summarizePromotionRecord(null) };
}
