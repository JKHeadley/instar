# ELI16 — The server babysitter finally speaks up

## The problem

Every Instar agent has a babysitter process whose whole job is restarting the
agent's server when it crashes. If the server keeps crashing, the babysitter
backs off to one revival attempt every 2 hours — forever. The "forever" part is
right (it's the thing that brings everything back; it should never quit). The
broken part: it never told you. A server stuck in crash-revive-crash cycles for
three days looked exactly like silence. You'd only find out your agent was down
by noticing it stopped talking to you.

This is the exact loop that inspired the "never give up, but never go silent"
caveat in the new No Unbounded Loops standard — so it's the first one fixed
under it.

## The fix

After 12 hours of failed revival attempts in one outage, the babysitter sends
you ONE Telegram message: roughly "Still down after 12 hours. I'm retrying
every 2 hours and won't stop, but a human may be needed — here's the command
that diagnoses it, here's the one that retries right now. This is the only
nudge I'll send for this outage." Then it goes back to quietly trying. When the
server recovers, the one-shot re-arms for the next outage.

Two details worth knowing: the message travels straight from the babysitter to
Telegram (it doesn't depend on the dead server — that would be useless), and a
test drives a simulated week-long outage through the logic to prove the
message count stays at exactly one.

## What changes for you

Nothing, until the bad day. On the bad day, you find out within 12 hours
instead of whenever you happen to notice the silence.
