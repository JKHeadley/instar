import { describe, expect, it, vi } from 'vitest';
import { FeedbackDrainService } from '../../src/feedback-factory/drain/FeedbackDrainService.js';

function serviceWith(storeOverrides: Record<string, unknown> = {}) {
  const transitions: Array<[string, string]> = [];
  const store = {
    abandonExpiredRuns: vi.fn(),
    startRun: vi.fn(() => ({ runId: 'run:test', state: 'accepted', acquired: true })),
    transitionRun: vi.fn((_id: string, from: string, to: string) => transitions.push([from, to])),
    heartbeatRun: vi.fn(), stopCancelledRunAtBoundary: vi.fn(() => false), requestRunCancellation: vi.fn(() => true),
    sourceCursor: vi.fn(() => null), projectSourceGeneration: vi.fn(), acceptSourceHandoff: vi.fn(),
    pendingProjectedFeedback: vi.fn(() => []), acknowledgeProcessedProjection: vi.fn(), markClusteringSucceeded: vi.fn(),
    ensureReadiness: vi.fn(), dueReadiness: vi.fn(() => []), getAuthority: vi.fn(() => null), readyReadiness: vi.fn(() => []),
    simulateClaims: vi.fn(() => 0), reconcileExpiredLeases: vi.fn(), reconcileSourceProjection: vi.fn(() => ({ checked: 0 })),
    sourceCompactionDue: vi.fn(() => false), recordSourceCompaction: vi.fn(),
    pruneOperationalHistory: vi.fn(() => ({ retiredWork: 0, prunedAudit: 0, prunedRuns: 0, checkpointed: true })),
    ...storeOverrides,
  };
  const processing = {
    sourceFeedbackGenerationPlan: vi.fn(() => []), processProjected: vi.fn(() => ({ result: { results: [] } })), activeClusters: vi.fn(() => []),
  };
  const service = new FeedbackDrainService({ store: store as never, processing: processing as never, consumer: {} as never,
    authorityId: 'authority', ownerHost: 'host', ownerEpoch: () => 7, isCanonicalOwner: () => true,
    isConsumerLive: () => false });
  return { service, store, processing, transitions };
}

describe('FeedbackDrainService cancellation and retention boundaries', () => {
  it('observes durable cancellation before source projection and abandons only at that boundary', async () => {
    const { service, store, processing, transitions } = serviceWith({ stopCancelledRunAtBoundary: vi.fn(() => true) });
    await expect(service.tick()).resolves.toMatchObject({ runId: 'run:test', result: 'degraded', reason: 'cancelled-at-stage-boundary' });
    expect(transitions).toEqual([['accepted', 'running']]);
    expect(store.stopCancelledRunAtBoundary).toHaveBeenCalledWith('run:test', { ownerHost: 'host', ownerEpoch: 7 });
    expect(processing.sourceFeedbackGenerationPlan).not.toHaveBeenCalled();
  });

  it('fences cancellation requests and performs one bounded retention pass after a successful terminal tick', async () => {
    const { service, store, transitions } = serviceWith();
    expect(service.requestRunCancellation('run:test')).toBe(true);
    expect(store.requestRunCancellation).toHaveBeenCalledWith('run:test', { ownerHost: 'host', ownerEpoch: 7 });
    await expect(service.tick()).resolves.toMatchObject({ result: 'no-op' });
    expect(transitions.at(-1)).toEqual(['running', 'no-op']);
    expect(store.pruneOperationalHistory).toHaveBeenCalledTimes(1);
    expect(store.pruneOperationalHistory).toHaveBeenCalledWith(expect.objectContaining({ ownerHost: 'host', ownerAuthorityEpoch: 7, limit: 500 }));
  });

  it('finishes the in-flight Initiative acknowledgement once, then cancels before another claim', async () => {
    let cancelled = false;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const claim = { workId: 'work-1', idempotencyKey: 'feedback-work:cluster-1:1', clusterId: 'cluster-1', title: 't', summary: 's', priority: 'normal', leaseEpoch: 1, claimToken: 'token' };
    const claimNext = vi.fn().mockReturnValueOnce(claim).mockReturnValueOnce({ ...claim, workId: 'work-2' });
    const { service, store } = serviceWith({
      stopCancelledRunAtBoundary: vi.fn(() => cancelled), claimNext,
      markArtifactReadable: vi.fn(), complete: vi.fn(),
    });
    (service as unknown as { opts: Record<string, unknown> }).opts.isConsumerLive = () => true;
    (service as unknown as { opts: Record<string, unknown> }).opts.consumerBatchBound = () => 2;
    (service as unknown as { opts: Record<string, unknown> }).opts.consumer = {
      consume: async () => { entered(); await releasePromise; return { initiativeId: 'initiative-1' }; },
    };
    const running = service.tick();
    await enteredPromise;
    cancelled = true;
    release();
    await expect(running).resolves.toMatchObject({ result: 'degraded', reason: 'cancelled-at-stage-boundary', completed: 1 });
    expect(store.markArtifactReadable).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(claimNext).toHaveBeenCalledTimes(1);
  });
});
