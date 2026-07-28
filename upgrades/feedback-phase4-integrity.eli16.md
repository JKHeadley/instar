# ELI16 — Phase-4 feedback-migration integrity tooling

## What problem does this solve?

We're moving the "feedback factory" (the thing that catches user bug reports, groups
duplicates into clusters, and tracks each cluster's lifecycle) from Dawn's Portal over to
Instar. The cluster records aren't just data — they hold human and AI *judgment*: which
bug is which, what was already triaged, what was shipped. That curated judgment is
irreplaceable. If the move corrupts it, or if the new processor later overwrites it, we
lose work nobody can recreate.

Two specific dangers:

1. **A silent bad copy.** "The row counts match" is far too weak a check — a single
   cluster could come across with its status flipped or its governance note dropped and a
   count check would never notice. We need to prove *every curated field of every row*
   survived the move byte-for-byte.

2. **A wrong-date backfill overwriting curated history.** After cutover, the processor is
   only supposed to touch *new* reports. But if someone ever re-runs it over old data, it
   would happily "re-cluster" the curated history and discard every triage decision.

## What this change adds

Two small, pure, well-tested building blocks (no database, no network — just logic, so
they're fully unit-testable):

- **`importIntegrity.ts`** — the import gate. It computes a per-row checksum over every
  curated field and compares source-vs-imported (catching silent corruption), scans the
  source for two clusters sharing a fingerprint *before* importing (which would otherwise
  abort the transaction or silently merge them), asserts the two schemas accept the same
  status values and field types, checks that no feedback row points at a missing cluster
  (referential integrity), and computes the auto-increment sequence reset so the next new
  insert can't collide. `runIntegrityGate()` rolls all of that into one pass/fail.

- **`immutableGuard.ts`** — the structural "never re-derive" guard. Instead of *trusting*
  the processor to only run over new traffic, we wrap the store: a cluster that predates
  cutover, or that carries any governance note, is **immutable**, and any attempt to merge
  into it, reopen it, or upsert over it is physically refused and recorded. A wrong-date
  backfill therefore *cannot* overwrite curated state — the write simply does not happen.

## Why it's safe

Both modules are pure functions plus one store decorator. The guard only ever *refuses*
writes (it never invents or changes data), and reads pass straight through. Nothing is
wired into the running server yet — these are the building blocks the Phase-4 cutover will
use. 36 new unit tests cover both sides of every boundary, including the processor running
over a guarded store and leaving a curated cluster's count, status, and note untouched.

## Plain-language risk

Near-zero. Worst case if the guard is mis-tuned: a *legitimate* post-cutover merge is
refused and shows up in the violations list (loud, not silent) — far better than the
alternative of silently overwriting curated judgment.
