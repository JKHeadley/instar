# Side-Effects Review — Degradation Is an Event (Postmortem F6)

**Version / slug:** `degradation-is-an-event`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `inline (Phase-5 'watchdog' trigger fires by name, but the change adds NO control authority — analysis below)`

## Summary

In `MultiMachineCoordinator.runTickWatchdog`, surface the FIRST re-arm of a stalled-lease-tick episode to the user via the existing `DegradationReporter.report(...)` (deduped per episode, reset when a real tick resumes). Closes postmortem Failure 6 (a >10-min coordination stall was silently re-armed, log-only).

## The 8 questions

1. **Over-block** — N/A. No gate, no block. It cannot reject anything; it adds a user notice.
2. **Under-block** — N/A.
3. **Level-of-abstraction fit** — Correct. The watchdog already DETECTS the stall and recovers it; the only missing thing was surfacing, and the surface (`DegradationReporter`) already exists and already reaches the user. This adds nothing new structurally — it routes an existing internal event to an existing user channel.
4. **Signal vs authority** — **Pure signal; no authority added.** This is the load-bearing review point given the Phase-5 'watchdog' trigger: the watchdog's control decisions — when to re-arm, when to reset a stuck guard, when to self-disarm — are **byte-identical** before and after this change. The diff adds only (a) a `leaseStallSurfaced` dedup flag, (b) one `DegradationReporter.report(...)` call on the first re-arm, (c) a flag reset on a real tick. No branch that decides watchdog behavior is touched. It produces a signal; it gates nothing. Complies with `docs/signal-vs-authority.md`.
5. **Interactions** — Reuses the SAME `DegradationReporter` path the self-disarm already used (and that framework-unavailable + native-heal already use). The dedup prevents double/flood-fire within an episode; the self-disarm event remains separate and louder. No race: the flag is set/read on the single-threaded watchdog tick and reset on the single-threaded main tick.
6. **External surfaces** — Adds a user-facing degradation notice when a multi-machine lease tick stalls and self-heals. Single-machine agents never construct a lease coordinator, so `runTickWatchdog` early-returns — zero new surface there.
7. **Multi-machine posture** — Machine-local BY DESIGN: each machine surfaces ITS OWN lease-tick stall. The notice is a local degradation event; no replication needed.
8. **Rollback cost** — Trivial. Revert the commit (one file + test). No state, no migration. The dedup flag is in-memory.

## What it does NOT do

- Does not change the watchdog's re-arm / guard-reset / self-disarm logic.
- Does not touch the secondary site (speaker-election fallback) — deferred with a named reason in the spec (notification-noise risk), not orphaned.
- Single-machine agents: no-op (no lease coordinator).

## Rollback

Revert the commit. In-memory flag only; no migration.

## Second-pass reviewer verdict

Inline (Phase-5 fires on the literal 'watchdog' keyword). The substantive review is Question 4: the change adds NO control authority — the watchdog's safety decisions are byte-identical; only a deduped user-surfacing signal is added. The decision boundary (first-re-arm-surfaces / dedup / reset-on-real-tick) is covered by the new unit test. A full independent reviewer was judged unnecessary for an authority-free additive surfacing; the PR is the review surface.
