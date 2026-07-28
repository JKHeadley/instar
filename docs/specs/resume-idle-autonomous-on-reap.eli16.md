---
status: draft-for-convergence
approved: false
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
---

# ELI16 — Bring an idle autonomous run back after it gets recycled

## The one-line version

If a long-running autonomous job's session gets shut down just for being old
(not for being broken), and the job isn't actually finished, automatically
bring it back — instead of letting it sit dead until someone sends a message.

## What's going on today

The agent has a safety net called the **resume queue**. When a session gets
killed *in the middle of real work*, the queue notices and quietly restarts it
later, one at a time, only when the machine is calm and has spare capacity. If
the same thing keeps dying over and over, the queue gives up loudly so it
doesn't spin forever.

But there's a catch in HOW the queue decides a session was "doing real work."
It looks for live evidence at the exact moment of the kill — a running build, a
sub-task in flight, a queued message. There's one kind of shutdown where none
of that is visible: the **age-limit recycle**. Sessions aren't allowed to run
forever, so when an autonomous session has been alive too long AND is sitting
idle between turns (waiting for its next step), it gets recycled. At that exact
instant nothing is "running" — so the queue sees no evidence and concludes
"nothing to bring back," even though the autonomous job itself is still very
much alive and unfinished.

Result: if this happens while you're away, the job is just... dead. It comes
back only when you next message that topic. A recent fix (PR #1155) made the
*notice* you'd see honest about this; this change fixes the actual behavior.

## The fix

When an age-limit recycle hits a topic that still has a **live autonomous run**,
we treat the live run itself as the proof of work. We tell the queue "yes, this
one counts," and from there it flows through all the existing safety rails — no
new restart path, no shortcuts.

We're careful to only do this for the *recycle* case. A session that was killed
because it was genuinely stuck or genuinely dead does NOT get auto-revived —
restarting those just recreates the problem.

We also flip this on **live for the dev agent (Echo)** so it actually gets
exercised on a real two-machine setup, while the rest of the fleet stays in
"watch only" mode until a deliberate later switch.

## Why it's safe (the four things that could go wrong)

1. **It won't start two copies.** If you message the topic and it wakes up
   before the queue gets to it, the queue checks "is a session already live
   here?" right before restarting — and if so, it backs off. Covered by an
   existing guard.
2. **It won't loop forever.** If a job keeps getting recycled-and-revived, it
   hits the existing "give up after N times in 24h" cap and raises one clear
   alert instead of spinning.
3. **Only the right machine revives it.** On a multi-machine setup, only the
   machine that "owns" the topic restarts it — never two machines at once.
4. **It won't pile onto a stressed machine.** Restarts still wait for the
   machine to be calm and for spare quota.

All four are handled by machinery that already exists — this change just lets
the age-limit-recycle case INTO that machinery, and adds tests proving each
guard still holds for it.

## What review tightened

The adversarial, security, and two outside-model (GPT + Gemini) reviews all
confirmed the two scariest failure modes — starting two copies, and an
endless restart loop — are already blocked by existing guards. Review then
added one structural improvement: right before a restart, the agent now
re-checks whether the job is STILL live; if it finished in the meantime, it
quietly skips the restart instead of wasting one. Review also pinned down the
honest classification of the live-on-dev decision: it spends real resources on
the dev machine, so it's treated as a deliberate, accepted, operator-approved
choice — not hand-waved as "safe because it's off everywhere else."

## Open questions for the operator

*(none)* — The forks (only age-limit qualifies; reuse the existing
`build-or-autonomous-active` evidence signal; live-on-dev / dark-on-fleet) were
pre-resolved by the operator under the topic-13481 autonomous-session
pre-approval and are recorded in the spec's Frontloaded Decisions table.
