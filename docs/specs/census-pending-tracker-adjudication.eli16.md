# ELI16 — Why the agent kept reporting 49 lost to-do items that were never lost

## The situation

Instar keeps a running count of "LLM decision points" — the places in the codebase
where an AI model makes a judgment call. Some are fully instrumented ("wired"). The
rest are queued up to be instrumented later, and each of those queued entries points
at a to-do item that tracks the work: `ACT-1193`.

That pointer is written into the source code. Every copy of Instar ships with the
same 49 entries all pointing at `ACT-1193`.

## The bug

The agent checks whether that to-do item still exists, so it can shout if the plan
quietly lost its tracker. Sensible check. The problem is *where* it looked.

The to-do list is **per-machine**. It lives on one computer's disk and does not
sync to the others. But the pointer that gets checked against it is **baked into
the shipped code**, identical everywhere.

So on 2026-07-23 the situation was:

- The laptop had 1,211 to-do items, the highest numbered `ACT-1211`, and `ACT-1193`
  was sitting right there, open.
- The Mac Mini — the machine that actually runs everything — had 1,063 items, the
  highest numbered `ACT-1119`, and no `ACT-1193` at all.

The Mini therefore announced that all 49 tracking references were dead.

They weren't. The Mini had just never created a to-do item numbered that high. It
wasn't looking at a deletion; it was looking at something it had never seen.

## Why the machines don't agree

You'd think the fix is "turn on syncing between the machines." That was my first
guess too, and it's wrong. The syncing for to-do items is half-built: the sending
half exists, the receiving half was deliberately left for a later stage. The code
says so directly — with only its own data, the merge is "a strict no-op." Switching
it on would change nothing.

## The fix

The key insight is that a to-do list's **highest number so far** tells you something
useful. If a machine's highest-ever item is number 1,119, and you ask it about item
1,193, the honest answer isn't "that's dead" — it's "I've never minted a number that
high, so I genuinely can't tell you."

So the check now sorts trackers into three buckets instead of two:

- **Alive** — it's here and still open. Nothing to say.
- **Dead** — it's within the range this machine has definitely reached, but it's
  gone or finished. This is the real alarm, and it still fires exactly as before.
- **Unverifiable** — it's numbered above anything this machine has ever created, so
  it was made somewhere else. Reported separately, not as a loss.

## Why not just silence it

Because a genuinely deleted tracker is a real problem worth knowing about, and
silencing the whole check to kill the noise would throw that away. The point isn't
fewer alarms, it's alarms that mean something. An alarm that fires on every machine
you add, forever, for a reason nobody on that machine can act on, trains you to
ignore alarms — which is worse than having none.

Two smaller judgment calls in the same spirit: a to-do id that's malformed still
reports as dead rather than hiding in the new bucket (a broken constant is a real
defect and should stay loud), and a machine with no to-do list at all still reports
nothing rather than flagging everything (a fresh install shouldn't greet you with 49
false alarms).

## What this does not touch

Nothing. It's a read-only number on a status page. It doesn't block a message, gate
a job, or trigger any action. It exists so a human can look at it and know whether
the enrollment plan still has a tracker attached.
