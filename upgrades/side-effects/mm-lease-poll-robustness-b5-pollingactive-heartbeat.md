# Side-Effects Review — B5 pollingActive heartbeat + pool adapter (multimachine-lease-poll-robustness, Decision 11)

**Change:** Propagate each machine's REAL Telegram poll state pool-wide so the exactly-one-listener guard can count actual pollers. Adds `pollingActive?: boolean` to `HeartbeatObservation` + `MachineCapacity` (+ the `assemble` passthrough); the server reads its own `lifeline-poll-active.json` (the lifeline's truth file from B1) and advertises `pollingActive` in its heartbeat — `undefined` (unknown) when the file is absent / stale (>90s) / the lifeline pid is dead (fail-open). Adds `poolPollerVerdict()` — the adapter that maps the pool's `MachineCapacity` rows → the unit-tested `evaluatePollerCount` (online = freshness; absent pollingActive = unknown).

**Files:** `src/core/MachinePoolRegistry.ts` (obs field + assemble passthrough), `src/core/types.ts` (`MachineCapacity.pollingActive`), `src/commands/server.ts` (advertise self pollingActive from the truth file), `src/core/pollerCount.ts` (`poolPollerVerdict` adapter), `tests/unit/pollerCount.test.ts`.

## Phase 1 — Principle check (signal vs authority)
Additive, observe-only. `pollingActive` is a new advisory heartbeat field consumed by NOTHING that makes an authority decision — placement does NOT read it (it gates on quota/clock/load only). The adapter is a pure function. No authority added.

## 1./2. Over/Under-block
Gates nothing. The field is the INPUT to the (later) guard surface; the verdict logic (three-valued, dark-peer→indeterminate, 409 ground truth) is the already-tested `evaluatePollerCount`. Fail-open: an absent/stale/dead-lifeline poll-active → `undefined` → unknown → the guard reports `indeterminate`, never a false silence/dual alarm.

## 3. Level-of-abstraction fit
Right layer — poll-active truth lives in the lifeline's file (B1); the server (which assembles the heartbeat) reads it and advertises it; the registry carries it like every other capacity field (quotaState, servesChannels). The adapter sits with the pure verdict helper.

## 4. Signal vs authority compliance
Compliant — advisory field + pure adapter, no blocking authority. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
- **Heartbeat assembly / placement:** purely additive — placement reads `online`/quota/load, not `pollingActive`, so placement behavior is unchanged. The field rides the same fail-open passthrough as `quotaState`.
- **B1 lifeline-poll-active.json:** the source. The server discounts a dead-lifeline/stale file → unknown (so a crashed lifeline can't be miscounted as polling).
- **Older peers (mid-rollout):** emit no `pollingActive` → `undefined` → unknown → `indeterminate`, the safe direction (wire-compat, Decision 11).

## 6. External surfaces
A new optional field on `/pool` capacity rows (already-authed). No new route yet (the `/guards` poll-ownership row + the Attention item are the completing increment, now trivially computable via `poolPollerVerdict`). No message.

## 7. Multi-machine posture (Cross-Machine Coherence)
Pool-scoped BY DESIGN: each machine advertises its own `pollingActive`; `poolPollerVerdict` reasons over the merged `?scope=pool` view and is dark-peer-tolerant (`online:false` → not fresh → indeterminate). Single-machine: one capacity row (self) → `ok` when polling.

## 8. Rollback cost
Trivial — an additive optional field; absent everywhere = exact current behavior (the verdict reports indeterminate/unknown). No state/migration. The `poolPollerVerdict` adapter is pure with no live consumer yet.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/pollerCount.test.ts` 11/11 (8 verdict cases + 3 adapter cases: online+active→ok, dark-peer→indeterminate, two-online→dual).

## Phase 5 — Second-pass review
**Not required** — additive, observe-only heartbeat field (fail-open, not read by any placement/authority decision) + a pure tested adapter with no live consumer. No session-lifecycle / messaging-gate / recovery path is touched. The full second-pass runs on the `/guards` row + Attention-item increment that gives it a live surface. Declared `not-required` with this reasoning (consistent with the B5/B1 decision-core commits).
