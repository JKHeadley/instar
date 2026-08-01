---
title: "The promise beacon notifies per-commitment, so its message rate scales with the backlog rather than with progress"
date: 2026-07-30
author: echo
machine: Mac Mini
severity: medium
status: open
kind: finding
relates:
  - "docs/STANDARDS-REGISTRY.md"
---

## The claim

In one Telegram topic on 2026-07-30, the promise beacon posted **105 messages**. They came from **11
distinct commitments**. My own deliberate messages in the same topic on the same day numbered **59**.

So the channel the operator reads carried **almost twice as much beacon output as agent conversation**, and
the beacon's volume is a function of **how many commitments are open**, not of how much happened.

The operator has called this channel unreadable twice. This is a measured, mechanical contributor.

## Evidence

Counted from the topic's message log for 2026-07-30:

| bucket | count |
|---|---|
| operator | 10 |
| **my deliberate messages** | **59** |
| automated / system | 139 |
| — of which the `⏳ working on it` beacon | **105** |

The beacon fires **one message per open beacon-enabled commitment, per cadence**, and they land in the same
minute:

```
00:14 → 3 fires: "Make the spawn-admission queue durable…"
                 "Report delivery honestly to the sending peer…"
                 "Add the class-level guard…"
00:34 → the same 3
00:54 → the same 3
01:14 → the same 3
```

Per-hour distribution shows 15–18/hour through the overnight stretch — roughly one every three and a half
minutes — falling to 1–6/hour later in the day as the open-commitment count dropped.

## Why the existing suppression does not catch this

`promiseBeacon.suppressUnchangedHeartbeats` is **already `true`** on this agent. That setting suppresses the
zero-information *"still on it, no new output"* filler. Every one of these 105 is the *other* variant —
`recent output observed`, the genuinely-changed case the suppression deliberately permits.

So each message is individually justified. **The volume is not caused by any of them being wrong.** It is
caused by there being one per commitment, with no bound across the set.

## The standard this crosses

The constitution's Bounded Notification Surface is explicit:

> *"If I am building a feature that notifies per-element over a collection: AGGREGATE — one summary item
> carrying the count and the list, never one item per element."*

The beacon is a per-element notifier over the open-commitment collection.

**Why the existing flood guard misses it:** the topic-creation budget and its burst-invariant test sit at the
**topic-creation** chokepoint — they bound how many *topics* an automated source may create. This beacon
creates no topics; it posts repeatedly into one that already exists. **A per-element notifier that reuses a
single topic is outside the bound entirely.** That is the structural gap, and it generalises past the
beacon: any future per-element notifier posting into an existing topic is equally unbounded.

## Direction (not decided here)

The shape the standard asks for is one message carrying the count and the list — *"3 items in progress:
durable spawn queue, honest delivery reporting, class-level guard"* — rather than three messages. That is a
change to how the beacon composes its output, not to when it decides to speak, and the existing
per-commitment cadence logic can stay.

The harder question, deliberately left open: a per-commitment cadence produces per-commitment timing, so an
aggregate needs its own cadence and a rule for what to do when one commitment has news and four do not.

## What is NOT claimed

- **Not** that any individual beacon message is wrong or unwanted. Each reflects real observed progress.
- **Not** that the suppression setting is misconfigured. It is on and working as designed.
- **Not** that the beacon is the only contributor to channel volume — it is 105 of 139 automated messages,
  so it dominates, but standby notices, respawn notices and observer posts make up the rest.
- **Not** measured on any other topic or agent. One topic, one day. The mechanism is shared code, so it is
  expected to generalise wherever several beacon-enabled commitments are open at once; that is an inference.

## A note on the measurement itself

I nearly reported this wrong twice. My first count classified **208 records as "mine" and 0 as the
operator's**, because I filtered on the wrong field — he had messaged twice that day, so the zero was
impossible and that implausibility is what caught it. The corrected split then showed my own deliberate
volume at 59 against a self-imposed bar of 60, which I had spent the day describing as *"far over"*. **Both
the alarming number and the reassuring one were artifacts of how I counted**; the load-bearing figure was
neither, and it only appeared once the automated traffic was separated out.
