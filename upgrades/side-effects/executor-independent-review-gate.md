# Side-Effects Review — feedback executor: independent review admits a fix PR to merge

**Version / slug:** `executor-independent-review-gate`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `required (merge authority) — see below`

## Summary of the change

The executor's review gate (spec §4 step 9) admitted a PR to `safe-merge --auto --match-head-commit` only on the repository owner's GitHub approval of the exact head. On the operator's directive (topic 18330, 2026-10-21 12:27 PDT; repeated 2026-10-23 09:17 PDT), a second route admits a head: a cross-family reviewer (codex/gemini) AND the Claude clean-door reviewer both answer CLEAN or MINOR ISSUES to a fixed safety-only prompt over the PR diff.

- `independentReview.ts` (new): prompt (`buildExecutorReviewPrompt`), rule (`judgeIndependentReview`), refusal classification (`reviewRefusalIsAboutTheChange`), PR comment (`renderReviewComment`), `REVIEW_DIFF_MAX_BYTES` = 192 KB.
- `FeedbackExecutorService.independentAdmission`: runs after the owner-approval check in `reconcilePr`; judges each head once (`reviewSha`/`reviewVerdict`/`reviewReason`/`reviewedAt` on the row); refusal about the change → PR comment, row stays `pr-open` with reason `review-failed:<reason>` (so owner approval, a new push, merged-elsewhere and pr-closed all keep working) and one action-list line; reviewer away → `reviewVerdict: 'retry'`, asked again after `MERGE_RETRY_DELAY_MS` when `degraded`, after `DAY_MS` (+ one degradation report) when `unavailable` (the owner route is untouched either way); a throwing port → a degraded outcome, never an aborted tick; the PR's files (from GitHub, `prFiles`) matched against the canonical checkout's `.github/CODEOWNERS` by `codeownersOwned` (ANY owner) → never admitted here.
- `GitHubGateway.prDiff` / `.prFiles` / `.comment` (gh `pr diff`, `pr view --json files`, `pr comment --body-file`). `reviewGate.codeownersOwned` (any-owner matcher beside `codeownersOutsideApprover`).
- `ExecuteLiveConfig.reviewGate: 'independent' | 'operator'` (default `independent`).
- `buildFeedbackExecutor`: the production port runs `runCrossModelReview` once per family (`codex-cli`, `gemini-cli`, `claude-code`) with the agent's reviewer config and per-family timeout.
- Store: four columns added in place (`ALTER TABLE` on a database that predates them).

## Decision-point inventory

One new LLM decision point: the independent review (two reviewer calls per head, each a verdict). Its outcome is graded `executor-independent-review-passed` (right, weak) on a pass; a refusal is recorded in the audit (`execute:independent-review`) with every reviewer's status and verdict. Enrolment in the decision-quality meter is a follow-up (CMT noted below).

## 1. Over-block

- A reviewer answering SERIOUS ISSUES on a safe change leaves the PR open and refused at that head, with the findings on it and one action-list line; the owner's approval merges it, a new push is re-reviewed. Judged once per head.
- A reviewer that is away blocks nothing permanently: a degraded family is asked again after the merge-retry delay, an absent one once a day (one degradation report), the row is never held, and the owner's approval is not delayed (no merge-retry is set).
- A diff over 192 KB is held unread. A feedback fix that large is outside what the executor is for.

## 2. Under-block

- The reviewers are models reading a diff. A change that reads safe but is not would merge. Mitigations that remain in force: the confined session cannot touch tooling/hooks/config (diff gate), cannot carry secret-shaped content (secret gate), publishes from a fork (no repository secrets in CI), must pass fails-before/passes-after + lint in the sandbox, and the local-verify full suite runs before `safe-merge` lets GitHub merge. The prompt names injected instructions as a refusal rule and marks the brief and diff as data.
- A Claude-only pass cannot admit (rule: the cross-family pass is required). A codex-only pass cannot admit (the Claude pass is required). An unparseable reply refuses.
- The agent cannot approve its own work through this route: the reviewers run through the cross-model chokepoint (provider allowlist, no custom endpoints), with a fresh prompt and no session context. The approver-independence check for the owner route is unchanged.
- CODEOWNERS-owned paths (the constitution) are never admitted by route 2 whoever the owner is — on `JKHeadley/instar` the approver IS the code owner, so an approver-relative check (`codeownersOutside`) would have been empty; the gate uses the any-owner match over GitHub's file list. GitHub's `require_code_owner_review` also refuses them.

