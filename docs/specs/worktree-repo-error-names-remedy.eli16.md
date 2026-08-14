# Worktree create: the error that blocked you now tells you how to unblock

> The one-line version: `instar worktree create` could fail with a perfectly honest explanation of what went wrong and no mention of the one setting that fixes it — so the person it blocked went around the command instead of using it.

## The problem in one breath

`instar worktree create` needs to find your instar checkout. It looks in several places in order, and if none of them is a valid checkout it stops and lists every place it tried and exactly why each one failed. That part is good — it never guesses, and it never pretends to have found something it did not.

What it never said is what to do about it. The very first place it looks is a setting called `INSTAR_REPO`, which exists precisely so you can point it at a checkout in an unusual location. That setting appeared nowhere in the failure message. So someone whose checkout lives somewhere the defaults do not cover reads a complete diagnosis, learns nothing about the remedy, and concludes the command cannot help them.

## What already exists

- **An ordered search** for your checkout: the `INSTAR_REPO` setting, then the directory you are standing in, then the agent's home, then two default locations.
- **A genuinely honest failure.** Every candidate is listed with the real reason it was rejected — not a repo, does not exist, remote not recognised. Nothing is silently swallowed.
- **Integrity checks** on whatever it does find, so a lookalike directory cannot be passed off as your checkout.
- **A documented escape hatch.** `INSTAR_REPO` is written up in the worktree convention spec — just not anywhere the failing command points you.

## What this adds

**The failure now names its remedy.** After the same list of candidates and reasons, the message says plainly: run this from inside your checkout, or point `INSTAR_REPO` at it, with an example. Nothing is removed — the diagnosis is kept word for word and the remedy is added after it.

The command's own help text now describes how the checkout is located, in the same place it already described how the agent's home is located. Those two were asymmetric: one resolution path was documented in detail, the other not at all.

## Why it matters

This is not a cosmetic wording change. The worktree command exists to enforce a safety convention: worktrees must live inside the agent's own home, because that is the one location the operating system sandbox cannot revoke while a session is running. The command also sets a per-worktree identity, shares the installed packages, and excludes the tree from the system file indexer.

When the command refuses and does not say how to proceed, the natural next move is to create the worktree by hand with plain git — which silently skips all of that. That is exactly what happened on 2026-08-14, and it is why this change exists. An error that does not name its remedy pushes people around the very safeguard the tool was written to provide.

## The safeguards

**The diagnosis is preserved, not replaced.** There is a deliberate second test whose only job is to fail if the candidate list or the per-candidate reasons ever go missing. It passes both before and after this change. Making an error message friendlier by deleting the detail a reader needs would be a worse outcome than the problem being fixed.

**No behaviour changes.** The same checkouts are found, the same ones are rejected, the same integrity checks apply. Only the text of the failure and the text of the help are different.
