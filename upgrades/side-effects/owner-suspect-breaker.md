# Side-Effects Review — Owner-Suspect Breaker

**Version / slug:** `owner-suspect-breaker`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, autonomous session per Justin's direction)`
**Second-pass reviewer:** `adversarial reviewer subagent — OBJECT on probe 1 (forever-suspect under load), CONFIRMED BY REPRODUCTION and fixed in-review (absolute per-episode TTL + regression test); probes 2–5 CONCUR`

## Summary of the change

Wires the SessionRouter's previously-inert `markOwnerSuspect` hook into a real per-peer circuit: `OwnerSuspectBreaker` (pure core; absolute-TTL half-open windows, default 30s; per-peer `FailureEpisodeLatch` for first-log/one-signal/recovery accounting; state deleted on success). Wiring composes `!isSuspect` into `isMachineAlive`, filters suspect machines from placement candidates (all-suspect → unfiltered fallback), and the new `onOwnerResponsive` router dep closes windows on any delivery ack. Plus the router `chains`-map leak fix (entries deleted when their tail settles while current). Files: `OwnerSuspectBreaker.ts` (new), `SessionRouter.ts` (two small additions), `server.ts` wiring block, tests.

## Decision-point inventory

- `isMachineAlive` composition — **modify** — a suspect peer reads as not-alive for ROUTING, sending its sessions down the EXISTING failover re-place path. The decision of where they land is unchanged (placement); the decision of when a peer is suspect is new (retry exhaustion, the signal the router already emitted).
- Placement candidate filter — **modify** — suspect machines excluded unless that empties the set.
- `OwnerSuspectBreaker` — **add** — per-peer state machine consuming the router's existing exhaustion signal.
- `chains` cleanup + `onOwnerResponsive` — **add (hygiene/signal)**.

## 1. Over-block

The reviewer's probe-1 OBJECT was exactly an over-block: with window-extension semantics, a steady <TTL message stream re-marked a suspect peer on every dispatch (no delivery is attempted while suspect → `recordSuccess` unreachable → TTL the only exit → extended forever). Reproduced: a peer healthy from t=40s stayed suspect at t=10min with 31 forced failovers. **Fixed in-review**: `markSuspect` no longer extends an open window (absolute per-episode TTL) — half-open is reached on schedule regardless of traffic, regression-tested. Residual over-block: a genuinely-healthy peer that failed one message's retries pays one 30s window — bounded, and any successful delivery (e.g. a different session's forward in the half-open probe) clears it instantly.

## 2. Under-block

(a) Suspect-window message POLICY is deliberately out of scope: messages still take the existing re-place path (the only message-preserving path while `queueMessage` is a production no-op). The queue-vs-replace stability trade — and the durable-queue investment it requires — is an operator decision; lettered options go to Justin <!-- tracked: CMT-1109 -->. (b) The no-op `queueMessage` also affects the `placing/transferring` branch (pre-existing; surfaced in the options message). (c) `spawnOnMachine` remains un-breakered (reviewer probe 3: deliberate — the all-suspect fallback depends on it attempting, and it throws-to-caller on failure).

## 3. Level-of-abstraction fit / 4. Signal vs authority

The breaker consumes the router's OWN exhaustion signal and feeds the router's OWN aliveness dep — no new decision-maker, no second routing brain; placement, CAS, and ownership semantics untouched. Per `docs/signal-vs-authority.md`: the suspect window is a routing-availability signal with bounded lifetime; the failover authority it triggers is the pre-existing path. Composition lives in the wiring (the router stays pure/dep-shaped).

## 5. Interactions

- **Swap count ("fewer swaps" directive):** unchanged — a session moves at most once per peer-down episode; the breaker removes the OTHER sessions' retry tax, not adds moves (reviewer probe 1 trace, post-fix).
- **Pins:** a HARD-pinned session does not migrate during a suspect window (placement returns `hard-pin-unavailable`; resolves in place after the TTL — reviewer probe 2).
- **All-suspect fallback:** placement proceeds unfiltered; `spawnOnMachine` is not `isMachineAlive`-gated so it attempts and throws-to-caller — no wedge (probe 3).
- **Stale-ownership acks** close the window — correct: the breaker measures transport health to the peer, which any ack proves (probe 4).
- **Chains cleanup race:** identity-check guard preserves per-session serialization under concurrent re-route; traced clean (probe 5).
- **Sustained-suspicion signal:** one DegradationReporter record per 10min episode per peer (`SessionPool.ownerDelivery`); reporter's internal cooldown bounds user-facing volume.

## 6. External surfaces / 7. Rollback

Logs + degradation records only; no API/schema/config/persistent state; no migration. Rollback = revert (the wiring block removal restores the inert-hook status quo; the leak and retry-tax return).

## Conclusion

The audit's vaguest lead ("load-shedding") resolved into the sharpest finding of the night: a fully-designed breaker hook shipped dead at the wiring layer. The fix is composition, not invention — and the adversarial pass caught a genuine inversion (the busier a recovered peer, the longer it stayed exiled) before it ever ran. Policy beyond the existing semantics goes to the operator, as it should.

---

## Phase 5 — Second-pass review (routing authority → required)

The adversarial reviewer ran six probes at line level with live reproduction: (1) forever-suspect under steady traffic — OBJECT, reproduced (peer healthy at t=40s still suspect at t=10min, 31 forced failovers), fixed in-review (absolute per-episode TTL in `markSuspect`) + regression test; (2) swap-count + pin behavior — no added moves; pinned sessions hold through windows; (3) all-suspect fallback — cannot wedge (`spawnOnMachine` un-gated, throws-to-caller); (4) stale-ack window-clearing — semantically correct for a transport-health breaker; (5) chains-cleanup serialization — identity guard traced clean; (6) ran breaker/router unit + dispatch integration + session-pool e2e suites and tsc — all green. **Verdict: CONCUR with the applied fix.**
