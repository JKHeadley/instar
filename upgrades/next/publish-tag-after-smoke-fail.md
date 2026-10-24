<!-- internal-only -->
# Publish workflow: tag the release whenever npm publish succeeded

## What Changed

- `.github/workflows/publish.yml`: `Commit version bump & tag` now runs on `always() && steps.publish.outcome == 'success'`. Before, a post-publish smoke failure (npm registry lag past the 15m window) skipped it, so 1.3.1395, 1.3.1411, 1.3.1415 and 1.3.1420 reached npm with no release commit or git tag. The smoke step still fails the run, so registry problems stay visible.

## What to Tell Your User

Nothing changes for users; this keeps git tags in step with what is published on npm.
