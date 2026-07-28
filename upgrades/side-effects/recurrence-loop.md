# Side-Effects Review — recurrenceLoop (the caller that closes the loop)

**Version / slug:** `recurrence-loop` · **Date:** `2026-07-27` · **Author:** `Echo (instar-dev agent)`

## Summary

`RecurrenceReader` sees; `RecurrenceActuator` decides. Both are pure, which left **"the loop closes"
a DESIGNED property, not a demonstrated one** — the weakest point named in the actuator's own review.
This closes it: read three stores → group → plan → create, via a caller-supplied `createAction`.

It is deliberately the ONLY I/O in the feature, so every read failure has exactly one reporting site
and cannot be swallowed mid-pipeline.

**Live run, writes intercepted, 2026-07-27:** coverage `complete` (attention, actions, sentinel);
836 problems; **would create 3, deferred 17, 0 write failures, no refusal.**

## Refusal evidence (constraint 2)

```
REFUSAL — action store unreadable ⇒ createAction NEVER CALLED
  create spy      : not called          created: 0
  refused.reason  : actions-store-unreadable      writeFailures: 0

A FAILED WRITE IS NOT A REFUSAL  (the distinction this module exists to protect)
  createAction throws '503 action store unavailable'
    refused       : undefined      ← an outage must NOT present as judgement
    writeFailures : [{ error: '503 …' }]
    created       : 0

  one failure among three ⇒ created 2, writeFailures 1 (others not abandoned)

UNREADABLE STORE IS DATA, NOT AN EXCEPTION
  sentinel throws ⇒ coverage.unreadable names it, completeness 'partial',
    and it STILL creates 1 (sentinel only understates counts)
  all three throw ⇒ verdict undefined, created 0, no crash
```

Tests **9 passed (9)**; whole feature **30 passed (30)**; `tsc --noEmit` exit 0.

## Decision-point inventory

| point | classification |
|---|---|
| read failure → coverage gap | `invariant` — try/catch → named entry, never a throw |
| refusal vs write-failure separation | `invariant` — distinct fields, the load-bearing rule |
| write loop continues past a failure | `invariant` |

No judgment points, no LLM, no authority: `createAction` is supplied by the caller, so the write path
keeps whatever gating it already has. This module never constructs an HTTP call.

## 1. Over-block

Refuses to write when the actions store is unreadable — inherited from the actuator and correct: it
cannot tell what is already owned. Cost: a broken actions store stops proposals until fixed.

## 2. Under-block

**No scheduler/route calls it.** Running it is deliberate. So this demonstrates the loop CAN close,
not that it closes *unattended*. Wiring a cadence is a separate increment with its own risk, and is
not claimed here.

**No dismissal memory.** A cancelled action leaves the cluster untracked, so a later run can propose
it again (same `externalKey`, so one row, not many). A "dismissed, stop asking" state belongs to the
action store. <!-- tracked: ACT-1311 -->

**`createAction` failures are reported, not retried.** Deliberate: retry policy belongs to the write
path, and a silent retry here would obscure the outage the separate field exists to surface.

## 3. Level-of-abstraction fit

All I/O in one place, everything else pure. The alternative — reads scattered through reader and
actuator — is exactly how a failed read becomes an empty result that reads as "nothing found".

## 4. Signal vs authority

Holds none. It executes a plan produced by deterministic rules and writes through a function the
caller owns.

## 5. Interactions

Consumes `RecurrenceReader` + `RecurrenceActuator` (same stack, PRs #1662 / actuator branch). Writes
only via the injected function. No schema change.

## 6. External surfaces

**None.** No route, no config, no persisted state of its own.

## 7. Multi-machine posture

**Posture: `machine-local`.** `machine-local-justification: physical-credential-locality` — it reads
one machine's stores, whose observation titles carry that machine's ids, topics and account emails,
and writes to that machine's action queue. Cross-machine synthesis would mean replicating those
records; the existing pool-scope fan-out is the correct route.

## 8. Rollback cost

**Zero.** One module, one test file, no callers.

## Phase 5 — Second-pass review

No gate/sentinel/watchdog, no block/allow authority, no LLM. Lenses:

**Adversarial — "how would I make this useless?"** Report a write outage as a refusal, so breakage
reads as judgement. Asserted against directly.

**"Would it have caught the incident?"** It IS the incident's remedy: 69 untracked recurrers, top
three actionable today.

**"Symptom or cause?"** Cause for never-picked-up. Not for the recurrence itself — creating an item
makes someone decide about the 278x idle-timeout; it does not fix it.

**Weakest point:** nothing schedules it. "Closes unattended" remains unclaimed.
