# Convergence Report — Context-wedge seen latch

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran on the boolean-only spec. A Gemini pass was attempted but returned no usable result. The Standards-Conformance Gate was invoked and was unavailable because the local endpoint required an authorization credential not exposed to this worktree.

## ELI10 Overview

Instar already sees the real context-limit banner and already has a recovery engine. The bug is that the banner can scroll outside the small terminal view, causing the next check to forget that the trusted detector had already seen it.

The converged design remembers only `true` for that topic. It adds no clock, copied text, pattern, mapping, retry, or second engine. The same recovery engine keeps every safety decision. The value clears only after that engine reports recovery or an operator explicitly clears it.

## Original vs Converged

The original draft grew into a typed expiring cache with session identity, detector metadata, timing predictions, rollout modes, telemetry, and a new evidence schema into recovery. Review correctly stopped it at the ten-round cap. The operator's final ruling removed all four disputed dimensions at once. The converged design is true-or-absent state only, persisted by SessionRecovery's existing state owner.

The external review then tightened four statements without expanding scope: topic-key reuse is an explicit operator/manual-clear invariant rather than a new mapping heuristic; the latched-only call uses a nullable current-pattern field only for message rendering; existing attempt/cooldown brakes are named as the protection against repeated action; and tests preserve attempt rows while the boolean changes.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---:|---|---:|---|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex-cli | 5 | Clarified stable topic invariant, exact nullable-pattern seam, existing action brakes, single-writer persistence, glossary. |
| 2 | (converged) | 0 | No further body change. External rerun was attempted but degraded without a usable response; round 1 remains the successful cross-family review. |

Standards-Conformance Gate: unavailable — local route rejected the unauthenticated worktree request. Signal-vs-authority was reviewed directly: the boolean is detector memory and SessionRecovery remains the sole authority.

## Full Findings Catalog

| Finding | Perspective | Resolution |
|---|---|---|
| A durable topic-only value could attach after deliberate topic-id reuse. | adversarial / codex | Kept the operator's no-mapping ruling; documented stable topic identity and mandatory explicit clear before deliberate reuse. |
| Latched-only matched-pattern handling was ambiguous. | integration / codex | Specified `null` only for optional message rendering; no synthetic pattern or branch key. |
| Durable stale signal could repeatedly disrupt. | security / codex | Named and tested the unchanged per-session attempt cap and cooldown, which execute before every disruptive action. |
| Whole-record persistence could lose attempt state. | integration / codex | Declared the existing single SessionRecovery writer and added preservation assertions. |
| Local terminology was underspecified. | decision-completeness / codex | Added exact definitions for topic, ordinary poll, and genuine progress. |
| Foundation could repeat the detector-as-authority mistake. | lessons-aware | Confirmed the detector only sets memory and the existing SessionRecovery engine owns all decisions. |
| A timer/TTL or session mapping would violate the final ruling. | scalability / adversarial | Explicitly prohibited both; persisted shape remains true-or-absent. |

## Convergence verdict

Converged at iteration 2. The final round found no new material issue inside the operator-ratified boolean-only boundary. There are no unresolved decisions, no cheap-to-change tags, and no hidden recovery authority.
