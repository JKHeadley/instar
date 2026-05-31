<!-- bump: patch -->

## What Changed

**The publish workflow now survives the publish-vs-merge git race.** Publishes are already serialized against each other (workflow concurrency group), but a concurrent PR merge — a separate workflow — can still move `main` between a publish's fetch and its final `git push`, which rejected the push and failed the release run (leaving npm briefly ahead of the committed version on main). The "Commit version bump & tag" step now retries that push: on a rejection it fetches and rebases the release commit onto the updated main and pushes again (up to five attempts). Because a concurrent merge never bumps npm, the version the run already resolved stays valid, so the rebase needs no version re-resolution. The version tag is now created on the final, landed commit. If a rebase ever hits a real conflict the run aborts loudly rather than force-pushing.

## What to Tell Your User

Nothing user-facing — this is release-pipeline robustness. When two changes hit the main branch at the same moment, a release that would previously have failed its final push now quietly rebases and completes, so versions on the registry and in the repository stay in step.

## Summary of New Capabilities

- The publish workflow's commit-and-push step retries with a fetch + rebase on a rejected push, then pushes the version tag on the commit that actually landed.
- The common path (push succeeds on the first try) is unchanged; the retry only runs on a rejected push, so a successful publish behaves exactly as before.

## Evidence

- `js-yaml` parse of `.github/workflows/publish.yml` succeeds; the commit step contains the rebase-retry loop and tags after the branch push.
- Pairs with the per-PR release-note fragment system (this very note is a fragment): fragments removed the PR-level NEXT.md collisions, this removes the publish-level git-push collision.
