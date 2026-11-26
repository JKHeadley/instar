# The merge check's status on GitHub says why a PR is waiting — plain-English overview

## What this change is

Every pull request to Instar shows a status from our own merge checker, Local Verify: a coloured mark plus a short line of text, such as "verifying" or "awaiting independent review". The mark decides whether the PR may merge; the text is supposed to say why.

The checker only updated GitHub when the mark changed. If the mark stayed "waiting" but the reason changed (from "tests are running" to "tests passed, waiting for the independent review record"), GitHub kept showing the old text. On one pull request today that made a correctly held PR look like a stuck test run for about 40 minutes, twice, and sent me chasing the wrong problem.

Now the checker also updates GitHub when only the reason changes.

## Safeguards

- Nothing about which pull requests pass, fail or merge changes; only the explanation shown next to the mark.
- Updates stay within the checker's existing limit on how often it posts to GitHub.
- A new test replays today's exact situation: it fails without the change and passes with it.

## What a reader needs to decide

Nothing; it makes the status text truthful.
