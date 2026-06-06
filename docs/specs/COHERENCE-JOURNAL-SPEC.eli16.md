# Coherence Journal — the plain-English version

## What we're building

Each of my machines starts keeping **diaries**. Not feelings — logistics.
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

Each kind gets its **own diary file** (a review insight): the "topic moved"
diary is tiny and precious, so it's kept essentially forever; the chattier
"session opened/closed" diary rotates. The history you actually ask about
can never get crowded out by routine noise.

A machine only ever writes its OWN diaries — never anyone else's — which is
the trick that makes the next part safe: machines simply **swap copies of
each other's diaries** over the same secure machine-to-machine line they
already use for everything else. No edit conflicts are possible, because
nobody ever edits — diaries only grow, and only their owner adds lines.

The swap is piggybacked on a check-in the machines already do on a schedule,
and the check-in itself carries only a tiny "I'm at line 412" note — the
actual diary lines travel in separate, size-capped exchanges, so the
check-in can never get fat and slow.

## What you get out of it

Ask any machine — not the "right" machine, ANY machine:
- "Where did this conversation live this week, and why did it move?"
- "Did the old machine actually close its session after the move?"
- "Which machine has the overnight job's files, and what are they called?"

One API call (or just reading the file — it works even when the server is
choking, a lesson from this afternoon).

## The seatbelts (several added by the review panel)

- **Writing a diary line can never slow the real work.** The line goes into
  memory instantly and is saved to disk a moment later in the background —
  no waiting on a busy disk inside the operation being described. (This
  machine has literally frozen under disk pressure before; the review
  caught that the first draft could have made that worse.)
- Diary lines are **logistics only, enforced by shape** — every line must
  match a strict per-kind template (ids, enums, validated paths). Free text
  structurally can't get in, so secrets and message contents can't either.
  A scrubber still runs as a second layer.
- **A machine can only hand me ITS OWN diary.** Copies claiming to be a
  third machine's diary are refused — so one confused (or compromised)
  machine can't rewrite everyone's history.
- **Every received line is sanity-checked before it's saved.** A corrupted
  line from a crashed peer gets quarantined and flagged — it can't poison
  the merged history view.
- **Restores from backup are detected, loudly.** If a machine comes back
  from a backup with its diary rewound, peers notice (a hidden "edition
  number" changes), set the old copy aside, and flag it — instead of
  silently ignoring the machine's new entries forever (a nasty failure the
  adversarial reviewer found).
- **The diary NEVER drives actions.** Nothing kills, spawns, or moves
  anything based on diary contents — copies are always a little stale, and
  acting on stale copies would re-create the exact duplicate-session bugs
  this project exists to kill. The diary answers questions; the live
  systems make decisions. Enforced by a test, not a promise.
- If the diary somehow can't be written, the real work proceeds anyway —
  the notebook must never break the thing it's describing.
- Crash mid-line? Repaired on restart — and the repair is *counted*, so a
  repeating repair gets noticed instead of silently absorbed. Same line
  delivered twice? Dropped by numbering. An operation retried after a
  restart? The diary recognizes it already wrote that line (a real gap the
  review closed — restarts retry operations, and naive numbering would have
  double-counted moves).
- Ships dark on the fleet, live on me (echo) first — the standard pattern.
  Existing agents get everything automatically on their next update (the
  review caught that the first draft forgot the update path entirely).

## Also riding along

The census from P0 gets its **enforcement teeth** here: a build-time check
that fails if any new feature writes durable state without declaring it in
the registry. That's the "nothing becomes machine-local by accident ever
again" guarantee. And my own docs teach every agent that the diary exists —
a capability nobody knows about may as well not exist.

## One question left for you (in §8)

The retention question answered itself in review (per-kind diaries: "topic
moved" kept ~forever, noisy kinds rotate). Remaining: OK to close P1 with
the real two-machine proof on your live fleet — move a topic, then read its
history from both machines?
