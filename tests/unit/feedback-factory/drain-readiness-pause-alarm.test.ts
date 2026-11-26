// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness pause alarm (2026-10-18): the brake below paused the sorter on Oct 14 and
 * nobody was told for four days. A paused authority must raise exactly one attention item
 * naming what stopped and what restores it — and must never restore itself.
 *
 * Setup copied from drain-readiness-brake.test.ts. The readiness brake. Live 2026-10-02 02:30 PDT (drain run 2e06aa3b, authority generation 4):
 * one real gpt-6-astra answer cross-cited a near-duplicate sibling's evidence id, the parser
 * called it a contract violation, and the operator's approval was voided with no record of
 * which check failed. Replayed here: the 10 real candidates and the real recorded replies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FeedbackProcessingService } from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { DrainConflictError, FeedbackDrainStore } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { EVIDENCE_NOT_OWN, FeedbackReadinessArbiter } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { FeedbackDrainService, READINESS_STALL_NOTICE_TICKS, type ReadinessPauseAttention } from '../../../src/feedback-factory/drain/FeedbackDrainService.js';
import type { FeedbackInitiativeConsumer } from '../../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'feedback-readiness-cross-cite-shapes.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
  resolvedModel: { model: string; framework: string };
  candidates: Array<{ clusterId: string; title: string; type: string; reportCount: number; createdAt: string; updatedAt: string }>;
  replies: Array<{ oldVerdict: string; raw: string }>;
};
const crossCite = fixture.replies.find((reply) => reply.oldVerdict.includes('cited evidence outside'))!;
const AUTHORITY = 'feedback-readiness-default';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'drain-readiness-pause-alarm.test.ts' });
});

