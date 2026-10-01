import { describe, expect, it } from 'vitest';
import type { IntelligenceProvider } from '../../../src/core/types.js';
import { FeedbackReadinessArbiter, FEEDBACK_READINESS_MODEL_TIMEOUT_MS, ReadinessContractViolation } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { CodexExecJsonTimeoutError } from '../../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
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

  // Live 2026-09-30 run 1 (drain run a671f4cc): one benign title tripped the injection
  // pattern and all 50 candidates were escalated without a model call.
  it('escalates only the suspected candidate and sends the rest of the batch to the model', async () => {
    const liveTitle = 'AgentMdReconcile flags execute.type:script user jobs as orphan-manifest';
    const others = Array.from({ length: 3 }, (_, i) => ({ ...candidate, clusterId: `cluster-${i + 2}`, evidenceIds: [`cluster:cluster-${i + 2}`] }));
    let prompt = '';
    const arbiter = new FeedbackReadinessArbiter({
      evaluate: async (p, options) => {
        prompt = p;
        options?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
        return JSON.stringify({ decisions: others.map((o) => ({ clusterId: o.clusterId, outcome: 'ready', confidence: 0.9, reasonCodes: ['coherent-recurrence'], evidenceIds: o.evidenceIds })) });
      },
    });
    const decisions = await arbiter.decideBatch(authority, [{ ...candidate, title: liveTitle, injectionSuspected: true }, ...others]);
    expect(decisions).toHaveLength(4);
    expect(decisions.find((d) => d.clusterId === 'cluster-1')).toMatchObject({ outcome: 'escalate-human', reasonCodes: ['injection-suspected'] });
    expect(decisions.filter((d) => d.outcome === 'ready').map((d) => d.clusterId)).toEqual(['cluster-2', 'cluster-3', 'cluster-4']);
    expect(prompt).not.toContain(liveTitle);
  });

  // Live 2026-10-01 run 2 (drain run a49ad1e8): codex gpt-6-astra hit CodexExecJsonTimeoutError at 20s.
  it('passes an invocation timeout through as a non-contract failure, with a budget sized for a full batch', async () => {
    let timeoutMs = 0;
    const arbiter = new FeedbackReadinessArbiter({
      evaluate: async (_p, options) => {
        timeoutMs = options?.timeoutMs ?? 0;
        options?.onModel?.({ model: 'gpt-6-astra', framework: 'codex-cli' });
        throw new CodexExecJsonTimeoutError(options?.timeoutMs ?? 0, '');
      },
    });
    const codexAuthority = { ...authority, provider: 'codex-cli', modelFamily: 'gpt-6-astra' };
    const error = await arbiter.decideBatch(codexAuthority, [candidate]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexExecJsonTimeoutError);
    expect(error).not.toBeInstanceOf(ReadinessContractViolation);
    expect(timeoutMs).toBe(FEEDBACK_READINESS_MODEL_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThan(20_000);
  });

  it('classifies provenance and schema breaks as contract violations', async () => {
    const ok = { decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] };
    for (const arbiter of [
      new FeedbackReadinessArbiter(provider(ok, 'gpt-5.5')),
      new FeedbackReadinessArbiter(provider('not json')),
      new FeedbackReadinessArbiter(provider({ decisions: [] })),
    ]) {
      await expect(arbiter.decideBatch(authority, [candidate])).rejects.toBeInstanceOf(ReadinessContractViolation);
    }
  });

  it('accepts a single surrounding markdown fence as formatting', async () => {
    const body = JSON.stringify({ decisions: [{ clusterId: 'cluster-1', outcome: 'collecting', confidence: 0.6, reasonCodes: ['single-report'], evidenceIds: ['feedback:1'] }] });
    const [decision] = await new FeedbackReadinessArbiter(provider(`\`\`\`json\n${body}\n\`\`\``)).decideBatch(authority, [candidate]);
    expect(decision.outcome).toBe('collecting');
  });
});
