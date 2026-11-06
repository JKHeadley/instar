<!-- bump: patch -->

## What Changed

`scripts/safe-merge.mjs` and the green-PR merge watcher no longer refuse or hold a pull request whose code owner has already approved it, when GitHub leaves the overall review decision empty. GitHub does that when the code-owner requirement comes from a ruleset. An empty decision now means "read the reviews": every owned file needs a named owner whose latest review approves the exact head. A stated decision still stands, and GitHub still enforces the rule at merge.

## What to Tell Your User

A rule-book change you have already approved on GitHub now merges by itself. Before, I could keep saying it was waiting for your review, or refuse to merge it, even though your approval was in place.

## Summary of New Capabilities

None. This corrects how an existing merge check reads an approval.

## Evidence

fb-694c7d08-aa8: on 2026-11-06 safe-merge returned `refused:approval-required` for PR #2812 with the code owner's APPROVED review on head 6c4c2a700 and `reviewDecision: null`; GitHub accepted the merge when called directly. Replaying the new check on #2812's real reviews returns true for that head and false for another head.
