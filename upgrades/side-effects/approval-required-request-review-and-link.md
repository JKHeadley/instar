# Side-effects review — approval-required: request the review, hand back the link

**Change:** when the base branch requires a human approval that `--admin`
cannot bypass (ruleset `pull_request` rule: `require_last_push_approval` /
`required_approving_review_count`), `safe-merge` now (a) reads the ruleset
BEFORE merging, (b) requests the operator's review itself, (c) returns a
distinct `refused:approval-required` result carrying the direct Files-tab
`reviewUrl`, and (d) classifies GitHub's non-pusher refusal text on the merge
path the same way. The green-PR watcher treats the new slug as
terminal-non-ladder and posts ONE attention line with the link. The agent
playbook (SKILL Phase 7 + the CLAUDE.md Green-PR section, with a migration)
says: send the link, merge when approved, never loop, never ask the operator
to request a review.

**Files:** `scripts/safe-merge.mjs`, `src/monitoring/GreenPrAutoMerger.ts`,
`src/core/PostUpdateMigrator.ts` (CLAUDE.md section + re-sync condition),
`skills/instar-dev/SKILL.md`, tests.

**Tier:** 1. Risk floor 1 — at the floor. Dev-cycle infrastructure; adds a
refusal-with-a-link, removes no authority, bypasses nothing.

**Origin:** 2026-08-22 — PR #1963 green but refused ("New changes require
approval from someone other than the last pusher") under a ruleset tightened
at 17:03 PDT; the operator met a reviewer-less PR ("waiting for someone to
request your review") and had to ask in chat for the review to be requested.
Operator feedback: the flow must be link → approve and nothing else.

---

## 1. Over-block — what does this now refuse that it should not?

A PR on a branch whose ruleset requires a review, where `reviewDecision` is
not `APPROVED`, is now refused BEFORE a merge attempt. That is correct — the
merge would have been refused by GitHub anyway — and the refusal now carries
the request + link instead of a failed command. Over-block risk: a ruleset
that lists `pull_request` with `required_approving_review_count: 0` AND
`require_last_push_approval: false` is correctly treated as no policy
(tested). A PR already `APPROVED` is not refused. A repo with no rulesets (404)
is treated as no policy (same as the classic-protection 404 path).

## 2. Under-block — what does it still miss?

- A review requirement expressed ONLY in classic branch protection was already
  handled by the existing `refused:reviews-required` path; that path does NOT
  request a review or emit a link. Left as-is (unchanged behaviour, named here).
- Teams-as-reviewers (`team_reviewers`) are not supported; only user logins.
- If GitHub rejects the request (e.g. the only resolvable reviewer is the PR
  author, or the token lacks permission), the result carries `requestError`
  and the link is still emitted — the operator can still approve via the
  link; the request is a convenience, not the gate.

## 3. Level-of-abstraction fit

The ruleset read and the review request belong in `safe-merge` because it is
the act-time authority every merge path funnels through (the watcher, the
skill, humans). Putting it in the watcher alone would leave the skill's manual
`safe-merge` invocation (tonight's path) unfixed. The watcher change is
limited to recognising the slug and messaging; the authority stays in one
place.

## 4. Signal vs authority compliance

This adds NO blocking authority: the block was already GitHub's. It converts a
generic failure into a classified refusal that carries an actionable signal
(the link) and performs one benign, idempotent side effect (requesting a
review). The watcher's handling is message-only and terminal-non-ladder.

## 5. Interactions

- **MergeRunner:** `parseResultLine` keeps only the slug; the watcher
  reconstructs the URL from `cfg.repo` + PR number, so no contract change to
  the result-line parser is needed.
- **Ladder:** `refused:approval-required` is handled BEFORE `applyOutcome`, so
  it never feeds the breaker or increments attempts (asserted).
- **Existing `refused:reviews-required` path:** runs first (classic
  protection); unchanged.
- **Dedup of attention lines:** `refreshAggregate` owns dedup; the message is
  keyed by PR number like the auto-arm-unavailable line.

## 6. External surfaces

- A review request appears on the PR (GitHub notification to the operator).
  This is the intended, operator-requested behaviour.
- `safe-merge --capabilities` advertises `approval-required-refusal` and
  `request-review-from` so orchestrators can key on them.
- New CLI flag `--request-review-from <login,…>`; default = repo owner.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: `safe-merge` is a CLI acting on GitHub (the shared
source of truth); the watcher already runs on the lease holder only. A
second machine running the same PR would request the same reviewer — GitHub
treats re-requests as no-ops. No replicated state, no user-facing notice
beyond the existing single attention aggregate.

## 8. Rollback cost

`git revert`. No stored state. Rolling back the migrator change leaves an
extra CLAUDE.md bullet on migrated agents (harmless prose).

## Framework generality

Not framework-related: GitHub merge mechanics, identical for every agent
framework.

## Phase 5 — second-pass review

Not run (standing operator directive against spawning subagents); trace
records `secondPass:false`; causal autopsy supplied.
