// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness review in chunks. Live 2026-10-01 (Mac Studio, gpt-6-astra via codex-cli):
 * ~3.1 s per candidate (10 candidates: run 20c4fac7 took 32.6 s end to end); a
 * 50-candidate call hit the 60 s call budget twice in a row (runs 2b4bebb3, 0e7b229a,
 * 60.1 s each). The fake clock below reproduces that latency shape; the replies are the
 * recorded gpt-6-astra decisions where the cluster ids match.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FeedbackProcessingService } from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { FeedbackDrainStore } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackReadinessArbiter } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { FeedbackDrainService, READINESS_CHUNK_SIZE, READINESS_TRANSIENT_FAILURE_LIMIT } from '../../../src/feedback-factory/drain/FeedbackDrainService.js';
import { CodexExecJsonTimeoutError } from '../../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
import type { FeedbackInitiativeConsumer } from '../../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'feedback-drain-live-shapes.json');
const shapes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
  arbiterReplies: { ready: string; collecting: string };
  arbiterResolvedModel: { model: string; framework: string };
};
interface RecordedDecision { clusterId: string; outcome: string; confidence: number; reasonCodes: string[]; evidenceIds: string[] }
const recorded = [shapes.arbiterReplies.ready, shapes.arbiterReplies.collecting]
  .flatMap((raw) => (JSON.parse(raw) as { decisions: RecordedDecision[] }).decisions);
const collectingTemplate = recorded.find((decision) => decision.outcome === 'collecting')!;

const PER_CANDIDATE_MS = 3_100;
const CALL_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'drain-readiness-chunking.test.ts' });
});

type CallFault = 'timeout' | 'wrong-model' | undefined;

