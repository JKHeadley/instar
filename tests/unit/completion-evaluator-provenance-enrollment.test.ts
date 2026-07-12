/**
 * CompletionEvaluator provenance enrollment — LLM-Decision Quality Meter P8
 * (docs/specs/llm-decision-quality-meter.md §5.1.4 per-callsite contract +
 * §5.2 content-bearing envelope discipline + §5.3 completion first customer).
 *
 * Pins, semantically (both sides of every boundary):
 *   - both judge callsites enroll via `options.provenance`, each under its OWN
 *     typed decision-point id (completion-evaluate / completion-stop-rationale);
 *   - the context is transcript-slice IDENTITY ONLY (hash + bounds + the
 *     code-derived signals block) — transcript/condition TEXT never enters the
 *     envelope, and the envelope stays bounded for arbitrarily large tails;
 *   - `optionsPresented`/`promptId` are the static, clamp-safe labels the
 *     judges actually emit/run;
 *   - the router-minted correlation id is captured onto the verdict AND
 *     persisted through the run-state sink at MINT time — including calls
 *     that subsequently throw (§5.1.4 onCorrelationId contract);
 *   - a throwing sink is contained (the judgment path never breaks).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { CompletionCorrelationSink, StopSignals } from '../../src/core/CompletionEvaluator.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { DP_COMPLETION_EVALUATE, DP_COMPLETION_STOP_RATIONALE } from '../../src/data/provenanceCoverage.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Router-simulating stub: captures options, fires onCorrelationId at "mint". */
function capturingProvider(reply: string | Error, mintId = 'd-abcd1234-11112222-3333-4444-5555-666677778888') {
  const captured: { prompt?: string; opts?: IntelligenceOptions } = {};
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string, opts?: IntelligenceOptions): Promise<string> {
      captured.prompt = prompt;
      captured.opts = opts;
      // The router fires onCorrelationId synchronously at mint (entry, before
      // the first attempt) — including decisions that subsequently throw.
      opts?.provenance?.onCorrelationId?.(mintId);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { provider, captured };
}

const TRANSCRIPT_MARKER = 'ZX9_TRANSCRIPT_BODY_MARKER_UNIQ';
const CONDITION_MARKER = 'ZX9_CONDITION_BODY_MARKER_UNIQ';
const PATH_MARKER = 'docs/specs/zx9-accreted-path-marker.md';

const signalsFixture: StopSignals = {
  completionConditionMet: false,
  uncheckedTaskCount: 3,
  taskStructure: 'has-tasks',
  milestoneRationalizationDetected: true,
  injectionSuspected: false,
  scopeAccretionSuspected: true,
  scopeAccretion: {
    unbuilt: [PATH_MARKER, 'docs/specs/other.md'],
    deleted: [PATH_MARKER],
    ratifiedCount: 1,
    corroborationDegraded: true,
  },
};