function setup(reply: (call: number) => { raw: string; model?: string }, raiseAttention?: (item: ReadinessPauseAttention) => Promise<void>) {
  let now = Date.parse('2026-10-02T09:30:22Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-brake-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'clusters.jsonl'), fixture.candidates.map((c) => `${JSON.stringify(c)}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), '');
  const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'x'.repeat(32), clock: () => now });
  store.mutateAuthority({
    action: 'create', operatorDecisionRef: 'approval:operator-1', authorityId: AUTHORITY,
    agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra',
    promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
    maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
  });
  let calls = 0;
  const arbiter = new FeedbackReadinessArbiter({
    evaluate: async (_prompt, options) => {
      const next = reply(++calls);
      now += 37_755; // the live call's latency
      options?.onModel?.({ ...fixture.resolvedModel, ...(next.model ? { model: next.model } : {}) });
      return next.raw;
    },
  });
  const service = new FeedbackDrainService({
    store, processing: new FeedbackProcessingService({ dataDir: dir }),
    consumer: { consume: async () => { throw new Error('consumer not used'); } } as unknown as FeedbackInitiativeConsumer,
    arbiter, authorityId: AUTHORITY, ownerHost: 'machine-a', ownerEpoch: () => 1,
    isCanonicalOwner: () => true, isConsumerLive: () => false, clock: () => now, maxWallClockMs: 115_000, raiseAttention,
  });
  const reason = (clusterId: string) => store.getReadiness(clusterId)?.reasonCode;
  return { service, store, reason, calls: () => calls, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('readiness pause alarm', () => {
  it('ticks with no usable answer never pause; after READINESS_STALL_NOTICE_TICKS ONE stall notice per episode', async () => {
    // Live 2026-10-14: eight HTTP 429s on the approved model's lane paused the sorter for four
    // days under the old three-strike rule. Spec line 121 closes the demotion list (a provider
    // failure is not on it); line 270 forbids a feature-local retry loop. So: never demote,
    // keep retrying on cadence, and say so once when it has gone on for a while.
    const items: ReadinessPauseAttention[] = [];
    let failing = true;
    const ctx = setup(() => ({ raw: failing ? JSON.stringify({ decisions: [] }) : crossCite.raw }), async (item) => { items.push(item); });
    for (let tick = 1; tick < READINESS_STALL_NOTICE_TICKS; tick++) {
      await ctx.service.tick();
      expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
      expect(ctx.store.readinessProgress(AUTHORITY, 1).consecutiveFailedTicks).toBe(tick);
      expect(items).toHaveLength(0);
      ctx.advance(30 * 60 * 1000);
    }
    await ctx.service.tick();
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active'); // never demoted: nothing to approve
    expect(items).toHaveLength(1);
    const since = ctx.store.readinessProgress(AUTHORITY, 1).stalledSince!;
    expect(typeof since).toBe('number');
    expect(items[0]).toMatchObject({
      id: `feedback-drain:readiness-stalled:${AUTHORITY}:1:${since}`,
      title: 'Feedback sorting is not making progress',
      priority: 'NORMAL',
      sourceContext: 'feedback-drain:readiness-stalled',
    });
    expect(items[0].summary).toContain(`${READINESS_STALL_NOTICE_TICKS} runs in a row`);
    expect(items[0].summary).toContain('Nothing is paused and nothing needs your approval');
    expect(items[0].summary).toContain('incomplete-decision-set'); // the last failure, named
    expect(items[0].description).toContain('nothing to approve');

    // Further failed ticks keep retrying on cadence and do not repeat the notice.
    for (let i = 0; i < 3; i++) {
      ctx.advance(30 * 60 * 1000);
      await ctx.service.tick();
    }
    expect(items).toHaveLength(1);
    expect(ctx.calls()).toBe(READINESS_STALL_NOTICE_TICKS + 3); // a model call every tick: nothing paused

    // A usable answer closes the episode; a later outage is a new episode with its own notice.
    failing = false;
    ctx.advance(30 * 60 * 1000);
    expect(await ctx.service.tick()).toMatchObject({ result: 'succeeded' });
    expect(ctx.store.readinessProgress(AUTHORITY, 1)).toMatchObject({ consecutiveFailedTicks: 0, stalledSince: null });
    expect(typeof ctx.store.readinessProgress(AUTHORITY, 1).lastSuccessAt).toBe('number');
    failing = true;
    ctx.advance(25 * 60 * 60 * 1000); // the held rows come due again
    for (let tick = 1; tick <= READINESS_STALL_NOTICE_TICKS; tick++) {
      await ctx.service.tick();
      ctx.advance(30 * 60 * 1000);
    }
    expect(items).toHaveLength(2);
    expect(items[1].id).not.toBe(items[0].id);
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
  });

  it('a different model answering → HIGH item at once', async () => {
    const items: ReadinessPauseAttention[] = [];
    const ctx = setup(() => ({ raw: crossCite.raw, model: 'gpt-5.5' }), async (item) => { items.push(item); });
    await ctx.service.tick();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe('HIGH');
    expect(items[0].summary).toContain('did not come from the approved model');
  });

  it('a pause that predates this process is told on the first tick that finds it', async () => {
    const items: ReadinessPauseAttention[] = [];
    const ctx = setup(() => ({ raw: crossCite.raw }), async (item) => { items.push(item); });
    ctx.store.demoteAuthority(AUTHORITY, 1, 'readiness-authority-repeated-invocation-failure');
    await ctx.service.tick();
    expect(items).toHaveLength(1);
    expect(ctx.calls()).toBe(0);
  });

  it('a failed enqueue is retried on the next tick; it never throws into the tick', async () => {
    let attempts = 0;
    const ctx = setup(() => ({ raw: crossCite.raw }), async () => { attempts++; if (attempts === 1) throw new Error('telegram down'); });
    ctx.store.demoteAuthority(AUTHORITY, 1, 'readiness-spend-brake');
    await expect(ctx.service.tick()).resolves.toBeDefined();
    ctx.advance(16 * 60 * 1000);
    await ctx.service.tick();
    expect(attempts).toBe(2);
    ctx.advance(16 * 60 * 1000);
    await ctx.service.tick();
    expect(attempts).toBe(2);
  });

  it('an active authority raises nothing', async () => {
    const items: ReadinessPauseAttention[] = [];
    const ctx = setup(() => ({ raw: crossCite.raw }), async (item) => { items.push(item); });
    await ctx.service.tick();
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
    expect(items).toHaveLength(0);
  });
});
