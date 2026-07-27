---
title: Recurrence Synthesis
description: One reader across the three places your agent notices problems, and the actuator that turns a repeated noticing into tracked work.
---

Your agent notices problems in three separate places — the **attention queue**, the **evolution
action queue**, and the **sentinel log**. Until now nothing read across them. Each individual
noticing was minor and each was true; nobody ever saw that the same underlying problem had been
raised two hundred times.

The measured consequence: roughly **thirty things started for every one finished**. Recurrence
synthesis exists to close that gap, and it is deliberately built in three pieces so that seeing,
deciding, and acting can each be wrong in isolation rather than silently together.

## What it found on real data

The first run against live stores, 2026-07-27:

| Measure | Value |
| --- | --- |
| Open observations across the three stores | 2,068 |
| Distinct underlying problems | 836 |
| Problems noticed repeatedly but never tracked | 69 |
| Noticings those 69 account for | 1,242 |

The three largest, never before seen grouped: idle-timeout detection (278), escalation-suppressed
(238 — a watcher recording its decision not to tell anyone, 238 times), and the credential
rebalancer (177, which alone is 48% of the attention queue).

## The three pieces

### RecurrenceReader — seeing

`RecurrenceReader` groups open observations from all three stores into recurrence clusters. It is
pure and read-only: no route, no config, no authority. Every report carries a `coverage` block
naming each store it could **not** read.

That coverage block is the point. If a store is unreadable, the reader publishes the clusters it
could see and leaves `verdict` **absent** rather than reporting `no-recurrence`. *Nothing there* and
*could not look* are different answers, and a synthesiser that conflated them would be able to
commit the exact failure it exists to detect.

Keying is title-based, with digits and hex normalized away so that "3 topics stranded" and "17
topics stranded" count as one problem. The trade is real: the blunt key occasionally over-merges,
so each cluster carries an `exemplar` and its `sources` for a reader to spot it. Semantic matching
would mean a model and a judgment point, deliberately avoided here.

### RecurrenceActuator — deciding

A report nobody acts on is the same 30:1 ratio with better typography. `RecurrenceActuator` turns a
finding into a proposal for **one tracked action** on the action queue that already exists — no new
store, no new notification channel. Creating a tracked action queues work for a human or agent to
judge; it does not close, prioritise, escalate, or act on anything.

It is pure: it returns a *plan*, so the write path and its gating stay exactly where they already
are.

Two refusals, deliberately **not** symmetric:

- **The action queue is unreadable → propose nothing.** Whether anyone has already committed to a
  problem is unanswerable, so every cluster would look unowned and the actuator would manufacture
  duplicates of work that already exists — the exact redundancy it was built to remove, under the
  banner of fixing it.
- **Attention or sentinel unreadable → proceed.** Those only *understate* counts, so a cluster that
  still clears the threshold genuinely clears it.

Treating all three identically would have looked tidier and been wrong.

Bounds keep the fix from becoming its own pile: a recurrence threshold (default 10 — a thing seen
twice is not yet a pattern worth a work item), a hard per-run cap (default 3) so it converges across
sessions densest-first rather than turning 69 clusters into 69 items, and a stable `externalKey` so
a re-run updates one row instead of adding another. Priority is derived from volume alone —
deterministic, no model.

### The loop — acting

`runRecurrenceLoop` reads the three stores, plans, and writes through a caller-supplied
action-creation function. It is deliberately the only place in the feature that performs I/O, so a
read failure has exactly one place to be reported from and cannot be swallowed mid-pipeline.

Its load-bearing distinction is at the very end: a **failed write** is recorded separately from a
**refusal**. One is an outage; the other is a decision not to act. Reporting an outage as a refusal
would let real breakage present as sound judgment — this system's own disease, committed on the last
line of the thing built to cure it. One failed write does not abandon the remaining ones.

An unreadable store is data, not an exception: the loop never throws for one, it names the gap in
coverage and lets the actuator's refusal read it.

## Honest limits

**Nothing schedules it.** The loop *can* close unattended; nothing yet calls it, so today it closes
when something invokes it. That is stated rather than implied.

Priority from volume alone means a rare-but-serious problem ranks below a frequent-but-trivial one.
And the actuator inherits the reader's title-only keying, over-merges included.
