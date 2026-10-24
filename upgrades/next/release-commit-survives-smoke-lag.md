<!-- internal-only -->
CI-only change to the publish workflow: the "Commit version bump & tag" step now runs whenever `npm publish` succeeded, even if the post-publish smoke test fails on registry lag. No user-facing behaviour changes; it stops main and the git tags drifting behind the version on npm.
