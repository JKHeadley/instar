import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IntelligenceProvider } from '../../../src/core/types.js';
import { EVIDENCE_NOT_OWN, FeedbackReadinessArbiter, FEEDBACK_READINESS_MODEL_TIMEOUT_MS, ReadinessContractViolation, ReadinessOutputRejected } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
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
    // Uncited or foreign evidence is a per-row floor now: the row is never ready, the answer stands.
    const [foreign] = await new FeedbackReadinessArbiter(provider({ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['outside'] }] })).decideBatch(authority, [candidate]);
    expect(foreign).toMatchObject({ outcome: 'collecting', reasonCodes: [EVIDENCE_NOT_OWN, 'x'], evidenceIds: [] });
    // A request for a human with foreign evidence stays a request for a human; never ready.
    const [escalated] = await new FeedbackReadinessArbiter(provider({ decisions: [{ clusterId: 'cluster-1', outcome: 'escalate-human', confidence: 0.9, reasonCodes: ['x'], evidenceIds: ['feedback:1', 'cluster:other'] }] })).decideBatch(authority, [candidate]);
    expect(escalated).toMatchObject({ outcome: 'escalate-human', reasonCodes: [EVIDENCE_NOT_OWN, 'x'], evidenceIds: ['feedback:1'] });
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

  it('classifies a wrong resolved model as a contract violation, with a diagnosis', async () => {
    const ok = { decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] };
    const error = await new FeedbackReadinessArbiter(provider(ok, 'gpt-5.5')).decideBatch(authority, [candidate]).catch((e: unknown) => e) as ReadinessContractViolation;
    expect(error).toBeInstanceOf(ReadinessContractViolation);
    expect(error.check).toBe('resolved-model-mismatch');
    expect(error.diagnosis).toMatchObject({ check: 'resolved-model-mismatch', resolvedModel: 'gpt-5.5', resolvedFramework: 'claude-code', candidateIds: ['cluster-1'], candidateCount: 1 });
    expect(error.diagnosis?.callId).toMatch(/^readiness-call:/);
  });

  it('rejects a bad answer as output (not a contract violation), naming the check with a bounded scrubbed excerpt', async () => {
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const cases: Array<[unknown, string]> = [
      ['not json', 'invalid-json'],
      [{ decisions: [] }, 'incomplete-decision-set'],
      [{ decisions: [{ clusterId: 'other', outcome: 'ready', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] }, 'changed-or-duplicated-id'],
      [{ decisions: [{ clusterId: 'cluster-1', outcome: 'held', confidence: 1, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] }, 'forbidden-outcome'],
      [{ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 7, reasonCodes: ['x'], evidenceIds: ['feedback:1'] }] }, 'invalid-confidence'],
      [{ decisions: [{ clusterId: 'cluster-1', outcome: 'ready', confidence: 0.9, reasonCodes: [`Bad Code ${secret}`], evidenceIds: ['feedback:1'] }] }, 'invalid-reason-codes'],
    ];
    for (const [reply, check] of cases) {
      const error = await new FeedbackReadinessArbiter(provider(reply)).decideBatch(authority, [candidate]).catch((e: unknown) => e) as ReadinessOutputRejected;
      expect(error).toBeInstanceOf(ReadinessOutputRejected);
      expect(error).not.toBeInstanceOf(ReadinessContractViolation);
      expect(error.diagnosis).toMatchObject({ check, candidateIds: ['cluster-1'], resolvedModel: 'claude-fable-5' });
      expect(error.diagnosis!.excerpt!.length).toBeLessThanOrEqual(700);
      expect(error.diagnosis!.excerpt).not.toContain(secret);
    }
    // A secret straddling the excerpt cut is redacted whole, not left as an unrecognisable prefix.
    const straddle = await new FeedbackReadinessArbiter(provider(`${'x'.repeat(590)} ${secret} tail`)).decideBatch(authority, [candidate]).catch((e: unknown) => e) as ReadinessOutputRejected;
    expect(straddle.diagnosis!.excerpt).not.toContain(secret.slice(0, 9));
    const huge = await new FeedbackReadinessArbiter(provider('x'.repeat(50_000))).decideBatch(authority, [candidate]).catch((e: unknown) => e) as ReadinessOutputRejected;
    expect(huge.diagnosis!.excerpt!.length).toBeLessThanOrEqual(700);
  });

  it('accepts a single surrounding markdown fence as formatting', async () => {
    const body = JSON.stringify({ decisions: [{ clusterId: 'cluster-1', outcome: 'collecting', confidence: 0.6, reasonCodes: ['single-report'], evidenceIds: ['feedback:1'] }] });
    const [decision] = await new FeedbackReadinessArbiter(provider(`\`\`\`json\n${body}\n\`\`\``)).decideBatch(authority, [candidate]);
    expect(decision.outcome).toBe('collecting');
  });

  // Live 2026-10-02 (drain run 2e06aa3b, generation 4): the reply cross-cited a near-duplicate
  // sibling's evidence and the whole authority was demoted. Replayed: the real candidates and
  // three real gpt-6-astra replies recorded on the same prompt.
  it('replays the recorded cross-cite replies: the answer stands, only the cross-citing rows are held back', async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'feedback-readiness-cross-cite-shapes.json'), 'utf8')) as {
      resolvedModel: { model: string; framework: string };
      candidates: Array<{ clusterId: string; title: string; type: string; reportCount: number; createdAt: string; updatedAt: string }>;
      replies: Array<{ oldVerdict: string; raw: string }>;
    };
    const instruction = /\b(ignore (all|any|the|previous)|system prompt|developer message|execute|run command)\b/i;
    const candidates = fixture.candidates.map((c) => ({
      clusterId: c.clusterId, title: c.title, type: c.type, reportCount: c.reportCount, firstSeenAt: Date.parse(c.createdAt), lastSeenAt: Date.parse(c.updatedAt),
      evidenceIds: [`cluster:${c.clusterId}`], injectionSuspected: instruction.test(c.title),
    }));
    expect(candidates.filter((c) => c.injectionSuspected)).toHaveLength(1);
    const live = { ...authority, provider: 'codex-cli', modelFamily: 'gpt-6-astra' };
    expect(fixture.replies.filter((r) => r.oldVerdict.includes('cited evidence outside'))).toHaveLength(2);
    for (const reply of fixture.replies) {
      const arbiter = new FeedbackReadinessArbiter({ evaluate: async (_p, options) => { options?.onModel?.(fixture.resolvedModel); return reply.raw; } });
      const decisions = await arbiter.decideBatch(live, candidates);
      expect(decisions).toHaveLength(10);
      const crossCited = (JSON.parse(reply.raw) as { decisions: Array<{ clusterId: string; evidenceIds: string[] }> }).decisions
        .filter((d) => d.evidenceIds.some((id) => id !== `cluster:${d.clusterId}`)).map((d) => d.clusterId);
      expect(crossCited.length > 0).toBe(reply.oldVerdict !== 'accepted');
      for (const decision of decisions) {
        if (crossCited.includes(decision.clusterId)) {
          expect(decision.outcome).not.toBe('ready');
          expect(decision.reasonCodes[0]).toBe(EVIDENCE_NOT_OWN);
          expect(decision.evidenceIds.every((id) => id === `cluster:${decision.clusterId}`)).toBe(true);
        }
        else expect(decision.reasonCodes).not.toContain(EVIDENCE_NOT_OWN);
      }
    }
  });
});
