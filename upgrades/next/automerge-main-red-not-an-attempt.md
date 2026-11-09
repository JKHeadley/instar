# A main-red refusal no longer uses up a PR's merge attempts

## What Changed

The green-PR auto-merger no longer counts a `refused:main-red` answer from safe-merge as one of a PR's merge attempts. It records the outcome and retries after one base backoff. Before, a short red spell on `main` could move a verified PR to `gave-up`, and only a new push re-armed it.

## What to Tell Your User

Nothing changes for most users. On agents that develop Instar, a finished pull request no longer gets stuck unmerged because the main branch was briefly failing. No action is needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Merge retries wait out a red main branch | Automatic; the green-PR auto-merger retries after a short wait |

## Evidence

PR #2879 was verified green on one head from 2026-11-06 23:08Z, gave up on `refused:main-red` at 11-07 01:30Z, and stayed unmerged until a manual safe-merge on 11-09. New unit tests: ten main-red refusals leave `attempts` at 0 and the episode active; a real refusal afterwards still counts. `green-pr-logic`, `green-pr-automerger` and `green-pr-local-floor`: 142 of 142 pass.
