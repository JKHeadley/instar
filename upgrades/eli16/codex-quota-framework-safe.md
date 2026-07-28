# ELI16 — Codex accounts become real members of the subscription pool

## What Changed

Instar already understood Codex accounts, but the live pool never read their actual quota. They therefore looked permanently empty, even when exhausted. The pool now reuses Codex's existing rollout reader to import its real five-hour and weekly usage windows.

## What to Tell Your User

Codex quota displayed in the pool now reflects real account pressure. Account placement and swapping are also separated by framework: Codex sessions can move only among Codex logins, while Claude sessions can move only among Claude logins.

## Summary of New Capabilities

- Poll Codex's authoritative rollout rate-limit windows into subscription-pool snapshots.
- Preserve snapshot provenance as `codex-rollout` across replicated account metadata.
- Filter placement, pool headroom, reactive swaps, proactive swaps, and anti-thrash targets by session framework.
- Preserve existing Claude-only behavior when no framework mixture exists.

## Evidence

Unit tests cover mapping and both framework boundaries. Integration coverage proves a persisted mixed pool selects only the matching framework. End-to-end HTTP coverage reads a real rollout fixture and exposes a non-zero Codex quota snapshot.
