// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness progress-age alarm (ACT-114, 2026-10-19). PR 2202 stopped a provider failure from
 * pausing the sorter and added a stall notice counted in failed TICKS. A sorter whose ticks never
 * run, or run but never ask the model, counts nothing and would again stop in silence (the shape
 * of the four-day 2026-10-14 incident). This check runs on a server timer, independent of ticks:
 * once candidates have waited past the bound with no successful readiness call, ONE item per wait.
 * Signal only (spec feedback-factory-operating-drain.md line 270): it never retries or re-runs.
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
import { FeedbackDrainService, READINESS_NO_PROGRESS_ALARM_MS, READINESS_STALL_NOTICE_TICKS, type ReadinessPauseAttention } from '../../../src/feedback-factory/drain/FeedbackDrainService.js';
import type { FeedbackInitiativeConsumer } from '../../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'feedback-readiness-cross-cite-shapes.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
  resolvedModel: { model: string; framework: string };
  candidates: Array<{ clusterId: string; title: string; type: string; reportCount: number; createdAt: string; updatedAt: string }>;
  replies: Array<{ oldVerdict: string; raw: string }>;
};
const crossCite = fixture.replies.find((reply) => reply.oldVerdict.includes('cited evidence outside'))!;
const AUTHORITY = 'feedback-readiness-default';
const HOUR = 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'drain-readiness-no-progress.test.ts' });
});

function setup(opts: { authority?: boolean; arbiter?: boolean; owner?: () => boolean; reply?: () => string } = {}) {
  let now = Date.parse('2026-10-19T09:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-no-progress-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'clusters.jsonl'), fixture.candidates.map((c) => `${JSON.stringify(c)}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), '');
  const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'x'.repeat(32), clock: () => now });
  if (opts.authority !== false) {
    store.mutateAuthority({
      action: 'create', operatorDecisionRef: 'approval:operator-1', authorityId: AUTHORITY,
      agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra',
      promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
      maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    });
  }
  let calls = 0;
  const arbiter = opts.arbiter === false ? null : new FeedbackReadinessArbiter({
    evaluate: async (_prompt, options) => {
      calls++;
      now += 30_000;
      options?.onModel?.({ ...fixture.resolvedModel });
      return (opts.reply ?? (() => crossCite.raw))();
    },
  });
  const items: ReadinessPauseAttention[] = [];
  const service = new FeedbackDrainService({
    store, processing: new FeedbackProcessingService({ dataDir: dir }),
    consumer: { consume: async () => { throw new Error('consumer not used'); } } as unknown as FeedbackInitiativeConsumer,
    arbiter, authorityId: AUTHORITY, ownerHost: 'machine-a', ownerEpoch: () => 1,
    isCanonicalOwner: opts.owner ?? (() => true), isConsumerLive: () => false, clock: () => now, maxWallClockMs: 115_000,
    raiseAttention: async (item) => { items.push(item); },
  });
  const seedDue = () => { for (const c of fixture.candidates) store.ensureReadiness(c.clusterId, now); };
  return { service, store, items, seedDue, calls: () => calls, advance: (ms: number) => { now += ms; } };
}

