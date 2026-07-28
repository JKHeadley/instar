# Fleet guard-posture completeness — Plain-English Overview

> The one-line version: every machine now carries a bounded list of load-bearing protections it cannot currently prove, and the fleet view displays that list without creating another alarm.

## The problem in one breath

The local guard readout already distinguishes two different questions: which critical protections are silently unguarded, and which critical protections are loudly unproven because their posture is missing, errored, stale, or contradicted by runtime state. The compact heartbeat omitted the second answer. That meant the cross-machine view could still show an empty critical-gap list and be mistaken for a complete all-clear even though the sending machine had explicitly found a load-bearing protection it could not prove.

## What already exists

- **Local guard inventory** — names load-bearing guards in the four existing unproven posture classes while leaving them out of the silent-gap class.
- **Guard posture alarms** — raise the existing missing, errored, stale, or runtime-divergent anomaly. They deliberately do not raise a second load-bearing-gap alarm for the same guard.
- **Machine heartbeat and pool view** — carry a compact guard-posture block from each machine and retain its last known value for a dark peer.
- **Machines dashboard** — reads the pool response and opens a per-machine detail record.

## What this adds

The heartbeat gains a full count and a bounded key sample for load-bearing protections whose existing posture cannot currently prove protection. The producer sorts the keys and sends at most 16 of them. Sixteen covers all 13 load-bearing guards in today’s manifest, and the uncapped count remains present if the manifest later grows past the key ceiling, so truncation is visible rather than becoming another false all-clear.

The machine detail record displays the count and the keys received from that machine. If the count is larger than the key sample, it says how many keys are shown. This is the actual reader for the new wire field; it prevents the fix from stopping at a decorative payload that no operator surface consumes.

## The new pieces

- **Bounded heartbeat projection** — copies the already-derived unproven list into a count plus at most 16 deterministic keys. It cannot classify a guard, change a gap, or trigger an action.
- **Fleet detail rendering** — displays “Load-bearing protection unproven” inside the existing machine record. It does not change the machine headline, attention tile, warning tone, or notification path.
- **Durable semantic comparison** — treats the new count and key sample as meaningful heartbeat state, so a changed sample persists even when the older aggregate posture counts happen to remain equal.

## The safeguards

**Prevents double-alarming.** The peer probe continues to ignore the new fields. A load-bearing errored guard still produces exactly one existing errored anomaly and no load-bearing-gap episode or fleet notification.

**Prevents classification drift.** The local effective-state precedence, `loadBearingGap` membership, gap keys, and machine-health calculation are unchanged. The new fields are a read-only projection of an existing list.

**Prevents heartbeat growth from becoming open-ended.** At most 16 key strings ride each 30-second heartbeat. The full count travels independently, so a future seventeenth key is omitted from the sample but not from the truth.

**Refuses a decorative wire field.** Unit coverage pins the producer, bound, and no-second-alarm rule. Integration coverage carries the fields through durable pool state and the real `/pool` route. End-to-end coverage opens the shipped Machines glance and requires the remote key to appear in the machine record.

## What ships when

This is one additive patch completing the same guard-read-surface item as the local summary. Older peers and consumers remain compatible because the two wire members are optional on read; upgraded senders always emit both.

## What you actually need to decide

Does this patch complete the cross-machine read without changing any existing guard classification, anomaly, notification, or fleet-health decision?
