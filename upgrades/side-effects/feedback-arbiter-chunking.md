# Side-Effects Review — feedback readiness reviewed in chunks

**Version / slug:** `feedback-arbiter-chunking`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The operated feedback drain asks the registered readiness authority (gpt-6-astra via
codex-cli) which clusters are ready to become work. It sent every due candidate, up to the
authority's `maxBatch` (50), in ONE model call. Live on 2026-10-01 the model took about 3-4 s
per candidate: 10 candidates finished in ~31 s (run 20c4fac7, 32.6 s end to end) and 50 hit
the 60 s call budget twice in a row (runs 2b4bebb3 and 0e7b229a, 60.1 s each, both
`readiness-authority-failed`). A 50-candidate call can never fit the call budget.

`FeedbackDrainService` now reviews a tick's due candidates (still capped at the authority's
`maxBatch`) in sequential calls of at most `readinessChunkSize` (default 10). Before each call
it checks the time left for readiness (the tick's wall clock minus one 20 s stage budget kept
for the stages after readiness). The first call is a full chunk; later calls are sized from
the pace observed so far in that tick, with a 25% margin. Each call's budget is also capped by
the time left. When the next call would not fit, the loop stops cleanly: rows not reached stay
due, untouched, for the next tick. Each call's decisions are applied as soon as it returns. A
failed call stops the tick, and its own rows are marked `readiness-authority-failed`
(re-review in 15 min). Spend is reserved per call: one `estimatedReadinessBatchUsd` per call,
plus that call's decision count. Daily usage is still counted per decision.

Failure accounting: a contract violation (wrong model, schema, ids) still demotes the authority
at once in any call. A transient failure (timeout, provider error) counts ONE toward the
consecutive-failure limit only if no call in that tick succeeded. A tick with at least one
successful call resets the counter.

Also: `feedbackFactory.drain.maxWallClockMs` (90 s in config defaults, and 90 s in the approved
spec §203) was declared but never passed to the service. The service ran on its own 115 s
default. It is wired now, together with the new optional `readinessChunkSize`.

Files: `src/feedback-factory/drain/FeedbackDrainService.ts`, `src/server/AgentServer.ts`
(wiring), `src/core/types.ts` (config type). Prompt id, schema id, parser and
`FeedbackReadinessArbiter` are unchanged.

## Decision-point inventory

- `FeedbackReadinessArbiter.decideBatch` (`feedback-cluster-readiness`): pass-through. The
  same prompt and schema now receive packets of at most 10 candidates instead of up to 50.
  Every packet stays inside the registered `maxBatch` envelope.
- Authority transient-failure demotion (`FeedbackDrainService`): modify. The counter is now
  per tick (any successful call resets it; an all-failed tick counts once) instead of per
  single call.
- Spend brake (`reserveAuthoritySpend`): modify (granularity only). It is reserved per call
  instead of per tick. The same cap applies, and a brake mid-tick keeps the earlier calls'
  decisions.

---

## 1. Over-block

No block/allow surface on user content. The one gating effect is on throughput: a tick can
now review fewer candidates than `maxBatch` when the wall clock runs short. Those rows are
not rejected; they stay due and the next tick reviews them first (the due order is
`next_review_at, cluster_id`).

---

## 2. Under-block

- A chunk that keeps timing out after one healthy chunk in every tick never reaches the
  demotion limit. This is intentional: the tick is making progress. Each such tick still ends
  `degraded` with `readiness-authority-failed`, and the job reports it as failed, so the
  pattern stays visible.
- The per-candidate pace comes from earlier calls in the same tick. A sudden slowdown on a
  later call can still overrun its slot. That call's budget is capped at the time left, so it
  fails as a transient failure rather than blowing the tick's wall clock.

---

## 3. Level-of-abstraction fit

This is the right layer. Batching is a drain-service concern: the service owns the tick
budget, the spend reservation and the failure accounting. The arbiter stays a single-call
authority adapter with its unchanged envelope check (`candidates.length <= maxBatch`). No
parallel gate is introduced.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The readiness judgment stays with the registered LLM authority. This change only decides how
many candidates go into each call and when to stop for the tick's time budget. Those are
resource limits, not judgments about the content.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Chunk sizing is a resource
bound over a measured pace (time left / observed per-candidate latency). The readiness
decision itself remains the LLM authority's.

---

## 5. Interactions

- Cancellation and ownership: `stopIfCancelled()` (owner fence, wall-clock assert, run-lease
  heartbeat) runs after every call. A long tick therefore heartbeats its 120 s run lease after
  each call, not only once.
- Later stages: readiness ends at least one 20 s stage budget before the tick's wall clock.
  This guarantees each later stage its own per-stage budget, but not the whole tail (claims
  allow up to maxClaims x 20 s, plus compaction). Before this change the unwired 115 s tick
  left about 50 s after a 65 s call. Now, with the spec's 90 s, readiness can fill to 70 s
  and leave 20 s. With the consumer in dry-run (live today), the tail is milliseconds. A
  live consumer with slow claims could trip the wall-clock assert and fail the run. That is
  named here; a later tick retries.
