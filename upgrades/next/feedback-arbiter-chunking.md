# Feedback drain: readiness reviewed in chunks that fit the call budget

## What Changed

The feedback drain's readiness stage sent all due clusters, up to the authority's
`maxBatch`, to the registered model in one call. Live, at about 3-4 s per candidate, a
50-candidate call hit the 60 s call budget every time, and the run degraded with
`readiness-authority-failed`.

- A tick now reviews its due clusters in sequential calls of at most
  `feedbackFactory.drain.readinessChunkSize` (default 10). The total per tick is still capped
  at the authority's `maxBatch`.
- Later calls are sized from the pace measured earlier in the same tick, so the last call
  still fits the tick's wall clock. 20 s is kept for the stages after readiness. Rows not
  reached stay due for the next tick.
- Each call's decisions apply as it returns. A later failure no longer discards them.
- Spend is reserved per call, against the same daily cap.
- A contract violation still demotes the authority at once. A tick with any successful call
  resets the transient-failure count. A tick in which every call failed counts once (3 in a
  row demote).
- `feedbackFactory.drain.maxWallClockMs` is now honoured. It was declared (90 s, as the spec
  says) but ignored, so the service ran on 115 s.

Prompt and schema versions are unchanged, so the registered authority stays valid.

## Evidence

From the Mac Studio's live store (a read-only copy):
- Runs 2b4bebb3 and 0e7b229a: 50 candidates, 60.1 s each, both timeouts.
- Run 20c4fac7: 10 candidates, 32.6 s, succeeded.

Tests replay the recorded gpt-6-astra replies with that latency shape:
- At a 90 s tick, the calls are 10, 10 and 2 (22 clusters decided).
- A timeout on the second call keeps the first call's 5 `ready` decisions and resets the
  failure count.
- The old single 50-candidate call times out.

Unit (11), integration (2) and e2e (1) cover this. Of the original 11, 10 fail on the pre-fix
source; the 11th guards the unchanged demotion rule.

## What to Tell Your User

The feedback sorter was asking its model about too many feedback groups at once, and the
model ran out of time every time. It now asks about ten at a time and keeps going while time
allows. Earlier answers are kept even if a later question fails. Nothing for you to do.

## Summary of New Capabilities

- The feedback drain reviews readiness in time-bounded chunks (`feedbackFactory.drain.readinessChunkSize`, default 10).