function setup(input: {
  clusters?: number; maxBatch?: number; maxDailySpendUsd?: number; chunkSize?: number; maxWallClockMs?: number;
  fault?: (call: number, size: number) => CallFault; beforeReadinessMs?: number;
  owner?: () => boolean; rawConfig?: { readinessChunkSize?: unknown; maxWallClockMs?: unknown };
} = {}) {
  let now = Date.parse('2026-10-02T02:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-chunking-'));
  dirs.push(dir);
  const ids = [...recorded.map((decision) => decision.clusterId)];
  for (let i = ids.length; i < (input.clusters ?? 50); i++) ids.push(`cluster-zz-synthetic-${String(i).padStart(3, '0')}`);
  fs.writeFileSync(path.join(dir, 'clusters.jsonl'), ids.slice(0, input.clusters ?? 50).map((clusterId) => `${JSON.stringify({
    clusterId, title: `Feedback ${clusterId}`, type: 'bug', reportCount: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  })}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), '');
  const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'x'.repeat(32), clock: () => now });
  store.mutateAuthority({
    action: 'create', operatorDecisionRef: 'approval:operator-1', authorityId: 'feedback-readiness-default',
    agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra',
    promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
    maxBatch: input.maxBatch ?? 50, maxTokens: 1200, maxDailySpendUsd: input.maxDailySpendUsd ?? 5,
  });
  const calls: number[] = [];
  const arbiter = new FeedbackReadinessArbiter({
    evaluate: async (prompt, options) => {
      const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
      calls.push(packet.length);
      const fault = input.fault?.(calls.length, packet.length);
      const latency = packet.length * PER_CANDIDATE_MS;
      if (fault === 'timeout' || latency > CALL_TIMEOUT_MS) {
        now += CALL_TIMEOUT_MS;
        throw new CodexExecJsonTimeoutError(CALL_TIMEOUT_MS, '');
      }
      now += latency;
      options?.onModel?.(fault === 'wrong-model' ? { model: 'gpt-5.5', framework: 'codex-cli' } : shapes.arbiterResolvedModel);
      return JSON.stringify({ decisions: packet.map(({ clusterId }) =>
        recorded.find((decision) => decision.clusterId === clusterId) ?? { ...collectingTemplate, clusterId, evidenceIds: [`cluster:${clusterId}`] }) });
    },
  });
  const processing = new FeedbackProcessingService({ dataDir: dir });
  if (input.beforeReadinessMs) {
    const activeClusters = processing.activeClusters.bind(processing);
    processing.activeClusters = () => { now += input.beforeReadinessMs!; return activeClusters(); };
  }
  const service = new FeedbackDrainService({
    store, processing, consumer: { consume: async () => { throw new Error('consumer not used'); } } as unknown as FeedbackInitiativeConsumer,
    arbiter, authorityId: 'feedback-readiness-default', ownerHost: 'machine-a', ownerEpoch: () => 1,
    isCanonicalOwner: input.owner ?? (() => true), isConsumerLive: () => false, clock: () => now,
    maxWallClockMs: (input.rawConfig ? input.rawConfig.maxWallClockMs : input.maxWallClockMs ?? 90_000) as number,
    readinessChunkSize: (input.rawConfig ? input.rawConfig.readinessChunkSize : input.chunkSize) as number,
  });
  const readiness = (state: string) => (store as unknown as { db: import('better-sqlite3').Database }).db
    .prepare(`SELECT cluster_id, reason_code, last_evaluated_at, next_review_at FROM readiness WHERE state=? ORDER BY cluster_id`).all(state) as
    Array<{ cluster_id: string; reason_code: string | null; last_evaluated_at: number | null; next_review_at: number }>;
  const usage = () => (store as unknown as { db: import('better-sqlite3').Database }).db
    .prepare(`SELECT committed_usd usd, decisions FROM authority_daily_usage`).get() as { usd: number; decisions: number } | undefined;
  return { service, store, calls, readiness, usage, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('readiness review in chunks (live latency shape)', () => {
  it('the old single 50-candidate call times out; chunks of 10 decide inside the 90 s tick', async () => {
    const single = setup({ chunkSize: 50 });
    expect(await single.service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed', reviewed: 0 });
    expect(single.calls).toEqual([50]);

    const chunked = setup();
    const startedAt = chunked.now();
    const result = await chunked.service.tick();
    // 90 s tick, 20 s kept for the later stages: 10 (31 s) + 10 (31 s) + 2 (6.2 s), then the next would not fit.
    expect(chunked.calls).toEqual([10, 10, 2]);
    expect(result).toMatchObject({ result: 'succeeded', reviewed: 22, approved: 5 });
    expect(result.reason).toBeUndefined();
    expect(chunked.now() - startedAt).toBeLessThanOrEqual(70_000);
    expect(chunked.readiness('queued')).toHaveLength(5);
    // The 28 not reached stay due for the next tick, untouched.
    const untouched = chunked.readiness('collecting').filter((row) => row.last_evaluated_at === null);
    expect(untouched).toHaveLength(28);
    expect(untouched.every((row) => row.next_review_at <= chunked.now())).toBe(true);
    // Spend and daily usage are reserved per call, counted per decision.
    expect(chunked.usage()).toEqual({ usd: 0.03, decisions: 22 });
  });

  it('a 115 s tick fits more calls, and the next tick picks up the rest', async () => {
    const ctx = setup({ maxWallClockMs: 115_000 });
    expect((await ctx.service.tick()).reviewed).toBe(30);
    expect(ctx.calls).toEqual([10, 10, 8, 2]);
    ctx.advance(30 * 60 * 1000);
    expect((await ctx.service.tick()).reviewed).toBe(20);
    expect(ctx.readiness('collecting').filter((row) => row.last_evaluated_at === null)).toHaveLength(0);
  });

  it('never exceeds the authority maxBatch per tick (live gen 3: maxBatch 10)', async () => {
    const ctx = setup({ maxBatch: 10, maxWallClockMs: 115_000 });
    expect(await ctx.service.tick()).toMatchObject({ result: 'succeeded', reviewed: 10 });
    expect(ctx.calls).toEqual([10]);
    expect(READINESS_CHUNK_SIZE).toBe(10);
  });

  it('keeps earlier chunks\' decisions when a later chunk times out, and resets the failure counter', async () => {
    const ctx = setup({ maxWallClockMs: 115_000, fault: (call) => call === 2 ? 'timeout' : undefined });
    ctx.store.recordAuthorityTransientFailure('feedback-readiness-default', 1);
    ctx.store.recordAuthorityTransientFailure('feedback-readiness-default', 1);
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed', reviewed: 10, approved: 5 });
    expect(ctx.calls).toEqual([10, 10]);
    expect(ctx.readiness('queued')).toHaveLength(5);
    expect(ctx.readiness('collecting').filter((row) => row.reason_code === 'readiness-authority-failed')).toHaveLength(10);
    // A tick with a successful chunk resets the run: one more failed tick is 1, not 3.
    expect(ctx.store.recordAuthorityTransientFailure('feedback-readiness-default', 1)).toBe(1);
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1).mode).toBe('active');
  });

  it('counts a tick whose every chunk failed as ONE transient failure, and demotes only after the limit', async () => {
    const ctx = setup({ fault: () => 'timeout' });
    for (let tick = 1; tick < READINESS_TRANSIENT_FAILURE_LIMIT; tick++) {
      expect(await ctx.service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
      ctx.advance(16 * 60 * 1000);
    }
    expect(ctx.calls).toHaveLength(READINESS_TRANSIENT_FAILURE_LIMIT - 1);
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1).mode).toBe('active');
    await ctx.service.tick();
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-authority-repeated-invocation-failure' });
  });

  it('still demotes at once on a contract violation in a later chunk, keeping the earlier decisions', async () => {
    const ctx = setup({ fault: (call) => call === 2 ? 'wrong-model' : undefined });
    expect(await ctx.service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed', approved: 5 });
    expect(ctx.calls).toEqual([10, 10]);
    expect(ctx.readiness('queued')).toHaveLength(5);
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-schema-provenance-or-routing-failure' });
  });

  it('brakes on the daily spend cap between chunks, keeping the decisions already made', async () => {
    const ctx = setup({ maxDailySpendUsd: 0.02, maxWallClockMs: 115_000 });
    expect(await ctx.service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-spend-brake', reviewed: 20, approved: 5 });
    expect(ctx.calls).toEqual([10, 10]);
    expect(ctx.usage()).toEqual({ usd: 0.02, decisions: 20 });
    expect(ctx.readiness('collecting').filter((row) => row.reason_code === 'readiness-spend-brake')).toHaveLength(30);
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1).mode).toBe('proposal-only');
  });

  it('makes no model call when earlier stages spent the readiness window, and leaves every row due', async () => {
    const ctx = setup({ beforeReadinessMs: 71_000 });
    expect(await ctx.service.tick()).toMatchObject({ result: 'degraded', reason: 'readiness-wall-clock-exhausted', reviewed: 0 });
    expect(ctx.calls).toEqual([]);
    expect(ctx.usage()).toBeUndefined();
    expect(ctx.readiness('collecting').every((row) => row.last_evaluated_at === null)).toBe(true);
    expect(ctx.store.authorityPosture('feedback-readiness-default', 1).mode).toBe('active');
  });

  it('falls back to the defaults on a non-numeric config value instead of stalling readiness', async () => {
    const ctx = setup({ rawConfig: { readinessChunkSize: 'abc', maxWallClockMs: 'ninety' } });
    const fields = ctx.service as unknown as { readinessChunkSize: number; maxWallClockMs: number };
    expect(fields.readinessChunkSize).toBe(READINESS_CHUNK_SIZE);
    expect(fields.maxWallClockMs).toBe(115_000);
    expect(await ctx.service.tick()).toMatchObject({ result: 'succeeded', reviewed: 30 });
  });

  it('fails the run on an ownership loss after a call, without counting a provider failure', async () => {
    let owner = true;
    const ctx = setup({ owner: () => owner, fault: (call) => { if (call === 2) owner = false; return undefined; } });
    await expect(ctx.service.tick()).rejects.toThrow('canonical ownership changed during drain run');
    expect(ctx.calls).toEqual([10, 10]);
    // The first call's decisions stand; the second call's are not applied and not marked failed.
    expect(ctx.readiness('ready')).toHaveLength(5);
    expect(ctx.readiness('collecting').filter((row) => row.reason_code === 'readiness-authority-failed')).toHaveLength(0);
    expect(ctx.store.recordAuthorityTransientFailure('feedback-readiness-default', 1)).toBe(1);
  });

  it('keeps rows a call already approved when a store error interrupts applying its decisions', async () => {
    const ctx = setup({ maxWallClockMs: 115_000 });
    const record = ctx.store.recordCollectingEvaluation.bind(ctx.store);
    let collectingWrites = 0;
    ctx.store.recordCollectingEvaluation = (clusterId, input) => {
      if (input.reason !== 'readiness-authority-failed' && ++collectingWrites === 3) throw new Error('SQLITE_BUSY: database is locked');
      return record(clusterId, input);
    };
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
    expect(ctx.calls).toEqual([10]);
    // The recorded "ready" decisions applied before the error are kept (and enqueued), not re-marked.
    expect(ctx.readiness('queued').length).toBeGreaterThan(0);
    expect(ctx.store.recordAuthorityTransientFailure('feedback-readiness-default', 1)).toBe(2);
  });
});
