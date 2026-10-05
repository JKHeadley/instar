# ELI16 — a second machine starts at login the same way the first one does

## What was wrong

On the first machine, the agent starts at login through the "lifeline": a small watchdog program that reads Telegram, keeps the agent's server running, and restarts it if it stops. The lifeline needs Telegram settings to run.

When a second machine joins with "instar join", it doesn't have Telegram settings yet, because those stay on each machine. So join set the second machine to start only the bare server at login, with no lifeline. That was a reasonable choice at join time. But nothing changed it later, after Telegram was set up on the second machine. Luna's Mac Studio was left without the watchdog the laptop has (instar#2122).

Join also finished by telling the person to run "instar server start", even though the login entry had already started a server. Following that advice started a second, unwatched server that fought the first for the same port.

## What changes

- Each time the server starts, it already checks that its login entry is correct and repairs it if not. That check now also catches this case. If Telegram is set up but the login entry starts only the bare server, it rewrites the entry to use the lifeline. This causes one restart, the same as the repairs it already makes.
- "instar join" now says the server is already starting, and no longer suggests starting another.

## What you need to decide

This is a bug fix with no decision for the operator.
