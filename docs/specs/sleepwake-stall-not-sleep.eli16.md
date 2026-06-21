# ELI16 — Stop misreading a frozen event loop as "the machine slept"

## What this is, in plain English

Echo's server has a little watcher called `SleepWakeDetector`. Every couple of
seconds it checks the clock. If a lot more time passed than expected between two
checks, *something* made the program stop running for a while — and the watcher
has to guess **what**. There are two very different causes, and they need
opposite responses:

1. **The computer actually went to sleep** (lid closed, OS suspend). That's
   normal. On wake-up, recovery steps run (reset timers, re-check the network).
2. **The program froze its own event loop** — one Node.js thread got stuck doing
   a huge chunk of work and couldn't answer anything for 10–60 seconds. That's a
   *bug* (a "wedge"), not sleep, and it should be flagged for the wedge watchers,
   never celebrated as a clean wake.

## What already exists

The detector already tries to tell these apart, but only with **system load**
(`loadavg ÷ cores`). The idea was: if the whole machine is overloaded, a late
check is starvation, not sleep — so suppress the false "wake."

## What was broken

System load is the **wrong yardstick for a single stuck process**. On Echo's
16-core box, one Node thread can pin itself solid for 14 seconds and the 16-core
load average barely moves — it stays *well* under the "overloaded" line. So the
load guard never trips, and the detector announces **"Wake detected after ~14s
sleep"** — on a machine that is plugged in, lid open, with `caffeinate` running,
where sleep is *physically impossible*. Justin caught exactly this: he didn't
trust the sleep measurement, and he was right. Worse, those false "sleep" reports
hid the real problem — the event-loop wedges that were actually causing the
restarts.

## What's new

A second, **decisive** check: how much CPU **this exact process** burned during
the gap. A sleeping process is frozen — it burns ~0 CPU. A wedged event loop
burns CPU for almost the whole gap. So:

- Burned a lot of CPU through the gap → it was a **block/wedge**, not sleep. Emit
  a new `stall` signal for the wedge watchers; **suppress** the false "wake."
- Burned ~0 CPU → it really was idle/asleep → emit "wake" as before.

This new check runs **first**, beats the old load guesswork, and applies even to
**long** gaps (the old code blindly called any multi-minute gap "sleep" — but a
multi-minute CPU-busy gap is the worst kind of wedge). It defaults on, needs no
config, and fails safe: if the CPU reading can't be taken, it quietly falls back
to the old load-based behavior instead of crashing the watcher.

## What the reader needs to decide

Nothing to configure. This is a correctness fix: the detector now tells the truth
about *why* time jumped, so wedges stop being laundered into "sleep." The knob
`cpuBlockBusyRatio` (default 0.5 = "burned ≥50% of the gap on CPU → it's a
block") exists only if you ever want to tune or disable it (set 0).