describe('evaluate() enrollment (decision point completion-evaluate)', () => {
  it('carries options.provenance with the typed decision point, the real verdict space, and the prompt-version promptId', async () => {
    const { provider, captured } = capturingProvider('MET\nok');
    const e = new CompletionEvaluator({ intelligence: provider });
    await e.evaluate(`condition ${CONDITION_MARKER}`, `tail ${TRANSCRIPT_MARKER}`);
    const p = captured.opts?.provenance;
    expect(p).toBeDefined();
    expect(p?.decisionPoint).toBe(DP_COMPLETION_EVALUATE);
    expect(p?.optionsPresented).toEqual(['MET', 'NOT_MET']);
    expect(p?.promptId).toBe(e.promptVersion);
    // §5.2 clamp-safety: promptId must survive the settlement charset clamp.
    expect(p?.promptId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('context is transcript-slice IDENTITY (hash + bounds) — never transcript or condition text', async () => {
    const tail = `line1\n${TRANSCRIPT_MARKER}\nline3`;
    const condition = `all tests pass ${CONDITION_MARKER}`;
    const { provider, captured } = capturingProvider('MET\nok');
    const e = new CompletionEvaluator({ intelligence: provider });
    await e.evaluate(condition, tail, signalsFixture);

    const ctx = captured.opts?.provenance?.context as Record<string, any>;
    expect(ctx).toBeDefined();
    // Identity: the exact hash + byte/char bounds of the judged slice.
    expect(ctx.transcriptSlice).toEqual({
      sha256: sha256(tail),
      bytes: Buffer.byteLength(tail, 'utf8'),
      chars: tail.length,
    });
    expect(ctx.condition).toEqual({ sha256: sha256(condition), bytes: Buffer.byteLength(condition, 'utf8') });

    // The envelope NEVER carries the judged text (the prompt legitimately
    // does — it goes to the model, not the provenance row).
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain(TRANSCRIPT_MARKER);
    expect(serialized).not.toContain(CONDITION_MARKER);
    expect(captured.prompt).toContain(TRANSCRIPT_MARKER);

    // Signals ride as code-derived scalars; scope-accretion facts reduce to
    // COUNTS (identity + features — the path lists stay out of the row).
    expect(ctx.signals).toMatchObject({
      completionConditionMet: false,
      uncheckedTaskCount: 3,
      taskStructure: 'has-tasks',
      milestoneRationalizationDetected: true,
      injectionSuspected: false,
      scopeAccretionSuspected: true,
      scopeAccretion: { unbuiltCount: 2, deletedCount: 1, ratifiedCount: 1, corroborationDegraded: true },
    });
    expect(serialized).not.toContain(PATH_MARKER);
  });

  it('the envelope stays BOUNDED for an arbitrarily large transcript tail', async () => {
    const huge = 'x'.repeat(1_000_000);
    const { provider, captured } = capturingProvider('MET\nok');
    const e = new CompletionEvaluator({ intelligence: provider });
    await e.evaluate('cond', huge, signalsFixture);
    const bytes = Buffer.byteLength(JSON.stringify(captured.opts?.provenance?.context), 'utf8');
    expect(bytes).toBeLessThan(2_048);
  });

  it('captures the router-minted correlation id onto the verdict', async () => {
    const { provider } = capturingProvider('NOT_MET\nstill failing', 'd-11112222-aaaa');
    const e = new CompletionEvaluator({ intelligence: provider });
    const v = await e.evaluate('cond', 'tail');
    expect(v.met).toBe(false);
    expect(v.correlationId).toBe('d-11112222-aaaa');
  });

  it('omits correlationId when the seam never fires (router-bypassed path)', async () => {
    const provider: IntelligenceProvider = { evaluate: async () => 'MET\nok' };
    const e = new CompletionEvaluator({ intelligence: provider });
    const v = await e.evaluate('cond', 'tail');
    expect(v.met).toBe(true);
    expect(v.correlationId).toBeUndefined();
  });

  it('persists the id through the run-state sink at mint — with kind "completion" and the runRef identity', async () => {
    const writes: Array<{ topicId: string; runId: string; kind: string; id: string }> = [];
    const sink: CompletionCorrelationSink = {
      recordDecisionCorrelation: (topicId, runId, kind, id) => {
        writes.push({ topicId, runId, kind, id });
      },
    };
    const { provider } = capturingProvider('MET\nok', 'd-mint-1');
    const e = new CompletionEvaluator({ intelligence: provider, runCorrelationSink: sink });
    await e.evaluate('cond', 'tail', undefined, { topicId: '29723', runId: 'run-x1' });
    expect(writes).toEqual([{ topicId: '29723', runId: 'run-x1', kind: 'completion', id: 'd-mint-1' }]);
  });

  it('does NOT write the sink without a runRef (no run to attribute to)', async () => {
    const writes: string[] = [];
    const sink: CompletionCorrelationSink = { recordDecisionCorrelation: (...a) => void writes.push(a.join()) };
    const { provider } = capturingProvider('MET\nok');
    const e = new CompletionEvaluator({ intelligence: provider, runCorrelationSink: sink });
    const v = await e.evaluate('cond', 'tail');
    expect(writes).toEqual([]);
    expect(v.correlationId).toBeDefined(); // still captured for the caller
  });

  it('a provider throw AFTER mint still yields a correlationId on the safe met:false verdict AND a sink write (§5.1.4: including calls that throw)', async () => {
    const writes: string[] = [];
    const sink: CompletionCorrelationSink = { recordDecisionCorrelation: (_t, _r, _k, id) => void writes.push(id) };
    const { provider } = capturingProvider(new Error('LLM down'), 'd-threw-1');
    const e = new CompletionEvaluator({ intelligence: provider, runCorrelationSink: sink });
    const v = await e.evaluate('cond', 'tail', undefined, { topicId: 't', runId: 'r' });
    expect(v.met).toBe(false);
    expect(v.reason).toMatch(/error/i);
    expect(v.correlationId).toBe('d-threw-1');
    expect(writes).toEqual(['d-threw-1']);
  });

  it('a THROWING sink is contained — the verdict still returns with its correlation id', async () => {
    const sink: CompletionCorrelationSink = {
      recordDecisionCorrelation: () => {
        throw new Error('disk full');
      },
    };
    const { provider } = capturingProvider('MET\nok', 'd-contained-1');
    const e = new CompletionEvaluator({ intelligence: provider, runCorrelationSink: sink });
    const v = await e.evaluate('cond', 'tail', undefined, { topicId: 't', runId: 'r' });
    expect(v.met).toBe(true);
    expect(v.correlationId).toBe('d-contained-1');
  });
});

describe('evaluateStopRationale() enrollment (decision point completion-stop-rationale — distinct)', () => {
  it('enrolls under its OWN decision point with the P13 verdict space and the stop-rationale promptId', async () => {
    const { provider, captured } = capturingProvider('STOP_OK\nartifact shipped');
    const e = new CompletionEvaluator({ intelligence: provider });
    await e.evaluateStopRationale(`tail ${TRANSCRIPT_MARKER}`);
    const p = captured.opts?.provenance;
    expect(p?.decisionPoint).toBe(DP_COMPLETION_STOP_RATIONALE);
    expect(p?.decisionPoint).not.toBe(DP_COMPLETION_EVALUATE);
    expect(p?.optionsPresented).toEqual(['STOP_OK', 'STOP_BLOCKED']);
    expect(p?.promptId).toBe(e.stopRationalePromptVersion);
    expect(p?.promptId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // Attribution keeps the census 1:1 component key.
    expect(captured.opts?.attribution?.component).toBe('CompletionEvaluator/P13');
  });

  it('context is transcript-slice identity only (no condition block on the P13 point; no transcript text)', async () => {
    const tail = `judge tail ${TRANSCRIPT_MARKER}`;
    const { provider, captured } = capturingProvider('STOP_BLOCKED\nno artifact', 'd-p13-1');
    const e = new CompletionEvaluator({ intelligence: provider });
    const v = await e.evaluateStopRationale(tail, signalsFixture);
    const ctx = captured.opts?.provenance?.context as Record<string, any>;
    expect(ctx.transcriptSlice.sha256).toBe(sha256(tail));
    expect(ctx.condition).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain(TRANSCRIPT_MARKER);
    expect(JSON.stringify(ctx)).not.toContain(PATH_MARKER);
    expect(v.correlationId).toBe('d-p13-1');
  });

  it('persists through the sink under the DISTINCT "stop-rationale" kind', async () => {
    const writes: Array<{ kind: string; id: string }> = [];
    const sink: CompletionCorrelationSink = { recordDecisionCorrelation: (_t, _r, kind, id) => void writes.push({ kind, id }) };
    const { provider } = capturingProvider('STOP_OK\nok', 'd-p13-2');
    const e = new CompletionEvaluator({ intelligence: provider, runCorrelationSink: sink });
    await e.evaluateStopRationale('tail', undefined, { topicId: '29723', runId: 'run-x1' });
    expect(writes).toEqual([{ kind: 'stop-rationale', id: 'd-p13-2' }]);
  });

  it('fail-OPEN on a provider throw still carries the minted correlation id', async () => {
    const { provider } = capturingProvider(new Error('LLM down'), 'd-p13-3');
    const e = new CompletionEvaluator({ intelligence: provider });
    const v = await e.evaluateStopRationale('tail');
    expect(v.stopAllowed).toBe(true);
    expect(v.correlationId).toBe('d-p13-3');
  });
});
