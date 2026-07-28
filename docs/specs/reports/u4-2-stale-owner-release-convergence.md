# Convergence Report — U4.2 Stale-Owner Release

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier external passes ran in rounds 1, 2, and 4 (all MINOR); gemini-2.5-pro
passed in rounds 2 (after one timeout retry) and 4 (MINOR). Clean RAN state.

## ELI10 Overview

When one of the agent's machines dies while "owning" conversations, those
conversations strand — messages route to a dead machine. Automatically taking them
over sounds obvious, but doing it WRONGLY is worse than not doing it: a machine
that merely LOOKS dead (asleep lid, network blip) that gets its topics seized will
double-reply when it wakes. This spec is the evidence bar for taking over a dead
machine's topics safely: proof of death (not mere unreachability), exactly one
claimer, self-fencing so a half-alive ex-owner cannot double-reply, paced rescues,
and a loud operator escalation whenever the evidence is ambiguous.

## Original vs Converged

The original draft proposed a new takeover mechanism. Round 1 grounded it against
the code and reframed it as an EVIDENCE UPGRADE to the existing takeover engine,
satisfying the seven prerequisites an earlier converged spec had already ruled
necessary. Round 2 found seven material holes — the deepest: a claimant that
restarts forgets everything it observed, silently degrading auto-failover to
manual forever (fixed with a bounded bootstrap rule over the git-synced coarse
heartbeat); the staleness input was the peer's own self-reported clock (rewired to
router-observed time); the endpoint list used to prove "unreachable everywhere"
could be forged by any machine with repo push (now owner-authenticated provenance
only); and operator refusals were machine-local while the claimer role moves
between machines (a declined takeover must follow the lease). Round 3 caught that
the round-2 fix itself could not ship: the ownership record's wire validation
strictly rejects unknown fields, so the new state (suspension, budgets, refusals)
became its own additive, epoch-independent replicated record kind
(`topic-claim-annotation`) that old-version machines simply ignore — verified in
round 4 against the real receive path. Round 4: CONVERGED, no material findings.

## Iteration Summary

| Round | Reviewers | Material findings | Changes |
|---|---|---|---|
| 1 | 6 internal + codex(MINOR) + gemini(MINOR) + gate | ~5 | Reframed as evidence upgrade to the existing engine (CMT-1786 prerequisites) — commit 63329967f |
| 2 | 2 combined panels + externals + gate (2 flags) | 7 deduped | Quorum-member escalation; restart bootstrap rule; TTL-ordering invariant; replicated refusals/budgets; evidence provenance fixes; status surface — commit c50935ca4 |
| 3 | all-lens panel | 2 | topic-claim-annotation record kind (wire-layer skew fix); epoch-independence; bootstrap honesty — commit 098b30f7e |
| 4 | all-lens panel + codex(MINOR) + gemini(MINOR) | 0 — CONVERGED | none |

Conformance gate: round-2 flags (LLM-supervision tier — resolved as an explicitly
argued Tier-0 exemption with an optional offline auditor; observability — resolved
with the refusals-by-reason status surface).

## Convergence verdict

Converged at iteration 4. The round-4 panel verified every round-3 fold against
real code (including the load-bearing unknown-KIND-vs-unknown-FIELD replication
claim) and found no material findings; externals MINOR-only. Zero open questions.
Ready for approval.

Decision-completeness evidence: frontloaded-decisions 9 · cheap-tags 0 ·
contested-then-cleared 0.
