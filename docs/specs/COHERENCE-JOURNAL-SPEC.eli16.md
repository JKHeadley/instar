# Coherence Journal — the plain-English version

## What we're building

Each of my machines starts keeping a **diary**. Not feelings — logistics.
Three kinds of entries to start:

1. **"Topic moved"** — conversation 13481 is now on the Laptop, moved at
   9:20pm because you asked. (This is the history you asked for by name:
   which machine a topic was linked to, and when.)
2. **"Session opened/closed"** — a work session for that topic started or
   ended on this machine.
3. **"Overnight job ran here"** — an autonomous run started on this machine
   and wrote its results to *these files*. This line is the direct fix for
   the night the Mini did a pile of analysis and the Laptop had no idea the
   files existed.

Every entry is one cheap line in a local file. A machine only ever writes
its OWN diary — never anyone else's — which is the trick that makes the next
part safe: machines simply **swap copies of each other's diaries** over the
same secure machine-to-machine line they already use for everything else.
No edit conflicts are possible, because nobody ever edits — diaries only
grow, and only their owner adds lines.

The swap is piggybacked on a check-in the machines already do on a schedule,
so this adds essentially zero new chatter: "I have your diary up to line
412" — "here are 413 through 420."

## What you get out of it

Ask any machine — not the "right" machine, ANY machine:
- "Where did this conversation live this week, and why did it move?"
- "Did the old machine actually close its session after the move?"
- "Which machine has the overnight job's files, and what are they called?"

One API call (or just reading the file — it works even when the server is
choking, a lesson from this afternoon).

## The seatbelts

- Diary lines are **logistics only** — ids, paths, timestamps, reasons.
  Never message contents, never anything secret-shaped (a scrubber runs over
  every line as a double-check).
- If the diary somehow can't be written, the real work (moving the topic,
  running the session) proceeds anyway — the notebook must never break the
  thing it's describing.
- Crash mid-line? The half-line is cleanly repaired on restart. Same message
  delivered twice? Dropped by line numbering. Both were live failure modes
  this afternoon; both are now tests, not hopes.
- Ships dark on the fleet, live on me (echo) first — the standard pattern.

## Also riding along

The census from P0 gets its **enforcement teeth** here: a build-time check
that fails if any new feature writes durable state without declaring it in
the registry. That's the "nothing becomes machine-local by accident ever
again" guarantee.

## Two questions for you (in §8)

1. How long should diary history be kept? (Proposed: rotate at 16MB, keep
   4 archives — call it weeks. Placement history could be kept forever if
   you want; those lines are tiny.)
2. OK to close P1 with the real two-machine proof on your live fleet —
   move a topic, then read its history from both machines?
