# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Two new constitutional standards are now in the registry and enforced (Stage 1 of the autonomy-governance work):

- **P13 "The Stop Reason Is the Work"** — when an autonomous run would stop because it "needs a judgment call" or "needs real engineering," that stop is now treated as a work item, not an endpoint. The autonomous stop-hook consults an independent guard (the completion evaluator) before letting a run end on a completion/promise; a stop resting on a judgment-or-engineering deferral keeps working instead. A message-layer rule (B18) backstops it, and a migration ships the updated hook to existing agents. The guard fails open — it never traps a genuine completion.
- **Constitutional Traceability "No Unconstitutional Work"** — every spec must now name the constitutional standard it serves with a resolvable parent. The pre-commit gate enforces the structural half (the spec's parent-principle must resolve to a real registry article); the standards-conformance reviewer adds a fit verdict (fit / weak / none) at review time. Both fail open when the reviewer is unavailable, so they never block work by being down.

Stage 1 ships the standards plus their enforcement and tests; the approval-as-data ledger and the auto-approval pilot are later phases of the same spec.

## What to Tell Your User

- **Steadier autonomous runs**: "When I'm working on my own, I won't quietly bail citing 'I need your call' or 'this needs real engineering' — those are now treated as the next thing to do, so I keep making progress and only stop for a decision that's genuinely yours."
- **Work that stays anchored**: "Every change I propose now has to trace to one of our written principles. If something doesn't clearly fit, I pause and we either grow the rulebook to cover it or recognize it shouldn't ship — so the project grows coherently instead of drifting."

## Summary of New Capabilities

- P13 "The Stop Reason Is the Work" constitutional standard, its primary stop-hook enforcement (the completion evaluator's stop-rationale guard), the B18 message-gate backstop, and a migration that ships the updated hook to existing agents.
- Constitutional Traceability standard, a blocking commit-time parent-resolution check in the pre-commit gate, and a review-time fit verdict on the standards-conformance reviewer.

## Evidence

- 105 tests across all three tiers (unit, integration, e2e); type-check clean.
- The full-suite verification caught and fixed two test regressions before merge: the new traceability check had blocked unrelated deferral-test fixtures (no parent-principle), and a migration-marker assertion needed updating to the new marker.
- Spec: docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md (approved). Side-effects review: upgrades/side-effects/autonomous-operation-judgment-and-approval-as-data.md.
