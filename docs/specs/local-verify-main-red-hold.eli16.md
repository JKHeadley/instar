# Local Verify main-red hold — Plain-English Overview

> The one-line version: while `main` is failing a known test, the verify queue stops running pull requests that cannot be the fix, runs the one that is first, and tells everyone which PR is already fixing it.

## The problem in one breath

Local Verify tests each pull request as its **merge with `main`**. So the moment `main` itself fails a test, every PR that does not fix that test fails the same test, by construction. On 2026-10-26 `main` went red on one file (`tests/unit/no-silent-fallbacks.test.ts`, one count over its baseline) at 11:21 PDT. The queue kept going and ran about eight PR verifies, 18 minutes each, that all failed on that one file. Meanwhile three different sessions each wrote the same one-comment fix (PRs 2372, 2373 and part of 2361), because nothing told them a fix was already on its way.

## What already exists

- **Main health** — the server verifies `main` after every merge. One failure makes it "suspect" (one re-run), a second makes it "red". While it is not healthy the automatic watcher asks for no new PR verifies, and merges are allowed only for a repair verified against the current `main`.
- **The run-detail** — every failed verify records which test files failed and why, in the audit log and on the main-red attention item.
- **The queue** — PRs that were already queued when `main` went red, and PRs a session asks for by hand (`safe-merge` does this for every PR it tries to merge), still ran one after another. That is where the eight wasted runs came from.

## What this adds

**A hold on doomed runs.** While `main` has a failed head and the failing files are known, only two things may take the single verify slot: a `main` verify, or a **repair candidate**. Every other PR keeps its place in the queue and waits for `main` to be green. Nothing is dropped; nothing is refused; it just does not start a run that is known to fail.

- **A repair candidate** is a PR whose diff touches a failing file, **or whose title or body names it** (the path, the file name, or its stem such as `no-silent-fallbacks`). The second rule is the one that matters: both real repairs on 2026-10-26 touched `src/` files, not the test file, and both named the check in their text. A rule on the diff alone would have held the actual fixes. **A revert also counts**: a PR whose title starts with "Revert", or whose body has GitHub's "Reverts owner/repo#N" line, runs first. Undoing the change that broke `main` is the commonest repair, and it touches and names no test file, so without this rule it would wait for a green `main` that nothing else might bring.
- **Candidates run first.** A repair queued behind nine unrelated PRs starts ahead of all of them.
- **The hold is visible.** `GET /local-verify` carries a `mainRedHold` block (the failing files, the PRs fixing it, the PRs held, and one plain sentence saying why) and each held entry is marked `held`. A `POST /local-verify` for a held PR answers 202 with the same `hold`, and `safe-merge` prints it, so a session that asks for a verify learns at once that `main` is red on file X and that PR N is already fixing it.
- **One attention item per red episode, once `main` is red.** Exactly one item (`local-verify:main-red-hold`) names the failing check and every PR already fixing it (or says none is yet), so a second session does not write the same fix. When a new fixing PR appears, the same item's text is refreshed rather than a second item being created, and the item closes itself when `main` is green. A PR that was already running when `main` went red, or already verified and waiting to merge, still counts as "fixing it" until `main` is green.
- **A repair is never locked out.** If the queue is full of held PRs, a repair candidate is admitted past the cap. There is no second cap; the number admitted this way is bounded by the open PRs that touch, name or revert the failing check, and each admission is logged.
- **It survives a restart.** The failing files are written to a small state file next to the main-health watermark and read back at boot, so an auto-update restart mid-red does not quietly resume the doomed runs.

**A label for work that speeds up merging.** Justin asked (2026-10-26) for a way to put merge-throughput work first. A PR with the GitHub label `merge-throughput` now runs ahead of ordinary PRs. The `main` health check still runs before it, and while `main` is red only the fixing PRs run at all. To stop the label from starving everyone else, an ordinary PR that has waited 90 minutes is ranked with labelled PRs, so later labelled PRs cannot pass it. The existing alarm for a PR waiting over 3 hours still fires.

## The safeguards

**It only delays; it never decides a merge.** A candidate still has to pass its full verify. Whether a PR merges is decided exactly as before.

**Unknown means today's behaviour, not a freeze.** A failed `main` that named no file (a dirty tree, a timeout), or a state file for a different head: the hold is inactive and the queue runs in its old order. After a restart or lease move the hold stays on only if the saved failure is for the same red head. A PR whose file list could not be read is held only until its title or body names the check.

**Green releases everything.** The moment a `main` verify is green, the hold lifts, held PRs start in their original order, and the episode's bookkeeping (which PRs were announced, which were held) is cleared.

**One switch turns it off live.** `monitoring.localVerify.mainRedHold: false` restores the old order without a restart.

## What ships when

One PR, Tier 1: the pure decision module, the service wiring, the read surface, the `safe-merge` line, the merge-throughput label priority, the agent-awareness text and its migration, and tests at all three tiers. Nothing is dark; the switch defaults to on because the only thing it changes is which verify spends the slot next.

## What you actually need to decide

Nothing. The behaviour defaults to on; if a held PR ever surprises you, `GET /local-verify` says why in one sentence, and the switch above turns the rule off.
