# Side-effects review — publish-vs-merge push retry

Seven-dimension review for the `.github/workflows/publish.yml` "Commit version bump & tag" change (retry-with-rebase on a rejected push).

## 1. Security
No new secrets, tokens, or permissions. Uses the same `RELEASE_TOKEN`/checkout already in the job. `git rebase`/`git fetch` operate only on `main`. No force-push (a conflict aborts loudly instead).

## 2. Blast radius (release pipeline — highest concern)
This is the one workflow nothing else can tolerate breaking. Mitigation: the change is **downside-bounded** — the common path is `git push origin main` exactly as before; the retry loop only executes when that push is *rejected*. A bug in the retry can therefore only affect the already-failing case (which previously failed outright), never a successful publish. YAML validated via `js-yaml`.

## 3. Correctness
Concurrent merges are not releases (they never bump npm), so the version this run resolved remains valid after rebasing onto them — no version re-resolution needed. The version tag is created after the successful branch push, so it always points at the commit that actually landed. Newly-arrived release-note fragments from the concurrent merge survive the rebase (this run's commit only deleted the fragments it assembled) and ride to the next publish — consistent with the fragment system.

## 4. Rollback
Revert the one workflow step (or the commit). No state migration, no persisted data. Reverting restores the prior single-push behavior exactly.

## 5. Observability
On a rejected push the step logs the attempt + reason; on an unrecoverable conflict it emits a GitHub `::error::` and exits non-zero (visible failed run) rather than silently proceeding.

## 6. Multi-machine / concurrency
This IS the concurrency fix. Publishes are serialized by the workflow `concurrency` group; this closes the remaining publish-vs-merge gap. Retry cap of 5 bounds the loop.

## 7. Backward compatibility
Pure workflow change; no API, config, schema, or agent-installed-file change. Existing releases behave identically on the common (no-race) path.

## Second-pass review
Release-pipeline change — a human reviewer sign-off on the workflow diff is appropriate before relying on it under heavy churn. The downside-bounded property (common path unchanged) makes shipping low-risk in the interim.