- Ownership loss, cancellation or the wall-clock assert after a call ends the run (failed or
  cancelled), exactly like any later stage. It is not counted as a provider failure, and the
  undecided chunk is left untouched.
- Job body (`feedback-factory-process`): unchanged. A tick that stops on the wall clock is
  `succeeded` (or `no-op`). A failed call still yields `degraded` /
  `readiness-authority-failed`, which the job reports.
- New reason `readiness-wall-clock-exhausted`. It appears only when earlier stages used the
  whole readiness window and no call was made. The run is degraded and no transient failure
  is counted.

---

## 6. External surfaces

- Model spend: about 2-3 calls per tick instead of one. At the default $0.01 per call and 48
  ticks a day, that is about $1.44/day, under the authority's $5/day cap. The cap is still
  enforced, now before each call.
- Config: new optional `feedbackFactory.drain.readinessChunkSize`. There is no default in
  ConfigDefaults (the code default is 10), so no migration is needed.
  `maxWallClockMs` now takes effect: agents with the shipped 90 s default go from 115 s to
  90 s per tick, which matches spec §203.
- No change to prompts, the schema, routes, the dashboard, messaging or the CLAUDE.md
  template. The template's "three timeouts or provider errors in a row" wording still
  describes the behaviour.

---

## 6b. Operator-surface quality

Not applicable. No operator surface is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Unchanged. The drain runs only on the canonical owner machine (owner fence + epoch). Chunking
is internal to one owner's tick. Proxied ticks behave as before.

---

## 8. Rollback cost

Low. Revert the commit. Setting `readinessChunkSize` to 50 gives back one call per tick
(which times out live), with no revert needed. No data shape changes: readiness rows, daily
usage rows and authority records are written with the same columns and meanings.

---

## Conclusion

The change makes the operated readiness stage able to finish on real latency. It respects the
approved authority envelope (prompt, schema, `maxBatch`, spend cap). Earlier decisions are no
longer thrown away when a later call fails, and timeouts are not over-counted toward
demotion. It also brings the tick's wall clock back to the spec's 90 s.

Throughput, measured at ~3.1 s per candidate:
- About 22 candidates per tick at 90 s, about 30 at 115 s.
- Every tick is still capped by the authority's `maxBatch`. The live gen 3 authority is
  narrowed to 10, so the drain stays at 10 per tick (480 a day at the 30-minute cadence)
  until a generation with a larger `maxBatch` is registered.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

"Concur with the review". The reviewer ran the three new test files (8/8, 2/2, 1/1). The
non-blocking notes and what was done:
- Non-numeric `readinessChunkSize` / `maxWallClockMs` from config produced NaN, which stalls
  or demotes. Fixed: they fall back to 10 and 115 s (unit test).
- A store error while applying decisions still counted as a success, and re-marked
  already-approved rows. Fixed: success is counted after apply, and only rows still
  `collecting` are marked failed (unit test).
- Ownership loss or the wall-clock assert inside the call's try was counted as a provider
  failure. Fixed: `stopIfCancelled()` now runs outside it, so the run fails or cancels
  (unit test).
- The §5 later-stage wording was inaccurate. Corrected above (named exposure for a live
  consumer).
- Left as is (named):
  - The first call is not sized to the time left (rare; bounded; one transient failure).
  - When the time left is under 60 s, the service timer fires before the arbiter's own
    timeout and the codex child keeps running. This is unchanged from before, and 30-minute
    ticks never overlap.

## Evidence pointers

- Live latency shapes: the Mac Studio store's `drain_runs` (a read-only `.backup` copy). Runs
  2b4bebb3 and 0e7b229a: 60.1 s, degraded `readiness-authority-failed` (50 candidates). Run
  20c4fac7: 32.6 s, succeeded (10 candidates). The authority records show gen 3 with
  `max_batch` 10.
- `tests/unit/feedback-factory/drain-readiness-chunking.test.ts` (11): fake clock at 3.1 s
  per candidate, with a 60 s `CodexExecJsonTimeoutError`. Recorded gpt-6-astra decisions are
  replayed through the unchanged parser. Of the first 8, 7 fail on the pre-fix source; the
  8th guards the unchanged all-failed demotion rule. The last 3 cover the review fixes.
- `tests/integration/feedback-drain-readiness-chunking.test.ts` (2): AgentServer wiring of
  both config fields and HTTP ticks. Both fail on the pre-fix source.
- `tests/e2e/feedback-drain-readiness-chunking.test.ts` (1): production wiring, the recorded
  live reports and recorded replies. The second call times out, the first chunk survives, and
  the next tick finishes the pass. It fails on the pre-fix source.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: the defect is in the drain's TypeScript batching. The
change modifies a bounded retry path inside a scheduled controller, so its convergence is
stated here:
- Control-loop edge: one tick makes at most `ceil(maxBatch / readinessChunkSize)` calls
  (5 at most), and stops earlier on the wall clock.
- Steady-state bound: any failed call ends the tick's readiness stage.
- Settling brake: the authority demotes to proposal-only after 3 consecutive ticks with no
  successful call, after any contract violation, or at the daily spend cap.
