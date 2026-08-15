# ELI16 — the refusal that named the machine in hex

## What this is about

When the agent runs on several computers, only one owns a given piece of state. If another tries to
write it, the write is refused — and the refusal is supposed to tell you *which* machine owns it, so
you know where to go instead.

## What was wrong

The refusal message already has two ways to say it: by nickname if one is known, and by raw machine id
if not. The nickname lookup was never handed to it, so **every refusal took the fallback**, and what
you got was a thirty-two character string of hex instead of "the Mac Mini".

The nicer branch existed and was unreachable — the same shape as the earlier fix where a work-queue
priority could never be assigned because the value it depended on was never supplied.

## Why it matters more than the last one

The previous fix made a machine able to name *itself*. This one makes it able to name **the other
machine** — which is the entire point of a refusal whose job is telling you where to re-send.

## Why it can't make anything worse

The lookup is unavailable in some start-up situations, and a machine not registered in the pool has no
nickname. **Both produce nothing — exactly what the message already fell back to.** So this can only
replace hex with a name; it cannot produce a wrong name and cannot fail.

## How I found it

By reading my own note. When I shipped the previous fix I wrote down, in the review, that this second
dependency was still unwired and untouched. Following that note is what produced this — the fourth
time tonight a fix came from a written record of what the previous one did *not* close, rather than
from looking for something new.

## How you know it works

The existing guard already scans every place the component is built. It now also requires this second
lookup. Against the old code it **fails**, naming the exact line and saying the consequence. Ten other
checks pass either way, including one proving the scan finds a construction at all — otherwise "every
site supplies it" would be trivially true of zero sites.
