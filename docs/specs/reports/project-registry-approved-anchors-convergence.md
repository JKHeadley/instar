# Convergence Report — Project registry alignment anchors

## ⚠ Cross-model review: DEGRADED — ALL ROUNDS (degraded-all-rounds)

The installed Codex reviewer returned an error on its first attempt and timed out on retry. The Claude clean-door request was unavailable. Detection also found Gemini unauthenticated and Grok disabled. No external model opinion was obtained.

## ELI10 Overview

A project can recover its purpose from the owner's original message. An operator selects the message, and the registry checks that the original history belongs to the verified owner and copies the saved text into the project. A session can recover the saved purpose after a restart.

The first pilot can verify messages held on the Studio. If a verified source or matching project record is unavailable, the existing recovery behavior applies. The proposed-purpose display, cross-machine source lookup and batch approval are separate follow-up work.

## Original vs Converged

The first draft allowed a general service credential to select an arbitrary cross-conversation owner message. Review required operator selection, a bounded exact-message lookup, a current binding and version, and preservation of the previous record if saving fails. The pilot now accepts only one source reference and copies its full stored text. A curated plan and checklist workflow is excluded.

## Iteration Summary

| Iteration | Reviewers | Design findings | Changes |
| --- | --- | --- | --- |
| 1 | Security and adversarial, integration and performance, decision completeness and lessons | 5 | Require operator source designation, exact history retrieval, direct active-binding validation, rollback after save failure and explicit machine-move fallback. |
| 2 | Same internal lenses | 2 | Remove the source-only text length cap and document the inherited adapter budget and stored-text fidelity. Clarify remaining curated scope. |
| 3 | Same internal lenses | 1 | Narrow the HTTP endpoint to source-only initialization. |
| 4 | Decision-completeness delta review with prior security and integration concurrence on the narrower path | 0 | Align wording with the narrowed route. |

## Proportion

Tier 2. Four rounds of the six-round allowance.

## Left behind

Add a dedicated injected disk-write-failure regression and qualify trusted remote registry reads. The source-only pilot continues to use ordinary recovery when a required record is unavailable.

## Full Findings Catalog

- Security and adversarial, design. Owner authorship does not authorize arbitrary disclosure. Operator session selection is required before reading history. Ordinary project visibility is documented.
- Integration and performance, design. The topic-history scan can block on a large log. The pilot reuses a bounded exact lookup and treats unavailable history as a refusal.
- Integration, design. A failed legacy file save can leave an unsaved record visible in memory. The writer restores the previous record on failure.
- Integration and deployment, design. A machine move can strand source history or leave the receiving session without the record. The pilot qualifies Studio recovery and retains ordinary recovery on missing records elsewhere.
- Decision completeness and lessons, design. Direct readers must enforce active binding, and undocumented form limits must not silently shorten original text. The reader checks current binding, the single-source pilot carries the full stored message, and the curated form is outside the public write path.
- Security and integration, precision. Document that the exact quote can be visible through ordinary project reads and inherits Telegram ingress normalization. Both details are recorded.

## Convergence verdict

The Studio-only pilot converged in round 4. The final delta removed the remaining curated-form decision from the public route. The reviewers concurred on the narrower pilot. External reviewer assurance remains unavailable.
