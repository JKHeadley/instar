<!-- bump: patch -->
## What Changed

A pull request link the agent sends now asks for the review on GitHub too. Before a reply goes out on Telegram, Slack or the app, every github.com pull request link in it is checked. For an open PR that the agent's own GitHub account opened, the reviewer (the configured `prLinkReviewRequest.reviewer`, else the repository owner when the owner is a person) is requested if not already, and the request is read back from GitHub before the reply is sent. If the request on one of the agent's own PRs cannot be confirmed, the reply still goes out with one plain line saying so. A PR link that cannot be read at all (it may be someone else's) is only logged, never annotated.

This closes a gap from Echo Bugs topic 10000002537: the operator approved PR #3046, a later push dismissed that approval, and GitHub does not put the request back, so the next "please approve" link pointed at a PR that did not ask him for anything. `safe-merge` already requested the review on its own path; hand-written replies did not.

Closed and merged PRs, PRs someone else opened, a reviewer who is the PR author, and a reviewer who already approved the current head are skipped. GitHub being slow or down never holds a reply (10 s budget, then the note).

## What to Tell Your User

When I send you a link to one of my pull requests, you will now always find it in your GitHub review requests. If GitHub would not take the request, my message says so plainly instead of leaving you to find out.

## Summary of New Capabilities

- Outbound replies (Telegram, Slack, app) request the reviewer on any of the agent's open PR links and verify it first.
- Setting: `prLinkReviewRequest.enabled` (default on), `prLinkReviewRequest.reviewer` (GitHub login; default the repository owner).

## Evidence

- Unit: `tests/unit/prLinkReviewRequest.test.ts` (dismissed-review case re-requested and read back; already requested; GitHub refusal and silent no-op both reported; closed, someone else's, org owner, author-as-reviewer, approved-at-head skipped; slow GitHub ends in a note).
- Integration: `tests/integration/pr-link-review-request-route.test.ts` (real `/telegram/reply` route with the origin send policy: request made before the send; refusal note reaches the Telegram wire; no-link reply never touches GitHub).
- Migration: `tests/unit/PostUpdateMigrator-prLinkReviewAwareness.test.ts`.
- Live read against GitHub with the server's own GitHub login path: #3046 read as already requested, merged #3052 skipped.
