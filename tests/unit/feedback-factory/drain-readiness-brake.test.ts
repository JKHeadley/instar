// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness brake. Live 2026-10-02 02:30 PDT (drain run 2e06aa3b, authority generation 4):
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
import { FeedbackDrainService, READINESS_TRANSIENT_FAILURE_LIMIT } from '../../../src/feedback-factory/drain/FeedbackDrainService.js';
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
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'drain-readiness-brake.test.ts' });
});

function setup(reply: (call: number) => { raw: string; model?: string }) {
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
    isCanonicalOwner: () => true, isConsumerLive: () => false, clock: () => now, maxWallClockMs: 115_000,
  });
  const reason = (clusterId: string) => store.getReadiness(clusterId)?.reasonCode;
  return { service, store, reason, calls: () => calls, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('readiness brake: one imperfect answer never voids the approval', () => {
  it('replays the live cross-cite answer: the authority stays active and only the cross-citing rows are held back', async () => {
    const ctx = setup(() => ({ raw: crossCite.raw }));
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'succeeded', reviewed: 10 });
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
    const decisions = (JSON.parse(crossCite.raw) as { decisions: Array<{ clusterId: string; outcome: string; confidence: number; evidenceIds: string[] }> }).decisions;
    const crossCited = decisions.filter((d) => d.evidenceIds.some((id) => id !== `cluster:${d.clusterId}`));
    expect(crossCited).toHaveLength(2);
    for (const d of crossCited) expect(ctx.reason(d.clusterId)).toBe(EVIDENCE_NOT_OWN);
    const ready = decisions.filter((d) => !crossCited.includes(d) && d.outcome === 'ready' && d.confidence >= 0.8);
    expect(result.approved).toBe(ready.length);
    for (const d of ready) expect(ctx.store.getReadiness(d.clusterId)?.state).not.toBe('collecting');
    expect(ctx.store.lastReadinessDiagnosis()).toBeNull();
  });

  it('a rejected answer applies nothing, retries its rows, records the exact check, and keeps the approval', async () => {
    const ctx = setup(() => ({ raw: 'I think these are mostly ready.' }));
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-output-rejected', reviewed: 0, approved: 0 });
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
    for (const c of fixture.candidates) {
      expect(ctx.store.getReadiness(c.clusterId)).toMatchObject({ state: 'collecting', reasonCode: 'readiness-output-rejected', nextReviewAt: ctx.now() - 37_755 + 15 * 60 * 1000 });
    }
    const last = ctx.store.lastReadinessDiagnosis()!;
    expect(last).toMatchObject({ runId: result.runId, outcome: 'output-rejected' });
    expect(last.diagnosis).toMatchObject({ check: 'invalid-json', candidateCount: 9, resolvedModel: 'gpt-6-astra', resolvedFramework: 'codex-cli', excerpt: 'I think these are mostly ready.' });
    expect(last.diagnosis!.candidateIds).toHaveLength(9);
    expect(last.diagnosis!.callId).toMatch(/^readiness-call:/);
  });

  it('demotes only after the limit of consecutive ticks with no usable answer', async () => {
    const ctx = setup(() => ({ raw: JSON.stringify({ decisions: [] }) }));
    for (let tick = 1; tick < READINESS_TRANSIENT_FAILURE_LIMIT; tick++) {
      expect(await ctx.service.tick()).toMatchObject({ reason: 'readiness-output-rejected' });
      expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
      ctx.advance(16 * 60 * 1000);
    }
    await ctx.service.tick();
    expect(ctx.store.authorityPosture(AUTHORITY, 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-authority-repeated-invocation-failure' });
    expect(ctx.store.lastReadinessDiagnosis()?.diagnosis?.check).toBe('incomplete-decision-set');
  });

  it('a usable answer after a rejected one resets the count', async () => {
    const ctx = setup((call) => ({ raw: call === 1 ? 'not json' : crossCite.raw }));
    await ctx.service.tick();
    ctx.advance(16 * 60 * 1000);
    expect(await ctx.service.tick()).toMatchObject({ result: 'succeeded' });
    expect(ctx.store.recordAuthorityTransientFailure(AUTHORITY, 1)).toBe(1);
  });

  it('still demotes at once when a different model answers, and says which', async () => {
    const ctx = setup(() => ({ raw: crossCite.raw, model: 'gpt-5.5' }));
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed', approved: 0 });
    expect(ctx.store.authorityPosture(AUTHORITY, 1)).toMatchObject({ mode: 'proposal-only', reason: 'readiness-schema-provenance-or-routing-failure' });
    expect(ctx.store.lastReadinessDiagnosis()).toMatchObject({ runId: result.runId, outcome: 'contract-violation', diagnosis: { check: 'resolved-model-mismatch', resolvedModel: 'gpt-5.5' } });
  });

  it('a refused store write is a failed call, not a demotion', async () => {
    const ctx = setup(() => ({ raw: crossCite.raw }));
    ctx.store.approveReady = () => { throw new DrainConflictError('cannot approve readiness from queued'); };
    const result = await ctx.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-authority-failed' });
    expect(ctx.store.authorityPosture(AUTHORITY, 1).mode).toBe('active');
    expect(ctx.store.lastReadinessDiagnosis()).toMatchObject({ outcome: 'call-failed', diagnosis: { check: 'DrainConflictError', message: 'cannot approve readiness from queued' } });
  });
});
