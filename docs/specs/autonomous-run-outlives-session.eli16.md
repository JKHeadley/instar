# An autonomous run must outlive its session — plain-English overview

## What broke

When you tell me "go work on this autonomously for a while," that work is supposed
to survive things that happen to the *session* it runs in. Sessions get recycled
all the time — they hit an age limit, the server restarts for an update, the
machine reboots. Instar already has a system (the "resume queue") whose whole job
is: if an autonomous run's session gets recycled, bring it back and keep going.

The problem we found on 2026-06-15: that revival system was **silently switched
off** on this Mac, and had been for who-knows-how-long. The reason is almost silly.
The resume queue writes a small "lock" file stamped with the computer's name, to
make sure two different computers never share the same state folder (that would
corrupt things). This Mac had been **renamed** at some point (from
"Justins-MacBook-Pro-7" to "Mac"). So the lock file had the *old* name on it. The
system saw a name it didn't recognize, assumed "uh oh, another computer is using my
files," and shut the revival system down to be safe — and never said a word. A
routine rename quietly disabled the safety net for autonomous work.

## What this change does

Two things, both aimed at one rule we're adding to the constitution: **a registered
autonomous run must outlive its session — and if the system that keeps it alive is
ever off, it must say so out loud.**

1. **Tell a rename apart from a real conflict.** When the lock has a different
   computer name, instead of just giving up, the system checks: is this actually
   the same physical machine (the old process is long dead, and the files are on a
   local disk, not a shared network drive)? If yes — it's a rename — it safely
   takes over the lock and keeps the revival system running. If there's any doubt
   (the files might be on a shared drive, or the other process might still be
   alive), it stays cautious and off — but **loudly**, with an alert, never in
   silence.

2. **Never let a safety guard be off in silence.** If the revival system is
   disabled for any reason, it now shows up as a red flag on the guard dashboard
   and raises a single clear alert, instead of hiding as one obscure line of status
   text.

## Why we're being careful with it

Auto-taking-over a lock is exactly the kind of thing that, if it misfires on a real
shared drive, could corrupt data — the precise disaster the lock existed to
prevent. So the self-heal is built to fail safe: anything uncertain → don't heal,
stay off, alert. And it ships **off for everyone except this development agent
first**, where it runs in "dry-run" (it only logs what it *would* do) so we can
prove the detection is right on real data before it ever rewrites a lock. Only after
that proof does it roll out more widely — as its own separate, reviewed decision.

## What changes for you

Before: rename your Mac and the thing that recovers your autonomous work quietly
turns off, with no warning. After: a rename heals itself (carefully), and if the
recovery system is ever genuinely off, you get one clear heads-up instead of
silence. The careful self-heal proves itself on the dev agent before it reaches
your other machines.
