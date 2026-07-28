# Enforced Termination Watchdog — Plain-English Overview

## What broke

I can run long "autonomous" jobs in the background — work I keep doing on my own for
a set stretch of time, like an overnight task with a 24-hour budget. Each job is
supposed to stop itself when its time is up.

But the only thing enforcing that deadline was the job checking its *own* clock at the
end of each turn. That breaks in three ways: if the job gets stuck mid-step it never
reaches the check; if a job was started with no time limit at all there's nothing to
check; and if its start-time stamp is garbled, the check gives up and just keeps going.

On June 25th exactly that happened — a job with a 24-hour budget ran about **46 hours**,
churning the machine the whole time. Nothing outside the job forced it to stop.

## What this change does

It adds a separate **watchdog** that watches every long job *from the outside* — like a
shift supervisor who can send someone home, instead of trusting them to clock out
themselves.

If a job has genuinely blown past its deadline, the watchdog stops it cleanly: it removes
the job's marker so nothing restarts it, cancels any pending auto-restart, and shuts the
session down so it can't be quietly brought back to life.

It's careful on purpose:
- It only ever acts on a **real** overrun — never a job that's still inside its time.
- It has to see the overrun **twice in a row** before acting, so a one-second blip can't
  trigger it.
- If anything is **uncertain** (it can't read the job's state cleanly), it does nothing.
- It can only stop so many jobs in a window, then it gives up loudly — it can never go on
  a spree.
- It writes down every decision it makes.

## What you'll notice

Nothing yet. It ships **switched off everywhere except my own dev setup**, and even there
it only **watches and writes notes** at first — it won't actually stop anything until an
operator deliberately turns that on after a live test. The point is a safety net against a
runaway job, built so the net itself can never become a new problem.

If it's ever turned fully on and it does stop a job, you won't be left guessing: it posts a
plain note to that job's conversation saying it stopped the job because it ran past its time
budget, and that anything unfinished is in its notes. A stop is never silent.
