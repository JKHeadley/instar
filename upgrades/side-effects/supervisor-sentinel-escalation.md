# Side-Effects Review — Slow-Retry Sentinel Escalation

**Version / slug:** `supervisor-sentinel-escalation`
**Date:** `2026-06-05`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent adversarial reviewer subagent — CONCUR (all four probes safe; no blocking defects; non-blocking notes recorded below)`

## Summary of the change

The ServerSupervisor's slow-retry mode (2h respawn cadence, deliberately forever) gains the Eternal Sentinel's condition-4 observability: a pure one-shot latch (`src/lifeline/SlowRetrySentinelEscalation.ts`) fires once per outage episode after `escalateAfterMs` (default 12h), the supervisor emits `'sentinelStalled'`, and `TelegramLifeline.notifySentinelStalled` delivers ONE operator message (doctor/reset levers), after which the sentinel keeps retrying unchanged. `resetCircuitBreaker()` — the single episode-ending funnel — re-arms the latch in lockstep with zeroing `slowRetryStartedAt`. Files: `SlowRetrySentinelEscalation.ts` (new, pure), `ServerSupervisor.ts` (declaration comment + per-tick check + emit + reset hook + one constructor option), `TelegramLifeline.ts` (listener + notify method), one test file.

## Decision-point inventory

- `ServerSupervisor` slow-retry block — **modify (additive)** — gains a read-only latch check + event emit; the retry decision, cadence, kill, and spawn are untouched.
- `SlowRetrySentinelEscalation` — **add** — a pure signal producer with no authority of any kind.
- `TelegramLifeline` event wiring — **add** — delivery only; mirrors the existing `circuitBroken` handler shape (fire-and-forget, catch-swallowed).

## 1. Over-block

Nothing is blocked — this change cannot suppress, delay, or alter any retry or recovery action. The only "cost" added is one Telegram message per ≥12h outage episode.

## 2. Under-block

(a) A lifeline PROCESS restart zeroes the in-memory latch with all breaker state; after ~13.5h of freshly rebuilt sustained failure it would notify again. Reviewer-assessed as correct-by-design ("still broken after a bounce" is a legitimate re-notification), and persisting the latch was explicitly rejected — a stale on-disk latch could suppress a legitimate notification, the worse failure. (b) The threshold is time-based, not attempt-based: a machine asleep for 12h would escalate on wake even though few attempts ran — acceptable; the operator-facing claim ("down ~N hours") remains true. (c) Other eternal-sentinel-shaped loops (lease pull) are NOT covered here — next audit PR <!-- tracked: CMT-1109 -->.

## 3. Level-of-abstraction fit

Yes. The latch lives beside the loop it observes (lifeline package), as a pure helper in the established suppressor shape (`AgeKillBackoff`: injectable clock, bounded state, unit-testable). Delivery rides the existing supervisor→lifeline event channel (`circuitBroken` precedent) rather than inventing a new notification path — and deliberately does NOT use the agent server's attention queue, which is definitionally down when this fires.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — pure signal. The latch can only cause one message; it holds no authority over retries, kills, spawns, or the circuit breaker. The healer's behavior is byte-identical with the latch removed.

## 5. Interactions

- **Double-fire:** impossible within a process — the episode key (`slowRetryStartedAt`) is written only at episode start (when 0) and zeroed only inside `resetCircuitBreaker()`, which re-arms the latch in the same method; key and latch cannot desync (reviewer traced every write).
- **Starvation:** the slow-retry block runs every 10s health-check tick while broken (the branch returns without resetting `consecutiveFailures`), so the latch check cannot be starved (reviewer traced `evaluateUnhealthyServer` → `handleUnhealthy` reachability).
- **Ordering:** the emit's listener is fire-and-forget and catch-swallowed; it cannot block or throw into the same tick's kill/spawn (mirrors `circuitBroken`).
- **Feedback loops:** none — a message cannot change health-check outcomes.

## 6. External surfaces

- **User-visible:** one new Telegram message class, bounded at one per episode (Bounded Notification Surface-compatible: no topic creation — it posts to the existing lifeline topic).
- **Delivery independence:** `sendToTopic` → Telegram Bot API directly over HTTPS from the lifeline process; zero dependency on the down agent server (reviewer-verified at `apiCall`).
- **Persistent state / config / schema:** none. In-code default; `slowRetryEscalateAfterMs` is a constructor option for tests only. No migration (Migration Parity: nothing installed changes).

## 7. Rollback cost

Revert the commit. No state to clean, no config to unwind. The only observable regression of rollback is the silence returning.

## Conclusion

Signal-only observability for the constitution's namesake Eternal Sentinel: persistence preserved, silence eliminated, volume bounded at one message per episode and proven by the P19 sustained-failure test (week-long never-recovering episode → exactly 1). Second-pass reviewer CONCUR with zero blocking findings; both non-blocking notes (restart re-fire window, no Tier-2/3 for a route-less signal change) are recorded in §2/§6 with their rationale.

---

## Phase 5 — Second-pass review (server-lifecycle-adjacent → performed)

An independent adversarial reviewer audited the diff and final files at line level against four probes: (1) any >1-fire-per-outage path — traced every `slowRetryStartedAt`/`circuitBroken` write; none desync the episode key from the latch; lifeline-restart re-fire requires ~13.5h of rebuilt failure and is a correct re-notification; (2) any never-fire path — the slow-retry branch is reached every 10s tick while broken (per-tick reachability traced through `evaluateUnhealthyServer`/`handleUnhealthy`); (3) delivery dependence on the down server — none: the lifeline posts straight to the Telegram Bot API; (4) emit-vs-spawn ordering — fire-and-forget listener, cannot block or throw into the spawn. Ran the 10-test suite (green) and `tsc --noEmit` (clean). **Verdict: CONCUR.**
