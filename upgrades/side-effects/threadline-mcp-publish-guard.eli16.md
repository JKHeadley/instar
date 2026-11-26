# Stopping unplanned threadline-mcp releases: plain-English overview

## What this is

`threadline-mcp` is a small package this repo publishes to npm. A GitHub workflow builds it, tests it and publishes it whenever its folder changes on main. Two things were wrong with that workflow, and they hid each other.

First, one of its tests asked the package's `pair status` command for a message. That command was removed in version 0.5.1, so the test could never pass, and every run stopped there.

Second, the publish step ran when the version in the repo matched the one already on npm. In that case it raised the version by one on its own, published it and pushed the change back to main. So any merge touching the folder, even a README fix, would ship a new release nobody planned. The broken test was the only thing stopping that. Fixing the test alone would have switched the surprise releases on.

## What is new

- The test no longer calls the removed command. It now checks that the installed package is the version the repo builds.
- The workflow publishes only when the version in `package.json` is higher than npm's. Equal or lower skips with a notice saying to bump the version to release. CI never raises the version itself, and the step that pushed a version change to main is gone.
- If npm cannot be asked for the current version, for any reason other than "not published yet", the run fails instead of guessing.
- Only changes to the source, `package.json`, the lockfile, `tsconfig.json` or the workflow itself start a run. A README-only change waits for the next real release, or a manual run.

## Safeguards

- A new test runs the workflow's own version check against a fake npm and covers equal, lower, higher, not-yet-published and unreachable registry. All 10 of its cases fail on the old workflow.
- Merging this starts one run, because the workflow file changed. The version is 0.6.1 in the repo and on npm, so that run tests and then skips publishing.

## What a reader needs to decide

Nothing. Releasing threadline-mcp now means bumping its `package.json` version in a PR. A plain revert restores the old behavior, including the surprise bump.
