/**
 * annotateCompletionRealcheck — LLM-Decision Quality Meter P8
 * (docs/specs/llm-decision-quality-meter.md §5.3 + §5.4.5 rule
 * completion-realcheck-v1).
 *
 * Pins ALL THREE evidence arms + every refusal arm:
 *   - met:true + realcheck PASS  → ONE annotation, grade 'right'
 *   - met:true + realcheck FAIL  → ONE annotation, grade 'wrong' (every
 *     non-pass gate outcome is a fail — timeout/refused/unavailable included)
 *   - no realcheck configured    → NO annotation (ages out unknown — honest)
 *   - met:false / no persisted correlation id / unbound chokepoint / throwing
 *     chokepoint → named dispositions, never a fabricated grade, never a throw.
 * Plus: gradedBy carries the REGISTERED owner + ruleId (the §5.4.2 chokepoint
 * rejects a non-owner), the evidence is content-free, and the injected clock
 * stamps observedAtMs.
 */

import { describe, it, expect } from 'vitest';
import {
  annotateCompletionRealcheck,
  realcheckRuleRegistryAgrees,
  COMPLETION_REALCHECK_RULE_ID,
  AUTONOMOUS_REALCHECK_COMPONENT,
} from '../../src/core/AutonomousRealCheckAnnotator.js';
import type { CompletionOutcomeAnnotation } from '../../src/core/AutonomousRealCheckAnnotator.js';
import { getRule } from '../../src/data/provenanceCoverage.js';

const T0 = Date.parse('2026-07-11T12:00:00.000Z');

const record = (correlationId?: string) => ({
  topicId: '29723',
  runId: 'run-x1',
  lastCompletionCorrelationId: correlationId,
});

function collector() {
  const calls: CompletionOutcomeAnnotation[] = [];
  return { calls, fn: (a: CompletionOutcomeAnnotation) => void calls.push(a) };
}

describe('the three §5.3 evidence arms', () => {
  it('met:true + realcheck PASS → ONE annotation, grade right, keyed on the persisted correlation id', () => {
    const { calls, fn } = collector();
    const d = annotateCompletionRealcheck(
      record('d-abc-1'),
      { met: true, realcheck: { configured: true, outcome: 'pass', exitCode: 0 } },
      fn,
      T0,
    );
    expect(d).toBe('annotated-right');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      correlationId: 'd-abc-1',
      ruleId: COMPLETION_REALCHECK_RULE_ID,
      gradedBy: { component: AUTONOMOUS_REALCHECK_COMPONENT, ruleId: COMPLETION_REALCHECK_RULE_ID },
      grade: 'right',
      evidence: {
        kind: 'completion-realcheck',
        met: true,
        realcheckOutcome: 'pass',
        exitCode: 0,
        topicId: '29723',
        runId: 'run-x1',
        observedAtMs: T0,
      },
    });
  });

  it('met:true + realcheck FAIL → ONE annotation, grade wrong (deterministic proof the "done" claim was false)', () => {
    const { calls, fn } = collector();
    const d = annotateCompletionRealcheck(
      record('d-abc-2'),
      { met: true, realcheck: { configured: true, outcome: 'fail', exitCode: 1 } },
      fn,
      T0,
    );
    expect(d).toBe('annotated-wrong');
    expect(calls).toHaveLength(1);
    expect(calls[0].grade).toBe('wrong');
    expect(calls[0].evidence.realcheckOutcome).toBe('fail');
    expect(calls[0].evidence.exitCode).toBe(1);
  });

  it('no realcheck configured → NO annotation at all (the decision ages out unknown — honest, never guessed)', () => {
    const { calls, fn } = collector();
    const d = annotateCompletionRealcheck(record('d-abc-3'), { met: true, realcheck: { configured: false } }, fn, T0);
    expect(d).toBe('skipped-no-realcheck');
    expect(calls).toHaveLength(0);
  });
});

describe('refusal arms (no fabricated grades, no throws)', () => {
  it('met:false → skipped (the rule grades met:true verdicts only; the hook never runs the check otherwise)', () => {
    const { calls, fn } = collector();
    const d = annotateCompletionRealcheck(
      record('d-abc-4'),
      { met: false, realcheck: { configured: true, outcome: 'pass' } },
      fn,
      T0,
    );
    expect(d).toBe('skipped-not-met');
    expect(calls).toHaveLength(0);
  });

  it('no persisted correlation id → skipped honestly (nothing to key on — never a guessed join)', () => {
    const { calls, fn } = collector();
    const d = annotateCompletionRealcheck(record(undefined), { met: true, realcheck: { configured: true, outcome: 'pass' } }, fn, T0);
    expect(d).toBe('skipped-no-correlation-id');
    expect(calls).toHaveLength(0);
  });

  it('unbound chokepoint (P6 handoff state, annotate=null) → named disposition, no grade', () => {
    const d = annotateCompletionRealcheck(record('d-abc-5'), { met: true, realcheck: { configured: true, outcome: 'fail' } }, null, T0);
    expect(d).toBe('annotate-unbound');
  });

  it('a THROWING chokepoint is contained — annotate-error, never a propagated throw into the exit path', () => {
    const d = annotateCompletionRealcheck(
      record('d-abc-6'),
      { met: true, realcheck: { configured: true, outcome: 'pass' } },
      () => {
        throw new Error('sqlite locked');
      },
      T0,
    );
    expect(d).toBe('annotate-error');
  });
});

describe('registry agreement + evidence hygiene', () => {
  it('the annotator constants agree with the registered rule (owner + rung + strength — drift would zero the grades at the chokepoint)', () => {
    expect(realcheckRuleRegistryAgrees()).toBe(true);
    const rule = getRule(COMPLETION_REALCHECK_RULE_ID)!;
    expect(rule.owningComponent).toBe(AUTONOMOUS_REALCHECK_COMPONENT);
    expect(rule.rung).toBe('deterministic-ground-truth');
    expect(rule.evidenceStrength).toBe('deterministic-proof');
  });

  it('evidence is content-free and bounded (ids/enums/numbers only — §5.2 pointer discipline)', () => {
    const { calls, fn } = collector();
    annotateCompletionRealcheck(record('d-abc-7'), { met: true, realcheck: { configured: true, outcome: 'fail' } }, fn, T0);
    const serialized = JSON.stringify(calls[0]);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(500);
    for (const v of Object.values(calls[0].evidence)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });

  it('exitCode is omitted (not null-stuffed) when the gate outcome carries none', () => {
    const { calls, fn } = collector();
    annotateCompletionRealcheck(record('d-abc-8'), { met: true, realcheck: { configured: true, outcome: 'fail' } }, fn, T0);
    expect('exitCode' in calls[0].evidence).toBe(false);
  });
});
