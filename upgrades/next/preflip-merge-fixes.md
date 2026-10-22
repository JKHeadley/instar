## What Changed

- **safe-merge judges the latest run of each check, the way GitHub does.** When a check failed and a rerun on the same commit passed, safe-merge still read the old failed run and refused with `refused:red-checks` (PR 2289, 2026-10-22), although GitHub showed the required check green. It now keeps only the latest run of each check within its own workflow (a pass in one workflow never hides a failure of the same-named check in another), using the same rule the green-PR watcher uses (one shared module, `scripts/latest-run-per-check.mjs`). A rerun that is queued or still running keeps safe-merge waiting instead of being judged on the old failure.
- **A brief empty or garbled checks answer from GitHub no longer refuses the merge at once.** safe-merge reads the checks up to two more times (5 s, then 10 s later) before refusing `contexts-unverifiable`, and never retries past the merge deadline.
- **The green-PR watcher runs the safe-merge that ships with the running server**, not the copy in the agent's home checkout. That checkout can sit on any branch with uncommitted edits; on 2026-10-22 it held an old safe-merge from before local-verify, and that was what the watcher ran. The watcher still needs the instar source checkout for its git reads.
- **safe-merge finds its agent home from its installed location.** Run from `<agent home>/.instar/shadow-install/node_modules/instar/scripts/`, it now resolves the agent home from that path (only when that home has `.instar/config.json`). Before, it found the right home only because the agent home happened to be a git checkout; on an agent home that is not one, it resolved to `…/node_modules/instar` and found no config.
- local-verify's status loop also loads safe-merge from the installed package (the same helper, `src/core/installedSafeMerge.ts`).

## What to Tell Your User

Nothing changes for you unless you run the automatic merging of your agent's own pull requests. If you do: a pull request whose tests failed once and then passed on a rerun now merges instead of being refused, and the merge always uses the checked version that came with your installed Instar.

## Summary of New Capabilities

- None. Two fixes to the existing merge path.

## Evidence

- `tests/unit/safe-merge-latest-run.test.ts` — the PR 2289 shape (fail then pass) passes; pass then fail stays red; queued and running reruns keep waiting; safe-merge and the watcher pick the same run on the same history; empty/unparseable reads retried then refused; installed-location agent home, including a home that is not a git checkout.
- `tests/unit/green-pr-automerge-wiring.test.ts` — the constructed MergeRunner gets the installed safe-merge path; the source-checkout requirement still holds.
- `tests/e2e/local-verify-lifecycle.test.ts` — the status loop loads the installed safe-merge, not a stale checkout copy.
