# Side-Effects Review — B5 poller-count decision (multimachine-lease-poll-robustness, Decision 11)

**Change:** Add the pure three-valued exactly-one-listener decision (`evaluatePollerCount`). Given per-machine poll-active observations (some possibly dark/unknown) + a local Telegram-409 signal, it returns `ok` (exactly one fresh poller) / `dual` (≥2 positively observed, OR a 409 = partition-immune evidence of a 2nd poller even when a peer is dark) / `silence` (a real zero — everyone fresh+known) / `indeterminate` (a dark/unknown peer → cannot confirm; NEVER a false silence/ok). Pure, deterministic, observe-only.

**Files:** `src/core/pollerCount.ts` (new pure helper), `tests/unit/pollerCount.test.ts`.

**Rollout sequencing (deliberate, not deferral):** this commit lands the decision CORE. Its guard surface — the `pollingActive` field on the capacity heartbeat, the `/guards` row, the pool fan-out, and the 409 source — wires in the B1 increment, because the authoritative `pollingActive` source is the lifeline's actual poll state (`lifeline-poll-active.json`) that B1 introduces (spec Decision 6). Landing the tested decision module first keeps each PR small and the wiring honest (the helper is fully unit-proven before it has a live consumer). Tracked: spec Decision 11/12 + CMT-1710.

## Phase 1 — Principle check (signal vs authority)
Pure decision function, no authority, no I/O. It will feed a SIGNAL-only guard (observe → Attention item), never a block/gate. Signal-vs-authority satisfied by construction.

## 1. Over-block / 2. Under-block
N/A — gates nothing. The decision's correctness axis is "never false-alarm": a dark/unknown peer yields `indeterminate`, not a false `silence`/`ok` (the adversarial-review requirement) — unit-tested. The 409 path prevents the under-detection of a partition-induced dual-poll that heartbeat-counting alone misses.

## 3. Level-of-abstraction fit
Right layer — a pure decision isolated from data-gathering, so the guard wiring (B1) just supplies observations. Matches the B3/B4/B2 pure-helper pattern.

## 4. Signal vs authority compliance
Compliant — pure function, no blocking authority. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
None yet — no consumer in this commit. When wired (B1), it reads the capacity heartbeat (fail-open `pollingActive`) + the local 409 signal; it produces an Attention item with a stable dedupKey (`poll-ownership:<state>`) + a `/guards` row (both in the B1 increment).

## 6. External surfaces
None in this commit (pure module). The future guard surface is observe-only (an Attention item + a `/guards` row), never a message gate.

## 7. Multi-machine posture (Cross-Machine Coherence)
The decision is inherently POOL-scoped (it reasons over all machines' observations) and dark-peer-tolerant BY DESIGN (`indeterminate` on any visibility gap). The future guard reads via the existing `?scope=pool` fan-out. Single-machine: one observation (self), `ok` — unit-tested.

## 8. Rollback cost
Trivial — a pure module with no consumer yet; deleting it removes a tested helper. When wired, the guard is dev-gated (`multiMachine.pollOwnershipGuard`) with a clean kill-switch.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/pollerCount.test.ts` 8/8: ok; dual (positive ≥2); silence (real zero); indeterminate (dark peer — NOT false silence); indeterminate (older-peer unknown field); dual-via-409 even when the peer is dark (partition-immune); positive-≥2 wins over an unknown third; single-machine → ok.

## Phase 5 — Second-pass review
**Not required.** This commit is a PURE decision module with NO consumer and NO authority (it gates nothing, touches no session lifecycle / messaging / recovery path). The second-pass review will run on the B1 increment that WIRES it into the guard surface (where it gains a live surface). Declared `not-required` with this reasoning.
