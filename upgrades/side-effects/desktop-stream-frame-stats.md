# Desktop stream: per-session picture counts

## Summary

Tier 1: counters in `DesktopStreamManager.serve` and one extra log line on close.

## Over-block

None; no decision changes.

## Under-block

It counts only on the machine being viewed. Losses on the front's relay hop or the viewer's network are not counted here.

## Level of abstraction

The stream loop is the one place every picture passes through on the target.

## Signal versus authority

Signal only.

## Interactions

One extra log line per closed stream. Timing adds two `Date.now()` calls per grab.

## 6b. Operator-surface quality

None.

## External surfaces

None; the line carries counts only, never content, grant, operator or address.

## Multi-machine posture

Machine-local: each target logs its own sessions.

## Rollback cost

Revert; no state.

## Class-Closure Declaration

`defectClass: observability-gap`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/desktop-stream-frame-stats.test.ts, howCaught: Mama PC delivered about 2 pictures a second while its capture took about 50 ms, and no per-session count existed to say where the rest went }`.
