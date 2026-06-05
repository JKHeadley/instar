# Side-Effects Review — Quota-aware placement

**Version / slug:** `quota-aware-placement`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (pure-function gate + additive optional field; absent field = bit-identical behavior; every boundary side test-pinned)

## Summary of the change

Capacity heartbeats self-report a per-machine `quotaState` (from THIS
machine's own QuotaTracker: provider block active OR 5-hour ≥95%), the
registry passes it through to `MachineCapacity`, and `PlacementExecutor`
drops quota-blocked machines from the candidate pool — with a
place-somewhere fallback when ALL are blocked (`all-machines-quota-blocked`)
and a pin-wins exception (`pinned-machine-quota-blocked`).

## Decision-point inventory

1. Heartbeat quota computation: block active / 5h exhausted / neither /
   tracker absent / tracker throws. All produce defined outputs (blocked /
   blocked / not-blocked / omitted / omitted); the omitted side = not blocked.
2. Gate: blocked machine vs not vs absent-field vs `blocked:false`. All four
   pinned.
3. All-blocked fallback vs some-unblocked. Both pinned.
4. Hard pin to blocked (honored+flagged) vs soft preference (degrades) vs
   sticky owner blocked (loses stickiness — the incident case). All pinned.
5. Pin path capability check preserved (never capability-blind). Pinned.

## 1. Over-block

A quota-blocked machine still serves: hard pins, the all-blocked fallback,
and every EXISTING session (placement only affects new/re-placements — the
gate cannot strand a running conversation). A false `blocked: true`
self-report (tracker over-reporting) shifts new placements to peers, which is
exactly the desired degraded behavior; the worst case equals today's behavior
when all machines report blocked.

## 2. Under-block

- A false `blocked: false` (stale tracker file) reproduces today's behavior —
  never worse than the status quo.
- The signal refreshes every 30s heartbeat; a block that begins mid-window is
  seen at most 30s late.
- A topic already on a machine that becomes blocked moves only on its NEXT
  message (placement is per-message by design) — no proactive eviction here.

## 3. Level-of-abstraction fit

The quota READ lives on the machine that owns the account (heartbeat
producer); the DECISION lives in the one pure placement function every
placement flows through; the registry is a dumb passthrough. No new
cross-machine channel — the signal rides the existing heartbeat.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The gate redirects NEW placements only; it never kills, blocks a message, or
overrides the user (pin wins). Failure modes degrade to current behavior
(absent/unknown = not blocked); the heartbeat computation is try/caught with
an explicit unknown ≠ blocked rule.

## 5. Interactions

- Stickiness intentionally weakened for blocked owners — that IS the incident
  fix; hysteresis still applies among unblocked candidates.
- The gemini quota-conflation lesson honored: each machine reads only its own
  QuotaTracker — no cross-machine quota file reads.
- Mixed-version pools safe: older machines simply omit the field.
- `GET /pool` and the Machines tab now show `quotaState` (additive).

## 6. External surfaces

One optional field on `MachineCapacity`/`HeartbeatObservation` (additive,
visible in `GET /pool`). No config, no routes, no migration (absence =
default). CLAUDE.md template line + idempotent append migration.

## 7. Rollback cost

Trivial — revert the PR; the field disappears from heartbeats and the gate
from decide(). No state, no schema.

## Conclusion

The quota-blind placement hole closed at the pure-function layer with
strictly-degrading failure modes: every uncertain case behaves exactly like
today.

## Second-pass review (if required)

Not required — see header.

## Evidence pointers

- `tests/unit/PlacementExecutor.test.ts` (+8, incl. the verbatim incident
  case: a blocked current owner loses stickiness).
- `tests/unit/MachinePoolRegistry.test.ts` (+1 passthrough + clears-on-next-heartbeat).
- 29 pre-existing placement tests green; tsc + lint clean.
- `docs/specs/quota-aware-placement.md` + `.eli16.md`.
