// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobSupervisionStore, supervisionMembershipStatus } from '../../src/scheduler/JobSupervisionStore.js';

describe('JobSupervisionStore', () => {
  let dir: string;
  let store: JobSupervisionStore;
  const t0 = Date.parse('2026-10-28T00:00:00Z');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-'));
    store = new JobSupervisionStore(dir);
  });
  afterEach(() => {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-supervision-store.test.ts' });
  });

  const register = (s: JobSupervisionStore, runId = 'run-1') => s.register({
    runId, fireId: 'fire-1', slug: 'health-check', machineId: 'm1',
    templateDigest: 'abc', featureStateHash: 'feature-v1', decisionEligible: true,
    evidencePolicy: 'structured-v1', now: t0,
  });
  const begin = (s: JobSupervisionStore, attemptId: string, now: number, provider: 'jev' | 'replacement' = 'jev') =>
    s.beginCall({ attemptId, provider, decisionPoint: 'job-result-session-v2',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'evidence-v1',
      intendedModel: provider === 'jev' ? 'jev-1.13.0' : 'haiku', leaseMs: 1000, now });

  it('registers before execution and never overwrites a conflicting completion', () => {
    const id = register(store);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(store.get(id)?.status).toBe('pending');
    expect(store.get(id)?.featureStateHash).toBe('feature-v1');
    expect(store.get(id)?.completedAt).toBeNull();
    expect(begin(store, id, t0 + 1)).toBeNull();
    store.recordResult(id, { result: 'success', completedAt: new Date(t0 + 10).toISOString(), evidenceHash: 'evidence-v1' });
    expect(store.get(id)?.result).toBe('success');
    expect(() => store.recordResult(id, { result: 'failure', evidenceHash: 'evidence-v2' })).toThrow(/conflicting result/);
  });

  it('never promotes a dark-era result into a model call after the rollout changes', () => {
    const id = store.register({ runId: 'dark-run', fireId: 'dark-fire', slug: 'health-check',
      decisionEligible: false, evidencePolicy: 'structured-v1', now: t0 });
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(),
      evidenceHash: crypto.createHash('sha256').update('verified sample').digest('hex'), evidenceText: 'verified sample' });
    expect(store.get(id)?.decisionEligible).toBe(false);
    expect(store.claimable(t0 + 1)).toHaveLength(0);
    expect(begin(store, id, t0 + 1)).toBeNull();
    store.close();
    store = new JobSupervisionStore(dir);
    expect(store.claimable(t0 + 2)).toHaveLength(0);
    expect(begin(store, id, t0 + 2)).toBeNull();
  });

  it('keeps missing pool machines in the expected roster until explicit revocation', () => {
    const self = 'm_aaaaaaaaaaaaaaaa';
    const peer = 'm_bbbbbbbbbbbbbbbb';
    store.observeMachineMembership([{ machineId: 'm_cccccccccccccccc', status: 'pending' }], t0);
    expect(store.expectedMachineIds()).toEqual([]);
    store.observeMachineMembership([{ machineId: self, status: 'active' },
      { machineId: peer, status: 'active' }], t0);
    expect(store.expectedMachineIds()).toEqual([self, peer]);
    store.close();
    store = new JobSupervisionStore(dir);
    store.observeMachineMembership([{ machineId: self, status: 'active' }], t0 + 7 * 24 * 60 * 60_000);
    expect(store.expectedMachineIds()).toEqual([self, peer]);
    store.observeMachineMembership([{ machineId: peer, status: 'revoked' }], t0 + 8 * 24 * 60 * 60_000);
    expect(store.expectedMachineIds()).toEqual([self]);
    expect(() => store.observeMachineMembership([{ machineId: self, status: 'active' },
      { machineId: 'bad-id', status: 'active' }])).toThrow(/invalid supervision machine id/);
    expect(store.expectedMachineIds()).toEqual([self]);
  });

  it('rejects malformed registry membership instead of retiring a peer', () => {
    expect(supervisionMembershipStatus({ status: 'active' })).toBe('active');
    expect(supervisionMembershipStatus({ status: 'active', revokedAt: '2026-10-28T00:00:00Z' })).toBe('revoked');
    expect(supervisionMembershipStatus({ status: 'revoked' })).toBe('revoked');
    expect(supervisionMembershipStatus({ status: 'pending' })).toBe('pending');
    expect(() => supervisionMembershipStatus({ status: 'unavailable' })).toThrow(/invalid supervision registry status/);
    expect(() => supervisionMembershipStatus({ status: 'active', revokedAt: 'bad' })).toThrow(/invalid supervision registry revocation/);
  });

  it('commits pre-call audit before egress and fences a late Jev response after replacement', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    const first = begin(store, id, t0 + 1);
    expect(first?.epoch).toBe(1);
    expect(store.callRows(id)).toHaveLength(1);
    expect(begin(store, id, t0 + 2)).toBeNull();
    store.expireLeases(t0 + 1002);
    const second = begin(store, id, t0 + 1003, 'replacement');
    expect(second?.epoch).toBe(2);
    expect(store.callRows(id)).toHaveLength(2);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api', actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 1500, now: t0 + 1503 })).toBe('late');
    expect(store.get(id)?.status).toBe('pending');
    expect(store.settleCall({ attemptId: id, epoch: 2, actualProvider: 'anthropic', actualModel: 'haiku', verdict: 'needs-session', latencyMs: 800, now: t0 + 1803 })).toBe('settled');
    expect(store.get(id)?.status).toBe('unresolved');
    expect(store.get(id)?.provider).toBe('replacement');
    expect(store.settleCall({ attemptId: id, epoch: 2, actualProvider: 'anthropic', actualModel: 'haiku',
      verdict: 'routine', latencyMs: 999, now: t0 + 2000 })).toBe('late');
    expect(store.callRows(id)[1].verdict).toBe('needs-session');
    expect(store.lateSettlements(id)).toHaveLength(1);
  });

  it('never retries untrusted evidence or outcome-unknown attempts', () => {
    const id = register(store);
    store.recordResult(id, { result: 'failure', completedAt: new Date(t0).toISOString(), reason: 'script-untrusted', evidenceHash: 'evidence-v1' });
    store.markUnchecked(id, 'script-untrusted', t0 + 1);
    expect(begin(store, id, t0 + 2)).toBeNull();
    expect(store.expireRetries(t0 + 24 * 60 * 60_000 + 1)).toBe(1);
    expect(store.get(id)?.status).toBe('expired-unchecked');
    expect(store.get(id)?.reason).toBe('script-untrusted');
    const unknown = register(store, 'run-2');
    store.markUnchecked(unknown, 'outcome-unknown', t0 + 1);
    expect(begin(store, unknown, t0 + 2)).toBeNull();
  });

  it('recovers a timed-out call from the durable journal after restart', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    expect(begin(store, id, t0 + 1)?.epoch).toBe(1);
    store.close();
    store = new JobSupervisionStore(dir);
    expect(store.callRows(id)).toHaveLength(1);
    expect(store.expireLeases(t0 + 1002)).toBe(1);
    expect(store.get(id)?.status).toBe('unchecked');
    expect(begin(store, id, t0 + 1003)).toBeNull();
    expect(begin(store, id, t0 + 21_003)?.epoch).toBe(2);
  });

  it('rejects an answer after its lease expires even before the reaper runs', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    expect(begin(store, id, t0 + 1)?.epoch).toBe(1);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 1001, now: t0 + 1002 })).toBe('late');
    expect(store.get(id)).toMatchObject({ status: 'pending', verdict: null });
    expect(store.callRows(id)[0]).toMatchObject({ settlement: 'late', verdict: 'routine' });
    expect(store.expireLeases(t0 + 1002)).toBe(1);
    expect(store.get(id)?.status).toBe('unchecked');
  });

  it('cannot close a status-only result as routine on model confidence alone', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    expect(store.beginCall({ attemptId: id, provider: 'jev', decisionPoint: 'job-result-session-v2',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'different',
      intendedModel: 'jev-1.13.0', leaseMs: 1000, now: t0 + 1 })).toBeNull();
    const call = begin(store, id, t0 + 2);
    expect(call?.epoch).toBe(1);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 10, now: t0 + 12 })).toBe('settled');
    expect(store.get(id)).toMatchObject({ status: 'unresolved', reason: 'evidence-insufficient', investigation: 'requested' });
  });

  it('reports failed and settled model calls with explicit unknown cost and outcome', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1', evidenceSufficient: true });
    expect(begin(store, id, t0 + 1)?.epoch).toBe(1);
    expect(store.failCall(id, 1, 'provider-error', t0 + 2)).toBe(true);
    expect(begin(store, id, t0 + 20_003, 'replacement')?.epoch).toBe(2);
    expect(store.settleCall({ attemptId: id, epoch: 2, actualProvider: 'anthropic', actualModel: 'haiku',
      verdict: 'routine', latencyMs: 25, tokensIn: 20, tokensOut: 3, costUsd: 0.001,
      now: t0 + 20_028 })).toBe('settled');
    const audit = store.callSummarySince(new Date(t0).toISOString());
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'jev', calls: 1, failed: 1, costUnknown: 1 }),
      expect.objectContaining({ provider: 'replacement', model: 'haiku', calls: 1, settled: 1,
        unknownOutcome: 1, tokensIn: 20, tokensOut: 3, costUsd: 0.001 }),
    ]));
  });

  it('reserves replacement calls and input tokens atomically before provider egress', () => {
    const budget = { maxCalls: 2, maxInputTokens: 30, reserveInputTokens: 20 };
    const add = (runId: string) => {
      const id = register(store, runId);
      store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
      return id;
    };
    const a = add('budget-a');
    const b = add('budget-b');
    const input = (attemptId: string) => ({ attemptId, provider: 'replacement' as const,
      decisionPoint: 'job-result-supervision-v2', promptHash: 'prompt-v1',
      evidencePolicyHash: 'policy-v1', evidenceHash: 'evidence-v1',
      intendedModel: 'gpt-6-luna', leaseMs: 1000, dailyBudget: budget, now: t0 + 1 });
    expect(store.beginCall(input(a))?.epoch).toBe(1);
    expect(store.replacementBudgetSince(new Date(t0).toISOString()))
      .toEqual({ calls: 1, inputTokens: 20 });
    expect(store.beginCall(input(b))).toBeNull();
    expect(store.callRows(b)).toHaveLength(0);
    expect(store.settleCall({ attemptId: a, epoch: 1, actualProvider: 'codex-cli',
      actualModel: 'gpt-6-luna', verdict: 'routine', latencyMs: 1,
      tokensIn: 25, now: t0 + 2 })).toBe('settled');
    expect(store.replacementBudgetSince(new Date(t0).toISOString()))
      .toEqual({ calls: 1, inputTokens: 25 });
    expect(store.beginCall(input(b))).toBeNull();
  });

  it('keeps a budget-refused result eligible when Jev returns', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    store.markUnchecked(id, 'replacement-budget-exhausted', t0 + 1);
    expect(store.get(id)?.nextRetryAt).toBe(t0 + 1 + 10 * 60_000);
    expect(store.claimable(t0 + 2)).toHaveLength(0);
    expect(store.claimable(t0 + 1 + 10 * 60_000).map(r => r.attemptId)).toContain(id);
    expect(begin(store, id, t0 + 1 + 10 * 60_000)?.epoch).toBe(1);
  });

  it('backs off repeated no-key checks across restarts instead of polling every ten seconds forever', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    store.markUnchecked(id, 'provider-unavailable', t0 + 1);
    expect(store.get(id)).toMatchObject({ retryCount: 1, nextRetryAt: t0 + 10_001 });
    store.close();
    store = new JobSupervisionStore(dir);
    store.markUnchecked(id, 'provider-unavailable', t0 + 10_001);
    expect(store.get(id)).toMatchObject({ retryCount: 2, nextRetryAt: t0 + 30_001 });
  });

  it('reconciles missing completed rows without treating them as reviewed', () => {
    const run = { runId: 'missing-run', slug: 'health-check', sessionId: 'script-x', trigger: 'scheduled',
      startedAt: new Date(t0).toISOString(), completedAt: new Date(t0 + 100).toISOString(),
      result: 'success' as const, runner: 'script' as const };
    expect(store.reconcileHistory([run], t0 + 200).inserted).toBe(1);
    expect(store.findByRunId(run.runId)).toMatchObject({ status: 'unchecked', reason: 'missing-record' });
    expect(store.reconcileHistory([run], t0 + 300).inserted).toBe(0);
  });

  it('recovers an abandoned pending run immediately when its process no longer owns it', () => {
    const run = { runId: 'abandoned-run', slug: 'health-check', sessionId: 'script-x', trigger: 'scheduled',
      startedAt: new Date(t0).toISOString(), result: 'pending' as const, runner: 'script' as const };
    expect(store.reconcileHistory([run], t0 + 100, () => true).inserted).toBe(0);
    expect(store.reconcileHistory([run], t0 + 101, () => false).inserted).toBe(1);
    expect(store.findByRunId(run.runId)).toMatchObject({ status: 'unchecked', reason: 'outcome-unknown' });
  });

  it('retains the independent census boundary if the SQLite journal is lost', () => {
    const baseline = store.censusBaselineAt();
    store.close();
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'ledger', 'job-supervision.db'),
      { operation: 'tests/unit/job-supervision-store.test.ts' });
    store = new JobSupervisionStore(dir);
    expect(store.censusBaselineAt()).toBe(baseline);
    expect(store.expectedMachineIds()).toBeNull();
    store.close();
    store = new JobSupervisionStore(dir);
    expect(store.journalWasRecreated()).toBe(true);
    expect(store.expectedMachineIds()).toBeNull();
  });

  it('retains independent outcome links and never lets a later correct grade hide a miss', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1', evidenceSufficient: true });
    expect(begin(store, id, t0 + 1)?.epoch).toBe(1);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 1, now: t0 + 2 })).toBe('settled');
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'probe-1', ruleId: 'independent-health-v1',
      gradedBy: 'health-monitor', grade: 'incorrect', now: t0 + 2 })).toBe(true);
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'probe-2', ruleId: 'independent-health-v1',
      gradedBy: 'health-monitor', grade: 'correct', now: t0 + 3 })).toBe(true);
    expect(store.get(id)?.grade).toBe('incorrect');
    expect(store.outcomeGrades(id)).toHaveLength(2);
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'probe-1', ruleId: 'independent-health-v1',
      gradedBy: 'health-monitor', grade: 'correct', now: t0 + 4 })).toBe(false);
  });

  it('grades an unnecessary needs-session verdict while its investigation remains open', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(), evidenceHash: 'evidence-v1' });
    expect(begin(store, id, t0 + 1)?.epoch).toBe(1);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'needs-session', latencyMs: 5, now: t0 + 6 })).toBe('settled');
    expect(store.get(id)).toMatchObject({ status: 'unresolved', investigation: 'requested' });
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'independent-probe-1',
      ruleId: 'health-v1', gradedBy: 'health-monitor', grade: 'incorrect', now: t0 + 7 })).toBe(true);
    expect(store.get(id)).toMatchObject({ status: 'unresolved', grade: 'incorrect' });
    expect(store.callRows(id)[0].outcome_evidence_id).toBe('independent-probe-1');
  });

  it('links a model call to its later independent outcome grade', () => {
    const id = register(store);
    store.recordResult(id, { result: 'success', completedAt: new Date(t0).toISOString(),
      evidenceHash: 'evidence-v1', evidenceSufficient: true });
    const call = begin(store, id, t0 + 1);
    expect(call?.epoch).toBe(1);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 10, now: t0 + 11 })).toBe('settled');
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'independent-probe-1',
      ruleId: 'health-proof-v1', gradedBy: 'health-monitor', grade: 'correct', now: t0 + 12 })).toBe(true);
    expect(store.callRows(id)[0].outcome_evidence_id).toBe('independent-probe-1');
  });

  it('keeps a contract-violation hold across a process restart', () => {
    store.holdSlug('health-check', 'parser-integrity', t0);
    store.close();
    store = new JobSupervisionStore(dir);
    expect(store.heldSlugs()).toEqual([{ slug: 'health-check', reason: 'parser-integrity',
      heldAt: new Date(t0).toISOString() }]);
  });
});
