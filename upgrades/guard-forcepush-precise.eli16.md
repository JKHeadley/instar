# Guard force-with-lease check — scope it to the actual push command

> The one-line version: the safety hook that blocks force-pushes was reading the *whole* command line — including unrelated status text — so it sometimes blocked a perfectly safe branch update by mistake; now it reads only the `git push` part.

## The problem in one breath

Instar has a safety hook (`dangerous-command-guard`) that stops dangerous git commands. It deliberately *allows* one safe case: `git push --force-with-lease` to your own feature/PR branch (the normal way to update a rebased branch), while still blocking a force-push that targets a protected branch like `main`, `master`, `develop`, or anything starting with `release`. The trouble was *how* it decided "is this targeting a protected branch": it scanned the entire command string for those words. So if the command happened to contain unrelated text — for example a chained status message or log line that mentioned "release cadence" or "main menu" — the guard saw the word "release"/"main" and wrongly concluded you were force-pushing a protected branch. It blocked a legitimate update to a feature branch.

## What already exists

- **`dangerous-command-guard` hook** — a PreToolUse shell hook that inspects every shell command an agent runs and blocks catastrophic or destructive ones (`rm -rf /`, `git push --force`, etc.). It already had the force-with-lease carve-out; only the protected-branch test inside it was too broad.
- **The carve-out itself** — the logic that says "force-with-lease to a non-protected branch is fine, force-with-lease to main is not." That intent is correct and unchanged.
- **Three writers of the guard** — the same guard script is produced in three places: the shipped template (`src/templates/hooks/dangerous-command-guard.sh`), the migration writer that updates existing agents (`PostUpdateMigrator`), and the fresh-install writer (`init.ts`). All three carried the identical bug.

## What this adds

The fix narrows the protected-branch check so it looks **only at the extracted `git push …` invocation**, not the whole command. Concretely: pull out just the `git push ...` portion of the command, and check *that* for a protected-branch token. Unrelated text elsewhere in the command can no longer flip the decision. The main/master/develop/release block stays exactly as precise as before for the part that actually matters — the push command — so nothing is loosened; force-with-lease to `main` is still blocked.

The same one-line change is applied to all three writers, so existing agents get it on their next update and new agents get it at install. A regression test pins the exact false-positive (a force-with-lease to a feature branch with the word "release" in trailing text must be allowed).

## The safeguards

**Prevents the false-positive without widening the guard.** The check is now scoped to the push invocation, so it is *narrower*, not broader. A force-push to a protected branch is still blocked; plain `--force` / `-f` (no lease) is still blocked; everything the guard caught before, it still catches.

**Prevents drift between the three writers.** All three copies are fixed together, and existing tests already assert all three writers contain the carve-out, so a future edit that fixes only one copy would be caught.

## What ships when

One PR, one release. The migration writer means deployed agents pick the fix up automatically on their next update; no action required from anyone.
