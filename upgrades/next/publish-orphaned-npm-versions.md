<!-- internal-only -->
# A published version always gets its release commit and tag

## What Changed

The publish workflow could put a version on npm and then fail before recording it on main. That left 22 versions between 1.3.1384 and 1.3.1493 with no release commit and no tag. There were two causes. First, the release commit's retry rebase treated a newly merged release-note fragment as a directory-rename conflict and aborted. That rebase now runs with directory-rename detection turned off. Second, the post-publish smoke test ran before the commit step, so a slow npm propagation stopped the run after the publish had already happened. The smoke test now runs after the commit and tag are pushed.

## Evidence

`tests/unit/publish-workflow-no-orphans.test.ts` replays the collision in a real git repo. Without the flag the rebase stops with `CONFLICT (file location)`. With it, the rebase is clean and the merged fragment stays queued for the next release. The step-order and flag assertions both fail against the previous workflow. Agents see no behavior change.
