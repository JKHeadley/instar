# Built-but-Dark Liveness Reconciler — the plain-English version

## The problem in one breath

We keep building features all the way — design them, code them, test them, merge them — and then forget to actually switch them on. The code is there. The lights are off. And nobody notices, sometimes for months.

We caught this happening twice in one feature: a safety system meant to stop me from quitting work early was fully built on the server side... but the wire connecting it to the actual "I'm stopping now" moment was never run, and its on-switch doesn't even exist yet. A *second* backup for the same problem is also sitting there switched off. Two finished safety nets, both unplugged.

## Why our existing checks didn't catch it

We have a lot of safety checks — but every one of them runs while we're *building* a feature, and only if someone remembers to add it. It's like a house where every appliance has its own inspection sticker, but nobody ever walks through the finished house flipping switches to confirm the lights come on. We've never had that walkthrough.

## What we're building

A **Liveness Reconciler**: an automatic walkthrough. Once a week it goes down the list of every feature and asks four quick questions — does it exist, is it real (not a stub), is it actually plugged in, and is it actually doing anything? Then it labels each one:

- **Live** — working, leave it alone.
- **Dark** — built but switched off (the bug we hit).
- **Hollow** — switched on but never actually used.
- **Deploy-lag** — finished in the code but not in the version that's really running.

## The important part: it won't nag you

Justin's rule: this must NOT bury you in notifications. So the reconciler asks one more question before it ever bothers you — *"is there a recorded reason this is off?"* If you turned something off on purpose and we wrote down when and why, it stays quiet forever. It only speaks up about things that are off with **no explanation on record** — and even then, only if it's new, only if it's safety-critical, and all of them bundled into a single message instead of a pile.

The great news: the "list of past decisions" this needs is **already about 70% built**. We have a little database that already tracks what's been offered, declined, and turned off — and it already knows to stop asking after you've said no a few times. We just point the new walkthrough at it and fill three small gaps: always record *why* something was turned off, widen what it tracks beyond just opt-in features, and have something actually read it.

## How you'll experience it

Normally: silence. Occasionally: one tidy message — "heads up, this safety feature is off and there's no note saying why." You answer once ("I turned that off because…"), we write it down, and it never asks again. Everything else just sits quietly on a dashboard page you can check whenever. Bonus: that page becomes the answer to "wait, why is this turned off?" — a real recorded reason instead of a shrug.

## Proof it works

It isn't finished until it can look at the two switched-off safety nets we already found and correctly shout "these are dark!" — AND, on that same first run, stay completely quiet about the hundred-plus things that are off perfectly on purpose. If it can't catch the exact bugs that inspired it without burying them in false alarms, it failed.

## What the review round caught (and how we fixed it)

I had several independent reviewers tear into the first draft. They found a genuinely serious problem: as first written, the walkthrough would have flooded you on its very first run. The repo has well over a hundred things that are switched "off" — but most of them are off *correctly* (optional features you simply haven't asked for, plus a pile of design documents that aren't features at all). The first draft would have flagged all of them as "dark," dumped them in your lap, and called it a day. That's the exact flood you said to avoid.

Two fixes close that hole:

1. **Tell apart "off on purpose" from "off by mistake."** Every feature now declares what it's *supposed* to be: a thing that must always be running (a safety net), or a thing that's correctly off until you ask for it (an optional extra). Only the first kind, when it's off, is ever a problem worth raising. Optional-and-off is just... fine, and stays silent.

2. **Draw a line in the sand on day one.** The first time the walkthrough runs, it takes a snapshot and accepts the current state as the baseline — so it doesn't drag you through years of history at once. From then on it only speaks up about things that *change* or that we've explicitly marked as "this one really needs finishing" (like our two switched-off safety nets).

They also caught that the first draft leaned on *me remembering* to write down why something got turned off — which is exactly the kind of "rely on willpower" mistake we're not allowed to make. Fixed: turning something off now *requires* a reason at the moment you do it, so there's nothing for me to forget.

Honest caveat: all my reviewers were Claude-family. The outside opinions (other AI models) sometimes catch things we don't, so I'd recommend one more review round with those before you give the final yes.
