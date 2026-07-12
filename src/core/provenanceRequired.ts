/**
 * provenanceRequired.ts — the PROVENANCE_REQUIRED allowlist (ACT-562,
 * docs/specs/llm-decision-provenance-wiring.md §3.2 / §3.2a).
 *
 * This is PRODUCTION code loaded by `JudgmentProvenanceLog.recordDecision` at
 * runtime (§3.2a — "the allowlist is PRODUCTION code/config, not a test
 * fixture"), NOT a test fixture. The coverage ratchet
 * (tests/unit/llm-decision-provenance-coverage-ratchet.test.ts) consumes the
 * SAME constant, so a runtime invariant (high-stakes sampling-exemption) can
 * never silently disagree with what CI asserts.
 *
 * Each entry keys on a stable DECISION-POINT IDENTITY (§3.1, codex #2):
 *   `<component>:<decisionKind>:v1`
 * This SAME id is:
 *   - this map's key,
 *   - the `decisionPoint` field on the provenance row,
 *   - and is asserted (§3.2) to match the callsite's `attribution.component`
 *     prefix (`<component>`), so identity drift is a red build.
 *
 * `highStakes:true` (§3.2a) makes a decision point sampling-EXEMPT by IDENTITY
 * (from THIS allowlist), never by a caller-passed `arbiter`/exempt argument —
 * a gate/kill verdict is logged at effective sampling 0.0 regardless of the
 * configured sampling knob or what the caller passes. The ratchet asserts every
 * high-stakes entry is genuinely sampling-exempt.
 */

/** One PROVENANCE_REQUIRED decision point. */
export interface ProvenanceRequiredEntry {
  /** The stable decision-point identity `<component>:<decisionKind>:v1`. */
  id: string;
  /**
   * The `<component>` prefix — the FIRST segment of `id` — which MUST equal the
   * callsite's `attribution.component` (§3.2 identity-match). Stored explicitly
   * so the ratchet cross-checks it against `COMPONENT_CATEGORY` without re-parsing.
   */
  component: string;
  /**
   * High-stakes points are sampling-EXEMPT by identity (§3.2a): a gate/kill
   * verdict is never sampled out, so its audit trail is complete regardless of
   * the sampling knob. Every in-scope point in THIS increment is high-stakes.
   */
  highStakes: boolean;
}

/**
 * The wired-this-increment (highest-stakes-first, §2) decision points. The
 * §3.2 monotonic ratchet drives EXPANSION from here toward full coverage; the
 * remaining ~55 points are tracked as `deferred:ACT-562` by the discovery
 * cross-check, not listed here until wired.
 */
export const PROVENANCE_REQUIRED: ReadonlyArray<ProvenanceRequiredEntry> = [
  // The autonomous continue/stop judge — gates whether a run keeps burning
  // budget or exits (today keep-working verdicts are entirely unlogged).
  { id: 'CompletionEvaluator:continue-stop:v1', component: 'CompletionEvaluator', highStakes: true },
  // The P13 "The Stop Reason Is the Work" hard-blocker classifier.
  { id: 'CompletionEvaluator:p13-blocker:v1', component: 'CompletionEvaluator', highStakes: true },
  // The highest-consequence LLM action in the fleet: a process kill.
  { id: 'ExternalHogClassifier:process-kill:v1', component: 'ExternalHogClassifier', highStakes: true },
  // The always-on outbound gate (today only an 80-char textHead is audited).
  { id: 'MessagingToneGate:outbound-gate:v1', component: 'MessagingToneGate', highStakes: true },
];

/** O(1) lookup by decision-point identity. */
const BY_ID: ReadonlyMap<string, ProvenanceRequiredEntry> = new Map(
  PROVENANCE_REQUIRED.map((e) => [e.id, e]),
);

/** The entry for a decision-point id, or undefined if not an allowlisted point. */
export function provenanceRequiredEntry(id: string): ProvenanceRequiredEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Is this decision point sampling-EXEMPT by IDENTITY (§3.2a)? True iff it is an
 * allowlisted high-stakes point — the ONLY way exemption is granted, never a
 * caller argument. Unknown ids are never exempt.
 */
export function isHighStakesDecisionPoint(id: string): boolean {
  return BY_ID.get(id)?.highStakes === true;
}
