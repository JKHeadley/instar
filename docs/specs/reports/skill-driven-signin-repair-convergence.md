# Convergence Report — Skill-driven sign-in repair (simple version)

**Spec:** [docs/specs/skill-driven-signin-repair.md](../skill-driven-signin-repair.md)
**ELI16:** [docs/specs/skill-driven-signin-repair.eli16.md](../skill-driven-signin-repair.eli16.md)
**Slug:** `skill-driven-signin-repair`
**Status:** Converged at iteration 5 of the simple-version pass. Rounds 4 and 5 each had zero design-class findings from the internal reviewers. Round 5's cross-model verdict was MINOR ISSUES.
**History:** An earlier 10-round review of a heavier design hit the cap without converging. The operator then chose this simpler version ("Yes, please proceed with your recommendations") and directed a one-round-plus-confirmation pass, extended to at most two more rounds.

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier pass ran in every round of this pass. Its verdicts by round were SERIOUS, SERIOUS, SERIOUS, SERIOUS and MINOR.

In every round codex asked for enforced containment of the helper: a password or click wrapper, a tool allowlist, a scoped vault and process-bound tokens. Those requests were **declined by operator decision**. The operator chose a trusted-local-operator helper (Frontloaded Decision 2). The declined option is recorded in the spec's Alternatives section as a deferred middle ground, to be added if Rung 1–2 evidence shows the helper misusing a secret or a window.

Two disclosures:

- **Combined reviewer.** The six internal perspectives ran as one combined reviewer per round, which the coordinator permitted.
- **Round 4's cross-model factual finding.** In round 4, codex flagged a factually wrong rollback claim ("no transition added"). By the skill's taxonomy that is design-class, and it was fixed before round 5. So by the strictest reading, only round 5 was fully design-quiet across every reviewer.

## ELI10 Overview

The automatic sign-in repair has never worked, because its fixed page rules trip over real sign-in pages. An ordinary agent session following the written sign-in guide fixed both Laptop accounts in about ten minutes.

This spec makes that the repair. On a Mac, a short-lived helper session follows the guide and types passwords itself after checking where the cursor is. It keeps to four hard lines and is treated as a trusted operator, just like the hand-run sessions. The server keeps the exact parts:

- **one helper per machine**, held by a lease, with the operator approving each repair at first;
- **starting the login**, and one small door for the final code;
- **deciding success**: the login finishes, the email matches, and a real call works.

It also fixes signed-out Codex accounts that looked active. Status now comes from the programs' own login checks, plus a live authenticated read.

## Original (simple draft) vs Converged

- **Approval is forced on this path until graduation.** Echo's live config has unattended mode on.
- **The helper is pinned explicitly** to a healthy account, Claude or Codex, never the one under repair.
- **For Codex, only a live app-server read counts as authenticated.** A signed-out account is flagged only when the CLI check and a real auth refusal agree on two polls in a row. Claude's existing paths are unchanged.
- **The one-per-machine lease is taken before an attempt counts.** It is renewed past its 10-minute lifetime. Waiting for the lease does not use up the operator's approval, thanks to a new `extendApproval` store method. The service tick no longer blocks on a helper.
- **The code route became a strict tagged union**: `code`, `phone-tap` and `macos-permission`. It uses a loopback-only 32-byte token and a 1 KB body cap.
- **Notices are keyed per attempt**, so a second notice in one episode is not deduplicated away. `no-healthy-seat` goes to the operator's phone Sign-in path.
- **Restart and rollback behaviour is stated exactly**, including the additive store changes.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|--------------------|-----------------------|
| 1 | combined internal; codex SERIOUS | 5 | 4 | Forced approval, helper pin, Codex auth source, ledger routing, breaker wording |
| 2 | combined internal; codex SERIOUS | 2 | 2 | Detached tick, explicit signed-out rule, lease acquire/renew, tagged union, notice kind |
| 3 | combined internal; codex SERIOUS | 5 | 0 | Pre-attempt check in the approved branch, `approved → waiting-operator-only`, macos-permission notify, existing needs-reauth paths kept, restart outcome, token spec |
| 4 | codex (factual rollback claim) | 0 internal (1 codex factual) | 2 | Approval extension during waits, operator-only row clearing, rollback list, `loginCheck: 'unavailable'` |
| 5 | none | 0 | 3 internal + codex MINOR | `extendApproval` store method, per-attempt `deliveryKey`, hard-line wording, CORS wording, focus-race residual |

The Standards-Conformance Gate ran in rounds 1–5. Each round raised 2 flags, Structure beats Willpower and Judgment Within Floors, and both concern the operator's trust decision (FD2): the helper's hard lines are held by the skill, not by code.

## Full Findings Catalog (condensed)

**Round 3 (internal, all fixed):**
- The lease-held wait had no valid transition.
- A retry of a forced-approval episode could not be re-run.
- Phone-tap notices fired once per episode, not per attempt.
- The macOS permission notice was unreachable.
- The claim that "the ledger has no rule" was wrong; Claude's existing paths are kept.

**Round 4 (internal, precision):**
- Approval expiry during a lease wait.
- A second operator-only notice was dropped.

**Round 4 (codex, factual):** the rollback claim was fixed.

**Round 5 (internal, precision, all fixed):**
- `extendApproval` was missing from the store.
- The deliveryKey deduplication made notice-row deletion ineffective.
- FD4's count of failure classes was wrong.

**Round 5 (codex, minor, all addressed in text):**
- Hard-line wording.
- A capacity race, now bounded as `seat-busy`.
- CORS wording.
- A focus-race residual.
- Degraded rollback notice wording.

## Convergence Verdict

Converged at iteration 5. The final two rounds produced zero design-class findings from the classifying reviewers, and round 5's cross-model verdict was MINOR ISSUES. One caveat: round 4's codex pass flagged one factual error, which was fixed. The only recurring objection, enforced containment of the helper, is the operator's explicit trust decision.

The spec is ready for the operator's review. `approved: true` is the operator's step.
