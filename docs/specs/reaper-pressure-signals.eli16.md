# In plain English: the thing that watches for an overloaded machine was reading the wrong dial

## The one-sentence version

Instar has a component whose job is to notice when a machine is in trouble and
tidy up. On the night it was needed most it was watching a number that lies on a
Mac, so it cried wolf about the processors while missing the thing that was
actually wrong with the memory.

## What happened

On 25 October 2026, AI Guy on Justin's laptop went effectively silent. Instar's
own check reported the machine as "critical" — and it was right that something
was wrong, but wrong about what.

Here is what it reported:

- processors: **critical**
- memory: **normal**

And here is what the machine actually looked like, measured seconds later:

- processors: **36 to 44 percent idle** — there was spare capacity
- memory: **115 GB of 128 GB in use, with 35 GB being squeezed** to keep it that way

Both halves of the report were unhelpful, for two different reasons.

## Reason one: a number that means something different on a Mac

The check was using the "load average" — a single number Unix systems have
reported for decades. The trouble is that it counts work *waiting* to happen,
not work the processors are actually doing, and exactly what a Mac counts in it
is not well documented.

What we measured, rather than what we assume: the laptop had nearly 1,500
programs and almost 14,000 separate threads of work open, the load average read
9.4 per core — a number that would normally mean a machine on fire — and a third
of the processors sat idle at the same moment. Something was inflating that
number without using the processors. We do not need to know exactly what, and
this change does not claim to: the two readings plainly disagree, and the one
that measures the processors directly is the one to believe.

What makes this worth fixing rather than just noting: **instar already knows
this.** Its own instructions to every agent say, in bold, never to judge load
from that number, and there is a dedicated script that exists purely so an agent
does not have to. The rule was written down everywhere except the one place that
actually makes the decision. A rule that only lives in prose is a wish; this
moves it into the code.

The fix reads what the processors genuinely did over the last interval, by
comparing two readings a moment apart. No extra programs are started to do it;
the numbers are already there for the asking.

## Reason two: a dial that does not exist yet

The memory half is a different story, and the honest answer turned out to be
uncomfortable: **I could not build it, and this change does not pretend to.**

The memory number was **not** misreading anything. It reports how much memory is
genuinely available, and 42 percent available is a fair description of what it
measures. An earlier fix already corrected a real bug there, and this change does
not touch it.

What I believed was that the machine was only holding that 42 percent by squeezing
35 GB of memory into the compressor, and that the squeeze was the distress signal
nobody was watching. I wrote three different ways to measure it. Review measured
all three against real machines, and all three failed:

- A bar on how much memory is squeezed: a perfectly healthy machine here sits at a
  third of its memory squeezed — *more* than the struggling laptop had.
- A bar on how fast squeezed memory is being pulled back: that same healthy machine
  does it tens of thousands of times a second, a thousand times over my bar.
- The operating system's own memory-pressure verdict: it says "normal" on the healthy
  machine, and the underlying number it is computed from scores the struggling laptop
  as *better* than the healthy machine. It would have said "normal" that night too.

So every instrument I could find says that laptop's memory was fine. The 35 GB was
real and the agent that could not start was real, but the link between them was my
assumption, and three measurements disagree with me.

What this change does instead: it **reads** those three numbers and shows them, and
they decide nothing. No new alarm, no hidden switch to turn on later. They are there
so that the next time a machine reaches that state we have its readings on record and
can work from data instead of from my guess.

Where the evidence actually points: that laptop had nearly 1,500 programs, almost
14,000 threads and 112 open terminal sessions, its own server was stalling for 8 to
19 seconds at a time, and new sessions died while starting — all while a third of the
processors sat idle and every memory reading said normal. That is a machine crowded
with too many things, not a machine out of memory. Counting those things is a separate
piece of work, already on the list, and it is the right next instrument.

## Why it matters

The component this fixes is the one whose entire job is to notice trouble. On the
night it was needed it was raising an alarm about a phantom and had no view of the
real problem.

A watcher pointed at the wrong dial is worse than no watcher, because people read
its silence as an all-clear. That is exactly what happened here: the laptop carried
112 open terminal sessions and nearly 1,500 programs for days, and nothing ever
raised a hand.

## The safeguards

- The measured case becomes a test. The exact numbers from that night are written
  into the test suite, so if anyone ever restores the old behaviour the suite says so.
- A genuinely overloaded machine still reports as overloaded — that is tested too,
  from the other direction.
- The processor reading needs two measurements thirty seconds apart to mean anything, so
  for roughly the first half-minute after a restart it says nothing at all and the verdict
  comes from memory alone. It deliberately does **not** fall back to the old number:
  falling back to a measurement we have just proven wrong, at the exact moment the better
  one is missing, would quietly reinstate the bug. It also refuses to report a reading
  taken over a few milliseconds — a flicker is not an average, and publishing one at
  startup would recreate the false alarm this fixes.
- The memory verdict is untouched, so there is nothing new that can wrongly condemn a
  machine on memory. The three readings that are added cannot change any verdict at all.
- On Linux the processor fix applies exactly as it does on a Mac — it reads the same counters
  there. The three memory readings are Mac-only, so on Linux they simply report nothing.

## What you need to decide

Nothing. If you ever want the old behaviour back, one setting restores it exactly,
and the test suite proves it reproduces that night's reading.
