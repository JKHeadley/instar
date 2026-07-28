# Quota-aware placement — the plain-English version

## What went wrong

One night your conversation lived on the Mac Mini while the Mini's Claude
account had hit its session limit ("resets at 10:30pm"). The multi-machine
pool kept routing your messages there anyway — it only looked at CPU load,
session counts, and memory when picking a machine. "Is this machine's AI
account actually able to respond right now?" wasn't a question it knew how to
ask. So you typed, and got silence, from a machine that looked perfectly
healthy on every metric the pool checked.

## What changes

Every machine now includes one more thing in the little status report it sends
the pool every 30 seconds: **"can my AI account actually work right now?"**
Each machine answers only for itself, from its own quota tracker (we learned
the hard way not to let one machine's quota file speak for another).

The machine-picker then uses it:

- A rate-limited machine **stops receiving new conversations**.
- A conversation currently ON a machine that becomes rate-limited **moves off
  it** on your next message — the "stay where you are" preference no longer
  applies to a machine that can't answer.
- If you explicitly pinned a conversation to a machine ("run this on the
  mini"), **your pin still wins** — but the decision is flagged so you can be
  told the machine is rate-limited rather than left guessing.
- If EVERY machine is rate-limited, the pool still places the conversation on
  the least-busy one (somewhere beats nowhere) and flags that too.

You can see each machine's quota state on the Machines view (`GET /pool`).

## What you'll notice

Messages stop landing on machines that can't answer. If a machine hits its
limit, your conversations quietly shift to one that's working — and you'd
only ever stay on a limited machine if you pinned it there yourself, in which
case I can tell you exactly why it's quiet and when it resets.
