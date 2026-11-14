# Side-Effects Review — Executor GitHub outage notice

**Version / slug:** executor-github-outage-notice
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, 2 runtime files plus one unit test, about 20 runtime lines. The executor tracks how long GitHub has been unavailable and raises one attention item at two hours. Effort: no spec rounds, first commit attempt.

## Decision-point inventory
- `tickBody` github-unavailable branch — pass-through: same degraded result and same early return; adds a record and a notice.

## 1. Over-block
No block/allow surface changed.

## 2. Under-block
Only github-unavailable is covered, the outage that actually went unreported. Other unavailable reasons keep their existing surfaces. A server that never ticks raises nothing, because the check runs inside the tick.

## 3. Level-of-abstraction fit
The executor already raises attention items for its other stops, through the same port.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. A signal only; it holds no authority over any action.

## 4b. Judgment-point check
The two-hour threshold decides only when to report, and nothing acts on it. Not a judgment point.

## 5. Interactions
The id includes the outage start, so the attention store dedupes repeats and a later outage gets its own item. The record is written through the fenced meta path, so a stale owner's write is refused and handled by the tick's existing stale-epoch path. Stop paths still run first.

## 6. External surfaces
One operator-visible attention item, in plain language, per outage lasting two hours. Its text states that fixes resume by themselves and where to look first.

## 7. Multi-machine posture
Machine-local BY DESIGN: only the canonical owner ticks, so one machine reports. After a handoff the new owner starts its own count from its own meta store if that store differs.

## 8. Rollback cost
Plain revert. A leftover meta row is harmless and unread.