## 3. Level-of-abstraction fit

The rule and the prompt are pure functions beside `reviewGate.ts`; the service holds only the sequencing and the row bookkeeping; the reviewers are a port, so tests inject outcomes and production goes through the one existing reviewer door.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — a decision point. The reviewers' verdicts are AUTHORITY over admission by the operator's explicit choice (they replace his tap). Floors around it are deterministic: the diff size bound, the CODEOWNERS exclusion, the fail-closed rules on UNKNOWN/absent reviewers, and every downstream gate (local-verify, `--match-head-commit`, fork-only).

## 4b. Judgment-point check

The verdict line is parsed by `parseReviewerReply` (an existing parser); anything but the three canonical verdicts is UNKNOWN and refuses.

## 5. Interactions

- Owner approval route: unchanged and checked first; grading `executor-operator-approved` only on that route.
- A refused head stays `pr-open` with reason `review-failed:<r>`; the action list renders it from `reviewVerdict`/`reviewReason` (one line per head), and the existing `pr-closed` path parks the item if a person closes the PR.
- Triage re-queue: a held item returns through the existing re-triage paths; the next attempt opens a new PR and is reviewed afresh.
- Decision-quality meter: new grade rule `executor-independent-review-passed` (weak evidence; a pass has no outcome check yet).

## 6. External surfaces

Operator: a PR the gate refuses carries a comment naming the rule and findings; the held item appears once in the action list. Config: `feedbackFactory.execute.reviewGate`. Persistent state: four new columns; older rows read as never reviewed.

## 7. Multi-machine posture

Per machine; the executor runs on the canonical owner only.

## 8. Rollback cost

`feedbackFactory.execute.reviewGate: "operator"` (read at the next tick); or revert. Rows keep their review columns harmlessly.

---

## Conclusion

Removes the operator's per-PR tap as the executor's merge authority, as directed, while keeping every deterministic gate and requiring two independent reviewer families to pass the exact head. Clear to ship pending the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only), 2026-10-23.
**Round 1 — Verdict: SERIOUS ISSUES, concur after fixes.** DESIGN findings, all applied: (1) a refused head ended the attempt `held`, which `tickBody` never reconciles — so the promised re-review on push, owner approval and merged-elsewhere detection could not happen → the row now stays `pr-open`/`review-failed:<reason>` under the gate, with a test that a refused head is merged by the owner's approval and that a new push is reviewed afresh; (2) the CODEOWNERS exclusion used the approver-relative list, which is empty on the target repo where the approver is the code owner → `codeownersOwned` (any owner) over GitHub's `prFiles`, tested with the approver as owner; (3) a refused PR was invisible to the operator → action-list lines for `review-failed` and `retry` rows. PRECISION, applied: structurally absent families retry daily with one degradation report instead of hourly; `verifyState` dropped from the prompt (it was the post-merge phase, never the verification record); a throwing review port is a degraded outcome; changed paths come from `gh pr view --json files`, not `+++ b/` lines. PRECISION, left: a store-migration test (added separately), the `awaits your approval` line's wording for a `retry` row (now its own line).
**Round 2 re-check — Verdict: CLEAN, CONCUR.** All six points verified against the worktree (88 tests green, `tsc` clean). Two PRECISION nits, applied in the same commit: a `codeowners-owned` row re-fetched the PR's file list every tick → now on the merge-retry cadence; stale "held" wording in two comments and this artifact's §5.

---

## Evidence pointers

`tests/unit/feedback-factory/execute-independent-review.test.ts` (rule both sides, prompt, comment); `tests/unit/feedback-factory/execute-service.test.ts` (independent pass merges without an owner review; serious refusal comments + holds; reviewer away retries; head moved re-reviews; CODEOWNERS path waits; `reviewGate: operator` unchanged).

Follow-up: enrol the review decision point in the decision-quality meter (CMT to be opened at ship).

---

## Class-Closure Declaration (display-only mirror)

No self-triggered controller added or modified.
