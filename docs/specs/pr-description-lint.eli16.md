# Pull-request description lint at open time — ELI16

Every pull request has to carry a proper description before it can merge: a plain-language ELI16 section, a decision record for files that need one, a release note when the change ships something, and a UX Impact section when it touches what a user sees. The merge script (safe-merge) checks all of this at the very end, just before merging.

Until now, the early versions of those checks ran only on pull requests aimed at `main`. A "stacked" pull request, one built on top of another unmerged branch, got no description check at all until it was retargeted. Its first refusal then came at merge time, after a full test run on our machines had already been spent on it. On the morning this was built, 21 open pull requests were stacked, and today's repair briefs found a missing or broken UX Impact section in about half of the older changes.

This change adds one GitHub check that runs on every pull request, whatever its base, every time the pull request is opened, edited or pushed to. It runs exactly the same description functions safe-merge runs at merge time, plus the same UX Impact rule, so the early answer and the merge-time answer can never disagree. It only warns: it writes a short table and a warning for each failing check, it always finishes green, and it is not a required check. Merging is still decided by safe-merge, and test admission is still decided by the verifier.

To keep it trustworthy, the check runs its code from `main`, never from the pull request being checked, and it has read-only access. If it cannot run for some reason, it says so as a warning and stops; it never blocks anyone. Nothing in an agent's install changes: this lives only in the repository's CI.
