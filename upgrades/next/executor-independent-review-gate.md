# Feedback executor: an independent review admits a fix PR to merge

## What Changed

- `src/feedback-factory/execute/independentReview.ts` (new): the safety-only reviewer prompt, the admission rule (a cross-family reviewer AND the Claude reviewer both CLEAN/MINOR), the PR refusal comment, the 192 KB diff bound.
- `src/feedback-factory/execute/FeedbackExecutorService.ts`: `independentAdmission` runs after the owner-approval check; each head judged once; refusal about the change → PR comment, the PR stays open and refused at that head (owner approval / new push / close all still work) and one action-list line; reviewer away → asked again after an hour (failing) or a day (absent); CODEOWNERS-owned paths (any owner, from GitHub's file list) never admitted here.
- `src/feedback-factory/execute/executorPorts.ts`: `prDiff`, `prFiles`, `comment`. `reviewGate.ts`: `codeownersOwned`. `executePolicy.ts`: `reviewGate: 'independent' | 'operator'` (default `independent`). `FeedbackExecuteStore.ts`: `review_sha`, `review_verdict`, `review_reason`, `reviewed_at` (added in place). `buildFeedbackExecutor.ts`: reviewers run through `runCrossModelReview` per family.

Why: the operator's directive (topic 18330, 2026-10-21 and 2026-10-23) — his GitHub tap was the pipeline's only merge authority and its bottleneck; value is decided at triage, the PR question is safety, and "safety is me plus a codex reviewer that has to actually pass".

## What to Tell Your User

Fix PRs from the feedback pipeline now merge once a Codex reviewer and a Claude reviewer both pass them on the exact commit. Your approval is still needed only for files GitHub reserves for you (the constitution), and your approval on any PR still works as before. A PR the reviewers refuse gets a comment saying why and a line in your action list; it stays open, so you can approve it on GitHub if you disagree, or it is reviewed again when a fix is pushed.

## Summary of New Capabilities

- `feedbackFactory.execute.reviewGate` (`independent` default; `operator` = the old rule).
- Audit event `execute:independent-review` (head, pass/fail, each reviewer's verdict); row fields `reviewSha`/`reviewVerdict`/`reviewReason`.

## Evidence

Unit: `execute-independent-review.test.ts` (rule, prompt, comment) and the independent-gate cases in `execute-service.test.ts`; executor suites green; `tsc` clean.
