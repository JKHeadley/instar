# Side-Effects Review — autonomous heartbeat restart-safe cap

**Version / slug:** `autonomous-heartbeat-restart-cap`
**Date:** `2026-07-31`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Instar-codey (independent second read; team delegation is disabled for this task)`

## Summary of the change

The autonomous progress heartbeat moves its count and cooldown anchor from a
process-local map into a bounded atomic ledger keyed by the stable autonomous
run identity. The heartbeat reserves a slot before outbound send, reloads that
state after restart, and rereads its config block at each tick. It also exposes
effective settings and persistence health on the existing status route.

## Decision-point inventory

- `AutonomousProgressHeartbeat.evaluateTopic` — modified — budget/cooldown now
  consult durable per-run state and suppress before send when it cannot be
  trusted.
- Pre-send reservation — added — durable write must succeed before the existing
  Telegram send funnel is called.
- Live config refresh — added — the current on-disk heartbeat block replaces
  the last good runtime block at the tick chokepoint.

## 1. Over-block

A temporarily unwritable or corrupt heartbeat ledger suppresses this optional
liveness backstop, including otherwise legitimate heartbeats. This is the
intentional safe direction: losing an optional check-in is less harmful than
resetting a cap and repeating messages. Normal agent replies and all autonomous
work continue unaffected.

## 2. Under-block

The ledger is machine-local, matching the existing v1 heartbeat spec. A topic
move between machines can still produce the spec's rare cross-machine duplicate;
this change closes process restarts on one machine, not the separately-scoped
distributed-lock problem. The existing move marker, warmup window, and one-voice
lease remain the applicable brakes.

## 3. Level-of-abstraction fit

The throttle belongs beside the heartbeat emitter because it is the component's
own convergence invariant. The store owns only bounded atomic persistence and
makes no send decision. Stable run identity is reused from `AutonomousSessions`
rather than invented in the monitor.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this remains a signal-only component; its deterministic floors can
  only suppress its own optional liveness notice.

The heartbeat has no authority over autonomous work, user messages, or session
lifecycle. Durability is a safety floor on a self-triggered notification, not a
contextual judgment about the user's intent.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. The cap,
cooldown, identity match, and write-before-send rule are enumerable safety
invariants for a bounded notification loop.

## 5. Interactions

- **Shadowing:** persistence runs only after all existing eligibility predicates
  and the shared one-voice lease pass; it cannot shadow normal conversation.
- **Double-fire:** commit-before-send closes restart resets. The acknowledged
  crash window chooses possible under-send, never duplicate send.
- **Races:** the server remains the single writer. Atomic rename gives readers
  old-or-new state; failed writes restore the store's prior in-memory image.
- **Feedback loops:** the heartbeat still enters topic history through the same
  send funnel, so its own outbound resets the silence clock as before.

## 6. External surfaces

Users see fewer repeated heartbeat lines after server restarts. The existing
status route gains effective tuning and persistence-health fields. A bounded
machine-local JSON ledger is new persistent state. There are no new routes,
credentials, external services, URLs, or operator actions.

## 6b. Operator-surface quality

No dashboard, form, approval page, or operator action surface is changed; not
applicable.

## 7. Multi-machine posture

**Machine-local by design for this increment:** the ledger enforces the run
budget across restarts of the machine currently observing and emitting the
heartbeat. The v1 spec explicitly accepts file-marker/warmup coordination and
tracks distributed event locking separately. The state-coherence registry
declares this scope rather than leaving it implicit. User-facing notices still
use the existing per-machine one-voice lease and move markers. The state does
not generate URLs. On topic transfer it may remain behind; the destination's
warmup rule is unchanged, so this does not claim cross-machine exactly-once.

## 8. Rollback cost

Revert and ship a patch. The ledger is additive and versioned; older binaries
ignore it. It can remain on disk harmlessly, or age out after the bounded
inactive window. No data migration or agent-state repair is required. Reverting
would reintroduce restart-reset heartbeat noise while propagation completes.

## Conclusion

The review tightened two choices: reservation occurs before outbound send, and
an empty/partial run scan cannot immediately erase durable budget. State errors
fail toward silence and remain visible in status. The change is clear to ship.

## Second-pass review

**Reviewer:** Instar-codey
**Independent read of the artifact: concur.** The main residual risk is the
already-declared cross-machine duplicate window, and the artifact names it
without presenting this single-machine restart fix as distributed exactly-once.

## Evidence pointers

- `tests/unit/AutonomousProgressHeartbeat.test.ts`
- `tests/unit/AutonomousHeartbeatRunStateStore.test.ts`
- `tests/integration/autonomous-heartbeat-routes.test.ts`
- `tests/e2e/autonomous-heartbeat-alive.test.ts`

## Class-Closure Declaration

- `defectClass`: `unbounded-self-action`
- `closure`: `guard`
- `guardEvidence.enforcementType`: `ratchet`
- `guardEvidence.citation`: `tests/unit/AutonomousProgressHeartbeat.test.ts`
- `guardEvidence.howCaught`: the restart regression instantiates a second
  component over the same run and refuses any heartbeat beyond the persisted
  cap; the persistence-failure tests prove the loop converges toward silence
  rather than resetting under repeated process failure.
