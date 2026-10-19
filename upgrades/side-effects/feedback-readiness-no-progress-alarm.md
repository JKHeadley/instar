# Side-Effects Review — a wall-clock "no readiness progress" alarm for the feedback drain

**Version / slug:** `feedback-readiness-no-progress-alarm`
**Date:** `2026-10-19`
**Author:** `Echo`
**Second-pass reviewer:** `not required (signal-only monitoring; no block/allow, session-lifecycle, gate or watchdog decision is added or changed)`

## Summary of the change

Completes `docs/specs/feedback-factory-operating-drain.md` line 270 ("expose ... stalled state, and progress age"; no feature-local retry workflow). Stacked on #2201/#2202, whose side-effects review recorded the gap this closes: "The stall notice counts ticks, not wall time; a drain that does not tick (job not scheduled) raises nothing here." ACT-114.

- `FeedbackDrainStore` — `readinessWaitingCount(now)` (collecting rows due now, or put back without an answer: `readiness-authority-unavailable` / `-failed` / `output-rejected`); a durable `readiness_waiting_since` meta stamp with `markReadinessWaiting` / `clearReadinessWaiting`; a successful readiness call (`clearAuthorityTransientFailures`) also closes the wait.
- `FeedbackDrainService.checkReadinessProgress()` — canonical-owner only; stamps when a wait starts, clears when nothing waits, and past `READINESS_NO_PROGRESS_ALARM_MS` (6 h) raises ONE attention item per wait (`feedback-drain:readiness-no-progress:<since>`), naming no approved model / drain not running (last run older than 2 h or none) / runs that never ask the model (with the last run's reason). Silent when the pause alarm (proposal-only) or the stall notice (≥ 6 failed ticks) already owns the episode, or the authority was revoked. `readinessProgressAge()` is the read-only view.
- `AgentServer` — a 15-minute unref'd timer calls the check; cleared on stop.
- `routes.ts` — `GET /feedback-factory/drain/status` carries `readinessProgressAge`.
- Template + migration — one awareness bullet after the stall-notice bullet.

## Decision-point inventory

- `checkReadinessProgress` — **add** — signal only (one deduped attention item); no block, no state change beyond its own wait stamp.

## 1. Over-block

Nothing is blocked.

## 2. Under-block

- Granularity is the 15-minute timer: the alarm fires between 6 h and 6 h 15 m after the wait was first observed. Accepted.
- The first observation is the first timer tick after boot; a wait that began while the server was down is dated from that tick, not earlier. Errs toward a later, never a missing, notice.
- A row put back by the spend brake (24 h, reason `readiness-spend-brake`) is not counted as waiting; the spend brake demotes, so the pause alarm owns that episode.
- The "covered by the stall notice" test reads the failure counter, not whether that notice was successfully delivered. If its enqueue failed, it retries on the next failed tick; this alarm does not duplicate it.
- A revoked authority is treated as deliberate and stays silent.

## 3. Level-of-abstraction fit

The wait lives in the drain store next to the readiness rows it counts. The check lives in the service, beside the pause and stall alarms it defers to. The timer lives in the server, because the failure it watches for is ticks that never run, so it cannot ride the tick. No recovery is added (line 270 reserves it for the shared SelfHealGate/P19 lane).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — signal only. It writes one meta key and one attention item; it never changes readiness, authority, runs or config.

## 4b. Judgment-point check

The bound (6 h) gates a notice, not an action, over an enumerable state.

## 5. Interactions

- **Shadowing / double-fire:** defers explicitly to the pause alarm and the stall notice, so each episode gets one item from one source. Ids differ by source context. Its own id is keyed on the wait start; an in-process set plus the attention store's id idempotency keep it to one item, across restarts too.
- **Races:** the timer and a tick may run together. The tick's success clears the stamp; a later timer read sees no stamp or a fresh one. Last-writer semantics on one meta key, both owner-local. No lost alarm, at worst a re-dated wait.
- **Feedback loops:** none; nothing reads the stamp but the check and the status route.

## 6. External surfaces

- Operator: one new NORMAL attention item class through the existing funnel, phone-readable (no paths or commands in the summary).
- Agents: a CLAUDE.md bullet, migrated idempotently.
- Persistent state: one `drain_meta` key; old code ignores it.
- Install base: inert unless the operated drain is live (dev-gated).

## 6b. Operator-surface quality

The item leads with the count and how long it waited, then the cause in one sentence, then whether an approval would help (only in the no-approved-model case).

## 7. Multi-machine posture

The check runs only on the canonical owner (`isCanonicalOwner`), like the drain itself; a non-owner neither stamps nor alarms. The item is visible pool-wide through the merged attention read.

## 8. Rollback cost

Pure code; revert. The meta key is ignored by older code.

---

## Conclusion

Closes the remaining silent-stop road (ticks absent or never asking) with exposure and one notice, exactly as line 270 allows. Clear to ship.

---

## Evidence pointers

Tests: `tests/unit/feedback-factory/drain-readiness-no-progress.test.ts` (6), `tests/unit/readiness-no-progress-awareness.test.ts` (3), route assertions in `tests/integration/feedback-drain-readiness-brake.test.ts` and `tests/e2e/feedback-drain-readiness-brake.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No self-triggered restart/swap/respawn/kill controller is added; the only action is one notify per wait, bounded by the wait's own stamp.
