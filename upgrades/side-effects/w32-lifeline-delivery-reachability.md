# Side-Effects Review — W32 lifeline delivery reachability

**Version / slug:** `w32-lifeline-delivery-reachability`
**Date:** `2026-09-07`
**Author:** `Echo`
**Second-pass reviewer:** `Mencius — CONCUR after temporal-validity correction`

## Summary of the change

`src/server/AgentServer.ts` now feeds Window 32's existing `delivery-reachable` predicate from either the healthy in-server Telegram poller or the existing fresh, token-matched lifeline poll-owner lease. `src/lifeline/TelegramPollOwnerLease.ts` adds a reachability-specific reader that requires bounded age `0 <= age <= 90s`, instead of reusing the collision guard's one-sided age semantics. Echo's production server intentionally runs the adapter send-only while the separate lifeline owns polling, so adapter `started:false` is not sufficient evidence of an outage. The E2E now reproduces that real topology and rejects future-dated lease evidence; unit tests cover the detector and pin its consumer wiring. No new store, route, timer, or external action is added.

## Decision-point inventory

- `AgentServer` W32 liveness sample provider — **modify** — supplies the existing liveness authority with the established lifeline poll-ownership signal in addition to adapter status.
- `WindowRunLivenessAuthority.tick()` — **pass-through, unchanged** — remains the sole authority that combines all five predicates and promotes or revokes `active`.

---

## 1. Over-block

A valid lifeline becomes temporarily unreachable to W32 if it cannot refresh its lease within 90 seconds, even if Telegram later delivers buffered traffic. This is intentional bounded underclaim: a stale transport signal must not keep an autonomous run green. Lifeline-less installations retain the existing adapter-status path.

---

## 2. Under-block

A freshly written lease can remain green for up to 90 seconds after the lifeline process dies. The pre-existing lease staleness ceiling bounds that ambiguity; this patch does not add a process-PID check because the lease heartbeat is the canonical successful-poll signal and PID existence alone would not prove Telegram reachability. A future-dated heartbeat is rejected, so host-clock rollback underclaims until the lifeline writes at or behind the sampled authority clock instead of extending green indefinitely. The lease proves the poll/ingress side of the Telegram topology, not that the operator read any particular outbound message. Individual cadence reports continue to require their own durable delivery receipt.

---

## 3. Level-of-abstraction fit

The low-level detector is the new `lifelinePollIsReachable()` view over the existing lease reader. It validates lease shape, configured-token identity, and a closed non-negative freshness interval. The original `lifelineOwnsPoll()` remains unchanged with its historical one-sided age rule: matching future-dated timestamps are accepted for startup collision avoidance. The strict detector feeds the existing W32 liveness authority; it does not create a parallel active-state authority or trust a capability/configuration label. Reusing the poll-owner lease is preferable to inspecting `lifeline.lock`, a process name, or the adapter's deliberately false `started` flag.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — this change is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The reachability check is a structural detector over an enumerable transport contract: correct token hash, valid record, finite sample time, and age inside `[0, 90s]`. Only `WindowRunLivenessAuthority` can use that signal together with executor, heartbeat, work, and lifecycle evidence to promote or revoke the run.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic decides among competing semantic signals. Lease validity is a hard transport invariant with an explicit 90-second freshness bound. The multi-signal judgment remains in the existing five-predicate liveness state machine.

---

## 5. Interactions

- **Shadowing:** A healthy adapter retains its original path. The lifeline lease is consulted as an alternative only for the same delivery predicate and cannot satisfy the other four predicates.
- **Double-fire:** No action or timer is added. Reading the lease has no side effect and cannot start or stop either poller.
- **Races:** The lifeline already writes the lease atomically. A sample may see the immediately previous heartbeat, bounded by the existing staleness window. Because the sample clock is captured before the file read, a concurrent newer lease can appear briefly future-dated and underclaim for one tick; the next sample resolves it. Invalid or future authority time fails closed for the lifeline path.
- **Feedback loops:** A green delivery signal can permit the existing authority to promote `active`; promotion does not alter the poll lease or polling topology.
- **Adjacent health checks:** System Reviewer already recognizes lifeline-owned polling. This change removes the contradictory W32-only interpretation while using the stronger token-matched fresh lease rather than the health probe's legacy lock-file presence check.

---

## 6. External surfaces

On lifeline-owned Telegram deployments, an otherwise valid W32 run may now become active instead of remaining falsely `preparing`/`at-risk`. Missing, stale, corrupt, or wrong-token leases remain non-green. No message text, route shape, configuration, migration, Telegram API call, or persistent schema changes. The only file read is the already-shipped machine-local poll-owner lease.

No operator-facing action is added or changed.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** Telegram polling ownership and its lease describe the transport process on this machine. W32 is also bound to one local executor and samples the local delivery path before its distributed ownership and lifecycle constraints can result in active work. The patch emits no notice, creates no URL, and introduces no durable state. It cannot duplicate messages or strand new state on topic transfer; a machine without the fresh local lease must underclaim rather than borrowing another machine's transport fact.

---

## 8. Rollback cost

Revert the `AgentServer` lease alternative and ship a patch. No data migration or agent-state cleanup is required. During rollback, lifeline-owned deployments return to the known false-negative behavior where W32 cannot become active while the main adapter is send-only; ordinary Telegram delivery remains unaffected.

---

## Conclusion

The change repairs a production-topology false negative by routing a strict view of an established lease into the single W32 authority. Independent review caught that the first draft reused the collision guard's one-sided handling of future timestamps; the design now deliberately underclaims on every absent, invalid, stale, future-dated, mismatched, or temporally invalid lease and introduces no new actuation. The corrected focused unit, integration, and booted-server E2E selection passed 55 tests. The second pass concurs after the correction; the full repository gate remains required before ship.

---

## Second-pass review (required)

**Reviewer:** Mencius
**Independent read of the artifact:** **CONCUR after correction.** The initial pass found that the collision-avoidance helper's one-sided age rule would accept a future-dated heartbeat as positive liveness evidence. The implementation now isolates strict reachability semantics with finite `0 <= age <= 90s`, the production W32 consumer asserts future evidence remains non-green, and the artifact accurately distinguishes both policies. No remaining blocker.

---

## Evidence pointers

- Before the source change, the lifeline-topology E2E failed at the first active projection because delivery remained false.
- The first independent review rejected the draft because its positive liveness path accepted future-dated leases; the strict reachability helper and W32-consumer negative were added in response.
- Corrected focused selection: 5 files and 55 tests passed across unit, integration, and booted-server E2E tiers.
- Live Echo evidence: `/health/probes` reports Telegram connected through lifeline-owned polling while `/channels` reports the server adapter's poll loop intentionally stopped.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no added or modified self-triggered controller — not applicable. The existing poll-ownership wiring ratchet is extended to assert the W32 consumer, and the booted lifecycle test reproduces the real send-only topology.
