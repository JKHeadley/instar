import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONSUMER_PROMOTION_HASH_DOMAIN,
  consumerPromotionSetHash,
  deriveConsumerPromotionProposal,
  effectiveClaimsPerRun,
  promotionMismatchReason,
  type PromotionProposalInput,
} from '../../src/feedback-factory/drain/consumerPromotionProposal.js';

const item = (n: number) => ({ workId: `work-${String(n).padStart(3, '0')}`, title: `Title ${n}`, priority: 'P2', reportCount: n });

const base = (over: Partial<PromotionProposalInput> = {}): PromotionProposalInput => ({
  available: true, restorePending: false, isCanonicalOwner: true, consumerEnabled: true,
  configuredDryRun: false, promotionRecord: null, priorRecordMarker: 'none', claimsPerRun: 10, claimable: [item(1), item(2), item(3)], ...over,
});

describe('consumerPromotionSetHash', () => {
  it('is sha256 over the domain line plus sorted ids joined by newline', () => {
    const expected = createHash('sha256').update(`${CONSUMER_PROMOTION_HASH_DOMAIN}\nprior:none\na\nb\nc`, 'utf8').digest('hex');
    expect(consumerPromotionSetHash(['c', 'a', 'b'])).toBe(expected);
    expect(consumerPromotionSetHash(['a'], '2026-11-26T00:00:00Z|2026-11-26T01:00:00Z')).not.toBe(consumerPromotionSetHash(['a']));
  });
  it('is order-independent and changes when any id changes', () => {
    expect(consumerPromotionSetHash(['x', 'y'])).toBe(consumerPromotionSetHash(['y', 'x']));
    expect(consumerPromotionSetHash(['x', 'y'])).not.toBe(consumerPromotionSetHash(['x', 'z']));
    expect(consumerPromotionSetHash(['x', 'y'])).not.toBe(consumerPromotionSetHash(['x']));
    expect(consumerPromotionSetHash(['x'])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('effectiveClaimsPerRun', () => {
  it('matches the drain service clamp (default 10, 1..50)', () => {
    expect(effectiveClaimsPerRun(undefined)).toBe(10);
    expect(effectiveClaimsPerRun(0)).toBe(1);
    expect(effectiveClaimsPerRun(500)).toBe(50);
    expect(effectiveClaimsPerRun(7.9)).toBe(7);
  });
});

describe('deriveConsumerPromotionProposal', () => {
  it('pending: exact batch in claim order, capped at claims per run, actionable locally', () => {
    const p = deriveConsumerPromotionProposal(base({ claimsPerRun: 2 }));
    expect(p.state).toBe('pending');
    if (p.state !== 'pending') return;
    expect(p.items.map((i) => i.workId)).toEqual(['work-001', 'work-002']);
    expect(p.approvedBatchBound).toBe(2);
    expect(p.claimsPerRun).toBe(2);
    expect(p.proposalSetHash).toBe(consumerPromotionSetHash(['work-001', 'work-002']));
    expect(p.localAction).toBe(true);
    expect(p.promotionRecord).toEqual({ present: false, revoked: false, approvedBatchBound: null, requiresReapproval: false });
  });

  it('never proposes more than 50 items', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(i));
    const p = deriveConsumerPromotionProposal(base({ claimsPerRun: 999, claimable: many }));
    expect(p.state === 'pending' && p.items.length).toBe(50);
  });

  it('evaluates in the agreed order', () => {
    expect(deriveConsumerPromotionProposal(base({ available: false, restorePending: true })).state).toBe('unavailable');
    expect(deriveConsumerPromotionProposal(base({ restorePending: true, isCanonicalOwner: false })).state).toBe('restore');
    expect(deriveConsumerPromotionProposal(base({ isCanonicalOwner: false, configuredDryRun: true })).state).toBe('non-owner');
    expect(deriveConsumerPromotionProposal(base({ configuredDryRun: undefined })).state).toBe('configured-simulation');
    expect(deriveConsumerPromotionProposal(base({ consumerEnabled: false })).state).toBe('configured-simulation');
    expect(deriveConsumerPromotionProposal(base({ claimable: [] })).state).toBe('no-work');
  });

  it('dryRun true wins over a valid record, and the record is reported', () => {
    const p = deriveConsumerPromotionProposal(base({ configuredDryRun: true, promotionRecord: { approvedBatchBound: 5, proposalBound: true } }));
    expect(p.state).toBe('configured-simulation');
    expect(p.localAction).toBe(false);
    expect(p.promotionRecord).toEqual({ present: true, revoked: false, approvedBatchBound: 5, requiresReapproval: false });
  });

  it('dryRun false with a valid record is already-live; with a revoked record it proposes again', () => {
    expect(deriveConsumerPromotionProposal(base({ promotionRecord: { approvedBatchBound: 5, proposalBound: true } })).state).toBe('already-live');
    const revoked = deriveConsumerPromotionProposal(base({ promotionRecord: { approvedBatchBound: 5, revokedAt: '2026-11-26T00:00:00Z', proposalBound: true } }));
    expect(revoked.state).toBe('pending');
    expect(revoked.promotionRecord).toEqual({ present: true, revoked: true, approvedBatchBound: 5, requiresReapproval: false });
  });

  it('a legacy record (not proposal-bound) needs re-approval: proposes again instead of already-live', () => {
    const p = deriveConsumerPromotionProposal(base({ promotionRecord: { approvedBatchBound: 3, proposalBound: false } }));
    expect(p.state).toBe('pending');
    expect(p.promotionRecord).toEqual({ present: true, revoked: false, approvedBatchBound: 3, requiresReapproval: true });
  });

  it('non-pending states are never locally actionable', () => {
    for (const over of [{ available: false }, { restorePending: true }, { isCanonicalOwner: false }, { configuredDryRun: true }, { claimable: [] }]) {
      expect(deriveConsumerPromotionProposal(base(over)).localAction).toBe(false);
    }
  });
});

describe('promotionMismatchReason', () => {
  it('accepts only the fresh hash and bound', () => {
    const fresh = deriveConsumerPromotionProposal(base());
    if (fresh.state !== 'pending') throw new Error('expected pending');
    expect(promotionMismatchReason(fresh, { evidenceHash: fresh.proposalSetHash, approvedBatchBound: fresh.approvedBatchBound })).toBeNull();
    expect(promotionMismatchReason(fresh, { evidenceHash: 'b'.repeat(64), approvedBatchBound: fresh.approvedBatchBound })).toBe('promotion-proposal-changed');
    expect(promotionMismatchReason(fresh, { evidenceHash: fresh.proposalSetHash, approvedBatchBound: 1 })).toBe('promotion-batch-bound-mismatch');
  });

  it('rejects a stale hash after the queue changes', () => {
    const before = deriveConsumerPromotionProposal(base());
    const after = deriveConsumerPromotionProposal(base({ claimable: [item(1), item(2), item(4)] }));
    if (before.state !== 'pending') throw new Error('expected pending');
    expect(promotionMismatchReason(after, { evidenceHash: before.proposalSetHash, approvedBatchBound: before.approvedBatchBound })).toBe('promotion-proposal-changed');
  });

  it('rejects when nothing is pending', () => {
    const none = deriveConsumerPromotionProposal(base({ claimable: [] }));
    expect(promotionMismatchReason(none, { evidenceHash: 'a'.repeat(64), approvedBatchBound: 1 })).toBe('promotion-not-pending:no-work');
  });
});

describe('FeedbackDrainStore.claimNext onlyWorkIds (approved batch claimed first)', () => {
  it('claims an approved item even when an unapproved item sorts earlier, and nothing outside the set', async () => {
    const { FeedbackDrainStore } = await import('../../src/feedback-factory/drain/FeedbackDrainStore.js');
    const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'k'.repeat(32) });
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = db.prepare(`INSERT INTO work(work_id,idempotency_key,cluster_id,readiness_epoch,state,title,summary,priority,report_count,first_seen_at,last_seen_at,authority_ref,evidence_ref,created_at,updated_at)
      VALUES (?,?,?,1,'queued','t','s','P1',1,?,?,'a','e',?,?)`);
    insert.run('unseen-early', 'k-early', 'c-early', 1, 1, 1, 1);
    insert.run('approved-late', 'k-late', 'c-late', 9, 9, 9, 9);
    expect(store.claimableWork(10).map((w) => w.workId)).toEqual(['unseen-early', 'approved-late']);
    const first = store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 30_000, onlyWorkIds: ['approved-late'] });
    expect(first?.workId).toBe('approved-late');
    expect(store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 30_000, onlyWorkIds: ['approved-late'] })).toBeNull();
    expect(store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 30_000, onlyWorkIds: [] })).toBeNull();
    expect(store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 30_000 })?.workId).toBe('unseen-early');
    store.close();
  });
});

