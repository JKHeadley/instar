# Stop the account-switching churn (plain-English overview)

## The problem

Your agent can hold several subscription accounts and move a work session from
one account to another when the first one is running low. That "move" is
actually a restart: the session is stopped and started again on the other
account. On July 2nd this went badly wrong — the agent moved sessions between
accounts **36 times in one day**, often moving the same session back and forth
between the same two accounts within the hour. Every one of those restarts
killed the helper tasks the session had running in the background and threw
away whatever it was in the middle of doing. A feature meant to keep work
alive became the main thing destroying work.

## The fix — four common-sense rules

1. **If every account is nearly full, stay put.** Moving from one nearly-full
   account to another nearly-full account buys nothing and costs a restart. The
   agent now just keeps working where it is, and only moves if it truly hits a
   hard limit.
2. **No quick re-moves.** Once a session has been moved, it stays where it is
   for at least 45 minutes. That ends the back-and-forth ping-pong.
3. **Only move somewhere clearly better.** A move now needs a destination
   account with real breathing room (under 65% used, and at least 15 points
   less used than where the session is now). "Barely less full" is no longer a
   reason to restart your work.
4. **Never interrupt work in progress.** Before any planned move, the agent
   checks whether the session is in the middle of something — answering you,
   or running helper tasks. If it is, the move waits (up to 30 minutes) for
   the work to finish. If the work is still going at the end of the wait, the
   move is simply **cancelled** — your work always outranks an optimization.

There is one deliberate exception to rule 4: if an account **actually hits its
hard limit**, the session must move or it dies. Even then it waits up to 2
minutes for the current step to finish, and after the forced move the
restarted session gets a note listing exactly which helper tasks were
interrupted, plus a copy of the last message you sent that never got answered
— so nothing is silently lost, and the restarted session can pick up where the
old one left off.

## What you'll notice

Far fewer surprise restarts. On a busy afternoon where all accounts run hot,
sessions simply keep working instead of bouncing around. If you ask "why
didn't my session move accounts?", there's now a written record with the exact
reason (everyone's full / it moved recently / the destination wasn't clearly
better / it was busy working). If the switching ever starts to misbehave
again, a built-in circuit breaker pauses all planned moves for an hour and
sends you one alert — not a flood. The misbehavior detector catches all the
shapes we know: the simple back-and-forth between two accounts, the same
back-and-forth spread across different sessions, and the sneakier version
where a session gets pushed around a circle of three or more accounts.

Two more things: you'll see fewer repeated "session restarted" notices (at
most one per move, not one per hop), and you'll no longer get silence when
things are genuinely stuck — if a session is forced to emergency-hop accounts
repeatedly because everything is truly full, or it literally cannot move
again for a while, you get exactly one clear alert about it instead of
nothing.

## Decisions already made (so you don't have to open the technical spec)

- The 45-minute stay-put window is a fixed number for now (easy to tune later
  after we watch it in practice).
- Emergency moves (the hard-limit case) behave exactly as they do today — this
  change only tames the *optional* moves.
- Sessions that run on the "default" account are never auto-moved, because
  moving them would quietly change which account all future new sessions use.
- If the server restarts, it remembers recent moves, any open circuit-breaker
  pause (including exactly when that pause was due to end), and which sessions
  were having trouble — a reboot can't reset any of the brakes.
- One narrow piece stays off at first: the extra check that stops a *model*
  change (not an account move) from interrupting quiet background helpers. It
  gets its own on-switch later, so nothing about today's model-changing
  behavior shifts by surprise on update day.
- Everything ships in observe-only mode first: it writes down what it *would*
  have done for a while before it's allowed to actually refuse anything.

No open questions remain — everything a builder would need to decide is
already decided in the spec.
