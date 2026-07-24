import { describe, expect, it } from 'vitest';
import type { IntelligenceProvider } from '../../../src/core/types.js';
import { FeedbackReadinessArbiter } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import type { AuthorityRecord } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';

const authority: AuthorityRecord = {
  authorityId: 'dev-readiness', agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 3,
  provider: 'claude-code', modelFamily: 'fable-5', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
  decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 900,
  maxDailySpendUsd: 5, generation: 1, revoked: false,
};
const candidate = {
  clusterId: 'cluster-1', title: 'Repeated scheduler crash', type: 'bug', reportCount: 4,
  firstSeenAt: 1, lastSeenAt: 2, evidenceIds: ['feedback:1', 'feedback:2'],
};

function provider(response: unknown, model = 'claude-fable-5'): IntelligenceProvider {
  return {
    evaluate: async (_prompt, options) => {
      options?.onModel?.({ model, framework: 'claude-code' });
      return typeof response === 'string' ? response : JSON.stringify(response);
    },
  };
}

describe('FeedbackReadinessArbiter', () => {
  it('authorizes a bounded high-confidence ready decision', async () => {
    const arbiter = new FeedbackReadinessArbiter(provider({ decisions: [{
      clusterId: 'cluster-1', outcome: 'ready', confidence: 0.92,
      reasonCodes: ['coherent-recurrence'], evidenceIds: ['feedback:1'],
    }] }));
    const [decision] = await arbiter.decideBatch(authority, [candidate]);
    expect(decision.outcome).toBe('ready');
    expect(decision.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('conservatively keeps low-confidence ready decisions collecting', async () => {
    const arbiter = new FeedbackReadinessArbiter(provider({ decisions: [{
      clusterId: 'cluster-1', outcome: 'ready', confidence: 0.4,
      reasonCodes: ['weak-evidence'], evidenceIds: ['feedback:1'],
    }] }));
    const [decision] = await arbiter.decideBatch(authority, [candidate]);
    expect(decision.outcome).toBe('collecting');
  });

  it('routes genuinely ambiguous evidence to optional human escalation without making it the normal path', async () => {
    const arbiter = new FeedbackReadinessArbiter(provider({ decisions: [{
      clusterId: 'cluster-1', outcome: 'escalate-human', confidence: 0.88,
      reasonCodes: ['evidence-ambiguous'], evidenceIds: ['feedback:1', 'feedback:2'],
    }] }));
    expect((await arbiter.decideBatch(authority, [candidate]))[0]).toMatchObject({ outcome: 'escalate-human' });
  });

  it('escalates suspected injection without invoking the model', async () => {
    let called = false;
    const arbiter = new FeedbackReadinessArbiter({ evaluate: async () => { called = true; return ''; } });
    const [decision] = await arbiter.decideBatch(authority, [{ ...candidate, injectionSuspected: true }]);
    expect(called).toBe(false);
    expect(decision.outcome).toBe('escalate-human');
  });

  it('rejects held, changed ids, uncited evidence, and wrong resolved models', async () => {
    await expect(new FeedbackReadinessArbiter(provider({ decisions: [{ ...candidate, outcome: 'held', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] })).decideBatch(authority, [candidate])).rejects.toThrow('forbidden outcome');
    await expect(new FeedbackReadinessArbiter(provider({ decisions: [{ clusterId: 'other', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] })).decideBatch(authority, [candidate])).rejects.toThrow('changed or duplicated');
    await expect(new FeedbackReadinessArbiter(provider({ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['outside'] }] })).decideBatch(authority, [candidate])).rejects.toThrow('outside');
    await expect(new FeedbackReadinessArbiter(provider({ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] }, 'gpt-5.5')).decideBatch(authority, [candidate])).rejects.toThrow('does not match');
  });

  it('fails closed on prompt/schema canary drift before invoking the model', async () => {
    let called = false;
    const arbiter = new FeedbackReadinessArbiter({ evaluate: async () => { called = true; return ''; } });
    await expect(arbiter.decideBatch({ ...authority, schemaVersion: 'drifted' }, [candidate])).rejects.toThrow(/canary/);
    expect(called).toBe(false);
  });
});
