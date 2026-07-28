/**
 * Tier 1 — UnjustifiedStopGate's provenance enrollment (llm-decision-quality-meter
 * §5.1.4/§5.6). The gate is the highest-volume UNENROLLED decision point in the
 * census (~1343 calls/7d), and enrolling it is the second half of the census task.
 *
 * The contract these tests defend is the CONTENT-BEARING one. This gate judges a
 * session's stop rationale, so its inputs are largely untrusted and quotable:
 * the stop reason and up to ten recent conversation turns. None of that may enter
 * the provenance row. If it did, the store would quietly become a transcript
 * archive — the exact failure the content-bearing class exists to prevent, and
 * the kind that is invisible until someone reads the archive.
 *
 * Enrollment must also be OBSERVABILITY-ONLY: it cannot change what the gate
 * decides, and a provenance problem cannot break a stop decision.
 */
import { describe, it, expect, vi } from 'vitest';
import { UnjustifiedStopGate } from '../../src/core/UnjustifiedStopGate.js';
import { DP_UNJUSTIFIED_STOP_GATE, PROVENANCE_COVERAGE } from '../../src/data/provenanceCoverage.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SECRET_REASON = 'I am stopping because the API key sk-live-abcdef123456 rotated and I got confused';
const SECRET_TURN = 'the user said: my password is hunter2 and the deploy path is /Users/justin/secret/deploy.sh';

/** Captures the options the gate hands the provider. */
function capturingProvider(): { provider: IntelligenceProvider; calls: any[] } {
  const calls: any[] = [];
  const provider = {
    evaluate: vi.fn(async (_prompt: string, opts?: any) => {
      calls.push(opts);
      // A SCHEMA-VALID response: the gate rejects anything without an
      // enumerated rule, so a lazy mock would exercise the failure path and
      // quietly prove nothing about the success path.
      return JSON.stringify({
        decision: 'continue',
        rule: 'U2_PLAN_FILE_NEXT_STEP_EXPLICIT',
        rationale: 'plan file still has open steps',
        // A `continue` verdict must cite a plan file from the enumerated
        // artifact set — the gate's own coherence rule. Satisfying it means
        // this test exercises the SUCCESS path rather than a validation reject.
        evidence_pointer: { plan_file: 'docs/plan.md' },
        cited_evidence: ['docs/plan.md'],
      });
    }),
  } as unknown as IntelligenceProvider;
  return { provider, calls };
}

function makeGate(provider: IntelligenceProvider) {
  return new UnjustifiedStopGate({
    intelligence: provider,
    clientTimeoutMs: 5_000,
    maxTokens: 512,
    now: () => 1_700_000_000_000,
    selfDeferralGuardEnabled: true,
  } as any);
}

const input = {
  evidenceMetadata: {
    artifacts: [
      { kind: 'plan-file', path: 'docs/plan.md' },
      { kind: 'commit', sha: 'abc123' },
    ],
    signals: { contextDeath: true, fatigue: false },
    sessionStartTs: 1_699_999_000_000,
    metaSelfReferenceHint: false,
  },
  untrustedContent: {
    stopReason: SECRET_REASON,
    recentTurns: [
      { source: 'user' as const, text: SECRET_TURN },
      { source: 'agent' as const, text: 'understood, continuing' },
    ],
  },
};

