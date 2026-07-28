# ELI16 — Standby lease-holder propagation

## What this is, in plain English

When you run one agent across two computers, one of them is "in charge" at a time.
The way the agents agree on who's in charge is a little token called the "lease" —
think of it as a captain's badge. The computer holding the badge is the captain;
the other one is the standby. Lots of things depend on this: when you say "move
this conversation to the Mac Mini," the laptop (the captain) has to hand the
conversation over, and the mini has to accept it — but it only accepts orders that
come from the recognized captain.

Here's the bug we found by actually testing it on two real machines. The mini had
**no idea who the captain was.** Its "who holds the badge?" answer was blank. So
when the laptop (the real captain) forwarded the conversation, the mini said "I
don't take orders from you — you're not the captain as far as I know," and refused.
The hand-off died right at the finish line.

Why was the mini blank? Two reasons stacked up. The code that sets up the whole
captain/standby system was bundled together with a different feature — backing the
data up to git (a code-history service). On the laptop, git backup is blocked on
purpose (a safety guard, because the laptop's agent folder is literally the instar
source code and we never want automated git writes there). When that git step
failed, the code threw the WHOLE bundle away — including the part that talks to the
other machine, which doesn't even need git. On the mini, git backup is simply
turned off, so the same bundle never ran at all. Net result: neither machine ever
started the captain-tracking system, so nobody knew who the captain was.

## What we changed

We separated the two things that were wrongly glued together. The git backup is now
an optional extra: if it works, great; if it can't run, we just skip it and keep
going. The captain-tracking system now always starts whenever multi-machine mode is
on, and it talks between machines over the normal secure web connection the agents
already use — no git required. For a machine with no git, we added a small local
file that remembers this machine's own view of the badge, while the live "who's the
captain right now" answer travels over the web link.

We also caught a second, hidden bug with the new test: even once the system runs,
the standby was throwing away every "I'm the captain" announcement it received,
because of an overly-strict duplicate-message check that accidentally rejected the
very message it was supposed to accept. We fixed that too, carefully, so it still
rejects real duplicates and forged messages but accepts the genuine announcement.

## Why it matters

Without this, multi-machine session transfer can never complete — the standby will
always refuse the hand-off. With it, the standby learns who the captain is, accepts
the hand-off, and the conversation moves machines cleanly. This is the missing piece
the live test-as-self proof was built to find, and it only shows up on real two-
machine hardware (our automated tests had been pretending the badge was already
shared, so they never caught it).

## What you'd notice

Nothing changes for a one-machine setup. On a two-machine setup, "move this to the
other machine" now actually works end to end instead of silently failing at the
last step.
