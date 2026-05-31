# Restart-when-idle — explained simply

## The everyday version

Imagine your phone is set to only install updates between 2am and 5am, so an update never
interrupts you mid-game or mid-call. That's a good rule! But now imagine your phone is just
sitting on the table at 2pm, screen off, nobody using it — and it *still* refuses to install a
ready update until 2am, because the rule says "only at night." That's silly: there's nobody to
interrupt right now. It should just install it immediately and be done.

That's exactly the bug this fixes for an Instar agent. An agent can be given a "restart window"
(say 2am–5am) so that when it downloads a new version, it only restarts to apply it overnight —
because a restart briefly pauses whatever the agent is doing. The problem: the agent was obeying
the window *even when it had nothing going on*. So an idle agent would download an update at, say,
9am and then run the old version for the next 17 hours, waiting for 2am, for no reason at all.

## What we changed

Before it decides to wait for the window, the agent now asks one question: "Is anyone actually
working with me right now?"

- **No one is active (idle):** restart now. Nobody gets interrupted, and the agent gets the new
  version immediately instead of waiting all day.
- **Someone is active:** wait for the window, exactly like before. The whole point of the window —
  not interrupting real work — is fully preserved.

## Why it's safe

The tricky part: the agent already has a trusted helper that decides "is it safe to restart?" But
that helper has a side effect — when it sees active work, it starts a countdown timer for how long
it's willing to wait. We did NOT want our new "are we idle?" peek to accidentally start that timer.
So we added a separate, read-only peek that answers the same question without touching anything.
To make sure the peek and the real decision can never disagree, they both run the exact same
piece of code to look at the sessions. We also kept the original safety helper completely
unchanged, and the existing tests that guard it all still pass — plus we added new tests proving
both cases: idle restarts right away, active work still waits.

The net effect: updates land sooner on idle agents, and you are still never interrupted while
working.
