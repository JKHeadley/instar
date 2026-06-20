# Side-Effects Review — B5 /pool/poller-count read route (multimachine-lease-poll-robustness, Decision 11)

**Change:** Add `GET /pool/poller-count` — exposes the exactly-one-Telegram-listener verdict (`poolPollerVerdict` over the pool's `MachineCapacity` rows: ok / dual / silence / indeterminate). Observe-only read route; the `pollingActive` source is the heartbeat field (B5), already propagated. The deduped Attention item on dual/silence is the follow-up; this surfaces the verdict on demand now.

**Files:** `src/server/routes.ts` (route + import), `tests/integration/pool-routes.test.ts` (2 tests).

## Phase 1 — Principle check
Read-only route, no authority. Returns a computed verdict; gates nothing.

## 1-8
- Over/under-block: N/A (read route). The verdict's correctness (dark-peer→indeterminate, never a false silence/dual) is the unit-tested `poolPollerVerdict` (11 unit tests) + 2 integration tests here.
- Abstraction: thin route over the tested pure adapter, mirroring the existing `/pool` route.
- Signal vs authority: pure read signal.
- Interactions: reads `machinePoolRegistry.getCapacities()` (same as `/pool`); no mutation.
- External surface: a new authed read route (returns the verdict + per-machine pollingActive). No message.
- Multi-machine: pool-scoped read, dark-peer-tolerant by construction. Single-machine → one capacity row → ok when self polls.
- Rollback: trivial (delete the route handler).

## Verification
- `tsc --noEmit` clean.
- `tests/integration/pool-routes.test.ts` 8/8 (incl. the 2 new: exactly-one→ok; dark-peer→indeterminate).

## Phase 5 — Second-pass review
Not required — a read-only observability route over the already-unit-tested `poolPollerVerdict`; no authority, no gate, no session/messaging/recovery path.
