# Side-Effects Review — Transfer idempotency + exactly-once-when-live

**Version / slug:** `transfer-idempotency-exactly-once`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (pure-planner reorder + config-resolution default; every boundary side test-pinned)

## Summary of the change

1. `planTransferByNickname`: the already-satisfied checks (`owner === target`,
   NEW `pin === target` via optional `currentPinOf`) now run BEFORE the rate
   limit, so a duplicate of an already-satisfied move plans `noop` ("already
   there") instead of `reject/rate-limited`. The consumer wires `currentPinOf`
   from `TopicPlacementPinStore` and words the `already-on-target` noop as
   "already running on X — nothing to move."
2. `resolveSeamlessnessConfig`: `exactlyOnceIngress` defaults ON when the
   session pool stage is `live-transfer`/`rebalance` (a live pool without the
   ingress dedupe ledger re-executes retried/replayed user commands — the
   2026-06-05 4×-execution incident). Explicit values always win.

## Decision-point inventory

1. `owner === target` → noop vs continue. Both sides pinned (incident test +
   transfer test).
2. `pin === target` → noop vs continue; absent `currentPinOf` → old behavior.
   All three pinned.
3. Rate-limit window for a real move (different target) → still rejected.
   Pinned.
4. Stage-derived `exactlyOnceIngress` default: off (none/dark/shadow), on
   (live-transfer/rebalance), explicit override both directions. All pinned.

## 1. Over-block

Nothing new is rejected. The planner now rejects strictly LESS (duplicates
that previously rate-limited now noop). The exactly-once default only
activates a gate that itself fails open (ledger errors fall through to normal
routing, per the existing route code).

## 2. Under-block

- The rate limit no longer applies to same-target duplicates — deliberate:
  re-pinning the same value is idempotent. Rapid same-target spam costs one
  pin-store write + one "already there" reply per message; the per-topic
  Telegram traffic itself is bounded upstream.
- The exactly-once default does NOT retroactively enable the ledger on pools
  still in dark/shadow — pre-live stages keep the old dark default by design.

## 3. Level-of-abstraction fit

The idempotency fix lives in the pure planner (the single decision function
both the natural-language path and `POST /pool/transfer` flow through), not in
the Telegram consumer. The exactly-once coupling lives in config RESOLUTION
(`resolveSeamlessnessConfig`) — the one place defaults are derived — not in
the wiring site.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new blocking authority. The planner reorder converts rejections into
no-ops. The exactly-once gate it activates was already authority-bearing by
design (spec §8 G3a) and fails open on any ledger error.

## 5. Interactions

- `noop` consumer behavior unchanged structurally (pin set + release-if-self
  + message): re-setting an identical pin refreshes `updatedAt`, which can
  extend the rate window for a SUBSEQUENT different-target move by up to 10s
  — bounded, harmless.
- Activating `exactlyOnceIngress` on live pools also activates the
  reply-marker transport (same flag, existing wiring) — that is the intended
  pairing per spec §8 G3a.
- Sentinel intercepts (emergency stop / pause) run BEFORE the ingress gate in
  the route — unchanged; an emergency stop is never deduped away.

## 6. External surfaces

No new routes, no new config keys (an existing key's DEFAULT becomes
stage-aware). One user-visible message wording improvement. No migration:
config absence means "follow the default," which is the point.

## 7. Rollback cost

Trivial. `exactlyOnceIngress: false` is an instant per-agent opt-out without
deploy; reverting the PR restores both old behaviors. No state, no schema.

## Conclusion

Two small, surgical changes at the correct layers, each killing one half of a
user-facing incident: duplicates narrated as failures, and duplicates
executing at all. Strictly less rejection, strictly more dedupe, both
test-pinned on every side.

## Second-pass review (if required)

Not required — see header.

## Evidence pointers

- `tests/unit/TransferByNickname.test.ts` — 5 new idempotency tests (incl. the
  verbatim incident case).
- `tests/unit/seamlessnessConfig.test.ts` — 4 new coupling tests.
- Production evidence: `logs/server.log` 2026-06-05T04:20:43/04:20:55 double
  pin + zero `exactly-once` lines; topic 13481 screenshot (Moving →
  rate-limited → Moving → rate-limited).
