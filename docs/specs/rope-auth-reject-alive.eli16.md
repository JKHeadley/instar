---
title: A machine that says "no" is not asleep
slug: rope-auth-reject-alive
audience: decider
---

# A machine that says "no" is not asleep

## The one-sentence version

When one of your machines actively refuses another's messages because of a key mix-up,
the health monitor used to file it as "that machine is offline — expected", and stay
quiet; now it recognises the refusal as proof the machine is awake, says so loudly, and
names the likely cause.

## What happened

On the 27th, the Studio's identity files went missing and its signing key had to be
regenerated. The other machines still remembered the old key, so every message the Studio
sent them came back "rejected — invalid signature". Nearly eleven thousand rejections per
connection over two days. Messages *to* the Studio still worked, so the mesh ran one-way,
and no alarm distinguished this from an ordinary sleeping machine.

## Why the monitor got it wrong — the circular part

The monitor's rule for "offline — expected, no alarm needed" checks two things: has the
machine stopped reporting itself in? and has its heartbeat stopped?

Both had stopped. But both had stopped *because of the key problem* — a machine that
can't authenticate to its peers can't report in or heartbeat to them. The monitor was
reading the fault's own symptoms as the innocent explanation for the fault. A
classification that consumes the evidence the failure destroys can never fire.

## The insight that fixes it

There was one signal the fault could not destroy: the rejections themselves. The
recovery prober was still sending test messages, and the Studio's peers were still
*answering* them — "no, invalid signature." A machine that answers "no" has dialled,
verified, and refused. It is provably awake. That answer is stronger evidence than any
missing heartbeat.

## What changes

The prober now remembers, per machine, when it last saw a signature-layer refusal. The
health monitor checks that evidence *first*, before either "offline — expected" rule.
Fresh refusals reclassify the machine as **awake but refusing** — a distinct state with
its own loud alert (one per episode, not a stream) whose text names the likely cause: a
key or identity mismatch, mesh probably running one-way, stored identity needs repair.
The daily digest says the same instead of "offline — expected."

## The safeguards

- **Evidence must be fresh** — within 45 minutes. One stale refusal from a long-fixed
  episode can't keep reviving the alarm.
- **Only real refusals count.** A connection that simply failed (network down) records
  nothing; only a typed "invalid signature"-class answer does. So a genuinely sleeping
  machine can never trip this.
- **One alert per episode**, with the same delivery honesty as the partition alert: if
  delivering it fails, it retries next evaluation rather than being lost.
- **If the evidence source can't be read, nothing is claimed** — the machine classifies
  by the ordinary rules, exactly as today.
- It raises an alert; it blocks, restarts, and repairs nothing. Signal only.

## What you need to decide

Nothing. This closes the "detect loudly" half of the machine-self-assertion plan you
already approved — it's the piece that makes a key mix-up visible in minutes instead of
days. The automatic *repair* (the machine re-announcing its new key with proof) is the
separate piece being built under that spec.
