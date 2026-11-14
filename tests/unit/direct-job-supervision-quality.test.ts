// safe-fs-allow: the test removes only its own temporary state directory.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';
import { buildDirectJobSupervisionQuality } from '../../src/server/directJobSupervisionQuality.js';

describe('direct job-supervision quality bridge', () => {
  const dirs: string[] = [];
  const stores: JobSupervisionStore[] = [];
  const fixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-job-quality-'));
    dirs.push(dir);
    const store = new JobSupervisionStore(dir);
    stores.push(store);
    return { store, history: new JobRunHistory(dir) };
  };
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true,
      operation: 'tests/unit/direct-job-supervision-quality.test.ts' });
  });

  it('keeps a missing journal row in the denominator and suppresses accuracy', () => {
    const { store, history } = fixture();
    history.recordStart({ slug: 'health-check', sessionId: 'script', trigger: 'scheduled', runner: 'script' });
    const view = buildDirectJobSupervisionQuality({ store, history, sinceHours: 24 });
    expect(view).toMatchObject({ source: 'job-supervision-store', routerEnrollment: 'pending',
      denominator: 1, missingRecords: 1, coverageIncomplete: true, accuracy: null });
    expect(view.gradeDistribution).toEqual({ correct: 0, incorrect: 0, unknown: 1 });
  });

  it('links each call to its attempt and exposes no raw evidence or receipt token', () => {
    const { store, history } = fixture();
    const runId = history.recordStart({ slug: 'health-check', sessionId: 'script', trigger: 'scheduled', runner: 'script' });
    const id = store.register({ runId, fireId: 'fire-1', slug: 'health-check', decisionEligible: true,
      evidencePolicy: 'structured-v1', receiptTokenHash: 'a'.repeat(64), now: Date.now() });
    const evidenceHash = crypto.createHash('sha256').update('PRIVATE-SCRIPT-OUTPUT').digest('hex');
    store.recordResult(id, { result: 'success', completedAt: new Date().toISOString(),
      evidenceHash, evidenceText: 'PRIVATE-SCRIPT-OUTPUT', evidenceSufficient: true });
    const call = store.beginCall({ attemptId: id, provider: 'jev', decisionPoint: 'job-result-supervision-v2',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash,
      intendedModel: 'jev-1.13.0', leaseMs: 1000 });
    expect(call?.epoch).toBe(1);
    const view = buildDirectJobSupervisionQuality({ store, history, sinceHours: 24 });
    expect(view).toMatchObject({ denominator: 1, missingRecords: 0, callCount: 1,
      costUnknownCalls: 1, accuracy: null });
    expect(view.callDetails).toEqual([expect.objectContaining({ attemptId: id, epoch: 1,
      runId, provider: 'jev', promptHash: 'prompt-v1', actualModel: null, grade: 'unknown' })]);
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE-SCRIPT-OUTPUT|a{64}/);
    expect(store.settleCall({ attemptId: id, epoch: 1, actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', latencyMs: 15, tokensIn: 12, tokensOut: 2,
      costUsd: 0.001 })).toBe('settled');
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'independent-probe-1',
      ruleId: 'health-proof-v1', gradedBy: 'health-monitor', grade: 'incorrect' })).toBe(true);
    const graded = buildDirectJobSupervisionQuality({ store, history, sinceHours: 24 });
    expect(graded).toMatchObject({ accuracy: 0, gradableFraction: 1,
      gradeDistribution: { correct: 0, incorrect: 1, unknown: 0 } });
    expect(graded.callDetails).toEqual([expect.objectContaining({ actualProvider: 'typesafe-api',
      actualModel: 'jev-1.13.0', verdict: 'routine', grade: 'incorrect', outcomeEvidenceLinked: true })]);
  });

  it('leaves a failed Jev call ungraded when a replacement call later receives the grade', () => {
    const { store, history } = fixture();
    const base = Date.now();
    const runId = history.recordStart({ slug: 'health-check', sessionId: 'script', trigger: 'scheduled', runner: 'script' });
    const id = store.register({ runId, fireId: 'fire-2', slug: 'health-check', decisionEligible: true,
      evidencePolicy: 'structured-v1', now: base });
    store.recordResult(id, { result: 'success', completedAt: new Date(base).toISOString(),
      evidenceHash: 'hash', evidenceSufficient: true });
    const first = store.beginCall({ attemptId: id, provider: 'jev', decisionPoint: 'job-result-supervision-v2',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'hash',
      intendedModel: 'jev-1.13.0', leaseMs: 1000, now: base + 1 });
    expect(first?.epoch).toBe(1);
    expect(store.failCall(id, 1, 'provider-error', base + 2)).toBe(true);
    const second = store.beginCall({ attemptId: id, provider: 'replacement', decisionPoint: 'job-result-supervision-v2',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'hash',
      intendedModel: 'haiku', leaseMs: 1000, now: base + 20_003 });
    expect(second?.epoch).toBe(2);
    expect(store.settleCall({ attemptId: id, epoch: 2, actualProvider: 'anthropic', actualModel: 'haiku',
      verdict: 'routine', latencyMs: 10, now: base + 20_013 })).toBe('settled');
    expect(store.gradeOutcome({ attemptId: id, evidenceId: 'independent-probe-2', ruleId: 'health-v1',
      gradedBy: 'health-monitor', grade: 'incorrect', now: base + 20_014 })).toBe(true);
    const view = buildDirectJobSupervisionQuality({ store, history, sinceHours: 24, now: base + 20_014 });
    expect(view.callDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ epoch: 1, settlement: 'failed', grade: 'unknown', outcomeEvidenceLinked: false }),
      expect.objectContaining({ epoch: 2, settlement: 'current', grade: 'incorrect', outcomeEvidenceLinked: true }),
    ]));
    expect(view.callCount).toBe(2);
  });

  it('flags an unexpected call decision point rather than relabeling it as the expected one', () => {
    const { store, history } = fixture();
    const runId = history.recordStart({ slug: 'health-check', sessionId: 'script', trigger: 'scheduled', runner: 'script' });
    const id = store.register({ runId, fireId: 'fire-3', slug: 'health-check', decisionEligible: true,
      evidencePolicy: 'structured-v1' });
    store.recordResult(id, { result: 'success', completedAt: new Date().toISOString(), evidenceHash: 'hash' });
    expect(store.beginCall({ attemptId: id, provider: 'jev', decisionPoint: 'wrong-point',
      promptHash: 'prompt-v1', evidencePolicyHash: 'policy-v1', evidenceHash: 'hash',
      intendedModel: 'jev-1.13.0', leaseMs: 1000 })).not.toBeNull();
    const view = buildDirectJobSupervisionQuality({ store, history, sinceHours: 24 });
    expect(view).toMatchObject({ expectedDecisionPoint: 'job-result-supervision-v2',
      observedDecisionPoints: ['wrong-point'], unexpectedDecisionPoints: ['wrong-point'],
      coverageIncomplete: true, accuracy: null });
    expect(view.callAudit).toEqual([expect.objectContaining({ decisionPoint: 'wrong-point' })]);
  });
});
