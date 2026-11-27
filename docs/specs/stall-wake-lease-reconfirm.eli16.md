# A machine back from a stall re-asks before it takes the lead — the plain version

## What this is

Echo runs on several computers at once. Only one of them is "the lead" at a time: it holds a short-lived pass (the
lease) that it renews every 30 seconds. If the lead stops renewing for a minute, another computer may take the pass.

This morning the Laptop's server froze for almost four minutes (and again at 08:30 for four more), probably because a big Mac app build was eating the
whole machine. While it was frozen it could not read any of the Studio's renewals. When it woke up, the first thing it
did, within one second, was look at its own out-of-date copy of the Studio's pass, see that it was "four minutes
old", decide the Studio must be dead, and take the lead. The Studio was perfectly healthy the whole time. That one
wrong grab caused a lead change and two restarts. The same thing happened at 00:27 with a series of shorter freezes.

The mistake is simple: the Laptop measured the Studio's silence with a clock that kept running while the Laptop
itself was not listening.

## What already exists

- The lease itself, its renewals every 30 seconds, and a pull loop that asks the other computers for their pass every
  5 seconds.
- A rule for freshly restarted computers (from the takeover-ready-pool work): they ask the others before they claim.
  That rule only covers the first minutes after a restart, which is why it did not help here.
- A way to tell "this computer is silent" from "it answered": three failed asks over 45 seconds means silent.

## What is new

The lease code now keeps its own small "am I awake?" clock, ticking every 2 seconds. If it notices that it lost more
than 30 % of a lease lifetime of running time (18 seconds out of the last 60), in one freeze or in several short ones,
it treats everything it believed about the other computers as stale. Until it has fresh evidence, it will not take the
lead from another computer until a full lease lifetime (one minute) has passed with this computer awake and at least
one fresh round of asks, started after the freeze, has finished. If the lead is alive, its renewal arrives in that time
(it renews every 30 seconds and answers every ask), and the grab never happens. If the lead really is dead, this
computer takes over one minute after it woke up.

There is deliberately no faster shortcut ("the lead told me it has nothing", or "the lead went quiet for 45 seconds"):
an answer or a timeout from an ask sent before the freeze can sit unread during the freeze and look fresh at wake, so
only a round of asks started after the freeze counts.

Before giving up, it asks every other computer once, right away, over every route it has. If the lead is alive, its
fresh renewal comes back and the grab simply never happens. This is exactly tonight's case, and the tests reproduce
it: without the change the Laptop grabs the lead; with it, it asks, sees the Studio renewing, and stays put.

## The safeguards

- It can only say "not yet". It never lets a computer take the lead in a case where it could not before, and it delays
  a real takeover of a dead lead by about one minute of awake time.
- Silence is never read as "the lead is dead", so this computer's own network still waking up cannot fool it.
- It is off unless someone turns it on, and turning it off takes effect on the next tick, with no restart and no state
  left behind.
- A computer that keeps freezing will not grab the lead while it keeps freezing; another healthy computer takes over
  instead. On a two-computer pool the takeover waits until the frozen one recovers for a minute, or at most about ten
  minutes.

## What you need to decide

Nothing. It ships switched off. After it merges, the plan is to switch it on for the Echo computers, watch the
`stall-reconfirm` lines in the server log and the weekly takeover drill for two weeks, and only then make it the
default.
