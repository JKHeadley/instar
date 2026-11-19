<!-- bump: patch -->
## What Changed

Agents now ask their operator to approve only what needs them. On 2026-11-17 a build session asked its operator to approve a pull request (#3326) that touched no file the operator owns. It also said the repository needed someone else's approval, which was false. The session was following its own instructions (Echo Bugs topic 10000002791):
- The build skill still described a repository approval rule that had been removed in August.
- Both skills called approval "the user's step".
- The PR-link helper asked GitHub to make the operator a reviewer on every pull request the agent linked.

- Instructions:
  - The instar-dev and spec-converge skills no longer state repository rules. Whether a merge needs a human approval is read live through `safe-merge`, which says `refused:approval-required` only when GitHub will not merge without a review.
  - An approval the operator recorded as theirs comes first.
  - The agent approves its own specs. Only a constitution or protected-list amendment goes to the operator.
  - Existing agents get the corrected sentences in place on update. Only those exact sentences are replaced, so other local edits are kept and in-sync skill copies are re-stamped.
- The PR-link helper now reads the repository's own rules before asking GitHub for a review. When the repository names a code-owner review and nobody's approval is required for that pull request (no rule requires a review, no code-owned file is touched, renames included), no review is requested.
  - Anything it cannot read for certain keeps the old behaviour, and so do repositories without a code-owner rule.
  - `prLinkReviewRequest.requestWhenNotRequired: true` restores always-request.
- The agent instruction section "PR links ask for the review on GitHub too" describes the new behaviour. Full-layout instruction files are reworded in place.
- New awareness entry "Ask for approval only where it is needed".

## What to Tell Your User

I won't ask you to approve something nothing requires you to approve. If a change needs your sign-off, by your own instructions or by the repository's rules, I still ask, with a link. Otherwise I finish the work and tell you what shipped. Linking a pull request no longer adds you as a GitHub reviewer when your approval isn't required.

## Summary of New Capabilities

- No new routes. One new setting: `prLinkReviewRequest.requestWhenNotRequired` (default off).
- New outcome in the PR-link log line: `skipped-no-approval-required`.

## Evidence

- **Unit, `tests/unit/prApprovalFact.test.ts`:**
  - Both sides of each boundary of the approval rule: the live ruleset shape, code-owned touch, count, last-push approval, required reviewers, unknown parameter, review decision, ungoverned repos, every unread input, the 3000-file cap.
  - CODEOWNERS lookup order, and the rulesets 404 vs other errors.
  - The hook: the request is skipped only for `not-required`, and the held PR view is not re-read. The switch restores always-request, and a slow fact means unknown, so the request is still made.
- **Unit, `tests/unit/approval-where-required-skill-text.test.ts`:**
  - The bundled skills carry every new sentence and no old one.
  - The migration rewords the canonical copy and both renderings and re-stamps them. It keeps local edits, reports a customized sentence, and is idempotent.
  - The template and migration text of the PR-links section are equal, and the in-place rewording happens once.
- **Unit, unchanged and green:** `tests/unit/prLinkReviewRequest.test.ts`, `tests/unit/PostUpdateMigrator-prLinkReviewAwareness.test.ts` and `tests/unit/awareness-entry-registry.test.ts`.
- **Integration, `tests/integration/pr-link-review-request-route.test.ts`:** through the real `/telegram/reply` route, a link to a pull request nobody must approve gets no review request and the reply goes out unchanged. A pull request touching a code-owned file still gets the request.
- **Live, against real GitHub (2026-11-17):**
  - #3326 reads not-required (no rule requires a review and no code-owned file is touched), in 610 ms.
  - #3331 reads not-required, in 497 ms.
  - Registry PR #3296 reads required (touches 1 code-owned file), in 518 ms.
