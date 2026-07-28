import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackProcessingService } from '../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackInitiativeConsumer } from '../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';
import { FeedbackReadinessArbiter } from '../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { FeedbackDrainService } from '../../src/feedback-factory/drain/FeedbackDrainService.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-factory-drain-service.test.ts' });
});

function setup(consumerLive = true, consumerBatchBound = 50, failAfterFirstArtifact = false, settings: {
  title?: string; arbiterThrows?: boolean; arbiterNever?: boolean; stageBudgetMs?: number;
  afterArtifact?: () => void;
  sourceCompactionIntervalMs?: number;
  seedFeedback?: boolean;
  ownership?: { held: () => boolean; epoch: () => number };
} = {}) {
  let now = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-service-'));
  dirs.push(dir);
  const canonical = path.join(dir, 'canonical');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), `${JSON.stringify({
    clusterId: 'cluster-1', title: settings.title ?? 'Recurring scheduler crash', description: 'not persisted to work',
    type: 'bug', reportCount: 4, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
  })}\n`);
  fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), settings.seedFeedback ? `${JSON.stringify({
    feedbackId: 'feedback-1', sourceRecordId: 'source-1', title: 'Recurring scheduler crash',
    description: 'metadata source', type: 'bug', status: 'processing', receivedAt: '2026-07-01T00:00:00Z',
  })}\n` : '');
  const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'x'.repeat(32), clock: () => now, idFactory: () => 'work-1', tokenFactory: () => 'claim-token' });
  store.mutateAuthority({
    action: 'create', operatorDecisionRef: 'approval:operator-1', authorityId: 'dev-readiness',
    agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'claude-code', modelFamily: 'fable-5',
    promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
    maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 5,
  });
  const arbiter = new FeedbackReadinessArbiter({
    evaluate: async (_prompt, evalOptions) => {
      if (settings.arbiterNever) return await new Promise<string>(() => undefined);
      if (settings.arbiterThrows) throw new Error('provider unavailable');
      evalOptions?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
      return JSON.stringify({ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 0.95, reasonCodes: ['coherent-recurrence'], evidenceIds: ['cluster:cluster-1'] }] });
    },
  });
  const tracker = new InitiativeTracker(path.join(dir, 'state'));
  const realConsumer = new FeedbackInitiativeConsumer(tracker);
  let injectFailure = failAfterFirstArtifact;
  const consumer = failAfterFirstArtifact || settings.afterArtifact ? {
    consume: async (work: Parameters<FeedbackInitiativeConsumer['consume']>[0]) => {
      const artifact = await realConsumer.consume(work);
      settings.afterArtifact?.();
      if (injectFailure) { injectFailure = false; throw new Error('injected crash after artifact creation'); }
      return artifact;
    },
  } as FeedbackInitiativeConsumer : realConsumer;
  const service = new FeedbackDrainService({
    store, processing: new FeedbackProcessingService({ dataDir: canonical }),
    consumer, arbiter, authorityId: 'dev-readiness',
    ownerHost: 'machine-a', ownerEpoch: settings.ownership?.epoch ?? (() => 1),
    isCanonicalOwner: settings.ownership?.held ?? (() => true), isConsumerLive: () => consumerLive,
    consumerBatchBound: () => consumerBatchBound, clock: () => now,
    stageBudgetMs: settings.stageBudgetMs,
    sourceCompactionIntervalMs: settings.sourceCompactionIntervalMs,
  });
  return { service, store, tracker, canonical, advance: (ms: number) => { now += ms; } };
}

