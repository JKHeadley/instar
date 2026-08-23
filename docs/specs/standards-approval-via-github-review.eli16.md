# Approving rulebook changes — Plain-English Overview

## The problem in one breath

Changes to the agent's own rulebook are supposed to need your approval. Right now the only accepted proof is a cryptographic signature from a key you'd have to create, guard for years, and use from a laptop. That key was never made, so nothing has been approved — and the pull request carrying your own five approved amendments is stuck behind it.

## What already exists

A checker runs on every pull request. When it sees the rulebook change, it demands a signature per changed article and refuses without one. It has been refusing since 17 August. Nothing has slipped past it, so it is doing something — it is just doing it at a price nobody was willing to pay.

## What this adds

You approve the pull request on GitHub instead. Three taps on your phone, on an account that already has two-factor. The signature route stays available for anyone who prefers it.

## The thing that changed the design completely

The first version of this plan said the new check would stop the agent editing its own rulebook. An outside reviewer showed that was false, and the reason applies to the existing check too:

**The agent writes the checker, and the agent can push straight to the main copy of the project without anyone reviewing it.** So it could change the rulebook and the checker together, and the check would wave itself through. The key file the current system trusts is also just a file in the project — replaceable the same way.

That is not a hole in one design. It means **no check written by the agent can restrain the agent.** The restraint has to come from the project's own settings, which need owner rights the agent does not have.

## The new pieces

**Your part — a settings change, once.** Require that changes to the main copy come through a pull request, and require your approval on exactly two files: the rulebook, and the short list that names the rulebook. Everything else keeps flowing untouched.

An earlier draft of this listed six things, including the checking machinery. That was a mistake, caught when the operator pushed back on the amount of red tape. The approval is enforced by the project host against the filename — so breaking the checker gains nothing, and owning it only cost approvals on unrelated work. Measured over the last 72 changes: the rulebook was touched once. About one approval a month.

**The agent's part — the code, demoted.** The checker stays, but as a helper, not a lock. It says which articles changed, in which direction, and whether your approval is still attached to the current version. That makes your three taps informed rather than ceremonial. It no longer claims to be the thing stopping anyone.

## The safeguards

**Your approval sticks to one exact version.** Push anything afterwards and the approval falls off, so nobody can get a yes on one text and land another.

**A withdrawn approval counts as withdrawn.** If you approve and then change your mind, the later objection wins.

**Anything it cannot verify, it refuses.** A failed lookup is not treated as consent.

**One gap left open on purpose.** If the branch falls behind while you are reading it, what finally lands can differ from what you approved. The fix is another setting — require branches to be up to date before merging. It is recommended rather than assumed, and it is named here rather than quietly left out.

## What ships when

Your settings change goes first. Shipping the code before it would install an easier approval route while every route is still bypassable — which would look like an improvement and be the opposite. And because this changes how amendments get approved, the code change is itself put in front of you rather than merged as routine.

## What you actually need to decide

Whether to make the settings change, and how to bootstrap it. The recommended way is to remove the agent's write access for five minutes while you set it up — two clicks, and it makes every ordering question disappear. There is an ordered alternative if that is inconvenient; the review found a mistake in an earlier version of that ordering, which is itself a reason to prefer the simple one.

Separately, and not fixed by any of this: the dashboard code that supposedly protects a dozen other operator-only actions is readable by the agent. That is filed on its own and still open.
