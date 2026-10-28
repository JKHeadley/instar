// safe-fs-allow: temporary fixture cleanup uses SafeFsExecutor.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';
import { JobSupervisionWorker, parseJevSupervisionVerdict } from '../../src/scheduler/JobSupervisionWorker.js';
import { jobSupervisionRolloutState } from '../../src/scheduler/JobSupervisionRollout.js';

const t0 = Date.parse('2026-10-28T00:00:00Z');
const evidence = 'job: health-check\nresult: success\nreasonCode: ok';
const evidenceHash = crypto.createHash('sha256').update(evidence).digest('hex');

describe('JobSupervisionWorker', () => {
  let dir: string;
  let store: JobSupervisionStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-worker-'));
    store = new JobSupervisionStore(dir);
  });
  afterEach(() => {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-supervision-worker.test.ts' });
  });

  const add = (s: JobSupervisionStore, runId: string, sufficient = false) => {
    const id = s.register({ runId, fireId: `fire:${runId}`, slug: 'health-check',
      decisionEligible: true, evidencePolicy: 'job-result-structured-v2', now: t0 });
    s.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(),
      evidenceHash, evidenceText: evidence, evidenceSufficient: sufficient });
    return id;
  };

  it('requires both audit readiness and a new decision for each repeated result', async () => {
    const a = add(store, 'r1', true);
    const b = add(store, 'r2', true);
    const fetchImpl = vi.fn(async () => Response.json({ model: 'jev-1.13.0',
      answers: { triage: { choice: 'routine', probabilities: { needs_session: 0.01 } },
        triage_rev: { choice: 'routine', probabilities: { needs_session: 0.01 } } } })) as unknown as typeof fetch;
    const dark = new JobSupervisionWorker({ store, readJevKey: () => 'key', auditReady: () => false,
      fetchImpl, now: () => t0 + 1000 });
    expect(await dark.drain()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const live = new JobSupervisionWorker({ store, readJevKey: () => 'key', auditReady: () => true,
      fetchImpl, now: () => t0 + 1000 });
    expect(await live.drain()).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.get(a)?.status).toBe('resolved');
    expect(store.get(b)?.status).toBe('resolved');
    expect(store.callRows(a)[0]).toMatchObject({ provider: 'jev', settlement: 'current' });
  });

  it('grades a routine grading-job verdict only with an independent idle effect proof', async () => {
    const response = (async () => Response.json({ model: 'jev-1.13.0',
      answers: { triage: { choice: 'routine', probabilities: { needs_session: 0.01 } },
        triage_rev: { choice: 'routine', probabilities: { needs_session: 0.01 } } } })) as typeof fetch;
    const run = (runId: string, proof?: string) => {
      const token = 'a'.repeat(64);
      const id = store.register({ runId, fireId: `fire:${runId}`, slug: 'llm-decision-grading',
        decisionEligible: true, evidencePolicy: 'job-result-structured-v2', now: t0,
        receiptTokenHash: crypto.createHash('sha256').update(token).digest('hex') });
      expect(store.recordGradePassReceipt(runId, token, 0, 6, t0, proof)).toBe(true);
      store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(),
        evidenceHash, evidenceText: evidence, evidenceSufficient: true });
      return id;
    };
    const proven = run('proven', 'b'.repeat(64));
    const unproven = run('unproven');
    const worker = new JobSupervisionWorker({ store, readJevKey: () => 'key', auditReady: () => true,
      fetchImpl: response, now: () => t0 + 1000 });
    expect(await worker.drain()).toBe(2);
    expect(store.get(proven)).toMatchObject({ status: 'resolved', grade: 'correct' });
    expect(store.callRows(proven)[0].outcome_evidence_id).toBe(`grade-pass-idle-v1:${'b'.repeat(64)}`);
    expect(store.get(unproven)).toMatchObject({ status: 'resolved', grade: 'unknown' });
    expect(store.callRows(unproven)[0].outcome_evidence_id).toBeNull();
  });

  it('keeps an uncertified bare OK unresolved even when Jev says routine', async () => {
    const id = add(store, 'r1');
    const attention = vi.fn();
    const worker = new JobSupervisionWorker({ store, readJevKey: () => 'key', auditReady: () => true,
      fetchImpl: (async () => Response.json({ model: 'jev-1.13.0',
        answers: { triage: { choice: 'routine', probabilities: { needs_session: 0.01 } },
          triage_rev: { choice: 'routine', probabilities: { needs_session: 0.01 } } } })) as typeof fetch,
      now: () => t0 + 1000, onAttention: attention });
    expect(await worker.drain()).toBe(1);
    expect(store.get(id)).toMatchObject({ status: 'unresolved', reason: 'evidence-insufficient', investigation: 'blocked' });
    expect(attention).toHaveBeenCalledWith(id, 'investigation-unavailable');
  });

  it('uses the benchmarked replacement only when Jev is unavailable', async () => {
    const id = add(store, 'r1', true);
    const call = vi.fn(async () => ({ verdict: 'routine' as const, actualModel: 'haiku', actualProvider: 'anthropic', tokensIn: 20 }));
    const worker = new JobSupervisionWorker({ store, readJevKey: () => null, auditReady: () => true,
      replacement: () => ({ model: 'haiku', provider: 'anthropic', benchmarkReady: true, call }),
      now: () => t0 + 1000 });
    expect(await worker.drain()).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(store.get(id)).toMatchObject({ status: 'resolved', provider: 'replacement' });
    expect(store.callRows(id)).toHaveLength(1);
    expect(store.callRows(id)[0]).toMatchObject({ intended_model: 'haiku', actual_model: 'haiku' });
  });

  it('leaves no-key one-provider results visibly unchecked without an unbenchmarked call', async () => {
    const id = add(store, 'r1');
    const call = vi.fn();
    const worker = new JobSupervisionWorker({ store, readJevKey: () => null, auditReady: () => true,
      replacement: () => ({ model: 'haiku', provider: 'anthropic', benchmarkReady: false, call }),
      now: () => t0 + 1000 });
    expect(await worker.drain()).toBe(1);
    expect(call).not.toHaveBeenCalled();
    expect(store.get(id)).toMatchObject({ status: 'unchecked', reason: 'provider-unavailable' });
    expect(await worker.drain()).toBe(0);
  });

  it('refuses a replacement after the input-token ceiling while keeping the result open', async () => {
    for (let i = 0; i < 10; i++) {
      const prior = add(store, `prior-${i}`, true);
      const audit = store.beginCall({ attemptId: prior, provider: 'replacement',
        decisionPoint: 'job-result-supervision-v2', promptHash: 'prompt-v1',
        evidencePolicyHash: 'policy-v1', evidenceHash, intendedModel: 'gpt-6-luna',
        leaseMs: 1000, now: t0 + 1 });
      expect(audit).not.toBeNull();
      store.settleCall({ attemptId: prior, epoch: audit!.epoch, actualProvider: 'codex-cli',
        actualModel: 'gpt-6-luna', verdict: 'routine', latencyMs: 1,
        tokensIn: 25_000, now: t0 + 2 });
    }
    const id = add(store, 'over-budget', true);
    const call = vi.fn();
    const attention = vi.fn();
    const worker = new JobSupervisionWorker({ store, readJevKey: () => null, auditReady: () => true,
      replacement: () => ({ model: 'gpt-6-luna', provider: 'codex-cli', benchmarkReady: true, call }),
      onAttention: attention, now: () => t0 + 1000 });
    expect(await worker.drain()).toBe(1);
    expect(call).not.toHaveBeenCalled();
    expect(store.get(id)).toMatchObject({ status: 'unchecked', reason: 'replacement-budget-exhausted' });
    expect(attention).toHaveBeenCalledWith(id, 'replacement-budget-exhausted');
  });
});

describe('Jev result parsing', () => {
  it('asks for investigation on uncertainty, missing order or contradictory labels', () => {
    expect(parseJevSupervisionVerdict({ answers: {
      triage: { choice: 'routine', probabilities: { needs_session: 0.5 } },
      triage_rev: { choice: 'routine', probabilities: { needs_session: 0.5 } },
    } })).toBe('cannot-tell');
    expect(parseJevSupervisionVerdict({ answers: {
      triage: { choice: 'routine', probabilities: { needs_session: 0.01 } },
      triage_rev: { choice: 'needs_session', probabilities: { needs_session: 0.99 } },
    } })).toBe('cannot-tell');
    expect(parseJevSupervisionVerdict({ answers: {
      triage: { choice: 'routine', probabilities: { needs_session: 0.01 } },
    } })).toBe('cannot-tell');
  });
});

it('a saved development-agent setting cannot open the code-owned rollout gate', () => {
  expect(jobSupervisionRolloutState({ developmentAgent: true })).toEqual({ auditReady: false, cohort: 'off', active: false });
  expect(jobSupervisionRolloutState({ throwawayAgent: true })).toEqual({ auditReady: false, cohort: 'off', active: false });
});
