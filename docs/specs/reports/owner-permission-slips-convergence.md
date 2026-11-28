# Sign a finite permission slip from chat review

## Outcome

The draft makes chat a proposal source and the paired Instar app the authority for one exact signed card set. The current work-card path is serial and its tap wake is not a multi-card authorization transaction. All six example cards were read from the live board and reported Not Started. No card was changed.

Convergence failed at the Tier 2 six-round cap. No convergence tag or implementation approval was issued.

## Review record

Three independent internal reviewers covered security, adversarial, integration, scalability, decision completeness and lessons. The authenticated Codex CLI reviewer used gpt-6.2-astra. Dashboard and Apple received the drafts for coordination.

| Round | Standards check | External verdict | Revision or outcome |
| --- | --- | --- | --- |
| 1 | Ran; 4 flags | SERIOUS ISSUES | Defined atomic approval against current revisions, one terminal action, cross-path idempotency, and durable per-item projections. |
| 2 | Ran; 4 flags | SERIOUS ISSUES | Defined stale-owner and stop/apply behavior, provenance per independent set, abrupt loss recovery, and exact race outcomes. |
| 3 | Ran; 3 flags | SERIOUS ISSUES | Persisted the accepted source grouping before links, fenced tentative decisions from workers, and separated stale dismissal from approval. |
| 4 | Ran; 4 flags | SERIOUS ISSUES | Added distinguishable card displays, terminal already-approved-independent status, and measured envelope plus topology instead of a copied console count. |
| 5 | Ran; 4 flags | Initial timeout; retry SERIOUS ISSUES | Clarified quorum-committed receipt reads, recorded independently approved items, and bound Stop to the still-pending intersection of the signed set. |
| 6 | Ran; 5 flags | SERIOUS ISSUES | Stopped at the review cap with three outstanding design issues. |

## Remaining design findings

- Retain the already-approved-independently state and make it a required end-to-end outcome. Prove both ordinary-tap/slip race orderings and lost reply produce exactly one WorkCard event and one set of projections attributed to the winner. The final external reviewer still reported ambiguity despite the draft naming the terminal state.
- A correction changing the number or membership of independent slips must name and atomically retire every affected pending predecessor. Specify the race with an already signed predecessor and test two-to-one regrouping against approval.
- Record a structured, redacted grouping decision for accepted sets and uncertain correction proposals. Include authenticated context references, signals considered, the applied rule and its outcome. Give the owner an actionable clarification without logging raw chat.

The internal round-six reviewers found no new security or adversarial issue within the stated witnessed topology. The unresolved external findings remain material to the owner experience and authority contract. The fleet has not been shown to supply the required independently durable journal or equivalent.

## Release posture

Keep existing approvals and production QR behavior. No implementation, deployment, or use of live approval authority was performed under this review.