describe('FeedbackDrainService lifecycle', () => {
  it('agent-approves, enqueues, claims, creates a readable Initiative, and completes', async () => {
    const { service, store, tracker } = setup(true);
    const result = await service.tick();
    expect(result).toMatchObject({ reviewed: 1, approved: 1, enqueued: 1, claimed: 1, completed: 1, result: 'succeeded' });
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('completed');
    expect(tracker.findByFeedbackWorkKey('feedback-work:cluster-1:1')).toMatchObject({ id: 'feedback-work-1', pipelineStage: 'outline' });
  });

  it('simulation leaves canonical queue unclaimed and reports would-create', async () => {
    const { service, store, tracker } = setup(false);
    const result = await service.tick();
    expect(result).toMatchObject({ approved: 1, enqueued: 1, claimed: 0, completed: 0, wouldCreate: 1 });
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('queued');
    expect(store.workByKey('feedback-work:cluster-1:1')?.attempts).toBe(0);
    expect(tracker.list()).toHaveLength(0);
  });

  it('scrubs credential-shaped source text before queue and Initiative persistence', async () => {
    const secret = `sk-${'A'.repeat(24)}`;
    const { service, store, tracker } = setup(true, 50, false, { title: `Scheduler leak ${secret}` });
    await service.tick();
    const work = store.workByKey('feedback-work:cluster-1:1');
    expect(work?.title).toContain('[REDACTED:openai-key]');
    expect(JSON.stringify(work)).not.toContain(secret);
    expect(JSON.stringify(tracker.list())).not.toContain(secret);
  });

  it('keeps rows collecting and makes authority failure observable without aborting the tick', async () => {
    const { service, store } = setup(true, 50, false, { arbiterThrows: true });
    const result = await service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed', approved: 0, enqueued: 0 });
    expect(store.getReadiness('cluster-1')).toMatchObject({ state: 'collecting', reasonCode: 'readiness-authority-failed' });
    expect(store.authorityPosture('dev-readiness', 1)).toMatchObject({ mode: 'proposal-only' });
  });

  it('bounds a stalled frontier-model authority stage and leaves work collecting', async () => {
    const { service, store } = setup(true, 50, false, { arbiterNever: true, stageBudgetMs: 10 });
    expect(await service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
    expect(store.getReadiness('cluster-1')?.state).toBe('collecting');
  });

  it('refuses a non-holder before admitting a durable run', async () => {
    const { service, store } = setup(true, 50, false, { ownership: { held: () => false, epoch: () => 9 } });
    expect(await service.tick()).toMatchObject({ result: 'degraded', reason: 'not-canonical-owner', runId: '' });
    expect(store.lastRun()).toBeNull();
  });

  it('refuses artifact acknowledgement when the canonical lease epoch changes mid-consumer', async () => {
    let held = true; let epoch = 1;
    const { service, store, tracker } = setup(true, 50, false, {
      ownership: { held: () => held, epoch: () => epoch },
      afterArtifact: () => { held = false; epoch = 2; },
    });
    await expect(service.tick()).rejects.toThrow(/ownership changed/);
    expect(tracker.list()).toHaveLength(1);
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('claimed');
    expect(store.lastRun()).toMatchObject({ state: 'running', ownerEpoch: 1 });
  });

  it('enforces the durable promotion batch bound even when live is requested', async () => {
    const { service, store, tracker } = setup(true, 0);
    const result = await service.tick();
    expect(result).toMatchObject({ enqueued: 1, claimed: 0, completed: 0 });
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('queued');
    expect(tracker.list()).toHaveLength(0);
  });

  it('recovers by exact feedbackWorkKey after a crash following artifact creation', async () => {
    const { service, store, tracker, advance } = setup(true, 50, true);
    expect(await service.tick()).toMatchObject({ retried: 1, completed: 0 });
    expect(tracker.list()).toHaveLength(1);
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('retryable');
    advance(60_000);
    expect(await service.tick()).toMatchObject({ claimed: 1, completed: 1 });
    expect(tracker.list()).toHaveLength(1);
    expect(store.workByKey('feedback-work:cluster-1:1')?.state).toBe('completed');
  });

  it('produces a bounded metadata-only historical backlog review packet', () => {
    const { service, store } = setup(false);
    store.ensureReadiness('cluster-1', 1000);
    const packet = service.analyzeHistoricalBacklog(500);
    expect(packet).toMatchObject({
      boundedBatchSize: 50, totalCollecting: 1, proposedClusterIds: ['cluster-1'],
      counts: { clusters: 1, reports: 4 }, priorityDistribution: { high: 0, normal: 1 },
      duplicates: { estimatedDuplicateReports: 3 }, estimatedWorkItemVolume: 1,
    });
    expect(JSON.stringify(packet)).not.toContain('Recurring scheduler crash');
    expect(JSON.stringify(packet)).not.toContain('not persisted to work');
  });

  it('compacts on the production tick cadence and accepts the checksummed handoff on the next tick', async () => {
    const { service, store, canonical, advance } = setup(false, 50, false, { seedFeedback: true, sourceCompactionIntervalMs: 1 });
    await service.tick();
    expect(fs.existsSync(path.join(canonical, 'feedback-generations.json'))).toBe(false);
    advance(2);
    await service.tick();
    const manifest = JSON.parse(fs.readFileSync(path.join(canonical, 'feedback-generations.json'), 'utf8')) as { currentGenerationId: string };
    expect(store.sourceCursor()?.generationId).toBe('canonical-feedback-v1');
    advance(2);
    await service.tick();
    expect(store.sourceCursor()?.generationId).toBe(manifest.currentGenerationId);
    expect(store.integrityCheck()).toBe(true);
  });
});