describe('readiness progress-age alarm', () => {
  it('ticks that never run: one item once the wait passes the bound, naming that the drain has not run', async () => {
    const ctx = setup();
    ctx.seedDue();
    expect(await ctx.service.checkReadinessProgress()).toBe('waiting');
    const since = ctx.store.readinessWaitingSince()!;
    ctx.advance(READINESS_NO_PROGRESS_ALARM_MS - 1);
    expect(await ctx.service.checkReadinessProgress()).toBe('waiting');
    expect(ctx.items).toHaveLength(0);
    ctx.advance(1);
    expect(await ctx.service.checkReadinessProgress()).toBe('alarmed');
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0]).toMatchObject({
      id: `feedback-drain:readiness-no-progress:${since}`,
      title: 'Feedback sorting has made no progress',
      priority: 'NORMAL',
      sourceContext: 'feedback-drain:readiness-no-progress',
    });
    expect(ctx.items[0].summary).toContain(`${fixture.candidates.length} feedback report groups`);
    expect(ctx.items[0].summary).toContain('The drain has never run');
    expect(ctx.items[0].description).toContain('Nothing retries or repairs this automatically');
    // Later checks in the same wait never repeat it.
    for (let i = 0; i < 4; i++) { ctx.advance(HOUR); await ctx.service.checkReadinessProgress(); }
    expect(ctx.items).toHaveLength(1);
    expect(ctx.calls()).toBe(0); // signal only: the check never runs a tick or calls the model
  });

  it('ticks that run but never ask the model (no model wired) are caught; the tick-counted notices see nothing', async () => {
    const ctx = setup({ arbiter: false });
    await ctx.service.tick();
    expect(await ctx.service.checkReadinessProgress()).toBe('waiting');
    for (let elapsed = 0; elapsed <= READINESS_NO_PROGRESS_ALARM_MS; elapsed += 30 * 60 * 1000) {
      ctx.advance(30 * 60 * 1000);
      await ctx.service.tick();
      await ctx.service.checkReadinessProgress();
    }
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
    expect(ctx.store.readinessProgress(AUTHORITY, 1).consecutiveFailedTicks).toBe(0); // the stall notice can never fire here
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0].summary).toContain('runs but asks the sorting model nothing');
    expect(ctx.items[0].summary).toContain('readiness-authority-unavailable');
  });

  it('no approved model: the item says approving one starts it', async () => {
    const ctx = setup({ authority: false });
    ctx.seedDue();
    await ctx.service.checkReadinessProgress();
    ctx.advance(READINESS_NO_PROGRESS_ALARM_MS);
    expect(await ctx.service.checkReadinessProgress()).toBe('alarmed');
    expect(ctx.items[0].summary).toContain('No sorting model has been approved');
    expect(ctx.items[0].description).toContain('Feedback Drain tab');
  });

  it('a successful readiness call closes the wait; a later wait gets its own item', async () => {
    const ctx = setup();
    ctx.seedDue();
    await ctx.service.checkReadinessProgress();
    ctx.advance(READINESS_NO_PROGRESS_ALARM_MS);
    await ctx.service.checkReadinessProgress();
    expect(ctx.items).toHaveLength(1);
    expect(await ctx.service.tick()).toMatchObject({ result: 'succeeded' });
    expect(ctx.store.readinessWaitingSince()).toBeNull();
    // Answered rows are rescheduled a day out under the model's reason: not waiting.
    expect(await ctx.service.checkReadinessProgress()).toBe('idle');
    ctx.advance(25 * HOUR); // they come due again and nothing answers
    expect(await ctx.service.checkReadinessProgress()).toBe('waiting');
    ctx.advance(READINESS_NO_PROGRESS_ALARM_MS);
    expect(await ctx.service.checkReadinessProgress()).toBe('alarmed');
    expect(ctx.items).toHaveLength(2);
    expect(ctx.items[1].id).not.toBe(ctx.items[0].id);
  });

  it('a wait already named by another notice is not told twice', async () => {
    // Paused authority: the pause alarm owns it.
    const paused = setup();
    paused.seedDue();
    paused.store.demoteAuthority(AUTHORITY, 1, 'readiness-spend-brake');
    await paused.service.checkReadinessProgress();
    paused.advance(READINESS_NO_PROGRESS_ALARM_MS);
    expect(await paused.service.checkReadinessProgress()).toBe('covered');
    expect(paused.items).toHaveLength(0);

    // A run of failed calls: the stall notice owns it.
    const failing = setup({ reply: () => JSON.stringify({ decisions: [] }) });
    await failing.service.tick();
    await failing.service.checkReadinessProgress();
    for (let tick = 1; tick < READINESS_STALL_NOTICE_TICKS + 6; tick++) {
      failing.advance(30 * 60 * 1000);
      await failing.service.tick();
      await failing.service.checkReadinessProgress();
    }
    expect(failing.items.map((item) => item.sourceContext)).toEqual(['feedback-drain:readiness-stalled']);
  });

  it('only the canonical owner stamps or alarms; nothing waiting closes the wait', async () => {
    const notOwner = setup({ owner: () => false });
    notOwner.seedDue();
    expect(await notOwner.service.checkReadinessProgress()).toBe('not-owner');
    expect(notOwner.store.readinessWaitingSince()).toBeNull();

    const ctx = setup();
    expect(await ctx.service.checkReadinessProgress()).toBe('idle');
    ctx.seedDue();
    await ctx.service.checkReadinessProgress();
    expect(ctx.service.readinessProgressAge()).toMatchObject({ waitingCandidates: fixture.candidates.length, alarmAfterMs: READINESS_NO_PROGRESS_ALARM_MS });
    expect(ctx.service.readinessProgressAge().waitingSince).not.toBeNull();
  });
});