describe('FeedbackDrainService live claims honour the approved batch', () => {
  it('claims only unattempted approved items (no fallback), then claims normally once they are all attempted', async () => {
    const { FeedbackDrainService } = await import('../../src/feedback-factory/drain/FeedbackDrainService.js');
    const { vi } = await import('vitest');
    let approval: () => { ids: string[]; attemptBaselines: Record<string, number>; nonce: string } | null = () => ({ ids: ['w-approved', 'w-done'], attemptBaselines: { 'w-approved': 0, 'w-done': 1 }, nonce: 'n1' });
    const run = async (unattempted: { outstanding: string[]; claimable: string[] }) => {
      const claims: Array<readonly string[] | undefined> = [];
      const store = {
        abandonExpiredRuns: vi.fn(), startRun: vi.fn(() => ({ runId: 'run:t', state: 'accepted', acquired: true })), transitionRun: vi.fn(),
        heartbeatRun: vi.fn(), stopCancelledRunAtBoundary: vi.fn(() => false), sourceCursor: vi.fn(() => null), projectSourceGeneration: vi.fn(),
        acceptSourceHandoff: vi.fn(), pendingProjectedFeedback: vi.fn(() => []), acknowledgeProcessedProjection: vi.fn(), markClusteringSucceeded: vi.fn(),
        ensureReadiness: vi.fn(), dueReadiness: vi.fn(() => []), getAuthority: vi.fn(() => null), readyReadiness: vi.fn(() => []),
        simulateClaims: vi.fn(() => 0), reconcileExpiredLeases: vi.fn(), reconcileSourceProjection: vi.fn(() => ({ checked: 0 })),
        sourceCompactionDue: vi.fn(() => false), quarantinedSourceRecords: vi.fn(() => 0),
        pruneOperationalHistory: vi.fn(() => ({ retiredWork: 0, prunedAudit: 0, prunedRuns: 0, checkpointed: true })),
        outstandingApprovedWork: vi.fn(() => ({ outstanding: unattempted.outstanding, claimable: unattempted.claimable })),
        claimNext: vi.fn((input: { onlyWorkIds?: readonly string[] }) => { claims.push(input.onlyWorkIds); return null; }),
      };
      const processing = { sourceFeedbackGenerationPlan: vi.fn(() => []), processProjected: vi.fn(() => ({ result: { results: [] } })), activeClusters: vi.fn(() => []) };
      const service = new FeedbackDrainService({ store: store as never, processing: processing as never, consumer: {} as never,
        authorityId: 'a', ownerHost: 'h', ownerEpoch: () => 1, isCanonicalOwner: () => true, isConsumerLive: () => true,
        consumerBatchBound: () => 2, consumerApprovedWorkIds: () => approval() });
      await service.tick();
      return { claims, store };
    };
    const first = await run({ outstanding: ['w-approved'], claimable: ['w-approved'] });
    expect(first.store.outstandingApprovedWork).toHaveBeenCalledWith({ 'w-approved': 0, 'w-done': 1 }, expect.any(Number));
    expect(first.claims).toEqual([['w-approved']]);
    const later = await run({ outstanding: [], claimable: [] });
    expect(later.claims).toEqual([undefined]);
    // A re-promotion between claims (nonce changes) stops the old run.
    let calls = 0;
    approval = () => (++calls <= 1 ? { ids: ['w-approved'], attemptBaselines: { 'w-approved': 0 }, nonce: 'n3' } : { ids: ['w-other'], attemptBaselines: { 'w-other': 0 }, nonce: 'n4' });
    expect((await run({ outstanding: ['w-approved'], claimable: ['w-approved'] })).claims).toEqual([]);
    // Approved items outstanding but none claimable (held): claim nothing, never unseen work.
    approval = () => ({ ids: ['w-held'], attemptBaselines: { 'w-held': 0 }, nonce: 'n5' });
    expect((await run({ outstanding: ['w-held'], claimable: [] })).claims).toEqual([]);
  });

  it('outstanding approved work counts retries and holds by attempt baseline, independent of clocks', async () => {
    const { FeedbackDrainStore } = await import('../../src/feedback-factory/drain/FeedbackDrainStore.js');
    const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'k'.repeat(32) });
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = db.prepare(`INSERT INTO work(work_id,idempotency_key,cluster_id,readiness_epoch,state,title,summary,priority,report_count,first_seen_at,last_seen_at,authority_ref,evidence_ref,attempts,claimed_at,created_at,updated_at)
      VALUES (?,?,?,1,?,'t','s','P1',1,5,5,'a','e',?,9999999999999,5,5)`);
    insert.run('retry-approved', 'k-r', 'c-r', 'retryable', 2);
    insert.run('held-approved', 'k-h', 'c-h', 'held', 0);
    insert.run('done-approved', 'k-d', 'c-d', 'completed', 1);
    const found = store.outstandingApprovedWork({ 'retry-approved': 2, 'held-approved': 0, 'done-approved': 0 }, 10);
    expect([...found.outstanding].sort()).toEqual(['held-approved', 'retry-approved']);
    expect(found.claimable).toEqual(['retry-approved']);
    expect(store.outstandingApprovedWork({ 'retry-approved': 1 }, 10)).toEqual({ outstanding: [], claimable: [] });
    expect(store.outstandingApprovedWork({}, 10)).toEqual({ outstanding: [], claimable: [] });
    store.close();
  });
});