describe('the enrollment is present and typed', () => {
  it('the census declares this point WIRED', () => {
    const entry = PROVENANCE_COVERAGE.find((e) => e.decisionPoint === DP_UNJUSTIFIED_STOP_GATE);
    expect(entry, 'the decision point must be in the census').toBeDefined();
    expect(entry!.status).toBe('wired');
    expect(entry!.component).toBe('UnjustifiedStopGate');
  });

  it('declares a volume valve and the content class, as a wired entry must', () => {
    const entry = PROVENANCE_COVERAGE.find((e) => e.decisionPoint === DP_UNJUSTIFIED_STOP_GATE)!;
    expect(entry.volumeClass).toBe('budget:300');
    expect(entry.contentClass).toBe('content-bearing');
  });

  it('declares measurement-only ON PURPOSE, with a real argument', () => {
    // The honest half of this enrollment: decisions are recorded, outcomes are
    // not gradeable yet. Declaring it keeps the census truthful instead of
    // implying this point is measured when only half of it is.
    const entry = PROVENANCE_COVERAGE.find((e) => e.decisionPoint === DP_UNJUSTIFIED_STOP_GATE)!;
    expect(entry.gradingPosture).toBe('measurement-only');
    expect((entry.gradingReason ?? '').length).toBeGreaterThanOrEqual(40);
  });

  it('passes a provenance block naming the typed decision point', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate(input as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].provenance?.decisionPoint).toBe(DP_UNJUSTIFIED_STOP_GATE);
    expect(calls[0].provenance?.optionsPresented).toEqual(['continue', 'allow', 'escalate']);
    expect(calls[0].provenance?.promptId, 'the prompt hash pins WHICH prompt decided').toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IDENTITY ONLY — the untrusted text never enters the row', () => {
  it('does not carry the stop reason, in whole or in part', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate(input as any);
    const serialized = JSON.stringify(calls[0].provenance?.context ?? {});

    expect(serialized).not.toContain(SECRET_REASON);
    expect(serialized, 'not even a fragment').not.toContain('sk-live-abcdef123456');
    expect(serialized).not.toContain('rotated and I got confused');
  });

  it('does not carry conversation turns — no transcript archive by accident', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate(input as any);
    const serialized = JSON.stringify(calls[0].provenance?.context ?? {});

    expect(serialized).not.toContain(SECRET_TURN);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('/Users/justin/secret/deploy.sh');
    expect(serialized).not.toContain('understood, continuing');
  });

  it('carries the IDENTITY and SHAPE a later reader actually needs', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate(input as any);
    const ctx = calls[0].provenance?.context as Record<string, unknown>;

    // A hash pins WHICH rationale was judged without republishing it.
    expect(String(ctx.stopReasonSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.stopReasonChars).toBe(SECRET_REASON.length);
    // The evidence the authority was allowed to cite, by shape.
    expect(ctx.artifactCount).toBe(2);
    expect(ctx.artifactKinds).toEqual(['commit', 'plan-file']);
    // Code-derived booleans are safe verbatim — they are not user text.
    expect(ctx.signals).toEqual({ contextDeath: true, fatigue: false });
    expect(ctx.recentTurnCount).toBe(2);
    expect(ctx.recentTurnChars).toBe(SECRET_TURN.length + 'understood, continuing'.length);
  });

  it('the hash actually distinguishes two different rationales', async () => {
    // Guards against a constant/empty hash making the identity field useless.
    const a = capturingProvider();
    await makeGate(a.provider).evaluate(input as any);
    const b = capturingProvider();
    await makeGate(b.provider).evaluate({
      ...input,
      untrustedContent: { ...input.untrustedContent, stopReason: 'a completely different reason' },
    } as any);

    expect(a.calls[0].provenance.context.stopReasonSha256).not.toBe(
      b.calls[0].provenance.context.stopReasonSha256,
    );
  });

  it('survives empty and missing untrusted content without throwing', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate({
      evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: null },
      untrustedContent: { stopReason: '', recentTurns: [] },
    } as any);
    const ctx = calls[0].provenance.context as Record<string, unknown>;
    expect(ctx.stopReasonChars).toBe(0);
    expect(ctx.artifactCount).toBe(0);
    expect(ctx.recentTurnCount).toBe(0);
  });
});

describe('observability only — enrollment cannot change the verdict', () => {
  it('returns the same decision it would have without provenance', async () => {
    const { provider } = capturingProvider();
    const out = await makeGate(provider).evaluate(input as any) as any;
    // The verdict comes from the model response, untouched by enrollment.
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.result.decision).toBe('continue');
    expect(out.result.rule).toBe('U2_PLAN_FILE_NEXT_STEP_EXPLICIT');
  });

  it('the provenance block is passed alongside attribution, not instead of it', async () => {
    const { provider, calls } = capturingProvider();
    await makeGate(provider).evaluate(input as any);
    // Losing attribution would silently drop this component from the cost
    // surface — enrollment must ADD a signal, never displace one.
    expect(calls[0].attribution?.component).toBe('UnjustifiedStopGate');
    expect(calls[0].provenance).toBeDefined();
  });
});
