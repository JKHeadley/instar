# Side-Effects Review — Mesh Lease-Transport Brakes

**Version / slug:** `mesh-pull-brakes`
**Date:** `2026-06-05`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent adversarial reviewer subagent — CONCUR with one substantive finding (10s timeout default → false self-suspend risk), APPLIED before commit (30s default + leaseTtlMs-derived wiring)`

## Summary of the change

`HttpLeaseTransport` (the fenced-lease wire) gains the two P19 brakes its deliberate fixed-cadence callers were missing: per-peer state-change failure logging via the new pure `PeerFailureLogGate` (first / every-Nth / recovery; exact bound ⌈F/N⌉+1 lines per streak; default N=360 ≈ 30min at the 5s pull cadence) replacing one-line-per-attempt (≈17k/day per down peer), with previously-silent non-ok responses now gated-logged; and `AbortSignal.timeout` on both fetches (default 30s; `server.ts` derives `min(leaseTtlMs/2, 30_000)`) closing the hung-socket wedge behind the pull loop's `leasePulling` re-entrancy guard. Files: `PeerFailureLogGate.ts` (new), `HttpLeaseTransport.ts`, one wiring line in `server.ts`, two test files.

## Decision-point inventory

- `HttpLeaseTransport.pullPeer` / `broadcast` — **modify (bounded)** — same requests, same return semantics; failures now abort at the timeout instead of hanging forever, and logging is gated.
- `PeerFailureLogGate` — **add** — a pure log shaper; no authority of any kind.
- `server.ts` lease-transport construction — **modify (one line)** — passes the config-derived timeout.

## 1. Over-block

The one real over-block risk was found BY the reviewer and closed BEFORE commit: a 10s timeout default sat inside the fleet's documented 5–40s receiver-stall envelope; because `LeaseCoordinator.renew()` treats an unconfirmed broadcast past `leaseTtlMs` as "no medium" and self-suspends the holder, a slow-but-alive peer would have falsely demoted a healthy awake machine on its FIRST slow renewal (renewal cadence 120s > TTL 60s leaves no retry headroom). Applied fix: 30s default (above the stall envelope's bulk; a truly hung socket never returns, so the wedge bound is intact) + derivation from `leaseTtlMs` at the construction site so operator-widened TTLs keep proportion. Residual: a peer consistently slower than 30s per request still reads as unreachable — at that point it is functionally unreachable (the TTL itself is 60s).

## 2. Under-block

(a) Sibling transports (`HttpLiveTailTransport`, `ReplyMarkerTransport`) share the no-timeout + per-attempt-log pattern at lower blast radius (no lease authority; live-tail already has #867's per-topic backoff bounding attempt rate) — next audit targets <!-- tracked: CMT-1109 -->. (b) A peer removed from the registry mid-failure-streak leaves one stale `Map` entry in the gate (never recovers, never deleted) — bounded by historical peer×op count (reviewer: "not worth fixing, worth knowing"). (c) The gate bounds LOG volume, not attempt volume — attempt cadence is the deliberate anti-blinding design and is out of scope by intent.

## 3. Level-of-abstraction fit

Yes. The brakes live in the transport that generates the cost; the cadence stays owned by the caller (`MultiMachineCoordinator`), exactly as the file's contract states. `PeerFailureLogGate` is the established pure-suppressor shape (`AgeKillBackoff`, `SlowRetrySentinelEscalation`) — count-based here (no clock) because the bound should be exact per attempt, not wall-time-dependent. Keying broadcast/pull separately mirrors `isReachable()`'s bidirectional reachability model.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — the gate shapes LOG output only. The timeout changes failure TIMING (hang → bounded abort), not failure handling: both callers already treated failures as advisisory data. Lease acquire/renew/suspend semantics are byte-identical; the reviewer traced the renewal path end-to-end to confirm the only semantic risk (timeout sizing) and it was resolved.

## 5. Interactions

- **Renewal-requires-medium:** the critical interaction, analyzed in §1 (reviewer probe 1) — resolved by the 30s/config-derived sizing.
- **Anti-blinding pull loop:** a timed-out pull loses one learning tick and retries in ~5s; never feeds self-suspend. The timeout RESTORES anti-blinding in the hung-socket case (previously wedged forever).
- **Test clocks:** `AbortSignal.timeout` uses real timers; the injected `now()` drives only reachability windows — orthogonal, no interaction (reviewer probe 2; all suites green).
- **Log-format consumers:** no test or consumer pinned the old per-attempt strings (reviewer probe 5, grepped src+tests).
- **Node engines:** `AbortSignal.timeout` needs ≥17.3; package.json engines is ≥20.12 (reviewer probe 4).

## 6. External surfaces

- **Logs only** — fewer lines in the failure steady-state, new (bounded) visibility for rejecting peers and recoveries. No API, schema, message, or notification surface. No topic creation (Bounded Notification Surface untouched).
- **Persistent state / config / migration:** none. The derivation reads the existing `leaseTtlMs`; `requestTimeoutMs`/`failureLogEveryN` are dep options with in-code defaults.

## 7. Rollback cost

Revert the commit. No state, no config, no schema. Rollback's only observable effect: the log flood and the hung-socket wedge return.

## Conclusion

The transport carrying the mesh's most consequential state (the lease) now satisfies P19: bounded per-attempt cost (log gate), a hard bound on a single attempt's duration (abort timeout), with the deliberately-unbounded cadence left intact and explicitly justified (anti-blinding). The review process did its job visibly: the reviewer's false-self-suspend trace changed the shipped default before commit — recorded in the spec so the sizing rationale survives.

---

## Phase 5 — Second-pass review (lease/coherence-critical → required)

An independent adversarial reviewer ran five probes at line level: (1) false unreachability via the renewal path — FOUND the 10s-default risk (traced `tickLease` 120s cadence → `renew()` → `broadcast` → self-suspend at TTL 60s against the fleet's 5–40s stall envelope) and proposed the exact fix that was then applied (30s default + `min(leaseTtlMs/2, 30s)` wired at `server.ts`); (2) AbortSignal real-timers vs injected test clocks — orthogonal, clean; (3) gate key independence + memory bounds — intended and bounded (one stale-key note, accepted); (4) Node engines — satisfied; (5) old-format/silence pins — none in src or tests. Ran the six lease/transport suites + tsc — all green. **Verdict: CONCUR** (with the recommended change, which is now in the diff).

**Post-CI note:** the original commit was made before this worktree had its husky shims installed (`pnpm install` not yet run → zero hooks → no decision-audit entry staged) — the decision-audit CI gate caught the bypass exactly as designed (#830). This follow-up commit runs through the full gate and carries the entry.
