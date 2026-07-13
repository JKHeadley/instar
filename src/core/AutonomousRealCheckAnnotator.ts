/**
 * AutonomousRealCheckAnnotator — the deterministic realcheck arm of the
 * LLM-Decision Quality Meter's completion first customer
 * (docs/specs/llm-decision-quality-meter.md §5.3 + §5.4.5, rule
 * `completion-realcheck-v1`, evidence-strength `deterministic-proof`).
 *
 * The autonomous stop hook runs the run's declared `verification_command` on a
 * met:true judge verdict (ACT-152 real-check gate; the hook is the only place
 * the command actually executes). THIS module turns that observed outcome into
 * an outcome annotation against the judge's decision row, joined on the
 * correlation id persisted in the durable run-state record
 * (AutonomousRunStore.recordDecisionCorrelation):
 *
 *   - met:true + realcheck PASS → grade `right`
 *   - met:true + realcheck FAIL → grade `wrong`
 *   - no realcheck configured   → NO annotation (the decision honestly ages
 *     out `unknown` — §5.3/§5.4.5: "No realcheck → unknown, never guessed")
 *
 * Operator "keep going" reversal detection is OUT of this build (named
 * residual, ACT-1198 evidence-source family).
 *
 * The annotate chokepoint (§5.4 write-integrity: rung derived from the rule
 * registry, owner-checked, upserted on correlationId × gradedBy) is INJECTED —
 * see the TODO(P6-handoff) block at the bottom for the exact production
 * binding once the hardened chokepoint lands.
 */

import type { AutonomousRunRecord } from './AutonomousRunStore.js';
import { getRule } from '../data/provenanceCoverage.js';

/** The registered evidence rule this annotator writes under (§5.4.5). */
export const COMPLETION_REALCHECK_RULE_ID = 'completion-realcheck-v1';

/**
 * The rule's registered OWNING component (§5.4.2 — the chokepoint rejects an
 * annotation whose gradedBy.component is not the ruleId's registered owner).
 * A unit test pins this against RULE_REGISTRY so drift fails CI.
 */
export const AUTONOMOUS_REALCHECK_COMPONENT = 'AutonomousRealCheck';

/** What the realcheck path observed for one met-claim (code-derived facts). */
export interface CompletionRealcheckObservation {
  /** The completion judge's verdict this realcheck ran against. */
  met: boolean;
  /**
   * The realcheck disposition: `configured:false` = the run declares NO
   * `verification_command` (or the realcheck gate is disabled) — the honest
   * no-annotation arm. `outcome` is the gate's binary result: `pass` = exit 0;
   * `fail` = any non-pass gate outcome (non-zero exit, timeout,
   * refused-destructive, unavailable) — every non-pass keeps the run working,
   * and every non-pass on a met:true verdict is deterministic proof the judge
   * called "done" on a goal whose declared check does not pass.
   */
  realcheck: { configured: false } | { configured: true; outcome: 'pass' | 'fail'; exitCode?: number };
}

/**
 * The outcome annotation handed to the §5.4 chokepoint. Content-free by
 * construction (ids, enums, numbers — pointer discipline; never transcript or
 * command output).
 */
export interface CompletionOutcomeAnnotation {
  /** The decision join key (§5.4.1) — from the run record. */
  correlationId: string;
  /** Top-level ruleId (mirrors gradedBy.ruleId for either chokepoint shape). */
  ruleId: string;
  /** Component + ruleId — rung/strength are DERIVED registry-side (§5.4.2). */
  gradedBy: { component: string; ruleId: string };
  grade: 'right' | 'wrong';
  /** Structured, clamp-safe evidence (§5.2 ≤500-char pointer discipline). */
  evidence: {
    kind: 'completion-realcheck';
    met: true;
    realcheckOutcome: 'pass' | 'fail';
    exitCode?: number;
    topicId: string;
    runId: string;
    observedAtMs: number;
  };
}

export type AnnotateOutcomeFn = (annotation: CompletionOutcomeAnnotation) => void;

/** Every arm is named — no silent skip (Observable Intelligence). */
export type RealcheckAnnotationDisposition =
  | 'annotated-right'
  | 'annotated-wrong'
  | 'skipped-not-met'
  | 'skipped-no-realcheck'
  | 'skipped-no-correlation-id'
  | 'annotate-unbound'
  | 'annotate-error';

