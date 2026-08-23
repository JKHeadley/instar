# Side-effects review — path B: ratification via GitHub code-owner review

Change: `scripts/standards-direction-guard.mjs` (+`verifyGithubReviewApproval`,
`applyGithubReviewRatification`), `scripts/standards-coverage.mjs` (top-level
resolution + application + reporting), `.github/workflows/ci.yml` (GITHUB_TOKEN
env on the coverage step), tests + REAL captured fixture.

Driven by the converged spec `docs/specs/standards-approval-via-github-review.md`
("The check, precisely", steps 1–5), which the operator chose over the held-key
path on 2026-08-22.

## 1. Over-block

Path B can only REMOVE a class of failure, never add one. Every uncertainty
returns UNAVAILABLE and leaves the signature path governing — the exact
behavior of yesterday. Residual over-block: an approval on a stale head, a
withdrawn approval, an org owner, an owner-authored PR all stay red. All are
correct per spec. No issue identified.

## 2. Under-block

The narrowing matters here and is deliberate: an accepted review clears ONLY
the "requires an independently signed direction ratification" class (articles
with NO ledger entry). A present-but-invalid signature entry — forged, stale
binding, duplicate — KEEPS its error even with an approving review, because
something claiming to be a signed ratification and failing verification is
worth stopping for, not papering over. This is stricter than the spec's
sentence ("every changed article is approved"); recorded in the function's
docblock so the narrowing reads as a decision.

Vocabulary drift fails closed: an unrecognized review state counts as a
withdrawal, never as an approval.

## 3. Level-of-abstraction fit

Correct layer. The verification lives in the guard module beside the signature
path it complements; the coverage script only resolves-once and applies. The
alternative — a separate workflow writing a marker file — adds an
agent-writable handoff for zero gain. Rejected.

## 4. Signal vs authority

The check REMAINS non-blocking machinery ("Standards Enforcement Coverage" is
not a required status check); the binding authority is the repository ruleset
(require_code_owner_review + require_last_push_approval), which the agent
cannot edit — verified live against the ruleset API, not assumed. The spec
says in as many words that the in-repo guard is not the security boundary;
this change does not move it toward being one.

## 5. Interactions

- The signature path is untouched and still governs whenever path B is
  unavailable or not accepted. A valid signed ledger continues to work.
- The dangerous-command merge hook and safe-merge read check CONCLUSIONS, not
  guard internals — when this check greens after approval, both release.
- Re-run semantics: reviews are fetched LIVE, so an approval submitted after a
  CI run is seen on re-run. No workflow trigger was added — deliberately: a
  `pull_request_review` trigger re-running heavy jobs with `if:` skips would
  let a skipped check-run conclusion mask an earlier red one (latest-run-wins),
  which is a real hole. The documented flow is operator approves → the check
  is re-run → greens.

## 6. External surfaces

One new read-only API call (PR reviews list) in CI, authenticated with the
run's own token. No user-visible surface changes. The coverage stderr gains
one line naming which ratification route governed — legibility, per spec.

## 7. Multi-machine posture

Machine-local BY DESIGN and trivially so: this code runs in CI on GitHub's
runners, keyed entirely on the event payload of the PR being checked. No agent
machine state is read or written. No replication surface exists.

## 8. Rollback cost

Revert the commit. The guard returns to signature-only, the check returns to
red on constitutional PRs, and the merge machinery correctly holds again —
the failure direction of the rollback is refusal, not exposure.

## Phase 5 — second-pass review

Reviewer: an independent subagent (required — this touches gate machinery),
dispatched with the diff and the spec section, NOT with this artifact's
conclusions. Result appended below after its pass.

### Second-pass result (independent subagent, 2026-08-22)

**Concern raised, two confirmed defects — both fixed in the same pass, each
with the test that would have caught it:**

- **(A) The per-article proof stamping never fired in production.** The marking
  keyed on `approvedBy === undefined`, but serialized changes normalize it to
  `null` — so spec step 5 (record which proof, per article) was unmet at
  runtime, and the unit test missed it because its hand-built fixture omitted
  the key. Fixed: the discriminator is now the cleared errors' own article ids,
  so exactly the cleared articles are stamped and a failed-validation article
  can never be mislabeled. New integration-shaped test runs the marker against
  REAL `evaluateStandardsDirection` output.
- **(B) `owner.login` was unvalidated** — an event payload with an absent login
  plus a userless review collapsed to `undefined === undefined` and ACCEPTED
  (executed by the reviewer). Outside the threat model (the event file is
  GitHub-written) but the exact type-confusion class the review hunted. Fixed:
  every identity field is type-checked before comparison; userless reviews are
  skipped; both pinned by tests.

Also adopted from the review: a 30s per-request timeout on the fetch, and a
least-privilege `permissions:` block on the CI job — now REQUIRED by the Root
self-wiring pin, so removing it fails the constitution's own wiring check.

Reviewer's residual notes, accepted as-is: the fetch runs once per PR CI run
regardless of whether articles changed (cost, not a hole — every failure
direction is UNAVAILABLE); the clearing regex is brittle-but-sound against the
enumerated error vocabulary (a future error reworded to end in the exact
phrase would join the clearable class — flagged in a comment at the constant).
