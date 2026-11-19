# Agent-started sessions go to the machine with room — Plain-English Overview

> The one-line version: when an Instar agent starts a helper session itself, it now starts it on whichever of its machines has room, instead of always on the machine it happens to be on, and it does this as soon as that machine is busy, not only once it is nearly full.

## The problem in one breath

Justin asked why sessions are not spread to other machines before the Mac Studio is overloaded. On 17 November the Studio had 23 sessions and the Laptop none; its load was two to four times what its 16 processor cores can handle for hours, its agent server froze for up to a minute and a half at a time, and code testing took twice as long. The reason is simple: when an agent, a scheduled job or the Chief of Staff starts a session, it always starts on the same machine. Only conversations started by a person's message get spread across machines.

## What already exists

- **Placement for conversations** — when a new message arrives for a new conversation, the agent picks the machine with the most room, using fresh load readings from every machine.
- **Placement for heavy helper work** — a separate way to start a heavy helper (builds, full test runs) on a big machine with room. It works, but almost nothing uses it.
- **An overload brake** — a busy machine can refuse new automatic work. On the Studio it is switched to "report only", so it has refused nothing.
- **Moving conversations off a full machine** — it only starts after three minutes of real refusals and with the machine at 85% of its session limit, so it has never started.

## What this adds

First, measurement: every time an agent starts a session, the agent writes down where it WOULD have put it (this machine or one with more room) and why, without moving anything. Within a day that shows exactly how much load could have gone elsewhere.

Second, for helper sessions that ask for it, real placement: if this machine is busy (its own load reading says overloaded, or it has more work than processor cores) and another machine has room, the helper starts there and the answer says which machine. If this machine isn't busy, the helper stays here.

## The new pieces

- **A "place this for me" choice on each start request** — only requests that ask for it can move. Many helpers need files that exist only on this machine, so moving them blindly would break them.
- **A record of every decision** — where each session would go, or went, and why.
- **A switch** — on for Echo, off for everyone else until it has proved itself.

## The safeguards

**Never runs anything twice.** If another machine may have started the session but didn't clearly confirm, nothing is started here; the answer says where to look.

**Never loses a session.** If the other machine clearly says no, the session starts here as before.

**No ping-pong.** A session sent to another machine is marked, so it is never sent on again.

**Stays home when there is room.** It only looks elsewhere when this machine is busy, using the same limits the system already uses for heavy work.

## What ships when

Now: the measurement for every session, and placement for helpers that ask. Next: sessions an agent starts for a conversation (18 of the Studio's 23), moved with the conversation's ownership using the same safe start the dashboard already uses. Then: the Chief of Staff decides whether the Studio's overload brake should really refuse work, and moving existing work off a machine based on sustained load. Each of these has a tracked commitment with a date.

## What you actually need to decide

Nothing for this first step: it ships switched on only for Echo, moves only helpers that ask, and is undone with one setting. The later step of turning the Studio's brake on for real comes to the Chief of Staff as a separate yes/no with numbers.
