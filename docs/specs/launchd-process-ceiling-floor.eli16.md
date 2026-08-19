# Launchd Process Ceiling — Plain-English Overview

> The one-line version: a safety limit meant to catch a runaway was set lower than the number of programs a normal computer runs while doing nothing, so it fired at rest and eventually took the agent's server down.

## The problem in one breath

Every computer has a cap on how many programs one user account may run at once. Instar sets that cap deliberately, as a last-resort belt in case something of its own runs away. The number chosen was 512 — a sensible-looking figure if you count only instar's own helpers. But the operating system counts EVERY program the logged-in person is running: the desktop itself, the browser, the editor, all of it. An ordinary Mac sits at 500 to 550 while idle. So the belt was already tight before instar started anything.

## What already exists

- **The main control** — a counter that limits how many AI helper programs run at the same time, currently eight. This is the real protection and it works.
- **The belt** — the operating-system cap this document is about. It exists only to catch something that ignores the counter entirely.
- **A past incident** — in June, roughly 230 to 290 helper programs started at once and exhausted the machine's memory. That is the event the belt was added for.

## What this adds

The belt's number goes from 512 to 2048. That is the whole functional change.

The reasoning is what matters: 2048 sits about 1,500 above what an idle machine already uses, far above anything the main control would ever let through, and far below the operating system's own hard maximum of 10,666. So it still catches the June-scale runaway, and it no longer fires when nothing is wrong.

- The number is also corrected for computers that already have instar installed, not just new ones — otherwise the fix would reach only the machines that never had the problem.

## The new pieces

- **The corrector** — a small routine that finds the number in the machine's startup settings and raises it if it is too low. It is deliberately allowed only to RAISE, never to lower: someone who set their own, higher number keeps it. It edits that one number and touches nothing else, so anything hand-added to those settings survives. Running it twice changes nothing the second time.

## The safeguards

**Prevents overwriting a deliberate choice.** The corrector acts only on a number strictly below the new minimum. A person who tuned theirs higher is left alone.

**Prevents fixing one outage by causing another.** The corrector does not restart anything. Restarting the background service would make the new number take effect immediately — and would also cut the operator off from their agent mid-update, which is the exact harm this whole change exists to stop. The number is written now and takes effect at the machine's next restart.

**Prevents damage on machines this does not apply to.** Only Apple computers have these startup settings. Elsewhere the corrector records that it skipped, rather than treating it as a failure.

## What ships when

One patch, all at once. There are no stages and nothing to switch on.

## What it does NOT do

Worth being blunt: after updating, a machine still runs under its OLD limit until it is restarted once, and nothing yet notices or reports that gap. During the incident, blocked commands came back empty rather than complaining — which quietly misled the agent into treating "the command never ran" as "here is your answer". Making the live limit visible, and making a blocked command say so, is real work and is not in this change. It is registered separately so it does not get lost.

## What you actually need to decide

Whether raising this limit from 512 to 2048 is acceptable — that is, whether you are comfortable that the belt still catches a genuine runaway (the June event was under 300) while no longer tripping on an idle machine. If yes, this ships and your other two machines pick it up on their next update plus one restart each.
