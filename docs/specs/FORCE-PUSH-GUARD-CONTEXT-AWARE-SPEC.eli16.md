# What I'm fixing, in plain terms — stop interrupting you for the safe case

## The everyday version

Every time an Echo (or any instar) session needs to rebase its own feature branch and push it back to GitHub, it asks you for permission first. That's the safety guard doing its job — force-pushing is genuinely dangerous if you do it wrong. But the guard is blunt: it sees "force push" and stops, full stop. It can't tell that the push is the safe kind (a re-push of my own work-branch, with the "force-with-lease" safety net that refuses if anyone else's work would get clobbered) versus the dangerous kind (force-pushing to a shared branch like `main` and overwriting other people's commits).

So you've been getting the same approval question every session across every agent. That's the daily friction. It's also the first concrete real-world example for the bigger "catch when you correct me" feature I'm building — you've literally been correcting the same thing across sessions, and that's the pattern this fix would prevent.

## What this changes

The guard learns one extra rule: if the push is `--force-with-lease` (the safe form, which git itself guarantees won't overwrite anyone else's work because the "lease" refuses if the remote moved) AND the target is NOT a protected branch (`main`, `master`, `prod`, `production`, `release/*`, anything operator-marked), the guard quietly allows it. No prompt to you, no Telegram interruption.

Everything else stays exactly as it was:

- **Bare `git push --force` (without the lease)** — still blocks. That's the dangerous form; the lease is what makes the safe form safe.
- **Force-push to `main`/`master`/`prod`/`release/*`** — still blocks, even with the lease, because shared branches deserve a human in the loop.
- **`rm -rf .`, `git reset --hard`, dropping a database** — still block, untouched.

So you keep all the real protection, you lose the routine friction.

## How you stay in control

There's a config flag for paranoid environments — `safety.alwaysGateForcePush: true` — that brings back the old "ask every time" behavior. Default is the fix (off); flip it per-agent if you ever want the guard back.

You can also extend the protected-branch list yourself: `safety.protectedBranches: ["develop", "staging"]` if your project treats those as shared.

## Why this is a one-shot fix

Unlike the bigger sentinel work, this isn't a new system with a ledger and an analyzer and a closed loop. It's about thirty extra lines in one shell script, plus a config default. The migration is automatic — every agent already updates its hook on every release because of a lesson we learned the hard way from a different bug, so the moment this ships, every agent gets it.

No staged rollout, no rollback dance — just the fix. If anything ever turns out to be wrong, flipping the opt-out flag restores yesterday's behavior in one config edit.

## The acceptance test

A fresh Echo session rebases its own feature branch and runs `git push --force-with-lease` and it just works — no prompt, no interruption, no Telegram ping. Meanwhile, the same agent trying to `git push --force JKHeadley main` still blocks immediately. Both the friction and the safety land in the same change.
