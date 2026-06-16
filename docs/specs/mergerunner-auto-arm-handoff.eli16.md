# MergeRunner Auto-Arm Handoff — Plain-English Overview

> The one-line version: instead of my robot standing in front of GitHub holding the door open until a slow build finishes (and getting kicked out before it does, so the merge never happens), I now press GitHub's own "merge this automatically the moment it's green" button and walk away — GitHub finishes the job itself, even if I get restarted.

## The problem in one breath

When I finish a piece of my own work, I'm supposed to merge the pull request (PR) automatically — no human clicking "merge." Today I do that by running a script that **waits, live, for the slow tests to pass and then merges**. But the slowest tests on this repo (Build, Integration, E2E) take a long time, and worse: the moment one of my merges goes through it triggers a new release, which **restarts my own server** — killing the very process that was waiting. So the waiter dies before the tests finish, the merge never happens, and I have to come back and merge by hand. That's the exact button-press the whole feature was built to remove.

## What already exists

- **The watcher** (`GreenPrAutoMerger`) — a background loop that runs every ~10 minutes, finds my green, un-held PRs, and tries to merge one. It already has a lot of safety: it only runs on the "lead" machine, it skips anything marked HOLD, it skips PRs that touch protected files, it checks that I am the right GitHub user, and it has a circuit-breaker that pauses if things keep failing.
- **The act-engine** (`MergeRunner`) — the part that actually spawns the merge script, keeps a crash-proof "I'm in the middle of a merge" record, and — crucially — never trusts that a merge happened until it independently re-reads GitHub and sees the PR is really MERGED. (We call that the "B10" rule: don't claim success you didn't verify.)
- **The `--auto` button** — a `safe-merge.mjs --auto` mode that shipped recently (PR #1185). It arms **GitHub's native auto-merge** — GitHub's own feature that merges a PR the instant every required check passes — and returns immediately. It can't time out, and it can't skip a check (unlike the old `--admin` mode, which bypassed checks and re-checked them in our own script).

## What this adds

The change is small in spirit, careful in the details: **switch the merge engine from "wait live, then merge" to "arm GitHub auto-merge, then hand off."** I press GitHub's auto-merge button and my process exits in seconds. GitHub then does the waiting and the merging on its own time.

The one genuinely tricky part is **accounting**. Today, the moment my merge script returns, the merge has already happened, so I re-read GitHub right then and record "merged — confirmed." But after this change, when I arm auto-merge the PR is **not merged yet** — GitHub will do it minutes (or hours) later. So I can't say "confirmed merged" at arming time. Instead:

- Arming a PR is recorded as a new, calm state: **"armed"** — not a success yet, not a failure. GitHub now owns it.
- On a **later** ~10-minute tick, before doing anything else, I re-check each armed PR. If GitHub has merged it, *now* I record the confirmed "merged" (same B10 independent re-read as before, just one tick later). If it's still waiting, I leave it alone. If it got closed, I record that.

So the "did it really merge?" honesty rule is untouched — I still only ever say "merged" after independently seeing MERGED on GitHub. The only thing that moved is *when* I check: from "right after my command" to "on the next tick after GitHub does it."

## The safeguards in plain terms

- **Every existing guard stays.** HOLD markers, protected-file exclusion, the I-am-the-right-user check, the circuit breaker, the "only the lead machine acts" lease, the crash-proof in-flight record — all unchanged. Arming a PR is gated by exactly the same checks as merging it was; I never arm a held, protected, or wrong-user PR.
- **An armed PR that later goes red is SAFE and needs nothing from me.** GitHub will not merge a PR with failing checks — armed auto-merge just waits. If a PR sits armed but unmerged for over a day, I raise **one** gentle "this has been stuck a while, take a look" note — never a flood, never a forced give-up.
- **GitHub's auto-merge is actually STRICTER than the old path.** The old `--admin` mode could bypass branch protection (that once turned main red for everyone). `--auto` lets GitHub enforce every required check itself and cannot bypass anything.
- **Restart-proof by design.** If my server restarts (or the lead machine changes) between arming and the merge, the merge STILL happens — GitHub owns it now, not my fragile process. Whichever machine is lead next does the "did it merge?" re-check. This is the whole point.
- **A clean rollback.** One config setting (`mergeStrategy: admin`) restores the exact old behavior. And if a repo ever has GitHub auto-merge turned off, I don't silently fall back to the bypass path — I tell the operator to either turn auto-merge on or flip that setting. The operator decides; I don't quietly pick the riskier path.

## What a decider needs to weigh

- **Is this live or dark?** It changes the behavior of an already-live feature, but only on agents that have already turned auto-merge on (my dev agent). It ships defaulting to the new `auto` strategy, behind the same on/off and dry-run switches the feature already has, and we soak it in dry-run first.
- **The one real trade:** confirmation of a merge now lands a tick later (up to ~10 minutes), because the merge itself lands later. In exchange, merges on slow PRs actually complete instead of being abandoned. That's the trade — slightly later bookkeeping for merges that reliably finish.
- **Honesty is preserved:** no merge is ever reported as done until GitHub independently shows it MERGED. The change does not weaken any safety check; it removes a structural failure mode (the waiter dying before the wait ends) by handing the wait to the system that can't be killed.
