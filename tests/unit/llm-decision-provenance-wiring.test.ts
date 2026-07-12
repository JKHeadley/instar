/**
 * ACT-562 — provenance WIRING unit tests for the two in-process LLM decision
 * points that emit through an injected sink (docs/specs/llm-decision-provenance-
 * wiring.md §3.1/§3.1b/§3.4):
 *   - CompletionEvaluator.evaluate → continue-stop:v1
 *   - CompletionEvaluator.evaluateStopRationale → p13-blocker:v1
 *   - MessagingToneGate.review → outbound-gate:v1
 *
 * Semantic correctness covers BOTH sides of each decision boundary; the fenced
 * (CompletionEvaluator) / derived (ToneGate) context is asserted; and the
 * fail-open observability invariant (a throwing sink never alters the verdict)
 * is proven.
 */
import { describe, it, expect } from 'vitest';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { DecisionRowInput } from '../../src/core/JudgmentProvenanceLog.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

/** A stub provider that also fires onUsage/onModel so we can assert attribution flows. */
function stubProvider(reply: string | (() => Promise<string>)): IntelligenceProvider {
  return {
    async evaluate(_prompt: string, opts?: IntelligenceOptions): Promise<string> {
      opts?.onModel?.({ model: 'test-fast-model', framework: 'test-framework' });
      opts?.onUsage?.({ inputTokens: 42, outputTokens: 7 });
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

function sink() {
  const rows: DecisionRowInput[] = [];
  return { rows, record: (r: DecisionRowInput) => rows.push(r) };
}

describe('CompletionEvaluator — continue-stop:v1 provenance', () => {
  it('records a MET verdict as decision "met" with fenced context + attribution', async () => {
    const s = sink();
    const e = new CompletionEvaluator({
      intelligence: stubProvider('MET\nall tests pass per the transcript'),
      recordProvenance: s.record,
    });
    const verdict = await e.evaluate('all tests pass', 'TAIL: agent said tests green', { completionConditionMet: true }, { runId: 'r1', topicId: '77' });
    expect(verdict.met).toBe(true);
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0];
    expect(row.decisionPoint).toBe('CompletionEvaluator:continue-stop:v1');
    expect(row.component).toBe('CompletionEvaluator');
    expect(row.decision).toBe('met');
    expect(row.reason).toBeTruthy();
    // §3.1 — the context is the ALREADY-FENCED form + correlation ids.
    const ctx = row.context as Record<string, unknown>;
    expect(String(ctx.fencedTranscript)).toContain('AGENT-PRODUCED DATA'); // the fence fired (signals present)
    expect(ctx.runId).toBe('r1');
    expect(ctx.topicId).toBe('77');
    // §3.1 — model/tokens sourced from the call's attribution path.
    expect(row.model).toBe('test-fast-model');
    expect(row.door).toBe('test-framework');
    expect(row.tokensIn).toBe(42);
    expect(row.tokensOut).toBe(7);
  });

  it('records a NOT_MET verdict as decision "not-met" (both sides of the boundary)', async () => {
    const s = sink();
    const e = new CompletionEvaluator({ intelligence: stubProvider('NOT_MET\n3 tests failing'), recordProvenance: s.record });
    const verdict = await e.evaluate('all tests pass', 'tail');
    expect(verdict.met).toBe(false);
    expect(s.rows[0].decision).toBe('not-met');
  });

  it('records a provenance row even on an evaluator ERROR (keep-working verdict)', async () => {
    const s = sink();
    const e = new CompletionEvaluator({
      intelligence: stubProvider(async () => { throw new Error('LLM down'); }),
      recordProvenance: s.record,
    });
    const verdict = await e.evaluate('cond', 'tail');
    expect(verdict.met).toBe(false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].decision).toBe('not-met');
  });

  it('a THROWING sink never alters the verdict (§3.4 observability-only)', async () => {
    const e = new CompletionEvaluator({
      intelligence: stubProvider('MET\nok'),
      recordProvenance: () => { throw new Error('provenance disk full'); },
    });
    const verdict = await e.evaluate('cond', 'tail');
    expect(verdict).toEqual({ met: true, reason: 'ok' });
  });
});

describe('CompletionEvaluator — p13-blocker:v1 provenance', () => {
  it('records STOP_BLOCKED as a stop-blocked decision', async () => {
    const s = sink();
    const e = new CompletionEvaluator({
      intelligence: stubProvider('STOP_BLOCKED\nneeds engineering is a buildable stop reason'),
      recordProvenance: s.record,
    });
    const v = await e.evaluateStopRationale('tail', { milestoneRationalizationDetected: true }, { runId: 'r9', topicId: '5' });
    expect(v.stopAllowed).toBe(false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].decisionPoint).toBe('CompletionEvaluator:p13-blocker:v1');
    expect(s.rows[0].decision).toContain('stop-blocked');
    expect((s.rows[0].context as { runId?: string }).runId).toBe('r9');
  });

  it('records a hard-blocker classification (external → stop-allowed)', async () => {
    const s = sink();
    const e = new CompletionEvaluator({
      intelligence: stubProvider('STOP_OK\ngenuinely external'),
      recordProvenance: s.record,
    });
    const v = await e.evaluateStopRationale('tail', { stopKind: 'hard-blocker' });
    expect(v.stopAllowed).toBe(true);
    expect(v.classifiedBlocker).toBe('external');
    expect(s.rows[0].decision).toContain('stop-allowed');
    expect(s.rows[0].decision).toContain('external');
  });
});

