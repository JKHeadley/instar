# ELI16 — Safe replicated-journal compaction

## What changed

Replicated records live in append-only journal files. Historical re-emits left many old versions of the same key on disk even though only the newest version per machine can affect current state. This adds an explicit one-shot compactor that streams each registered record journal, retains the newest HLC version per `(origin, recordKey)`, and reports the before/after record count.

## Why it is safe

The feature is off by default and its first enabled posture is dry-run. A real run writes a separate temporary stream, syncs it to disk, rebuilds the witness answers from those actual bytes, and requires exact parity with the original before an atomic rename. Any error or interruption before rename leaves the original byte-for-byte intact.

That read-back check matters: it validates the bytes that would actually replace the journal, not merely the in-memory compaction plan.

## How to verify

Unit coverage proves superseded versions disappear without changing the winning witness. Integration coverage proves dry-run writes nothing and a real run reclaims bytes with the same rebuilt witness. The crash test interrupts immediately before rename and proves the original survives unchanged.

A fresh install with no journal or peers directory is an explicit no-op: there are no replicated streams to compact.

The hand-authored dark-gate attribution map is updated for the ConfigDefaults line shift; the set of enabled-feature paths does not change.
