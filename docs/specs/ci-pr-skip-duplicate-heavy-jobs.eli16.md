# Pull requests stop repeating the tests our own machines already run — Plain-English Overview

> The one-line version: GitHub no longer repeats the full test suite on every pull request, because our own two test machines already run it before anything merges, and those repeats were making every release wait hours for a GitHub build machine.

## The problem in one breath

Every change to the agent software goes through two sets of tests. Our own two Macs (the Studio and the M5) run the full suite on every pull request through Local Verify, and nothing merges until that passes. GitHub also ran the same full suite on every pull request, which asked GitHub for about twenty build jobs per push. GitHub runs only about four jobs at a time for this account, so a release, which is a short job that publishes merged code to npm, waited in the same line behind hundreds of duplicate test jobs. On the morning of 21 November 2026 the release that started at 8:00 waited two hours for its first machine and more than thirty minutes for its second, while merged fixes sat unpublished.

## What already exists

- **Local Verify** — our own test line. It runs every unit, integration and end-to-end test on the Studio or the M5 for each pull request, posts the result to GitHub, and is the only check the repository requires before a merge.
- **GitHub's test workflow** — a copy of the same suite run on GitHub's shared machines, split into eight unit test shards, an integration job, an end-to-end job, a build job, a contract test job, two desktop packaging jobs and a handful of fast checks (type check, repository invariants, documentation coverage, standards coverage, cartographer freshness).
- **The publish workflow** — runs after each merge to main and publishes the new version to npm. It needs two GitHub machines in turn and waits in the same account-wide line as everything else.
- **The green-PR merger** — the agent's own merge step. Under its current "local floor" setting it merges on the Local Verify record and does not wait for GitHub's heavy jobs.

## What this adds

On pull requests, GitHub now skips the heavy jobs: the eight unit test shards, the integration tests, the end-to-end tests, and, because they depend on the unit shards, the build and contract jobs. Those jobs still run in full on every push to main, which is where releases come from, and whenever someone starts the workflow by hand. Pull requests keep both native desktop packaging jobs, which check platform compilation and package contents beyond the test suites, and the fast checks that Local Verify does not cover: the type check, repository invariants, documentation coverage, standards coverage and cartographer freshness.

## The safeguards

- **The required full-suite check remains.** Local Verify runs every suite before merge. Native Mac and Windows packaging checks stay on pull requests because they add platform coverage. The Node-version trade-off is stated below.
- **Main is still tested on GitHub.** The full suite still runs on every merge to main, on GitHub's older Node versions too, so a problem that shows up only there is still caught, after the merge rather than before it.
- **Every merge path still works.** The agent's merge step reads the Local Verify record (the local floor). One caller, the feedback executor, always asked the merge script to wait for GitHub's checks first; that would have blocked every one of its merges once the heavy jobs stopped running on pull requests, so the merge script now honours the local floor for that caller too. If the floor is ever switched back to GitHub's checks, merges of pull requests are refused outright until the heavy jobs are restored there.
- **A Node 20 or 22 regression can now reach npm first.** Our machines test on Node 24. GitHub tests Node 20 and 22 on main, but the publish workflow runs on the same push and does not wait for it, so such a regression would be published and then flagged, rather than flagged on the pull request. This is stated in the review so it is a known cost, not a surprise.
- **One commit undoes it.** Reverting the workflow and merge-path changes restores the prior behavior; no stored user data changes.

## What ships when

This ships with the next release after it merges, but it takes effect for every pull request the moment it lands on main, because GitHub reads the workflow from the main branch for the push and from the pull request's own branch for pull request events.

## What you actually need to decide

Nothing. The Chief of Staff approved removing duplicate tests under the owner's throughput priority on 21 November 2026. The owner separately approved using our Mac for releases; that implementation remains under security review.
