# MergeRunner Auto-Arm Handoff — Plain-English Overview

> The one-line version: instead of my robot pressing "merge" itself and then babysitting the result until it lands (and possibly getting restarted mid-merge so the merge is left in limbo), I press GitHub's own "merge this automatically the moment it's green" button and walk away — GitHub finishes the job itself, even if I get restarted.

## The honest problem (corrected)

An earlier draft of this said the problem was "my robot stands in front of GitHub holding the door open for ~20 minutes waiting for slow tests, and gets kicked out before they finish." **That was wrong, and I'm fixing the story before building anything.** My background merge-watcher only ever acts on PRs that are ALREADY green — it checks "are all the tests passing?" first, and only then runs the merge. So it never actually sits and waits for slow tests; the merge script's wait loop exits on its very first check. (The "20-minute wait that got killed" was a DIFFERENT thing — manual one-off merge watchers I sometimes run in the background, not this in-server watcher.) Always check that the mechanism you're describing is the real one before you commit to a design — that's the lesson here.

So what IS the real value? Two honest, more modest things:

1. **It frees my "one-merge-at-a-time" slot in seconds instead of holding it for up to 25 minutes.** Even on an already-green PR, the old way runs a merge command and then re-checks GitHub, all inside a budget of 25 minutes. Pressing the auto-merge button returns in seconds.
2. **It survives me restarting myself mid-merge.** This is the big one. When one of my merges goes through, it triggers a release, which RESTARTS my own server. With the old way, that restart can kill my process right after GitHub accepted the merge but before I confirmed it — leaving the merge in limbo that I then re-try. With GitHub's auto-merge, GitHub OWNS the merge; a restart can't kill it, and whichever machine is in charge next just confirms it landed.

## What this changes

**Switch the merge engine from "merge it myself, then confirm" to "arm GitHub auto-merge, then hand off."** I press GitHub's auto-merge button and my process exits in seconds. GitHub does the merging on its own time. The tricky part is **accounting**: when I arm auto-merge, the PR is NOT merged yet, so I can't say "confirmed merged" right then. Instead I record a new calm state — **"armed"** (not a success yet, not a failure; GitHub owns it now) — and on a LATER ~10-minute tick I re-check each armed PR and only THEN record the confirmed "merged" (the same independent re-read as before, just one tick later). The honesty rule is untouched: I never say "merged" until I independently see MERGED on GitHub.

## The five careful fixes (what reviewers flagged)

1. **The head-pin doesn't fully bind.** I pin the exact commit when I arm, but GitHub's auto-merge merges whatever the latest green commit is, and it only cancels the auto-merge if someone WITHOUT write access pushes. So a write-capable push after I arm could merge a commit I didn't pin. I'm honest about this small residual risk (the set of people who can push here is tiny) AND I add a check: when reconciling, I compare the PR's FINAL head (the tip that actually got merged) to what I armed — a mismatch gets flagged for review (the merge still happened; this is catching it after the fact). One precision detail I had to get right: because I merge with "squash," the merge creates a BRAND-NEW commit that never equals the PR's head — so I must compare the PR's head, NOT the squashed merge commit, or I'd false-alarm on every single clean merge. I dropped the false claim that auto-merge is "stricter" on head-pinning; it's only stricter on enforcing the required tests.
2. **Don't re-arm the same PR over and over.** An already-armed PR is still "green," so without a guard I'd re-arm it every tick, resetting the 24-hour clock and wasting effort. Fix: skip any PR that's already armed (both in my own notes AND by reading GitHub's live "is auto-merge armed?" flag).
3. **My kill switch must actually stop an in-flight merge.** A HOLD label does NOT stop GitHub's auto-merge (GitHub gates on tests and mergeability, not labels). So when the operator hits rollback/pause, or puts an explicit HOLD on an armed PR, I now actually call GitHub's "disable auto-merge" command on every armed PR and tell the operator which ones I disarmed. The kill switch is now real.
4. **Works across my machines.** My notes about what's armed live on one machine only. If the "in charge" role moves to another machine, that machine reads GitHub's live "is auto-merge armed?" flag — not my local notes — so it never double-arms and never strands a real in-flight merge.
5. **Never quietly forget a stuck merge.** If a PR sits armed-but-unmerged for over a day, I do NOT clear my notes and go blind (that would under-count merges and break "close the loop"). Instead I mark it "overdue," KEEP watching it, and re-raise one gentle deduped "take a look" note on a cadence — closing it only when it actually merges, gets closed, or the operator acts.

## The safeguards in plain terms

- **Every existing guard stays.** HOLD markers, protected-file exclusion, the I-am-the-right-user check, the circuit breaker, the "only the lead machine acts" lease, the crash-proof in-flight record — all unchanged. Arming is gated by exactly the same checks merging was.
- **If I can't read GitHub during a re-check, I fail SAFE.** I leave the PR marked "armed," don't advance any failure counter, don't trip the breaker, and just try the read again next tick. I never give up on a real in-flight merge because of a temporary read glitch, and I never fabricate a merge I can't confirm.
- **An armed PR that later goes red is SAFE and needs nothing from me.** GitHub won't merge a PR with failing checks — it just waits.
- **GitHub's auto-merge is stricter than the old path on the thing that matters most** — it enforces every required test itself and cannot bypass them (the old `--admin` mode could bypass branch protection, which once turned main red for everyone).
- **Restart-proof by design.** If my server restarts between arming and the merge, the merge STILL happens — GitHub owns it now. This is the whole point.
- **A clean rollback.** One config setting (`mergeStrategy: admin`) restores the exact old behavior, and rollback now also disarms in-flight auto-merges. If a repo ever has GitHub auto-merge turned off, I don't silently fall back to the bypass path — I tell the operator to either turn it on or flip the setting. The operator decides; I don't quietly pick the riskier path.

## What a decider needs to weigh

- **Is this live or dark?** It changes an already-live feature, but only on agents that already turned auto-merge on (my dev agent). It defaults to the new `auto` strategy, behind the same on/off and dry-run switches, and I soak it in dry-run first.
- **The one real trade:** confirmation of a merge now lands a tick later (up to ~10 minutes), because the merge itself lands later. In exchange, the merge slot frees in seconds and merges survive my own restart-mid-merge. Slightly later bookkeeping for merges that reliably finish and a kill switch that actually reaches them.
- **Honesty is preserved:** no merge is reported as done until GitHub independently shows it MERGED, and I corrected the problem statement to describe the real mechanism rather than a dramatic-but-false one.
