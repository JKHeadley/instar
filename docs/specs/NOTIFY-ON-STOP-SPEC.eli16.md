# ELI16 — Notify-on-Stop (a stopped session always says why)

## Your rule

You said it plainly: a session either keeps going reliably, OR it sends you a quick message explaining why it stopped — and that "why" had better be a good one. Right now neither half is guaranteed, and that's exactly how a session can go quiet on you without a word.

## Where it's silent today

Two gaps:

1. **When an autonomous run ends, you hear nothing.** When one of my background runs finishes — whether it completed, ran out of its time budget, or got emergency-stopped — it writes the reason to the *terminal*, which you can't see, and quits. You're supposed to get a wrap-up message, but that depends on me *remembering* to send one. That's willpower, not structure — and the incident is what happens when it slips.

2. **When a session stops mid-task unexpectedly, the watchdog sees it but can't tell you.** We have a guard that judges whether a stop was justified. Right now it runs in "watch but don't block" mode. So when it spots a session that stopped when it shouldn't have, it can't keep the session going *and* it doesn't tell you — it just notes it quietly. The silence is the whole problem.

## The fix — two layers, one calm delivery

Both layers use the *same* messaging path we already built for the quiet-session watchdog: log everything, send to your one existing system thread, bundle multiple alerts into a single message, never spam a new thread per event.

**Layer A — when an autonomous run ends, you get one plain message** saying which run, why it stopped (done / out of time / stopped), and where it got to. Built into the machinery, not dependent on me remembering. Exactly one per run, so no spam.

**Layer B — when the watchdog catches a session that stopped mid-work and shouldn't have, you get one message** with what it was doing and a "want me to dig in?" There are three guards against noise:
- It only pings for *unattended* sessions (a background run). If you're right there chatting with me, you can see the silence yourself — no ping needed.
- At most one ping per session per half hour — it never nags about the same stuck session.
- It stays silent on ordinary "I answered, now I'm waiting for you" pauses — those aren't stops, they're normal.

## The one decision I want your nod on

I've set this to **on by default**, because you explicitly asked to be told when a session stops. That's a little against my usual "stay near-silent" instinct — but a session stopping mid-work is exactly the kind of thing you said you DO want pushed to you, and the three guards above keep it from becoming noise. If you'd rather it default to autonomous-runs-only and stay quieter on the watchdog half, say so and I'll flip the default. Otherwise I'll build it on-by-default.

## What you'll notice

Mostly nothing different day-to-day. But the two situations where a session used to go quiet on you — an autonomous run ending, and a session stalling mid-task — now each produce one short, plain message. The thing you've been hammering on gets closed structurally.

## Risk

Low. A single switch turns it off instantly if it's ever too chatty, no redeploy. It reuses the delivery path we already trust. The guards (unattended-only, once-per-half-hour, skip normal pauses) are the spam protection.
