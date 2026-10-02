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
import { FeedbackDrainService, READINESS_TRANSIENT_FAILURE_LIMIT } from '../../src/feedback-factory/drain/FeedbackDrainService.js';
import { CodexExecJsonTimeoutError } from '../../src/providers/adapters/openai-codex/transport/codexSpawn.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-factory-drain-service.test.ts' });
});

function setup(consumerLive = true, consumerBatchBound = 50, failAfterFirstArtifact = false, settings: {
  title?: string; arbiterThrows?: boolean; arbiterNever?: boolean; stageBudgetMs?: number;
  arbiterError?: () => Error | undefined; resolvedModel?: string;
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
    evaluate: async (prompt, evalOptions) => {
      if (settings.arbiterNever) return await new Promise<string>(() => undefined);
      if (settings.arbiterThrows) throw new Error('provider unavailable');
      const injected = settings.arbiterError?.();
      if (injected) throw injected;
      evalOptions?.onModel?.({ model: settings.resolvedModel ?? 'claude-fable-5', framework: 'claude-code' });
      const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
      return JSON.stringify({ decisions: packet.map(({ clusterId }) => ({ clusterId, outcome: clusterId === 'cluster-1' ? 'ready' : 'collecting', confidence: 0.95, reasonCodes: ['coherent-recurrence'], evidenceIds: [`cluster:${clusterId}`] })) });
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
    readinessStageBudgetMs: settings.stageBudgetMs,
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
    expect(store.authorityPosture('dev-readiness', 1)).toMatchObject({ mode: 'active' });
  });

  // Live 2026-10-01 run a49ad1e8: one CodexExecJsonTimeoutError demoted the authority for good.
  it('retries a transient invocation failure and demotes only after a run of them', async () => {
    let failing = true;
    const { service, store, advance } = setup(false, 50, false, { arbiterError: () => failing ? new CodexExecJsonTimeoutError(60_000, '') : undefined });
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
      expect(store.authorityPosture('dev-readiness', 1).mode).toBe('active');
      advance(16 * 60 * 1000);
    }
    failing = false;
    await service.tick();
    expect(store.authorityPosture('dev-readiness', 1).mode).toBe('active');
    expect(store.getReadiness('cluster-1')?.state).toBe('queued');
  });

  it('demotes after the consecutive transient failure limit', async () => {
    const { service, store, advance } = setup(false, 50, false, { arbiterError: () => new CodexExecJsonTimeoutError(60_000, '') });
    for (let attempt = 1; attempt < READINESS_TRANSIENT_FAILURE_LIMIT; attempt++) { await service.tick(); advance(16 * 60 * 1000); }
    expect(store.authorityPosture('dev-readiness', 1).mode).toBe('active');
    await service.tick();
    expect(store.authorityPosture('dev-readiness', 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-authority-repeated-invocation-failure' });
  });

  it('still demotes at once on a provenance violation', async () => {
    const { service, store } = setup(false, 50, false, { resolvedModel: 'gpt-5.5' });
    expect(await service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
    expect(store.authorityPosture('dev-readiness', 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-schema-provenance-or-routing-failure' });
  });

  it('keeps the authority after a same-machine lease epoch advance, and refuses it on a new owner machine', async () => {
    let epoch = 1;
    const { service, store, advance } = setup(false, 50, false, { ownership: { held: () => true, epoch: () => epoch } });
    store.ensureReadiness('cluster-1', 0);
    epoch = 3; // two same-machine restarts after approval at epoch 1
    expect(await service.tick()).toMatchObject({ reviewed: 1, approved: 1 });
    expect(service.canAgentMutateReadiness('echo')).toBe(true);
    // Another machine owned the drain: the record bound to machine-a at epoch 1 is stale.
    const foreign = store.startRun({ ownerHost: 'machine-b', ownerEpoch: 4, leaseMs: 1 });
    store.transitionRun(foreign.runId, 'accepted', 'running', '', { ownerHost: 'machine-b', ownerEpoch: 4 });
    store.transitionRun(foreign.runId, 'running', 'succeeded', '', { ownerHost: 'machine-b', ownerEpoch: 4 });
    advance(1_000);
    epoch = 5;
    expect(service.canAgentMutateReadiness('echo')).toBe(false);
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

  it('reads the drain\'s own processing re-append as a version and keeps every later run green', async () => {
    const { service, store, canonical } = setup(false);
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), `${JSON.stringify({ feedbackId: 'f-a', sourceRecordId: 'src-a', status: 'unprocessed',
      title: 'Scheduler crash on boot', description: 'a', type: 'bug', receivedAt: '2026-07-01T00:00:00Z' })}\n`);
    expect(await service.tick()).toMatchObject({ processed: 1, result: 'succeeded' });
    // processing appended f-a again (status processing, same sourceRecordId); the next run reads it.
    expect(fs.readFileSync(path.join(canonical, 'feedback.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await service.tick()).not.toMatchObject({ result: 'degraded' });
    expect(store.metrics().sourceChecksumConflicts).toBe(0);
    expect(store.lastRun()?.state).not.toBe('failed');
  });

  it('quarantines one conflicting source record, keeps runs degraded until repaired, and still processes the rest', async () => {
    const { service, store, canonical } = setup(false);
    const report = (feedbackId: string, sourceRecordId: string) => `${JSON.stringify({ feedbackId, sourceRecordId, status: 'unprocessed',
      title: `Distinct failure ${feedbackId}`, description: 'd', type: 'bug', receivedAt: '2026-07-01T00:00:00Z' })}\n`;
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), report('f-1', 'src-1') + report('f-2', 'src-1') + report('f-3', 'src-3'));
    const stalls: string[] = [];
    (service as unknown as { opts: { onRecoverableStall?: (reason: string) => void } }).opts.onRecoverableStall = (reason) => { stalls.push(reason); };
    const first = await service.tick();
    expect(first).toMatchObject({ processed: 2, result: 'degraded', reason: 'source-record-quarantined' });
    expect(store.lastRun()).toMatchObject({ state: 'degraded', reason: 'source-record-quarantined' });
    expect(stalls).toEqual(['source-record-quarantined']);
    expect(store.metrics().sourceChecksumConflicts).toBe(1);
    // Every later run keeps reporting it until an operator repairs the held line (spec: persistent attention),
    // while the rest of the pipeline keeps moving.
    expect(await service.tick()).toMatchObject({ result: 'degraded', reason: 'source-record-quarantined' });
    expect(store.lastRun()?.state).toBe('degraded');
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
