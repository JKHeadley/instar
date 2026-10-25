# Side-Effects Review — the direction guard accepts the operator's GitHub review

**Version / slug:** `direction-guard-review-approval`
**Date:** `2026-08-22`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli — 4 adversarial rounds on the design (spec: docs/specs/standards-approval-via-github-review.md)`

## Summary of the change

The constitutional direction guard accepted exactly one proof that a change to `docs/STANDARDS-REGISTRY.md` was approved: an Ed25519 signature over the exact article bytes, verified against a key pinned in the repository. That key shipped as an empty placeholder, so **no registry change merged between the guard landing on 2026-08-17 and 2026-08-22** — including the operator's own five ratified amendments (#1960). This adds a second accepted proof: an approving GitHub review from the repository owner, on the exact head commit. Path A is untouched. Files: `scripts/standards-direction-guard.mjs` (new `evaluateOperatorReviewApproval`, plus a `reviewApproval` input to `evaluateStandardsDirection`), `scripts/standards-coverage.mjs` (reads the review context from a file the workflow writes), `.github/workflows/ci.yml` (a step that fetches the reviews from the API).

## Decision-point inventory

- `evaluateOperatorReviewApproval` (new) — **add** — decides whether an owner approval is present, current and unwithdrawn. Pure; no I/O.
- `evaluateStandardsDirection` per-article decision — **modify** — a changed article may now be satisfied by path B as well as path A.
- CI `Fetch operator review context` step — **add** — supplies the evidence. Cannot fail the job.

## 1. Over-block

The added path only ever turns a refusal into an acceptance; it cannot refuse anything path A previously accepted. A signed ratification is still checked first and still wins. The one way this could over-block is if the new CI step failed the job — it cannot, because it tolerates API failure and writes an empty context, which the guard reads as UNAVAILABLE rather than as an error.

## 2. Under-block

**This is the section that matters, and the honest answer is that the code does not carry the security.** An adversarial review of the first draft established it: the agent authors this file and the workflow that runs it, and (before 2026-08-22) could push directly to `main`. So a version of the agent that wanted to bypass this would edit it, not defeat it.

What actually blocks that is the repository ruleset the operator applied on 2026-08-22 — require-PR on `main`, `require_code_owner_review`, `bypass_actors: []` — plus `.github/CODEOWNERS` naming the operator on `docs/STANDARDS-REGISTRY.md`. Those need admin rights the agent does not hold (verified: a ruleset write returns 404 for its identity). **This change is legibility on top of that, not a lock.** Removing it would not remove the protection.

Within its own scope it under-blocks in one named way: it verifies that an approval exists on the reviewed head, not that the bytes reaching `main` are those bytes. A moved base or a merge commit can differ. Mitigation is a platform setting (require branches up to date), recommended in the spec and not assumed here.

## 3. Level-of-abstraction fit

The decision lives beside the existing signature check, in the function that already owns "is this article's change approved?". The evidence-gathering lives in the workflow, so the script stays pure and testable and performs no network I/O. No new file, no new invocation point.

## 4. Signal vs authority compliance

Compliant, and the change makes the split more honest than before. The script is a SIGNAL that reports which articles changed and whether an approval is attached. The AUTHORITY is the ruleset, which the agent cannot alter. The previous arrangement blurred this by describing an agent-authored check as the thing preventing self-amendment; the spec and the code comments now say plainly that it is not.

## 4b. Judgment-point check

No judgment point is added. Every predicate is a deterministic comparison — login equality, sha equality, state string, timestamp ordering. No model is consulted, and nothing infers intent from prose.

## 5. Interactions

- **`.github/CODEOWNERS`** (merged in #1962) is what makes the review exist at all: it causes GitHub to request the operator automatically. Verified live — pushing to #1960 auto-added `JKHeadley` as a reviewer and the PR went to `blocked`.
- **`docs/STANDARDS-DIRECTION-GUARD.md`** describes path A as the only proof. It is now incomplete; updating it is tracked, not done here, and named rather than left silent.
- **The `standards-coverage` report** gains `directionGuard.reviewApproval` and a per-change `approvedVia`, so a reader can tell which proof was used.

## 6. External surfaces

One outbound call, from CI only: `GET /repos/{owner}/{repo}/pulls/{n}/reviews` using the workflow's own `github.token`. Read-only, no secrets beyond the ephemeral job token, and it never runs outside a `pull_request` event. No agent-side runtime surface, no route, no message.

## 6b. Operator-surface quality

The operator's experience is three taps on a PR GitHub already asked them to review. The failure text names which proof is missing and, when the review path is unavailable, why — so a red check says "waiting for Justin" rather than something cryptic.

## 7. Multi-machine posture

`unified` — trivially. Pure functions plus one CI-side read; no durable state, no per-machine state, no generated URL, no notification. Identical on any machine over the same inputs.

## 8. Rollback cost

Near zero and additive to revert: delete the new function, the `reviewApproval` parameter, the CI step and the test, and the guard is byte-equivalent to today's behaviour. Because the ruleset carries the security, a revert does not reopen a hole — it only makes the pipeline less informative and returns the operator to needing a key.

## Conclusion

Ship. It converts a guard nobody could satisfy into one the operator can satisfy in three taps, adds no authority, has no runtime or agent-facing surface, and is covered in both directions by 17 tests. The honest caveat, repeated because it is the point: the security is the ruleset, not this code.

## Second-pass review

The DESIGN was adversarially reviewed over four rounds (5 → 3 → 1 → 0 security findings) before any of this was written; round 1 was invalidated wholesale and the design rewritten around its central finding. Record: `docs/specs/standards-approval-via-github-review.md`. The implementation follows that converged design.

## Evidence pointers

- `tests/unit/standards-direction-review-approval.test.ts` — 17 tests. Both directions per arm: accepted on head; refused on an earlier commit; refused after withdrawal; refused on dismissal; **accepted on re-approval after an objection** (so a resolved objection cannot block forever); refused for a non-owner; refused for self-approval; refused for `COMMENTED`; unavailable (not permissive) for an organization owner; fails closed on a missing list, a malformed sha, an absent login, and an unparseable timestamp.
- Composition tests assert that an unavailable context is not-approved *and names why*, and that an unchanged registry produces no fabricated change to approve.
- Pre-existing local failures in `standards-coverage-ratchet.test.ts` (2) were verified to fail identically on clean `upstream/main` with this work stashed — a local git-ref artifact, not a regression from this change.

## Class-Closure Declaration (display-only mirror)

The class is "a guard that cannot be satisfied, and is therefore not a guard." Closed here for the constitution: the operator now has a reachable proof. It is NOT closed generally — the same shape exists wherever a check depends on a credential nobody has created, and the dashboard-PIN finding (a dozen routes documented as operator-only, gated on a secret the agent reads) is the same class from the other direction. Tracked separately, open.
