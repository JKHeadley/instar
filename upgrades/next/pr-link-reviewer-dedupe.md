<!-- bump: patch -->
## What Changed

Two merged changes (PRs 3061 and 3063) both asked GitHub to add the reviewer before a pull-request link was sent (Echo Bugs topic 10000002553). On a development agent both ran, so one link could request the same reviewer twice, and the older one could hold a reply instead of sending it with a note.

- Removed the PR 3061 send-time check (`PrLinkReviewerCheck`), its `prLinkReviewer` setting, development gate and rollout ladder.
- The one path is the PR 3063 reply check (`prLinkReviewRequest`, on by default): the agent's own open PRs get the reviewer requested first, a request that cannot be confirmed is said in the message, and links to other people's PRs are only logged.
- A test now fails if a second place in the source starts requesting reviewers.

## What to Tell Your User

When I send you a link to one of my pull requests, I ask GitHub to add you as reviewer once, not twice. Nothing changes in how it looks to you.

## Summary of New Capabilities

- None. A duplicate code path was removed; the `prLinkReviewer` setting no longer does anything (use `prLinkReviewRequest`).

## Evidence

- Unit: `tests/unit/pr-reviewer-request.test.ts` keeps the safe-merge helper tests and adds the one-path guard (only `src/messaging/prLinkReviewRequest.ts` and `scripts/safe-merge.mjs` POST `requested_reviewers`). `tests/unit/prLinkReviewRequest.test.ts` and `tests/integration/pr-link-review-request-route.test.ts` cover the kept path unchanged.
