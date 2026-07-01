# Plain-English overview: stopping the conversation "tug-of-war"

## What problem is this fixing?

The agent can run on more than one of your machines (say a laptop and a Mac Mini). A
conversation lives on exactly one machine at a time, and you can ask to move it. Last night we
fixed the big bug where a move would get stuck and never finish.

While proving that fix, one last rough edge showed up: if you start a **second** move on a
conversation that is *still finishing* its first move, the two machines can start fighting over
it — each keeps yanking it back to where *it* thinks it should go. The conversation bounces
back and forth instead of settling. Nothing gets corrupted (there is never two owners at once —
that safety is rock-solid), but the thrashing is a bad experience.

## Why does the fighting happen?

Four small things line up: (1) old "move to machine B" notes are never thrown away, so a new
move has a stale note to fight; (2) those notes are timestamped with each machine's wall clock,
so a tiny clock difference can make a *stale* note look *newer*; (3) nothing says "only one
machine gets to drive this move"; and (4) a separate bug quietly deletes an operator's "off"
setting on updates, so the feature can't reliably be switched off.

## What the review process changed (important)

My first design added a "one driver at a time" **lock**. Eight reviewers — including two
outside AI models — showed that was the wrong tool: that kind of lock lives on one machine, so
each machine would just grab its own copy and it would coordinate nothing. They also showed my
"throw the stale note away" step cleared it on the wrong machine (so it cleared nothing), and
that the deepest problem is clocks: a machine that was briefly offline with a skewed clock can
still win the fight when it reconnects.

So the design got simpler and sturdier:

- **Order moves by "which happened after which," not by clock time.** The system already has a
  tamper-proof counter for each conversation (it ticks up every time ownership changes). We use
  *that* to decide which move is newest — a wrong clock can't fake it. This is the real fix.
- **Throw the stale note away on the machine that actually wrote it**, once the move has clearly
  settled — and just let the copies on other machines quietly expire, rather than sending out a
  "delete" that could itself go wrong under clock drift.
- **Drop the lock. Add a simple safety brake instead.** The brake just counts how many times a
  conversation bounces in a short window; if it ever exceeds a sane limit, it stops driving that
  conversation and flags it for a look. It never freezes anything — the conversation keeps
  working where it is — it just refuses to keep fighting. This also doubles as the "is it
  working?" gauge.
- **Fix the switch** so an operator's "off" actually stays off across updates — and, because
  some agents already had their "off" silently deleted, pop a one-time heads-up so they can set
  it again if they meant it.

## What you'll notice

Ideally nothing — a move just completes once and stops, even if you fire off a second move
while the first is still settling. If something ever does go wrong, the design always errs
toward "let the move happen" and "keep the conversation reachable," never "freeze it." The
worst case is one extra little wobble, never a stuck conversation.

## The main tradeoff

We're deliberately choosing "never freeze, occasionally wobble" over "perfectly serialize with a
hard lock that could jam." Given the whole point of this work is a seamless experience across
your machines, "never freeze" is the right side to err on. The underlying one-owner-at-a-time
guarantee is untouched and absolute; everything here only decides *how moves get ordered and
when to stop fighting*, never *who owns the conversation*.
