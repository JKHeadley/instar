<!-- bump: patch -->

## What Changed

Added the Phase-4 data-migration integrity tooling for the feedback-factory
migration: import-as-is preservation of every curated field, per-row checksums
(in vs out), fingerprint-uniqueness scanning, auto-increment sequence reset,
schema-equivalence assertion, and the structural never-re-derive guard (the
processor refuses to mutate any cluster created before the cutover timestamp or
carrying governance notes). Internal migration tooling — not yet wired to any
live behavior.

## What to Tell Your User

Nothing changes for you. This is internal plumbing for the feedback-system
handover: the checks that guarantee curated history is copied perfectly and can
never be silently rewritten afterward. It ships dormant.

## Summary of New Capabilities

- Internal: integrity-safe import core + a guarded store wrapper that makes
  pre-cutover and governance-noted clusters structurally immutable.
- Maturity: internal migration tooling, dormant until the import phase.
