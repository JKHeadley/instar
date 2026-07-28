# ELI16 — Evolution actions clean themselves up safely

## What Changed

The evolution-action queue can now identify old, ordinary pending items that have never progressed. It runs on a schedule and ships in observation-only mode, so an upgrade reports what would expire without deleting anything.

## What to Tell Your User

Nothing is deleted by default. Critical or pinned work, active work, completed/cancelled records, recent items, invalid dates, and future deadlines are always protected. An operator can turn off dry-run after reviewing the observations.

## Summary of New Capabilities

- Configurable age and sweep interval under `evolutionActions.autoExpiry`.
- Conservative eligibility with status and protection rules taking precedence over age.
- One durable save per sweep rather than one write per action.
- Replication-aware deletion tombstones, preventing an offline peer from restoring expired work.

## Evidence

Unit coverage proves eligibility precedence and dry-run behavior. Integration coverage proves coalesced persistence. End-to-end replication coverage proves the tombstone remains authoritative after a full peer resync.
