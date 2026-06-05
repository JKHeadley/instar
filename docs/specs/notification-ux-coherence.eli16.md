# Notification UX Coherence — explained simply

## The problem, in one picture

Imagine your agent has a smoke detector for its own work sessions. If a session
looks like it stopped making progress, the detector beeps. That part is good. The
problem was HOW it beeped: every single beep created a brand-new Telegram "topic"
(a separate little chat thread), with a cryptic title like `Session "topic-19077"
is stale but unkillable`. Run a few long jobs overnight and you wake up to dozens
of these threads — a wall of noise referencing numbers you can't decode, with no
hint of what to do about them. One real agent had 116 topics and 54 of them were
this kind of auto-generated junk.

There were three reasons it spiraled:

1. These notices were marked **"high priority."** The system already HAS a
   spam-guard that bundles repetitive notices together — but it deliberately lets
   anything "high priority" skip the bundling (so genuine emergencies always get
   through). The smoke-detector beeps were wrongly labeled high-priority, so they
   skipped the guard and flooded freely.
2. The bundling that did exist still let the first few through as their own
   topics before bundling the rest.
3. The titles used the raw internal name (`topic-19077`) instead of the friendly
   name you gave the topic ("EXO 3.0"), and never told you what you could do next.

## The fix

We added one calm lane: a single, permanently-named **"🩺 Agent Health"** topic.
Any routine self-health notice now goes THERE, starting from the very first one —
it never spawns its own topic, even if something mislabels it "high priority."
If the same session beeps again soon, we just stay quiet instead of repeating
ourselves (we still record it in the background, we just don't re-ping you).

And the wording changed. Instead of `Session "topic-19077" is stale but
unkillable`, you now get: *Heads-up on the "EXO 3.0" session — it hasn't shown
visible progress in a while, so it might be stuck, but it's still running and
nothing's been killed. Reply "check EXO 3.0" and I'll look, or ignore this if you
know it's fine.* Named, plain-language, and you can just reply.

## What this does NOT change

The detection itself is untouched — the smoke detector still watches exactly the
same way. Genuine, you-must-act-now alerts still get their own topic (we only
calmed the routine housekeeping). Nothing is ever dropped — every notice is still
saved in the attention list; we only changed how (and how loudly) it's delivered.
It's purely a "make the delivery calm and clear" change, not a "turn off the
safety" change.

## Why it's safe to ship on

It only affects notices that explicitly opt into the lane, so every other message
is byte-for-byte the same as before. The lane is on by default but does nothing
until a self-health notice actually fires, and a single config flag turns it back
to the old behavior if anyone ever wants that.