describe('MessagingToneGate — outbound-gate:v1 provenance', () => {
  const okContext = { channel: 'telegram' as const, recentMessages: [], messageKind: 'conversational' as const };

  it('records a PASS verdict with the DERIVED context (textHead, NOT the full body) + attribution', async () => {
    const s = sink();
    const body = 'This is a long friendly reply to the user that exceeds eighty characters so we can prove only a head is logged, not the whole thing.';
    const gate = new MessagingToneGate(stubProvider(JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })), {}, { recordProvenance: s.record });
    const res = await gate.review(body, okContext);
    expect(res.pass).toBe(true);
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0];
    expect(row.decisionPoint).toBe('MessagingToneGate:outbound-gate:v1');
    expect(row.decision).toBe('pass');
    // §3.1b — the context is the DERIVED form: an 80-char textHead, never the full body.
    const ctx = row.context as { textHead?: string };
    expect(ctx.textHead?.length).toBeLessThanOrEqual(80);
    expect(body).toContain(ctx.textHead as string); // it IS a prefix of the body
    expect(ctx.textHead).not.toBe(body); // but NOT the whole body
    expect(row.model).toBe('test-fast-model');
    expect(row.tokensIn).toBe(42);
  });

  it('records a BLOCK verdict with the rule (both sides of the boundary)', async () => {
    const s = sink();
    const gate = new MessagingToneGate(
      stubProvider(JSON.stringify({ pass: false, rule: 'B1_CLI_COMMAND', issue: 'leaked a CLI command', suggestion: 'rephrase' })),
      {},
      { recordProvenance: s.record },
    );
    const res = await gate.review('run `rm -rf /` to fix it', okContext);
    expect(res.pass).toBe(false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].decision).toBe('block:B1_CLI_COMMAND');
    expect(s.rows[0].reason).toContain('leaked');
  });

  it('a THROWING sink never alters the gate verdict (§3.4 — never holds/drops the message)', async () => {
    const gate = new MessagingToneGate(
      stubProvider(JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })),
      {},
      { recordProvenance: () => { throw new Error('provenance disk full'); } },
    );
    const res = await gate.review('hello', okContext);
    expect(res.pass).toBe(true); // the message still passes — provenance is inert to the verdict
  });

  it('emits NO row when no sink is injected (the fleet-dark path is byte-identical)', async () => {
    const gate = new MessagingToneGate(stubProvider(JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })));
    const res = await gate.review('hello', okContext);
    expect(res.pass).toBe(true); // works exactly as before, no provenance
  });
});
