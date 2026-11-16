# Chief of Staff checks "PR merged" done items itself

## What Changed

The Chief of Staff's done-item evaluator moved from `server.ts` into `ChiefOfStaffEvidence.buildDoneItemEvaluator` and gained the second deterministic form from the approved spec (docs/specs/chief-of-staff-topic.md §1.3): `PR owner/repo#N merged`. It reads the PR through the agent's authenticated GitHub access, only for a repo the project links, and passes only when the PR merged into that repo's default branch. Anything unreadable or unlinked is `unknown`, never `fail`. The existing `page <url> contains "<text>"` form behaves as before. A Feature notes entry tells agents to write done items in the checkable forms and to fill linked repos.

## What to Tell Your User

When I set up a project for you to track, I can now write its finish line so I can check it myself: "this pull request merged" is now something I verify directly with GitHub. Projects written that way stop showing "not known yet" once their work lands. If you'd like, I can rewrite the finish lines of your existing projects into that form; you'd approve each one before it changes.

## Summary of New Capabilities

- Chief of Staff done items of the form `PR owner/repo#N merged` are checked automatically against GitHub (linked repos only).

## Evidence

On Echo, 15 of 22 bound projects read verdict `unknown` on every check; the judge note read "The merge status is unreadable" (telegram:141876, check of 2026-11-15T17:14Z). The only evaluator was the page form and every done item was prose (fb-e9d75715-316). Unit tests cover pass, open, closed-unmerged, wrong-base, unreadable, no-gh and unlinked-repo cases, plus the unchanged page form.
