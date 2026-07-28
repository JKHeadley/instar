# Close the Loop — plain-English overview

## What this is

Instar is adding a new rule to its "constitution" — the Standards Registry, the
list of engineering principles every build is checked against. The new rule is
called **Close the Loop** (catchphrase: *"Untracked = Abandoned"*).

The rule, in one sentence: **anything the agent starts and means to come back to
has to be written down somewhere that will automatically remind it, on a schedule,
until the thing is actually finished.** If nothing brings it back up for review, it
quietly dies — even if you "meant" to return to it.

## Why it matters

An AI agent doesn't have a human's memory. When a session ends or its context gets
compacted, anything it was only "keeping in mind" is gone. So a promise it made, a
half-finished feature it shipped turned off, or a safety check it deployed and never
looked at again — all of those can silently rot. To the next version of the agent,
they simply don't exist.

This already bit us three ways, all the same shape — *something was opened, then
forgotten*:

1. The agent made a commitment to follow up later, but the commitment system marked
   it "done" **22 seconds** after it was created, so the reminder never fired and the
   promise vanished.
2. Features get shipped "dark" (turned off) to be matured later — but if nothing
   reminds anyone, they sit off forever.
3. The agent's safety checks were running on every message and nobody measured them,
   so their cost piled up invisibly until it showed up as a rate-limit.

## What already exists

Instar already has pieces that DO this for specific things: commitments fire repeated
reminders ("beacons") until delivered, and there's a track for maturing dark features.
There's even an older rule, **Deferral = Deletion**, that says "write it down NOW,
don't say you'll do it later." This new rule is the *next half* of that one: Deferral
= Deletion is about **capturing** something the moment you have it; Close the Loop is
about **keeping it in front of you** until it's truly closed.

## What's new

Just words, in three places — **no code behavior changes at all**:

1. The rule is written into the **Standards Registry** (the constitution), right next
   to Deferral = Deletion, with the story of how it was earned.
2. It's added to the **template** that every new agent's CLAUDE.md is built from, so
   new agents grow up with it.
3. A small, safe **migration** adds it to agents that already exist, so they get it on
   their next update too (not just brand-new agents).

## What the reader needs to decide

Justin already ratified the rule ("yes") and said to proceed. So the decision is made;
this change just records it. If you're reviewing: check that the wording of the rule
matches what you intended, and that it's correctly marked as a *principle* (like
"Structure beats Willpower"), not a new feature with buttons — because it's the former.

## What is deliberately NOT in this change

The actual machinery that would *measure every safety check and re-surface it for
tuning* — the thing that motivated all this — is a bigger, separate piece of work that
comes next. This change only declares the **value** that machinery will serve. Nothing
here turns into a new endpoint, job, or gate.
