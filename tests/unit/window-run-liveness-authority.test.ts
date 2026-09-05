import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WindowRunLivenessAuthority,
  WindowRunLivenessStore,
  type WindowRunLivenessDocument,
  type WindowRunLivenessSample,
} from '../../src/core/WindowRunLivenessAuthority.js';

const BASE = Date.parse('2026-09-05T20:00:00.000Z');

function harness(options: { dryRun?: boolean; recovery?: boolean; replacementExecutorId?: string; resumedTaskRef?: string; projectStatus?: (status: string) => string } = {}) {
  let nowMs = BASE;
  let sample: WindowRunLivenessSample = {
    sampledAt: new Date(nowMs).toISOString(),
    executor: { id: 'echo-topic-36966', running: true, heartbeatAt: new Date(nowMs).toISOString() },
    deliveryReachable: true,
    work: { receiptId: 'work-1', sequence: 1, digest: 'a'.repeat(64), observedAt: new Date(nowMs).toISOString(), artifact: 'src/a.ts', taskRef: 'task-6' },
    lifecycle: { lifecycleRunId: 'lifecycle-w32', state: 'active_start', admitted: true, expiresAt: new Date(nowMs + 24 * 60 * 60_000).toISOString() },
  };
  let recoveryCalls = 0;
  const notices: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-run-live-'));
  const store = new WindowRunLivenessStore(dir);
  const authority = new WindowRunLivenessAuthority(store, {
    now: () => new Date(nowMs).toISOString(),
    sample: () => structuredClone(sample),
    recover: async ({ attemptId, taskRef }) => {
      recoveryCalls++;
      if (options.recovery !== false) {
        if (options.replacementExecutorId) sample.executor.id = options.replacementExecutorId;
        sample.executor.running = true;
        sample.executor.heartbeatAt = new Date(nowMs).toISOString();
        return { succeeded: true, detail: 'resumed first unreceipted task', receipt: `recovery:${attemptId}`, replacementExecutorId: options.replacementExecutorId, resumedTaskRef: options.resumedTaskRef ?? taskRef };
      }
      return { succeeded: false, detail: 'executor could not restart', receipt: `failed:${attemptId}` };
    },
    verifyWorkArtifact: (state, request) => ({ artifact: request.artifactRef, digest: (request.artifactRef.match(/([a-f])\.ts$/)?.[1] ?? 'a').repeat(64), taskRef: `task-${(state.audit.entries.filter(entry => entry.kind === 'work-receipt').length) + 7}` }),
    resolveRecoveryTask: () => 'task-recovery-open',
    projectStatus: options.projectStatus ? (_state, status) => options.projectStatus!(status) : undefined,
    rebindExecutor: (_state, replacementExecutorId) => `rebind:${replacementExecutorId}`,
    notifyFailure: async (_state, text) => { notices.push(text); return true; },
  }, { enabled: true, dryRun: options.dryRun ?? false, heartbeatMaxAgeMs: 60_000, workEvidenceMaxAgeMs: 30 * 60_000, recoveryCeilingMs: 15 * 60_000 });
  authority.register({ windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' });
  return {
    authority,
    store,
    notices,
    get recoveryCalls() { return recoveryCalls; },
    mutateSample(fn: (value: WindowRunLivenessSample) => void) { fn(sample); sample.sampledAt = new Date(nowMs).toISOString(); },
    advance(ms: number) { nowMs += ms; },
  };
}

describe('WindowRunLivenessAuthority', () => {
  it('labels active only when all five predicates are green', async () => {
    const h = harness();
    const state = await h.authority.tick();
    expect(state?.status).toBe('active');
    expect(Object.values(state!.predicates).every(verdict => verdict.ok)).toBe(true);
    expect(state?.transitions.at(-1)?.reason).toBe('all-five-predicates-green');
  });

  it.each([
    ['executor-bound-running', (s: WindowRunLivenessSample) => { s.executor.running = false; }],
    ['heartbeat-fresh', (s: WindowRunLivenessSample) => { s.executor.heartbeatAt = new Date(BASE - 61_000).toISOString(); }],
    ['delivery-reachable', (s: WindowRunLivenessSample) => { s.deliveryReachable = false; }],
    ['durable-work-advanced', (s: WindowRunLivenessSample) => { s.work = null; }],
    ['lifecycle-admitted-unexpired', (s: WindowRunLivenessSample) => { s.lifecycle.admitted = false; }],
  ] as const)('revokes active when %s is false', async (predicate, breakSample) => {
    const h = harness({ dryRun: true });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(breakSample);
    const state = await h.authority.tick();
    expect(state?.status).toBe('at-risk');
    expect(state?.predicates[predicate].ok).toBe(false);
    expect(state?.recoveryAttempt).toMatchObject({ number: 1, outcome: 'would-attempt' });
  });

  it('does not burn recovery while the separate preparation carrier is still pre-admission', async () => {
    const h = harness();
    h.mutateSample(s => { s.lifecycle.admitted = false; s.lifecycle.state = 'pre_start_gate'; });
    const state = await h.authority.tick();
    expect(state?.status).toBe('preparing');
    expect(state?.recoveryAttempt).toBeUndefined();
    expect(h.recoveryCalls).toBe(0);
  });

  it('attempts recovery exactly once and returns active only with an attributable receipt plus a green re-sample', async () => {
    const h = harness();
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.executor.running = false; });
    const recovered = await h.authority.tick();
    expect(h.recoveryCalls).toBe(1);
    expect(recovered?.status).toBe('active');
    expect(recovered?.recoveryAttempt).toMatchObject({ number: 1, outcome: 'succeeded' });
    expect(recovered?.recoveryAttempt?.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered?.transitions.at(-1)).toMatchObject({ to: 'active', reason: 'recovery-verified', recoveryAttemptId: recovered.recoveryAttempt?.attemptId });
    await h.authority.tick();
    expect(h.recoveryCalls).toBe(1);
  });

  it('becomes stalled and delivers one loud failure when its only recovery fails', async () => {
    const h = harness({ recovery: false });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.deliveryReachable = false; });
    const state = await h.authority.tick();
    expect(state?.status).toBe('stalled');
    expect(h.recoveryCalls).toBe(1);
    expect(h.notices).toHaveLength(1);
    await h.authority.tick();
    expect(h.recoveryCalls).toBe(1);
    expect(h.notices).toHaveLength(1);
  });

  it('persists an attributable replacement binding before recovery re-sampling', async () => {
    const h = harness({ replacementExecutorId: 'echo-topic-36966-r2' });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.executor.running = false; });
    const recovered = await h.authority.tick();
    expect(recovered?.status).toBe('active');
    expect(recovered?.executorId).toBe('echo-topic-36966-r2');
    expect(recovered?.recoveryAttempt?.replacementExecutorId).toBe('echo-topic-36966-r2');
    expect(recovered?.executorBindingReceipts).toHaveLength(1);
    expect(recovered?.executorBindingReceipts[0]).toMatchObject({ fromExecutorId: 'echo-topic-36966', toExecutorId: 'echo-topic-36966-r2', projectionReceipt: 'rebind:echo-topic-36966-r2' });
  });

  it('rejects a recovery that claims a different task than the server-bound first unreceipted task', async () => {
    const h = harness({ resumedTaskRef: 'task-wrong' });
    await h.authority.tick();
    h.mutateSample(s => { s.executor.running = false; });
    const state = await h.authority.tick();
    expect(state?.status).toBe('stalled');
    expect(state?.recoveryAttempt).toMatchObject({ requestedTaskRef: 'task-recovery-open', resumedTaskRef: 'task-wrong', outcome: 'failed', detail: 'recovery-task-attribution-mismatch' });
  });

  it('durably commits active before projection and retries an interrupted promotion', async () => {
    let compatibility = 'preparing';
    let rejectActive = true;
    const h = harness({
      projectStatus: status => {
        if (status === 'active' && rejectActive) throw new Error('injected-projection-crash');
        compatibility = status;
        return `projection:${status}`;
      },
    });
    await expect(h.authority.tick()).rejects.toThrow('injected-projection-crash');
    expect(h.store.load()).toMatchObject({ status: 'active', legacyProjection: { status: 'preparing' } });
    expect(compatibility).toBe('preparing');
    rejectActive = false;
    const retried = await h.authority.tick();
    expect(retried).toMatchObject({ status: 'active', legacyProjection: { status: 'active' } });
    expect(compatibility).toBe('active');
  });

  it('revokes compatibility before committing at-risk when projection throws', async () => {
    let compatibility = 'preparing';
    let rejectDemotion = false;
    const h = harness({
      dryRun: false,
      projectStatus: status => {
        compatibility = status;
        if (status === 'at-risk' && rejectDemotion) throw new Error('injected-demotion-crash');
        return `projection:${status}`;
      },
    });
    await h.authority.tick();
    expect(compatibility).toBe('active');
    rejectDemotion = true;
    h.mutateSample(s => { s.deliveryReachable = false; });
    await expect(h.authority.tick()).rejects.toThrow('injected-demotion-crash');
    expect(compatibility).toBe('at-risk');
    expect(h.store.load()?.status).toBe('active');
  });

  it('keeps dry-run shadow evaluation from projecting any compatibility status', async () => {
    const projections: string[] = [];
    const h = harness({ dryRun: true, projectStatus: status => { projections.push(status); return status; } });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.deliveryReachable = false; });
    expect((await h.authority.tick())?.status).toBe('at-risk');
    expect(projections).toEqual([]);
  });

  it('fails and freezes no later than the bounded recovery ceiling', async () => {
    const h = harness({ dryRun: true });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.work = null; });
    expect((await h.authority.tick())?.status).toBe('at-risk');
    h.advance(15 * 60_000);
    const failed = await h.authority.tick();
    expect(failed?.status).toBe('failed');
    expect(failed?.finalSnapshot?.reason).toBe('recovery-ceiling-exceeded');
  });

  it('rejects regressive work receipts and expires at the server-supplied ceiling', async () => {
    const h = harness({ dryRun: true });
    expect((await h.authority.tick())?.status).toBe('active');
    h.mutateSample(s => { s.work = { ...s.work!, sequence: 0, receiptId: 'rollback' }; });
    expect((await h.authority.tick())?.predicates['durable-work-advanced'].ok).toBe(false);

    const other = harness();
    other.mutateSample(s => { s.lifecycle.expiresAt = new Date(BASE).toISOString(); });
    const expired = await other.authority.tick();
    expect(expired?.status).toBe('failed');
    expect(expired?.finalSnapshot?.reason).toBe('window-expired');
  });

  it('mints sequence, timestamp, digest attribution server-side and rejects unchanged artifacts', async () => {
    const h = harness();
    const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' };
    await h.authority.tick();
    await expect(h.authority.recordWorkAdvance({ ...binding, artifactRef: 'src/a.ts' })).rejects.toThrow('window-run-liveness-artifact-unchanged');
    const receipt = await h.authority.recordWorkAdvance({ ...binding, artifactRef: 'src/b.ts' });
    expect(receipt).toMatchObject({ sequence: 2, observedAt: new Date(BASE).toISOString(), digest: 'b'.repeat(64), artifact: 'src/b.ts', taskRef: 'task-7' });
    expect(receipt.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(h.store.load()?.lastWorkReceipt).toEqual(receipt);
  });

  it('refuses work receipts for a mismatched run binding', async () => {
    const h = harness();
    await expect(h.authority.recordWorkAdvance({
      windowId: 'w32', topicId: 36966, autonomousRunId: 'another-run', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966', artifactRef: 'src/b.ts',
    })).rejects.toThrow('window-run-liveness-binding-mismatch');
  });

  it('freezes an immutable final snapshot for Lane C composition', async () => {
    const h = harness();
    await h.authority.tick();
    const frozen = h.authority.freeze('close-receipts-passed');
    const second = h.authority.freeze('different-reason');
    expect(frozen.status).toBe('closed');
    expect(second.finalSnapshot).toEqual(frozen.finalSnapshot);
    expect(second.transitions).toEqual(frozen.transitions);
  });

  it('freezes deterministic adversarial exit proof from the hash-chained sample and receipt audit', async () => {
    const h = harness();
    await h.authority.tick();
    const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' };
    const receipts = [];
    for (const artifact of ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']) {
      receipts.push(await h.authority.recordWorkAdvance({ ...binding, artifactRef: artifact }));
      if (artifact !== 'src/e.ts') h.advance(30 * 60_000);
    }
    h.mutateSample(s => {
      s.work = receipts.at(-1)!;
      s.executor.heartbeatAt = new Date(BASE + 90 * 60_000).toISOString();
      s.executor.running = false;
    });
    expect((await h.authority.tick())?.status).toBe('active');
    const frozen = h.authority.freeze('adversarial-exit-complete');
    expect(frozen.finalSnapshot?.exitProof).toMatchObject({
      workReceiptCount: 4,
      advancingThirtyMinuteIntervals: 3,
      threeCadenceIntervalsPassed: true,
      inducedLossObserved: true,
      recoveryAttempts: 1,
      recoveryTaskMatched: true,
      falseActiveSamples: 0,
    });
    expect(frozen.finalSnapshot?.exitProof.auditHeadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists the at-risk/recovery cardinality across a process restart', async () => {
    const h = harness({ dryRun: true });
    await h.authority.tick();
    h.mutateSample(s => { s.executor.running = false; });
    const atRisk = await h.authority.tick();
    const restarted = new WindowRunLivenessAuthority(h.store, { sample: async () => { throw new Error('must not sample terminal test fixture'); } }, { enabled: true });
    expect(restarted.status().state?.recoveryAttempt?.attemptId).toBe(atRisk?.recoveryAttempt?.attemptId);
  });

  it('serializes a concurrent tick and work receipt so the tick cannot overwrite advancement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-run-concurrent-'));
    const store = new WindowRunLivenessStore(dir);
    let sampleEntered!: () => void;
    const entered = new Promise<void>(resolve => { sampleEntered = resolve; });
    let releaseSample!: () => void;
    const released = new Promise<void>(resolve => { releaseSample = resolve; });
    const authority = new WindowRunLivenessAuthority(store, {
      now: () => new Date(BASE).toISOString(),
      sample: async state => {
        sampleEntered();
        await released;
        return {
          sampledAt: new Date(BASE).toISOString(), executor: { id: state.executorId, running: true, heartbeatAt: new Date(BASE).toISOString() }, deliveryReachable: true,
          work: state.lastWorkReceipt ?? null,
          lifecycle: { lifecycleRunId: state.lifecycleRunId, state: 'active_start', admitted: true, expiresAt: new Date(BASE + 60_000).toISOString() },
        };
      },
      verifyWorkArtifact: () => ({ artifact: 'artifact.txt', digest: 'c'.repeat(64), taskRef: 'task-1' }),
    }, { enabled: true, dryRun: true });
    const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-concurrent', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' };
    authority.register(binding);
    const tick = authority.tick();
    await entered;
    const work = authority.recordWorkAdvance({ ...binding, artifactRef: 'artifact.txt' });
    releaseSample();
    await Promise.all([tick, work]);
    expect(store.load()?.lastWorkReceipt).toMatchObject({ sequence: 1, digest: 'c'.repeat(64) });
    const restarted = new WindowRunLivenessAuthority(store, { sample: async () => { throw new Error('unused'); } }, { enabled: true });
    expect(restarted.status().state?.lastWorkReceipt?.digest).toBe('c'.repeat(64));
  });
});
