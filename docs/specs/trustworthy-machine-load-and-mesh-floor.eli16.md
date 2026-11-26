# Trustworthy machine load — the plain-English version

## What happened

On 2026-10-25 the agent told Justin that the Mama PC had been "offline since Oct 23". That was
wrong: the Mama PC was running the whole time, it was just overloaded and answering slowly or not
at all. The agent got it wrong for three reasons. First, the machine list had no way to say "I
don't know": a machine the server had not heard from since its own restart looked exactly like a
machine that was confirmed dead. Second, an old saved record ("last seen Oct 23") was shown as if
it were a fresh check. Third, the only load number each machine shared was one raw "load
average", which cannot tell a busy machine from a drowning one.

## What already exists

Every machine already sends its peers small status reports, and every machine keeps a list of
the others (the "pool"). There are already ways to move a conversation from one machine to
another, a cap on how many model processes one machine can run at once, and a measurement of how
slow the agent's own server is responding. None of these were tied together into an honest view
of "how is that machine doing, and how do I know?".

## What is new

1. **Honest status.** Each machine is shown as live, unreachable (struggling or refusing),
   stale, or unknown, always with how old the evidence is and who saw it ("Mac Mini reached it 3
   minutes ago"). The last real contact is saved to disk, so a restart no longer turns a machine
   into "offline". Old saved records are never shown as current, and the word "offline" is only
   used when there is real proof (the machine said it was shutting down, or it is asleep).
2. **A real load report.** Each machine measures several things on its own, every 15 seconds:
   CPU idle, load per core, free memory, the operating system's memory-pressure signal, how slow
   its own server is, and how many sessions it is running. A simple table turns that into ok,
   elevated, saturated or impaired. Missing measurements stay missing; they are never filled in
   with a guess, and a report older than a minute counts as unknown.
3. **Later steps** (separate releases, each checked first): a saturated machine stops taking new
   work and keeps one session free for recovery; work moves off a machine that stays overloaded,
   one conversation at a time and only to a machine that is known to be fine; and finally a small
   model helps read the signals when they disagree, in observe-only mode.

## The safeguards

Step 1 only reports. It does not change which machine serves a conversation, does not move
anything, and does not block anything. The existing "online" flag that placement uses keeps its
exact current meaning in this step; changing it is a later, measured decision. Evidence can never
look younger than it is: re-reading a saved copy or a copy relayed by another machine keeps its
original age. A machine running older code that sends no load report shows as "unknown", never as
"fine".

## What you need to decide

Nothing for step 1 — Justin approved the plan on 2026-10-25. Each later step (stopping new work,
moving work) ships switched off or in dry-run on development agents first, and turning it on for
real is a separate decision once its logs show the thresholds are right.
