# Convergence Report — Skill-driven sign-in repair (simple version)

**Spec:** [docs/specs/skill-driven-signin-repair.md](../skill-driven-signin-repair.md) (198 lines)
**ELI16:** [docs/specs/skill-driven-signin-repair.eli16.md](../skill-driven-signin-repair.eli16.md)
**Status:** **NOT CONVERGED — the confirming round was not design-quiet.** No `review-convergence` tag was written. `approved` is not set.
**Rounds this pass:** 2. That was the operator-scoped budget: one round plus one confirming round. An earlier 10-round review of a heavier design hit the cap. The operator then chose this simpler version ("Yes, please proceed with your recommendations").

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier pass ran in both rounds. Both times its verdict was SERIOUS ISSUES, and much of that was a request to bring back runtime floors the operator deliberately removed. The internal perspectives ran as one combined reviewer per round, which the coordinator allowed. The Standards-Conformance Gate ran in both rounds.

## ELI10 Overview

The automatic sign-in repair has never worked, because its fixed page rules trip over real sign-in pages. An ordinary agent session following the written guide fixed both Laptop accounts in about ten minutes.

This spec makes that the repair. On a Mac, a short-lived helper session follows the guide, types passwords itself after checking where the cursor is, and keeps to four hard lines. The server keeps the parts that must be exact:

- one helper per machine;
- starting the login;
- a single door for the final code;
- deciding success, which needs the login to finish, the email to match and a real call to work.

It also fixes a second problem: Codex accounts that looked active while signed out. Pool status will now come from the Codex or Claude program's own login check.

## Original (simple draft) vs after review

- **Rollout safety.** Approval is forced on this path until graduation. The live config had unattended mode on, so the "approval first" bound would otherwise have been false.
- **Helper pinning.** The helper is pinned explicitly to its account, for both Claude and Codex. The existing resolver pins Claude only and cannot exclude the account under repair.
- **Codex authentication.** For Codex, only a live app-server read counts as authenticated use or health. The rollout-file fallback was the reason signed-out accounts looked active.
- **Signed-out detection.** A new explicit rule: signed-out only when the CLI check and an auth refusal (not a transport error) agree on two consecutive polls. The ledger had no such rule.
- **Lease.** The one-per-machine lease is acquired before the attempt counts, and renewed past its 10-minute TTL. The service tick starts episodes without waiting on them, so notices keep flowing during a helper run.
- **Code route.** It became a strict tagged union (`code` once, or an idempotent `notify: phone-tap`). The phone-tap notice is a named kind with its own handler.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|--------------------|-----------------------|
| 1 | combined internal (5 design), codex (SERIOUS: 5) | 5 internal (+ codex overlap) | 4 | Admission/approval gate, helper pin, Codex auth source, pool-health via ledger, breaker wording, failure class |
| 2 (confirming) | combined internal (2 design), codex (SERIOUS: 5) | 2 internal | 2 | Applied **after** the round, not re-reviewed: detached tick, a new explicit signed-out rule, lease acquire/renew, tagged-union route, notice kind handler, alternatives section |

Standards-Conformance Gate:
- **Round 1:** ran, 2 flags (Structure beats Willpower, Judgment Within Floors).
- **Round 2:** ran, 2 flags (the same two).

Both flags concern the helper's hard lines being enforced by the skill rather than by code. That is the operator's explicit trust decision (Frontloaded Decision 2), bounded by approval being forced until graduation.

## Remaining findings

**Round 2 internal findings, fixed in text after the round and not yet re-reviewed:**
- The tick claim was false against the code. The spec now makes the detached tick a stated change.
- The ledger had no rule to turn a signed-out reading into `needs-reauth`. A two-poll rule is now specified.
- The seat lease was only checked at approval, never held.
- The phone-tap notification kind had no handler.

**Codex round 2, not adopted:**
- Enforceable containment for the helper (a tool allowlist, a scoped vault API). Declined; it contradicts the operator's trust choice.
- A full per-module implementation-delta section. Deferred to the build.
- Non-empty open questions. Declined; the alternatives are now listed and the operator decided.

## Convergence Verdict

Not converged within the two rounds. The remaining design findings were code-grounded gaps, and they are now fixed in the text. They are local, and none reopens the architecture.

One more confirming round on the current body is the natural next step. If it comes back design-quiet, the tag can be written with the skill's script. The operator decides whether to run it. `approved: true` remains the operator's step.
