# Feedback sorting that silently stops is now announced, even when nothing fails (plain-English overview)

Governing spec: `docs/specs/feedback-factory-operating-drain.md` (converged and approved). Line 270 asks this part of the system to expose "stalled state, and progress age" and to contain no retry workflow of its own. This change completes that; it adds no new rule.

## What was missing

Feedback reports become work items only after an approved sorting model says they are ready. Two notices already exist. One fires when a safety brake pauses the sorter. One fires when six scheduled runs in a row ask the model and get no usable answer (added the day before, after a rate limit paused the sorter for four days).

Both depend on runs that reach the model. If the runs stop happening (the scheduled job is off, or every run is refused), or happen but never ask the model (no model approved, no model connected, the approval bound to a different machine), neither notice can fire. Reports would pile up with nobody told: the same four-day silence by a different road.

## What changes

- Every 15 minutes the machine that owns the drain checks how long feedback has been waiting for any answer from the sorting model. It does this on its own timer, so it works even when no runs happen.
- When reports have waited six hours with no successful answer, it raises ONE attention item ("Feedback sorting has made no progress"). The item says in plain words which case it is: no sorting model approved, the drain not running, or runs that never ask the model.
- It stays quiet when another notice already named the cause (a paused sorter, or a run of failed calls), and when the operator revoked the approval on purpose.
- The wait ends when a call succeeds or nothing is waiting. A later wait gets its own item, and the same wait is never announced twice.
- The drain status shows the wait as `readinessProgressAge`: how many reports wait, since when, and the alarm bound.

## What does not change

- Nothing restarts, retries, re-runs or repairs anything. Line 270 of the spec gives that job to a separate shared recovery lane.
- No brake, no approval and no PIN path changes.

## What you need to decide

Nothing.
