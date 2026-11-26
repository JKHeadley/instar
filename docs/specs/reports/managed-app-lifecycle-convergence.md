# Review report for managed browser and application lifecycle

## ⚠ Cross-model review degraded across all attempts

Three Codex reviewer calls returned two timeouts and one execution error. They returned no findings because the reviews did not complete. Gemini was unauthenticated and the separate Anthropic reviewer was unavailable. This report records the independent internal reviewer findings and the automated standards results.

## Overview

Instar will keep track of the apps it opens and who needs them. A machine will check its configured capacity before starting a new managed app. The app can close after its work finishes, and an hourly check catches missed cleanup.

A shared browser or an app with uncertain ownership stays open. Echo will first observe what the system would do, then prove the checks with real disposable apps before enabling cleanup.

## Iteration summary

| Round | Input | Changes |
| --- | --- | --- |
| 1 | Independent security, adversarial, integration, performance, decision completeness and lessons review. Standards check timed out. | Added an exclusive, identity-bound close path, generation fencing, atomic launch reservations, safe shared-profile behavior, host cap scope, cross-platform integration, and maturation evidence. Reused Machine Care inventory. |
| 2 | Follow-up security and standards reviewers. Automated inspector checked 102 standards and flagged four possible violations. | Clarified policy and expiry precedence, removed lifetime renewal counts, added adaptive scan budget and increasing backoff, distinguished admission from cleanup, and bound the graduation review. |
| 3 | Independent decision-completeness and lessons review approved the revised expiry, policy and maturation rules. | Tightened the installed Playwright path and same-session expiry proof. |

| 4 | Standards review raised descendant budget, renewal authority, attribution, constitutional traceability and standalone explanation. | Added resource containment, owner-delegated bounded grants, incident references, and launch terminology. Integration and security reviewers ratified the launch model with real browser and platform proof required before Echo enforcement. |
| 5 | Standards review raised root count judgment, total close attempts, measurements, and simplicity. | Named the binding owner ceiling, budgeted retry episodes across sweeps, added pre and post process and memory readings, and reused the Machine Care authority. |
| 6 | Standards review raised refusal visibility, seat cross-store coherence, role-based maturation, and exact attribution. | Returned a typed refusal to the caller, made the existing seat lease authoritative with a matching attachment and close gate, retained role-based fleet graduation, and linked the direction to the handoff. |

## Findings resolved

- A verified launch handle is required through close. LaunchServices profile discovery and old ledger rows remain signals for inventory. A lower cap blocks new starts while current work continues.
- Broker generation and authenticated session and task identity govern events. Closing denies new borrows or renewals. A stale callback cannot resurrect a finished lease.
- Every enrolled adapter reserves capacity before launching. Missing or corrupt policy on a previously enrolled host holds starts and closes while the fault is recorded.
- An expiry triggers reconciliation. The session and borrower checks, verified identity and current save and download safeguards govern closure.
- The sweep budgets native work, persists a fair cursor and backs off repeated failures. Existing Machine Care status distinguishes observed candidates and actual outcomes.
- Maturation moves from isolated test to Echo observation and enforcement before a separate fleet graduation. It has a weekly evidence review.

## Experience fit

An ordinary task ending should clear its own app without operator action. An active login in a shared browser should stay open and tell the reader why. The Studio process inventory showed why a name or profile flag alone cannot distinguish the two. The verification plan covers a disposable managed launch, shared or protected work, and an unidentified external process through the existing Machine Care view.

## Verdict

The final internal verification found no material blocker after the changes. The automated post-round-six recheck raised three observations. Structural capacity coverage is now a graduation gate, parked launches get bounded read-only recovery probes, and the promotion receipt includes held-slot time and launch availability. The independent standards reviewer verified those dispositions and the matching seat-generation contract. The review converged with degraded external assurance. Platform containment and one real installed browser adapter on Echo are rollout gates, with no reliance on disposable fixtures alone.

## Deferred precision

The build must establish native descendant containment and the Playwright connector with the real installed configuration. The separate scheduler and restart proof work is tracked in the stewardship cadence plan.
