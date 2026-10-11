# Side-Effects Review — the relay connection follows the serving lease

## Summary of the change
On a multi-machine agent the Threadline relay accepts one connection per identity. Relay ownership used to be fixed at boot by `multiMachine.telegramPolling`; a standby that never set it connected and displaced the awake machine, and a standby that later took over never connected (instar#2122 step 4a, ACT-1306 a). `bootstrapThreadline` now takes an optional live `relayOwner` predicate: connect while owner, release after 3 consecutive non-owner checks (5 s apart), skip displacement reclaim while not owner. The server passes "this machine holds the serving lease" (single-machine: always owner) and keeps the relay-forward context's `relaySuppressedByStandby` current, so a released machine forwards sends to the holder. `/threadline/health` reports a released machine as `standby` instead of `disconnected`. Dev-gated via `threadline.relayFollowsLease.enabled` (omitted rides the developmentAgent gate); off is today's behaviour exactly.

## Decision-point inventory
- Connect at boot: now also requires `relayOwner()` when supplied.
- Release: 3 consecutive non-owner checks (hysteresis against a lease blip).
- Re-take: first owner check after a release.
- Displacement reclaim: skipped when not owner.
- Health classification: `standby` reported before loss states.

## 1. Over-block
A machine that briefly fails `holdsLease()` for 15 s releases the relay; the holder side reconnects as soon as it holds again. An owner predicate that throws is treated as owner (today's behaviour).

## 2. Under-block
`multiMachine.telegramPolling: false` still suppresses outright and wins over the predicate.

## 3. Level-of-abstraction fit
Ownership is decided where the poll ownership is already decided (the serving lease), passed in as a predicate; the bootstrap only reacts. No new authority.

## 4. Signal vs authority compliance
The lease remains the only authority; the relay follows it. Health `standby` is signal.

## 4b. Judgment-point check (Judgment Within Floors standard)
No LLM judgment; deterministic.

## 5. Interactions
- Relay forward (A2A cross-machine route): a released machine sets `relaySuppressedByStandby`, so `relay-send` forwards to the holder rather than 503.
- Displacement reclaim timer is cleared on release and refuses to reclaim while not owner, so it cannot fight the holder.
- `connect()` after `disconnect()` builds a fresh RelayClient (confirmed in Echo's review; `reconnectRelay()` would throw).
- Timers are unref'd and cleared in shutdown.

## 6. External surfaces
`/threadline/health` gains a `standby` relay state. Log lines on release/take. New optional config key `threadline.relayFollowsLease.enabled`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
Health no longer shows a deliberate standby as "disconnected, retrying".

## 7. Multi-machine posture (Cross-Machine Coherence)
This is the multi-machine fix itself: exactly one machine (the lease holder) holds the relay, and it moves with the lease. Single-machine agents have no lease and always own the relay.

## 8. Rollback cost
Set `threadline.relayFollowsLease.enabled: false` (boot-time behaviour returns at the next restart) or revert. No persisted state.

## Conclusion
Tested against a real RelayServer with two bootstraps sharing one identity (`tests/e2e/threadline/relay-follows-lease.test.ts`), plus the health unit test; existing relay-displacement-reclaim e2e still green. Reviewed by Echo on PR #2160, nothing blocking; his health-state note is included.

## Evidence pointers
- Spec: docs/specs/lease-unconfirmed-candidate-flap.md; ELI16 docs/specs/threadline-relay-standby.eli16.md
- Issue: instar#2122
- Review: PR #2160 comment by Echo at head 2f2f17b8