/**
 * Apply the §5.3 realcheck grading rules for ONE observed met-claim.
 * Pure decision logic + one injected side effect; never throws.
 *
 * @param record   the run's durable record (carries the persisted correlation id)
 * @param obs      what the realcheck path observed (code-derived, never content)
 * @param annotate the §5.4 chokepoint binding, or null while unbound (P6 handoff)
 * @param nowMs    injected clock (tests pass a fixed value)
 */
export function annotateCompletionRealcheck(
  record: Pick<AutonomousRunRecord, 'topicId' | 'runId' | 'lastCompletionCorrelationId'>,
  obs: CompletionRealcheckObservation,
  annotate: AnnotateOutcomeFn | null,
  nowMs: number = Date.now(),
): RealcheckAnnotationDisposition {
  // The rule grades met:true verdicts only — the hook runs the realcheck
  // exclusively on a met:true judge verdict, so a met:false observation has
  // no gradeable counterfactual here (§5.3).
  if (!obs.met) return 'skipped-not-met';
  // No realcheck configured → NO annotation; the decision ages out `unknown`
  // (honest — §5.4.5: "No realcheck → unknown, never guessed").
  if (!obs.realcheck.configured) return 'skipped-no-realcheck';
  const correlationId = record.lastCompletionCorrelationId;
  // No persisted correlation id (pre-meter record, router-bypassed judge call,
  // or a failed persistence write) → nothing to key on; the decision row —
  // if one exists — ages out `unknown` rather than being guessed at.
  if (!correlationId) return 'skipped-no-correlation-id';
  if (!annotate) return 'annotate-unbound';

  const grade: 'right' | 'wrong' = obs.realcheck.outcome === 'pass' ? 'right' : 'wrong';
  try {
    annotate({
      correlationId,
      ruleId: COMPLETION_REALCHECK_RULE_ID,
      gradedBy: { component: AUTONOMOUS_REALCHECK_COMPONENT, ruleId: COMPLETION_REALCHECK_RULE_ID },
      grade,
      evidence: {
        kind: 'completion-realcheck',
        met: true,
        realcheckOutcome: obs.realcheck.outcome,
        ...(obs.realcheck.exitCode !== undefined ? { exitCode: obs.realcheck.exitCode } : {}),
        topicId: record.topicId,
        runId: record.runId,
        observedAtMs: nowMs,
      },
    });
  } catch {
    /* @silent-fallback-ok — an annotation write failure must never propagate
       into the realcheck/exit path it observes; the decision then honestly
       ages out `unknown` (§5.4.6). The chokepoint counts its own rejections. */
    return 'annotate-error';
  }
  return grade === 'right' ? 'annotated-right' : 'annotated-wrong';
}

/**
 * Sanity guard the tests pin: the constants above must agree with the
 * registered rule (rung `deterministic-ground-truth`, owner
 * `AutonomousRealCheck`) — the chokepoint REJECTS an annotation whose
 * component is not the registered owner, so drift here would silently zero
 * the completion grades.
 */
export function realcheckRuleRegistryAgrees(): boolean {
  const rule = getRule(COMPLETION_REALCHECK_RULE_ID);
  return rule !== undefined && rule.owningComponent === AUTONOMOUS_REALCHECK_COMPONENT;
}

// ── TODO(P6-handoff): production chokepoint binding — SINGLE handoff point ──
// The hardened §5.4 annotate chokepoint (correlationId keying + registry-
// derived rung + owner rejection; DecisionQualityRecorderImpl / the upgraded
// JudgmentProvenanceLog.annotateOutcome) was built CONCURRENTLY with this
// module and was not importable at P8 build time. When it lands, bind it at
// the realcheck-outcome surface — the /autonomous/:topic/run-end handler arm
// (realcheck PASS reaches the server as the hook's `run_end_call "met"`;
// carrying the FAIL arm + the configured/not-configured bit requires the hook
// to include its realcheck outcome on the run-end body — integration note in
// the P8 build report) — passing EXACTLY:
//
//   annotateCompletionRealcheck(rec, obs, (a) =>
//     decisionQualityRecorder.annotateOutcome({
//       correlationId: a.correlationId,   // §5.4.1 keying
//       gradedBy: a.gradedBy,             // { component: 'AutonomousRealCheck', ruleId: 'completion-realcheck-v1' }
//       grade: a.grade,                   // 'right' (met+pass) | 'wrong' (met+fail)
//       evidence: a.evidence,             // structured, content-free (§5.2 clamp discipline)
//     }),
//   );
//
// Until then callers pass `annotate: null` and get the honest
// 'annotate-unbound' disposition (never a fabricated grade).
